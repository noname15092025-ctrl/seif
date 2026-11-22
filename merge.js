"use strict";
/* ======================================================================
   SHUT · Слияние сейфа при синхронизации (по отдельным записям).
   Раньше версия из облака целиком заменяла локальную, и правки, сделанные
   на другом устройстве без сети, терялись. Теперь:
   - запись изменили только здесь → берём локальную;
   - только на другом устройстве → берём из облака;
   - новые записи с обеих сторон сохраняются;
   - изменили на ОБОИХ после последней синхронизации → конфликт:
     по умолчанию побеждает более свежая, а пользователя спрашиваем.
   lastSync — момент последней успешной синхронизации этого устройства.
   ====================================================================== */
const mgStamp = x => Math.max(+x.updated || 0, +x.deletedAt || 0, +x.created || 0);
// содержимое без служебного «когда использовали» (его просто берём максимальным)
const mgBody = x => { const { used, ...rest } = x; return JSON.stringify(rest); };
function mergeEntries(local, remote, lastSync) {
  const L = new Map(local.map(x => [x.id, x])), R = new Map(remote.map(x => [x.id, x]));
  const out = [], conflicts = []; let fromRemote = 0, fromLocal = 0;
  const ids = [...new Set([...local.map(x => x.id), ...remote.map(x => x.id)])];
  for (const id of ids) {
    const l = L.get(id), r = R.get(id);
    if (l && !r) { out.push(l); fromLocal++; continue; }
    if (r && !l) { out.push(r); fromRemote++; continue; }
    if (mgBody(l) === mgBody(r)) { out.push((+r.used || 0) > (+l.used || 0) ? r : l); continue; }
    const lt = mgStamp(l), rt = mgStamp(r);
    const lChanged = lt > lastSync, rChanged = rt > lastSync;
    if (lChanged && rChanged && lastSync > 0) {
      const win = lt >= rt ? l : r;
      out.push(win); conflicts.push({ id, local: l, remote: r, picked: win === l ? "local" : "remote" });
      if (win === r) fromRemote++; else fromLocal++;
    } else if (rChanged && !lChanged) { out.push(r); fromRemote++; }
    else if (lChanged && !rChanged) { out.push(l); fromLocal++; }
    else { const win = lt >= rt ? l : r; out.push(win); if (win === r) fromRemote++; else fromLocal++; }
  }
  // порядок: как в облаке, новые локальные — в конце
  const order = new Map(remote.map((x, i) => [x.id, i]));
  out.sort((a, b) => (order.has(a.id) ? order.get(a.id) : 1e9) - (order.has(b.id) ? order.get(b.id) : 1e9));
  const sameAsRemote = out.length === remote.length && out.every((x, i) => mgBody(x) === mgBody(remote[i]) && (+x.used || 0) === (+remote[i].used || 0));
  return { entries: out, conflicts, fromRemote, fromLocal, needPush: !sameAsRemote };
}
// Применить выбор пользователя по конфликтам: choice[id] = "local" | "remote" | "both"
function mergeResolve(list, conflicts, choice, copySuffix, newId) {
  const out = list.slice();
  conflicts.forEach(c => {
    const ch = choice[c.id] || c.picked, i = out.findIndex(x => x.id === c.id); if (i < 0) return;
    if (ch === "local") out[i] = c.local;
    else if (ch === "remote") out[i] = c.remote;
    else if (ch === "both") {
      const keep = c.picked === "local" ? c.local : c.remote, other = c.picked === "local" ? c.remote : c.local, now = Date.now();
      out[i] = keep;
      out.push({ ...other, id: newId(), title: (other.title || "") + copySuffix, updated: now, created: now });
    }
  });
  return out;
}
