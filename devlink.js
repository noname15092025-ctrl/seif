"use strict";
/* ======================================================================
   SHUT · Подключение второго устройства по QR-коду.
   Старое устройство (Настройки → «Подключить устройство»): после мастер-пароля показывает
   QR и одноразовый 6-значный код. В QR — ключ сейфа, зашифрованный этим кодом через Argon2id
   (как мастер-пароль), поэтому фото QR без кода бесполезно.
   Новое устройство («Войти по QR-коду»): сканирует QR (или вставляет текст), вводит код,
   сейф подтягивается из облака, остаётся задать пароль для этого устройства.
   ====================================================================== */
const DL_PREFIX = "SHUT1:";
const dlB64u = u8 => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dlUnB64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return unb64(s); };
async function dlKeyFromCode(code, salt) {
  const tag = await argon2(String(code), salt);
  return C.importKey("raw", tag, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
// старое устройство: собрать текст для QR
async function dlMakePayload(raw) {
  let code = ""; for (let i = 0; i < 6; i++) code += randInt(10);
  const salt = rand(16), key = await dlKeyFromCode(code, salt), box = await seal(key, raw);
  const iv = unb64(box.iv), ct = unb64(box.ct), all = new Uint8Array(16 + iv.length + ct.length);
  all.set(salt, 0); all.set(iv, 16); all.set(ct, 16 + iv.length);
  return { text: DL_PREFIX + dlB64u(all), code };
}
// новое устройство: расшифровать
async function dlOpenPayload(text, code) {
  const all = dlUnB64u(text.trim().slice(DL_PREFIX.length));
  if (all.length < 16 + 12 + 32) throw new Error("bad");
  const salt = all.slice(0, 16), iv = all.slice(16, 28), ct = all.slice(28);
  const key = await dlKeyFromCode(code, salt);
  return open(key, { iv: b64(iv), ct: b64(ct) });
}

/* ---------- старое устройство: показать QR ---------- */
if ($("b-dl-show")) $("b-dl-show").onclick = async e => {
  const s = store.get(), pw = $("dl-pw").value; $("dl-err").textContent = "";
  if (!pw) { $("dl-err").textContent = T("Введите мастер-пароль", "Enter your master password"); return; }
  busy(e.target, true, T("Готовлю…", "Preparing…"));
  let raw;
  try { raw = await open(await wrapKeyFrom(pw, s), s.wrapped); }
  catch { busy(e.target, false, ""); $("dl-err").textContent = T("Неверный мастер-пароль", "Wrong master password"); return; }
  try {
    if (syncUrls().length) { try { await persist(); await syncPush(store.get()); } catch {} } // чтобы новое устройство получило свежий сейф
    const p = await dlMakePayload(raw); $("dl-pw").value = "";
    dlShowQr(p);
  } finally { raw.fill(0); busy(e.target, false, ""); }
};
function dlShowQr(p) {
  const ov = document.createElement("div"); ov.className = "cal-pop-ov";
  let left = 300;
  ov.innerHTML = `<div class="cal-pop dl-pop" role="dialog" aria-modal="true">
    <div class="cp-top"><b class="nh-h">${T("Подключить устройство", "Link a device")}</b><button type="button" class="cp-x" data-dl-close aria-label="${T("Закрыть", "Close")}">✕</button></div>
    <ol class="dl-steps"><li>${T("На новом устройстве откройте SHUT и нажмите <b>«Войти по QR-коду»</b>.", "On the new device open SHUT and tap <b>“Sign in with QR code”</b>.")}</li><li>${T("Наведите камеру на этот код.", "Point the camera at this code.")}</li><li>${T("Введите одноразовый код:", "Enter the one-time code:")}</li></ol>
    <div class="dl-qr">${qrSvg(p.text, 260)}</div>
    <div class="dl-code">${p.code.slice(0, 3)} ${p.code.slice(3)}</div>
    <p class="dl-timer" id="dl-timer"></p>
    <details class="cs-help"><summary>${T("Нет камеры? Перенести текстом", "No camera? Transfer as text")}</summary><p>${T("Скопируйте этот текст и вставьте его на новом устройстве в «Войти по QR-коду» → «Вставить текст». Код всё равно понадобится.", "Copy this text and paste it on the new device in “Sign in with QR code” → “Paste text”. The code is still required.")}</p>
      <div class="dl-text mono">${esc(p.text)}</div><button type="button" class="ghost cp-small" data-dl-copy>${T("Скопировать текст", "Copy text")}</button></details>
    <p class="cs-note">${T("Никому не показывайте этот экран и код. QR без кода бесполезен, но вместе они открывают сейф. Окно закроется через 5 минут.", "Don't show this screen and code to anyone. The QR is useless without the code, but together they open the vault. This window closes in 5 minutes.")}</p></div>`;
  document.body.appendChild(ov);
  const tick = () => { left--; const t = ov.querySelector("#dl-timer"); if (t) t.textContent = T("Закроется через ", "Closes in ") + Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"); if (left <= 0) close(); };
  const timer = setInterval(tick, 1000); tick();
  const close = () => { clearInterval(timer); ov.remove(); };
  ov.onclick = async e => {
    if (e.target === ov || e.target.closest("[data-dl-close]")) return close();
    if (e.target.closest("[data-dl-copy]")) { try { await navigator.clipboard.writeText(p.text); toast(T("Текст скопирован", "Text copied")); } catch {} }
  };
}

/* ---------- новое устройство: войти по QR ---------- */
async function dlStart() {
  const how = await modal(T("Войти по QR-коду. На старом устройстве: Настройки → «Подключить устройство».", "Sign in with QR code. On the old device: Settings → “Link a device”."),
    [[T("Сканировать QR", "Scan QR"), "scan"], [T("Вставить текст", "Paste text"), "paste", "ghost"], [T("Отмена", "Cancel"), null, "ghost"]]);
  if (!how) return;
  let text = "";
  if (how === "scan") { const r = await scanBarcode(); if (!r) return; text = (r.text || "").trim(); }
  else { text = await dlAsk(T("Вставьте текст со старого устройства", "Paste the text from the old device"), "SHUT1:…", false); if (!text) return; }
  if (!text.startsWith(DL_PREFIX)) { alertBox(T("Это не код подключения SHUT. На старом устройстве откройте Настройки → «Подключить устройство».", "This is not a SHUT link code. On the old device open Settings → “Link a device”.")); return; }
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await dlAsk(attempt ? T("Код не подошёл. Введите 6 цифр ещё раз", "Wrong code. Enter the 6 digits again") : T("Введите 6-значный код со старого устройства", "Enter the 6-digit code from the old device"), "123 456", true);
    if (!code) return;
    let raw;
    try { raw = await dlOpenPayload(text, code.replace(/\D/g, "")); }
    catch (e) { if (e && e.message === "bad") { alertBox(T("Повреждённый код подключения.", "Damaged link code.")); return; } continue; }
    try { await dlRestoreFromRaw(raw); } finally { raw.fill(0); }
    return;
  }
  alertBox(T("Слишком много неверных попыток. Покажите на старом устройстве новый QR-код.", "Too many wrong attempts. Show a new QR code on the old device."));
}
function dlAsk(title, ph, digits) {
  return new Promise(res => {
    const ov = document.createElement("div"); ov.className = "cal-pop-ov";
    ov.innerHTML = `<div class="cal-pop dl-ask" role="dialog" aria-modal="true"><b class="nh-h">${esc(title)}</b>
      ${digits ? `<input id="dl-in" class="field dl-in" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="${esc(ph)}">` : `<textarea id="dl-in" class="field mono" rows="3" spellcheck="false" placeholder="${esc(ph)}"></textarea>`}
      <div class="cp-actions"><span></span><button type="button" class="ghost" data-x>${T("Отмена", "Cancel")}</button><button type="button" class="cp-save" data-ok>${T("Продолжить", "Continue")}</button></div></div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector("#dl-in"); setTimeout(() => inp.focus(), 30);
    const done = v => { ov.remove(); res(v); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter" && digits) { e.preventDefault(); done(inp.value.trim()); } if (e.key === "Escape") done(""); });
    ov.onclick = e => { if (e.target === ov || e.target.closest("[data-x]")) done(""); if (e.target.closest("[data-ok]")) done(inp.value.trim()); };
  });
}
async function dlRestoreFromRaw(raw) {
  const key = await C.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]), id = await vaultId(key);
  let box = null; const local = store.all().find(p => p.id === id); if (local) box = local.vault;
  if (syncUrls().length) {
    try { const d = await deriveSync(raw); const best = await syncFetchLatest(d.id, d.auth); if (best && best.vault) { await open(key, best.vault); box = best.vault; } } catch {}
  }
  if (!box) { alertBox(T("Ключ принят, но сейф в облаке не найден. Включите синхронизацию на старом устройстве (Настройки → «Синхронизировать сейчас») и попробуйте снова.", "The key is accepted but the vault was not found in the cloud. Turn on sync on the old device (Settings → “Sync now”) and try again.")); return; }
  key._vaultBox = box; pendingKey = key;
  setSetpwBtn("Открыть сейф", "Open the vault"); $("setpw-err").textContent = ""; show("setpw");
  toast(T("Сейф найден — задайте пароль для этого устройства", "Vault found — set a password for this device"));
}
document.querySelectorAll("[data-dl-start]").forEach(b => b.onclick = () => dlStart());
