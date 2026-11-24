"use strict";
/* ======================================================================
   SHUT · Заметки и задачи, расширения:
   ссылки [[Заметка]] с автодополнением и обратные ссылки, история версий,
   папки и теги, закрепление, экспорт в Markdown / HTML / PDF,
   подзадачи у задач, задачи из заметок (- [ ]), быстрое добавление Ctrl+K.
   Всё хранится внутри записей сейфа и шифруется вместе с ними.
   ====================================================================== */

/* ---------- поиск заметки по названию ---------- */
const noteByTitle = t => { const k = String(t || "").trim().toLowerCase(); return k ? notesList().find(n => (n.title || "").trim().toLowerCase() === k) : undefined; };

/* ---------- папки и теги ---------- */
let notesFolderSel = "*", notesTagSel = "";
const noteFolders = () => [...new Set(notesList().map(n => (n.folder || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
function notesFilter(list) {
  return list.filter(n => {
    const f = (n.folder || "").trim();
    if (notesFolderSel === "") { if (f) return false; }
    else if (notesFolderSel !== "*" && f !== notesFolderSel && !f.startsWith(notesFolderSel + "/")) return false;
    if (notesTagSel && !mdTags(n.body).includes(notesTagSel)) return false;
    return true;
  });
}
function notesChipsRender(all) {
  const head = $("ws-head"); if (!head) return;
  const folders = noteFolders(), tagCount = {};
  all.forEach(n => mdTags(n.body).forEach(t => tagCount[t] = (tagCount[t] || 0) + 1));
  const tags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a] || a.localeCompare(b)).slice(0, 30);
  if (!folders.length && !tags.length) return;
  const fc = (v, label, n) => `<button type="button" class="nf-chip${notesFolderSel === v ? " on" : ""}" data-nfolder="${esc(v)}">${label}${n != null ? `<span>${n}</span>` : ""}</button>`;
  const cnt = v => all.filter(n => { const f = (n.folder || "").trim(); return v === "" ? !f : f === v || f.startsWith(v + "/"); }).length;
  head.insertAdjacentHTML("beforeend", `<div class="nf-bar">
    ${folders.length ? `<div class="nf-row">${fc("*", T("Все папки", "All folders"))}${folders.map(f => fc(f, "📁 " + esc(f), cnt(f))).join("")}${fc("", T("Без папки", "No folder"), cnt(""))}</div>` : ""}
    ${tags.length ? `<div class="nf-row">${tags.map(t => `<button type="button" class="nf-chip tag${notesTagSel === t ? " on" : ""}" data-ntag="${esc(t)}">#${esc(t)}<span>${tagCount[t]}</span></button>`).join("")}</div>` : ""}
  </div>`);
}
$("ws-head") && $("ws-head").addEventListener("click", e => {
  const f = e.target.closest("[data-nfolder]"); if (f) { notesFolderSel = f.dataset.nfolder; renderNotes(); return; }
  const t = e.target.closest("[data-ntag]"); if (t) { notesTagSel = notesTagSel === t.dataset.ntag ? "" : t.dataset.ntag; renderNotes(); }
});
function noteRowMeta(x) {
  const tags = mdTags(x.body).slice(0, 3), f = (x.folder || "").trim();
  if (!f && !tags.length) return "";
  return `<span class="note-meta-chips">${f ? `<i>📁 ${esc(f)}</i>` : ""}${tags.map(t => `<i>#${esc(t)}</i>`).join("")}</span>`;
}

/* ---------- панель заметки: закрепить, история, экспорт; папка ---------- */
function noteBarExtra(x) {
  const h = (x.hist || []).length;
  return `<span class="nb-break"></span><button class="ib nb-btn${x.pinned ? " on" : ""}" data-note-pin title="${x.pinned ? T("Открепить", "Unpin") : T("Закрепить сверху", "Pin to top")}">📌</button>` +
    `<button class="ib nb-btn" data-note-hist title="${T("История версий", "Version history")}">${T("История", "History")}${h ? ` <span>${h}</span>` : ""}</button>` +
    `<button class="ib nb-btn" data-note-export title="${T("Экспорт", "Export")}">${T("Экспорт", "Export")}</button>`;
}
function noteMetaRow(x) {
  return `<div class="note-meta"><span class="note-meta-l"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg></span><input id="note-folder" class="note-folder" list="note-folders" maxlength="80" placeholder="${T("Без папки — введите название, например «Работа/Проекты»", "No folder — type a name, e.g. “Work/Projects”")}" value="${esc(x.folder || "")}">
    <datalist id="note-folders">${noteFolders().map(f => `<option value="${esc(f)}">`).join("")}</datalist></div>`;
}
$("note-editor").addEventListener("change", async e => {
  if (e.target.id !== "note-folder") return;
  const x = notesList().find(y => y.id === selectedId); if (!x) return;
  x.folder = e.target.value.trim().replace(/\s*\/\s*/g, "/").replace(/^\/|\/$/g, ""); x.updated = Date.now(); await persist(); renderNotes();
});

/* ---------- обратные ссылки ---------- */
function noteBacklinksHtml(x) {
  const k = (x.title || "").trim().toLowerCase(); if (!k) return "";
  const back = notesList().filter(n => n.id !== x.id && mdLinks(n.body).includes(k));
  if (!back.length) return "";
  return `<div class="note-back"><p>${T("Ссылаются на эту заметку", "Linked from")}</p>${back.map(n => `<a href="#" class="md-wiki" data-wiki="${esc(n.title)}">${esc(n.title)}</a>`).join("")}</div>`;
}

/* ---------- история версий ---------- */
const NOTE_HIST_MAX = 50, NOTE_HIST_GAP = 5 * 6e4;
const noteEditTs = new Map(); // id → время последней правки (только в памяти, в сейф не пишется)
// Сохраняем состояние ДО правки: не чаще раза в 5 минут непрерывного редактирования
function notePushHistory(x) {
  const h = x.hist = x.hist || [], now = Date.now();
  const top = h[0];
  if (top && top.title === (x.title || "") && top.body === (x.body || "")) return;
  if (top && now - (noteEditTs.get(x.id) || 0) < NOTE_HIST_GAP && now - top.at < NOTE_HIST_GAP) { noteEditTs.set(x.id, now); return; }
  if (!(x.title || x.body)) { noteEditTs.set(x.id, now); return; } // пустую заметку не сохраняем
  h.unshift({ at: x.updated || now, title: x.title || "", body: x.body || "" });
  if (h.length > NOTE_HIST_MAX) h.length = NOTE_HIST_MAX;
  noteEditTs.set(x.id, now);
}
function noteHistoryOpen(x) {
  const h = x.hist || [];
  if (!h.length) { alertBox(T("Пока нет сохранённых версий. Версия появляется, когда вы меняете заметку (не чаще раза в 5 минут).", "No saved versions yet. A version is saved when you change the note (at most every 5 minutes).")); return; }
  const fmt = ts => new Date(ts).toLocaleString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const diff = (a, b) => { const A = new Set((a || "").split("\n")), B = new Set((b || "").split("\n")); let add = 0, del = 0; B.forEach(l => { if (!A.has(l)) add++; }); A.forEach(l => { if (!B.has(l)) del++; }); return { add, del }; };
  const ov = document.createElement("div"); ov.className = "cal-pop-ov nh-ov";
  let sel = 0;
  const render = () => {
    const v = h[sel], d = diff(v.body, x.body);
    ov.innerHTML = `<div class="cal-pop nh-pop" role="dialog" aria-modal="true">
      <div class="cp-top"><b class="nh-h">${T("История версий", "Version history")}</b><button type="button" class="cp-x" data-nh-close aria-label="${T("Закрыть", "Close")}">✕</button></div>
      <div class="nh-wrap"><div class="nh-list">${h.map((v2, i) => `<button type="button" class="nh-i${i === sel ? " on" : ""}" data-nh="${i}"><b>${esc(fmt(v2.at))}</b><small>${esc((v2.title || T("Без названия", "Untitled")).slice(0, 40))} · ${(v2.body || "").split(/\s+/).filter(Boolean).length} ${T("сл.", "words")}</small></button>`).join("")}</div>
        <div class="nh-view"><p class="nh-diff">${T("По сравнению с текущей: ", "Compared to current: ")}<span class="add">+${d.add}</span> <span class="del">−${d.del}</span> ${T("строк", "lines")}</p>
          <h2 class="nh-title">${esc(v.title || T("Без названия", "Untitled"))}</h2><div class="md nh-md">${mdToHtml(v.body, { noteExists: noteByTitle }) || `<p class="muted">${T("Пусто", "Empty")}</p>`}</div></div></div>
      <div class="cp-actions"><span></span><button type="button" class="ghost" data-nh-close>${T("Закрыть", "Close")}</button><button type="button" class="cp-save" data-nh-restore>${T("Восстановить эту версию", "Restore this version")}</button></div></div>`;
  };
  render(); document.body.appendChild(ov);
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = e => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ov.onclick = async e => {
    if (e.target === ov || e.target.closest("[data-nh-close]")) return close();
    const i = e.target.closest("[data-nh]"); if (i) { sel = +i.dataset.nh; render(); return; }
    if (e.target.closest("[data-nh-restore]")) {
      const v = h[sel]; noteEditTs.delete(x.id); notePushHistory(x); // текущее состояние тоже в историю
      x.title = v.title; x.body = v.body; x.updated = Date.now(); await persist(); close(); renderNotes();
      toast(T("Версия восстановлена", "Version restored"));
    }
  };
}

/* ---------- экспорт заметки ---------- */
const noteFileName = x => (x.title || T("заметка", "note")).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "note";
function noteHtmlDoc(x) {
  return `<!DOCTYPE html><html lang="${lang === "en" ? "en" : "ru"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(x.title || "")}</title>
<style>body{font:16px/1.65 -apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1a}h1,h2,h3{line-height:1.25}code{background:#f2f2f2;padding:1px 5px;border-radius:4px}pre{background:#f5f5f5;padding:14px;border-radius:8px;overflow:auto}blockquote{border-left:3px solid #ccc;margin:0;padding-left:14px;color:#555}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}.md-check{list-style:none;padding-left:4px}.md-box{display:inline-block;width:14px;height:14px;border:1.5px solid #888;border-radius:3px;margin-right:8px;text-align:center;font-size:11px;line-height:13px}.md-task.done>span:last-child{text-decoration:line-through;color:#888}mark{background:#f6f0a8}.md-spoiler{background:#222;color:#222}.md-callout{border-left:4px solid #8db33a;background:#f3f8e8;padding:10px 14px;border-radius:6px}.md-fns{border-top:1px solid #ddd;margin-top:30px;font-size:14px}.md-tag{color:#6b8f1c}</style></head>
<body><h1>${esc(x.title || "")}</h1>${mdToHtml(x.body)}</body></html>`;
}
async function noteExport(x) {
  const how = await modal(T("Экспорт заметки «", "Export note “") + (x.title || T("Без названия", "Untitled")) + T("». Файл не зашифрован — храните его аккуратно.", "”. The file is not encrypted — keep it safe."),
    [["Markdown (.md)", "md"], ["HTML (.html)", "html", "ghost"], [T("PDF / печать", "PDF / print"), "pdf", "ghost"], [T("Отмена", "Cancel"), null, "ghost"]]);
  if (!how) return;
  if (how === "md") download(new Blob([(x.title ? "# " + x.title + "\n\n" : "") + (x.body || "")], { type: "text/markdown;charset=utf-8" }), noteFileName(x) + ".md");
  else if (how === "html") download(new Blob([noteHtmlDoc(x)], { type: "text/html;charset=utf-8" }), noteFileName(x) + ".html");
  else {
    const pk = $("print-kit"); if (!pk) return;
    pk.innerHTML = `<div class="note-print"><h1>${esc(x.title || "")}</h1><div class="md">${mdToHtml(x.body)}</div></div>`;
    addEventListener("afterprint", () => { pk.innerHTML = ""; }, { once: true });
    window.print();
  }
}

/* ---------- редактор: автодополнение [[…]], списки по Enter, Tab для подпунктов ---------- */
function caretXY(ta) { // координаты каретки внутри textarea (через зеркальный div)
  const div = document.createElement("div"), cs = getComputedStyle(ta);
  ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderLeftWidth", "boxSizing", "width", "whiteSpace", "wordWrap", "tabSize"].forEach(p => div.style[p] = cs[p]);
  div.style.position = "absolute"; div.style.visibility = "hidden"; div.style.whiteSpace = "pre-wrap"; div.style.overflowWrap = "break-word";
  div.textContent = ta.value.slice(0, ta.selectionStart); const sp = document.createElement("span"); sp.textContent = "​"; div.appendChild(sp);
  document.body.appendChild(div); const r = ta.getBoundingClientRect(), y = sp.offsetTop - ta.scrollTop, x = sp.offsetLeft; div.remove();
  return { x: r.left + Math.min(x, r.width - 40), y: r.top + y + parseFloat(cs.lineHeight || 20) };
}
let wikiPop = null;
function wikiClose() { if (wikiPop) { wikiPop.remove(); wikiPop = null; } }
function noteEditorBind(ta) {
  const sel = { i: 0, items: [] };
  const show = () => {
    const before = ta.value.slice(0, ta.selectionStart), m = /\[\[([^\]\n|]*)$/.exec(before);
    if (!m) return wikiClose();
    const q = m[1].trim().toLowerCase(), cur = notesList().find(n => n.id === selectedId);
    let items = notesList().filter(n => n !== cur && (n.title || "").trim() && (n.title || "").toLowerCase().includes(q)).sort((a, b) => b.updated - a.updated).slice(0, 8).map(n => n.title.trim());
    if (q && !items.some(t => t.toLowerCase() === q)) items.push("+ " + m[1].trim());
    if (!items.length) return wikiClose();
    sel.items = items; sel.i = Math.min(sel.i, items.length - 1);
    if (!wikiPop) { wikiPop = document.createElement("div"); wikiPop.className = "wiki-pop"; document.body.appendChild(wikiPop);
      wikiPop.addEventListener("mousedown", e => { e.preventDefault(); const b = e.target.closest("[data-wi]"); if (b) { sel.i = +b.dataset.wi; pick(); } }); }
    wikiPop.innerHTML = `<p>${T("Ссылка на заметку", "Link to note")}</p>` + items.map((t, i) => `<button type="button" class="wiki-i${i === sel.i ? " on" : ""}" data-wi="${i}">${t.startsWith("+ ") ? `<i>${T("Создать", "Create")}</i> ${esc(t.slice(2))}` : esc(t)}</button>`).join("");
    const p = caretXY(ta); wikiPop.style.left = Math.min(p.x, innerWidth - 270) + "px"; wikiPop.style.top = Math.min(p.y + 4, innerHeight - 260) + "px";
  };
  const pick = () => {
    let t = sel.items[sel.i]; if (!t) return; if (t.startsWith("+ ")) t = t.slice(2);
    const pos = ta.selectionStart, before = ta.value.slice(0, pos), start = before.lastIndexOf("[[") + 2;
    let after = ta.value.slice(pos); if (after.startsWith("]]")) after = after.slice(2);
    ta.value = ta.value.slice(0, start) + t + "]]" + after; const c = start + t.length + 2; ta.setSelectionRange(c, c);
    wikiClose(); ta.dispatchEvent(new Event("input"));
  };
  ta.addEventListener("input", show);
  ta.addEventListener("click", show);
  ta.addEventListener("blur", () => setTimeout(wikiClose, 120));
  ta.addEventListener("keydown", e => {
    if (wikiPop) {
      if (e.key === "ArrowDown") { e.preventDefault(); sel.i = (sel.i + 1) % sel.items.length; show(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); sel.i = (sel.i - 1 + sel.items.length) % sel.items.length; show(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(); return; }
      if (e.key === "Escape") { e.preventDefault(); wikiClose(); return; }
    }
    const v = ta.value, s = ta.selectionStart, ls = v.lastIndexOf("\n", s - 1) + 1, line = v.slice(ls, s);
    // Enter продолжает список / задачу; на пустом пункте — выходит из списка
    if (e.key === "Enter" && !e.shiftKey && ta.selectionStart === ta.selectionEnd) {
      const m = /^(\s*)([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|(\d+)\.\s+)(.*)$/.exec(line); if (!m) return;
      e.preventDefault();
      if (!m[4].trim()) { ta.value = v.slice(0, ls) + v.slice(s); ta.setSelectionRange(ls, ls); }
      else { const mark = m[3] ? (+m[3] + 1) + ". " : m[2].replace(/\[[xX]\]/, "[ ]"); const ins = "\n" + m[1] + mark; ta.value = v.slice(0, s) + ins + v.slice(s); ta.setSelectionRange(s + ins.length, s + ins.length); }
      ta.dispatchEvent(new Event("input")); return;
    }
    // Tab / Shift+Tab — вложенность пункта списка (подзадачи)
    if (e.key === "Tab" && /^\s*([-*+]|\d+\.)\s/.test(v.slice(ls, v.indexOf("\n", ls) < 0 ? v.length : v.indexOf("\n", ls)))) {
      e.preventDefault();
      if (e.shiftKey) { const m2 = /^( {1,2}|\t)/.exec(v.slice(ls)); if (!m2) return; ta.value = v.slice(0, ls) + v.slice(ls + m2[0].length); const c = Math.max(ls, s - m2[0].length); ta.setSelectionRange(c, c); }
      else { ta.value = v.slice(0, ls) + "  " + v.slice(ls); ta.setSelectionRange(s + 2, s + 2); }
      ta.dispatchEvent(new Event("input"));
    }
  });
}

/* ---------- клики в редакторе/просмотре ---------- */
async function noteOpenByTitle(title) {
  let n = noteByTitle(title);
  if (!n) { // ссылки на несуществующую заметку создают её
    if (!(await confirmBox(T("Заметки «", "Note “") + title + T("» ещё нет. Создать?", "” doesn't exist yet. Create it?"), T("Создать", "Create")))) return;
    const now = Date.now(); n = { type: "page", id: b64(rand(9)), title: title.trim(), body: "", created: now, updated: now }; entries.push(n); await persist(); renderNav(); noteMode = "edit";
  } else noteMode = "preview";
  await saveNoteCore();
  if (view !== "notes") setView("notes");
  selectedId = n.id; renderNotes(); $("v-vault").classList.add("show-detail"); $("detail").scrollTop = 0;
}
async function noteEditorClick(e) {
  const w = e.target.closest(".md-wiki"); if (w) { e.preventDefault(); await noteOpenByTitle(w.dataset.wiki); return true; }
  const tg = e.target.closest(".md-tag"); if (tg) { notesTagSel = tg.dataset.tag.toLowerCase(); notesFolderSel = "*"; renderNotes(); toast(T("Фильтр: #", "Filter: #") + notesTagSel); return true; }
  const sp = e.target.closest(".md-spoiler"); if (sp) { sp.classList.toggle("open"); return true; }
  const fn = e.target.closest("[data-fn]"); if (fn) { e.preventDefault(); const t = document.getElementById(fn.getAttribute("href").slice(1)); if (t) t.scrollIntoView({ behavior: "smooth", block: "center" }); return true; }
  const x = notesList().find(y => y.id === selectedId); if (!x) return false;
  if (e.target.closest("[data-note-pin]")) { x.pinned = !x.pinned; x.updated = Date.now(); await persist(); renderNotes(); return true; }
  if (e.target.closest("[data-note-hist]")) { await saveNoteCore(); noteHistoryOpen(x); return true; }
  if (e.target.closest("[data-note-export]")) { await saveNoteCore(); noteExport(x); return true; }
  return false;
}

/* ---------- подзадачи у задач ---------- */
const taskSubsOpen = new Set();
function taskSubsBadge(x) {
  const s = x.subs || [], d = s.filter(i => i.done).length;
  return `<button type="button" class="task-subs-b${s.length ? "" : " empty"}${taskSubsOpen.has(x.id) ? " open" : ""}" data-subs-toggle title="${T("Подзадачи", "Subtasks")}">${s.length ? d + "/" + s.length : "+"}</button>`;
}
function taskSubsHtml(x) {
  if (!taskSubsOpen.has(x.id)) return "";
  const s = x.subs || [];
  return `<div class="task-subs" data-id="${esc(x.id)}">${s.map((i, n) => `<div class="task-sub${i.done ? " done" : ""}"><button type="button" class="task-check sm" data-sub-toggle="${n}">${i.done ? "✓" : ""}</button><span>${esc(i.t)}</span><button type="button" class="ib task-del" data-sub-del="${n}" aria-label="×">✕</button></div>`).join("")}
    <input class="field task-sub-new" data-sub-add maxlength="200" placeholder="${T("Новая подзадача… (Enter)", "New subtask… (Enter)")}"></div>`;
}
/* ---------- задачи из заметок ---------- */
function noteTasksSection() {
  const groups = notesList().map(n => ({ n, t: mdTasks(n.body).filter(t => !t.done) })).filter(g => g.t.length);
  if (!groups.length) return "";
  return `<div class="ntask-sec"><div class="task-divider">${T("Из заметок", "From notes")}</div>${groups.map(g => `<div class="ntask-g">
    <button type="button" class="ntask-note" data-open-note="${esc(g.n.id)}">${esc(g.n.title || T("Без названия", "Untitled"))} ›</button>
    ${g.t.map(t => `<div class="ntask lvl-${Math.min(t.level, 4)}"><button type="button" class="task-check sm" data-ntask="${esc(g.n.id)}|${t.index}"></button><span>${mdInline(t.text)}</span></div>`).join("")}</div>`).join("")}</div>`;
}
$("list").addEventListener("click", async e => {
  if (view !== "tasks") return;
  const row = e.target.closest(".task-row"), subs = e.target.closest(".task-subs");
  const tg = e.target.closest("[data-subs-toggle]");
  if (tg && row) { e.stopPropagation(); const id = row.dataset.id; taskSubsOpen.has(id) ? taskSubsOpen.delete(id) : taskSubsOpen.add(id); renderTasks(); setTimeout(() => { const i = document.querySelector(`.task-subs[data-id="${CSS.escape(id)}"] [data-sub-add]`); if (i) i.focus(); }, 30); return; }
  if (subs) {
    e.stopPropagation();
    const x = tasksList().find(t => t.id === subs.dataset.id); if (!x) return;
    const st = e.target.closest("[data-sub-toggle]"), sd = e.target.closest("[data-sub-del]");
    if (st) { const i = x.subs[+st.dataset.subToggle]; i.done = !i.done; x.updated = Date.now(); if (x.subs.length && x.subs.every(s => s.done) && !x.done) toast(T("Все подзадачи готовы — можно закрыть задачу", "All subtasks done — you can close the task")); await persist(); renderTasks(); }
    if (sd) { x.subs.splice(+sd.dataset.subDel, 1); x.updated = Date.now(); await persist(); renderTasks(); }
    return;
  }
  const nt = e.target.closest("[data-ntask]");
  if (nt) { e.stopPropagation(); const [id, idx] = nt.dataset.ntask.split("|"); const n = notesList().find(y => y.id === id); if (!n) return; notePushHistory(n); n.body = mdToggleTask(n.body, +idx); n.updated = Date.now(); await persist(); renderTasks(); toast(T("Отмечено в заметке «", "Checked in note “") + (n.title || "") + T("»", "”")); return; }
  const on = e.target.closest("[data-open-note]");
  if (on) { e.stopPropagation(); setView("notes"); selectedId = on.dataset.openNote; noteMode = "preview"; renderNotes(); $("v-vault").classList.add("show-detail"); }
}, true);
$("list").addEventListener("keydown", async e => {
  if (view !== "tasks" || e.key !== "Enter") return;
  const inp = e.target.closest("[data-sub-add]"); if (!inp || !inp.value.trim()) return;
  const x = tasksList().find(t => t.id === inp.closest(".task-subs").dataset.id); if (!x) return;
  (x.subs = x.subs || []).push({ t: inp.value.trim(), done: false }); x.updated = Date.now(); await persist(); renderTasks();
  setTimeout(() => { const i = document.querySelector(`.task-subs[data-id="${CSS.escape(x.id)}"] [data-sub-add]`); if (i) i.focus(); }, 30);
}, true);

/* ======================================================================
   Быстрое добавление и поиск по всему сейфу: Ctrl+K (⌘K)
   Пусто/текст — поиск, «>» — команды, «+» — создать по фразе:
   «+Стоматолог пт 15:00 на час напомнить за 30 мин», «+задача купить молоко завтра»,
   «+заметка Идеи для отпуска», «+Планёрка по будням 10:00».
   ====================================================================== */
function qaDescribe(p) {
  if (!p.title) return T("Напишите, что добавить", "Type what to add");
  const d = p.date ? p.date.toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { weekday: "short", day: "numeric", month: "short" }) : "";
  const rep = (p.every || 1) > 1 ? T("каждые ", "every ") + p.every + " " + { daily: T("дн.", "days"), weekly: T("нед.", "weeks"), monthly: T("мес.", "months"), yearly: T("г.", "years") }[p.repeat]
    : { daily: T("каждый день", "daily"), weekdays: T("по будням", "weekdays"), weekly: T("каждую неделю", "weekly"), monthly: T("каждый месяц", "monthly"), yearly: T("каждый год", "yearly") }[p.repeat];
  if (p.kind === "note") return T("Заметка: ", "Note: ") + p.title;
  if (p.kind === "task") return T("Задача: ", "Task: ") + p.title + (d ? T(" · срок ", " · due ") + d : "");
  const t = p.time ? cPad(p.time[0]) + ":" + cPad(p.time[1]) : T("весь день", "all day");
  return T("Событие: ", "Event: ") + p.title + " · " + d + ", " + t + (p.time ? " (" + (p.dur || 60) + T(" мин)", " min)") : "") + (rep ? " · " + rep : "") + (p.remind != null ? " · " + T("напомнить за ", "remind ") + p.remind + T(" мин", " min") : "");
}
async function qaCreate(p) {
  if (!p.title) return null;
  const now = Date.now();
  if (p.kind === "note") { const n = { type: "page", id: b64(rand(9)), title: p.title, body: "", created: now, updated: now }; entries.push(n); await persist(); renderNav(); return n; }
  if (p.kind === "task") { const t = { type: "task", id: b64(rand(9)), title: p.title, done: false, priority: 0, due: p.date ? cYmd(p.date) : "", created: now, updated: now }; entries.push(t); await persist(); renderNav(); return t; }
  const allDay = !p.time, s = new Date(p.date); if (p.time) s.setHours(p.time[0], p.time[1], 0, 0);
  const e = new Date(s.getTime() + (p.dur || 60) * 6e4);
  const ev = calMakeEvent({ title: p.title, allDay, start: cFmt(s, allDay), end: allDay ? cYmd(s) : cFmt(e, false), repeat: p.repeat, every: p.every || 1, until: "", meet: "", location: "", guests: "", note: "", remind: p.remind != null ? p.remind : allDay ? -1 : 10, color: 0 });
  entries.push(ev); await persist(); renderNav(); if (typeof calScheduleNative === "function") calScheduleNative(); return ev;
}
function qaOpenEntry(x) {
  $("v-vault").classList.remove("nav-open");
  if (x.type === "page") { setView("notes"); selectedId = x.id; noteMode = "preview"; renderNotes(); $("v-vault").classList.add("show-detail"); return; }
  if (x.type === "task") { setView("tasks"); setTimeout(() => { const r = document.querySelector(`.task-row[data-id="${CSS.escape(x.id)}"]`); if (r) { r.scrollIntoView({ block: "center" }); r.classList.add("flash"); } }, 50); return; }
  if (x.type === "event") { setView("calendar"); const [S] = evBounds(x); calDate = cDayStart(S); if (calView === "month") calView = "week"; renderCalendar(); calOpenPop(x, { e: x, s: S, en: evBounds(x)[1] }); return; }
  view = "vault"; filter = x.type === "loyalty" ? "t:loyalty" : "all"; setViewChrome("vault"); selectedId = x.id; renderNav(); render(); showDetail(); $("v-vault").classList.add("show-detail"); $("detail").scrollTop = 0;
}
const QA_CMDS = () => [
  [T("Новая заметка", "New note"), "page", () => { setView("notes"); newNote(); }],
  [T("Новая задача", "New task"), "task", () => { setView("tasks"); setTimeout(() => $("task-new") && $("task-new").focus(), 50); }],
  [T("Новое событие", "New event"), "event", () => { setView("calendar"); calNew(); }],
  [T("Новая запись (пароль, карта…)", "New entry (password, card…)"), "login", () => { setView("vault"); clearForm(); showForm(); }],
  [T("Новая скидочная карта", "New loyalty card"), "loyalty", () => { view = "vault"; filter = "t:loyalty"; setViewChrome("vault"); renderNav(); render(); clearForm(); formType = "loyalty"; applyTypeLabels(); showForm(); }],
  [T("Открыть: Обзор", "Go to: Overview"), "", () => setView("home")],
  [T("Открыть: Заметки", "Go to: Notes"), "", () => setView("notes")],
  [T("Открыть: Задачи", "Go to: Tasks"), "", () => setView("tasks")],
  [T("Открыть: Календарь", "Go to: Calendar"), "", () => setView("calendar")],
  [T("Открыть: Скидочные карты", "Go to: Loyalty cards"), "", () => { view = "vault"; filter = "t:loyalty"; setViewChrome("vault"); renderNav(); render(); }],
  [T("Генератор паролей", "Password generator"), "", () => $("b-generator").click()],
  [T("Аудит паролей", "Password audit"), "", () => $("b-audit").click()],
  [T("Настройки", "Settings"), "", () => $("b-settings").click()],
  [T("Инструкция", "Guide"), "", () => document.querySelector("[data-guide]")?.click()],
  [T("Скачать резервную копию", "Download backup"), "", () => $("b-export").click()],
  [T("Заблокировать сейф", "Lock the vault"), "", () => lock()]
];
let qaEl = null;
function qaOpen(prefill) {
  if (typeof vaultKey === "undefined" || !vaultKey || qaEl) return;
  qaEl = document.createElement("div"); qaEl.className = "qa-ov";
  qaEl.innerHTML = `<div class="qa" role="dialog" aria-modal="true"><div class="qa-in"><span class="qa-ic">⌕</span><input id="qa-input" autocomplete="off" spellcheck="false" placeholder="${T("Поиск по сейфу · «+» создать · «>» команды", "Search the vault · “+” create · “>” commands")}"><kbd>Esc</kbd></div><div class="qa-res" id="qa-res"></div>
    <div class="qa-foot">${T("<b>+</b>Стоматолог пт 15:00 на час напомнить за 30 мин · <b>+задача</b> купить молоко завтра · <b>+заметка</b> идеи · <b>&gt;</b> команды", "<b>+</b>Dentist fri 3pm for 1h remind 30 min · <b>+task</b> buy milk tomorrow · <b>+note</b> ideas · <b>&gt;</b> commands")}</div></div>`;
  document.body.appendChild(qaEl);
  const inp = qaEl.querySelector("#qa-input"), res = qaEl.querySelector("#qa-res");
  let items = [], sel = 0;
  const typeName = x => x.type === "page" ? T("Заметка", "Note") : x.type === "task" ? T("Задача", "Task") : TYPE_NAME(x.type);
  const sub = x => x.type === "page" ? ((x.folder ? "📁 " + x.folder + " · " : "") + (x.body || "").replace(/[#*`>\[\]|=]/g, "").replace(/\s+/g, " ").trim().slice(0, 60)) : x.type === "task" ? (x.done ? T("выполнена", "done") : x.due ? T("срок ", "due ") + x.due : "") : x.type === "event" ? evWhenText(x) : subline(x);
  const draw = () => {
    const q = inp.value;
    if (q.startsWith("+")) {
      const p = qaParse(q.slice(1));
      items = p.title ? [{ k: "create", p }] : [];
      res.innerHTML = `<div class="qa-create${p.title ? "" : " empty"}" data-qi="0"><span class="qa-plus">+</span><span><b>${esc(qaDescribe(p))}</b><small>${p.title ? T("Enter — создать", "Enter — create") : ""}</small></span></div>`;
      return;
    }
    const cmdMode = q.startsWith(">"), qq = (cmdMode ? q.slice(1) : q).trim().toLowerCase();
    const cmds = QA_CMDS().filter(c => !qq || c[0].toLowerCase().includes(qq)).map(c => ({ k: "cmd", c }));
    let found = [];
    if (!cmdMode && qq) {
      found = live().filter(x => [x.title, x.login, x.url, x.body, x.note, x.folder, x.location, (x.f || {}).num, ...(x.subs || []).map(s => s.t)].filter(Boolean).join(" ").toLowerCase().includes(qq))
        .sort((a, b) => ((b.title || "").toLowerCase().startsWith(qq) ? 1 : 0) - ((a.title || "").toLowerCase().startsWith(qq) ? 1 : 0) || (b.used || b.updated || 0) - (a.used || a.updated || 0)).slice(0, 30).map(x => ({ k: "entry", x }));
    } else if (!cmdMode) {
      found = live().filter(x => x.type !== "task" || !x.done).sort((a, b) => Math.max(b.used || 0, b.updated || 0) - Math.max(a.used || 0, a.updated || 0)).slice(0, 6).map(x => ({ k: "entry", x }));
    }
    items = cmdMode ? cmds : found.concat(qq ? cmds.slice(0, 4) : []);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    res.innerHTML = items.length ? items.map((it, i) => it.k === "cmd"
      ? `<button type="button" class="qa-i cmd${i === sel ? " on" : ""}" data-qi="${i}"><span class="qa-ava">›</span><span><b>${esc(it.c[0])}</b><small>${T("Команда", "Command")}</small></span></button>`
      : `<button type="button" class="qa-i${i === sel ? " on" : ""}" data-qi="${i}"><span class="qa-ava">${esc(initial(it.x.title || "?"))}</span><span><b>${esc(it.x.title || T("Без названия", "Untitled"))}</b><small>${esc(typeName(it.x))}${sub(it.x) ? " · " + esc(sub(it.x)) : ""}</small></span></button>`).join("")
      + (!cmdMode && !qq ? `<p class="qa-hint">${T("Недавние", "Recent")}</p>` : "")
      : `<p class="qa-empty">${T("Ничего не найдено. Начните с «+», чтобы создать.", "Nothing found. Start with “+” to create.")}</p>`;
    if (!cmdMode && !qq && items.length) res.prepend(res.querySelector(".qa-hint"));
  };
  const close = () => { if (!qaEl) return; qaEl.remove(); qaEl = null; };
  const run = async i => {
    const it = items[i]; if (!it) return;
    if (it.k === "create") { const x = await qaCreate(it.p); close(); if (x) { toast(qaDescribe(it.p).split(":")[0] + T(" — создано", " — created")); render(); } return; }
    close();
    if (it.k === "cmd") it.c[2](); else qaOpenEntry(it.x);
  };
  inp.addEventListener("input", () => { sel = 0; draw(); });
  inp.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); draw(); res.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); res.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
  });
  qaEl.addEventListener("mousedown", e => { if (e.target === qaEl) close(); });
  res.addEventListener("click", e => { const b = e.target.closest("[data-qi]"); if (b) run(+b.dataset.qi); });
  inp.value = prefill || ""; draw(); setTimeout(() => inp.focus(), 10);
}
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K" || e.code === "KeyK")) { if (typeof vaultKey !== "undefined" && vaultKey) { e.preventDefault(); qaOpen(); } }
});
// кнопка в шапке рядом с поиском
(() => {
  const s = $("search"); if (!s || $("b-qa")) return;
  const b = document.createElement("button"); b.type = "button"; b.id = "b-qa"; b.className = "qa-btn";
  b.title = T("Быстрое добавление и поиск (Ctrl+K)", "Quick add & search (Ctrl+K)");
  b.innerHTML = `<span class="qa-plus">+</span><kbd>${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K"}</kbd>`;
  b.onclick = () => qaOpen("+");
  s.after(b);
})();
