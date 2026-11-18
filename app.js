"use strict";
// Защита от кликджекинга: не отрисовываемся внутри чужого фрейма (CSP frame-ancestors нельзя задать через <meta>).
if (self !== top) { try { top.location = self.location.href; } catch { document.documentElement.innerHTML = ""; throw new Error("framed"); } }
/* =====================================================================
   Vault — zero-knowledge менеджер паролей
   Схема ключей:
   - энтропия 128 бит → 12 слов (BIP39)
   - фраза → seed (PBKDF2-SHA512, 2048 итераций, стандарт BIP39) → vaultKey (HKDF-SHA256)
   - vaultKey шифрует все записи (AES-256-GCM)
   - мастер-пароль → wrapKey (Argon2id: 19 МиБ, 2 прохода) → шифрует vaultKey на устройстве
   В localStorage лежат только зашифрованные данные. Ключи живут лишь в памяти вкладки.
   ===================================================================== */

const STORE = "seif.v2";
const KDF = { alg: "argon2id", m: 19456, t: 2, p: 1 }; // OWASP-минимум: ~1 с на вход; пул-JS argon2 при большей памяти слишком медленный
let LOCK_IDLE_MS = 5 * 60 * 1000; const LOCK_HIDDEN_MS = 60 * 1000;
try { const _al = localStorage.getItem("vault.autolock"); if (_al != null) LOCK_IDLE_MS = +_al; } catch {}
const stayOn = () => { try { return (localStorage.getItem("vault.stay") ?? "1") === "1"; } catch { return true; } };
const enc = new TextEncoder(), dec = new TextDecoder();
const C = crypto.subtle;
let WORDS = null;

const $ = id => document.getElementById(id);
const b64 = u8 => { let s = ""; const a = new Uint8Array(u8); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- Язык ---------------- */
let lang = (() => { try { return localStorage.getItem("vault.lang") || "ru"; } catch { return "ru"; } })();
const T = (ru, en) => lang === "en" ? en : ru;
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll("[data-en]").forEach(el => {
    if (el.dataset.ru === undefined) el.dataset.ru = el.textContent;
    el.textContent = lang === "en" ? el.dataset.en : el.dataset.ru;
  });
  document.querySelectorAll("[data-en-html]").forEach(el => { // только статичный текст из разметки
    if (el.dataset.ruHtml === undefined) el.dataset.ruHtml = el.innerHTML;
    el.innerHTML = lang === "en" ? el.dataset.enHtml : el.dataset.ruHtml;
  });
  document.querySelectorAll("[data-en-ph]").forEach(el => {
    if (el.dataset.ruPh === undefined) el.dataset.ruPh = el.placeholder;
    el.placeholder = lang === "en" ? el.dataset.enPh : el.dataset.ruPh;
  });
  document.querySelectorAll("[data-lang-toggle]").forEach(b => b.textContent = lang === "en" ? "RU" : "EN");
  $("guide-ru").classList.toggle("hidden", lang === "en");
  $("guide-en").classList.toggle("hidden", lang !== "en");
  document.title = T("SHUT — хранилище", "SHUT — storage");
  applyTypeLabels();
  if (vaultKey) { renderNav(); render(); }
  if (!$("v-unlock").classList.contains("hidden")) renderProfiles();
}
const toggleLang = () => { lang = lang === "en" ? "ru" : "en"; try { localStorage.setItem("vault.lang", lang); } catch {} applyLang(); };
document.querySelectorAll("[data-lang-toggle]").forEach(b => b.onclick = toggleLang);

/* ---------------- Тема ---------------- */
let theme = "dark"; // единый тёмный режим
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll("[data-theme-toggle]").forEach(b => b.textContent = theme === "dark" ? "☀" : "☾");
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#0A0A0A" : "#ffffff";
}
const toggleTheme = () => { theme = theme === "dark" ? "light" : "dark"; try { localStorage.setItem("vault.theme", theme); } catch {} applyTheme(); };
document.querySelectorAll("[data-theme-toggle]").forEach(b => b.onclick = toggleTheme);

/* ---------------- Модальные окна и уведомления ---------------- */
function modal(text, buttons) {
  return new Promise(res => {
    $("modal-text").textContent = text;
    $("modal-btns").innerHTML = "";
    buttons.forEach(([label, value, cls]) => {
      const b = document.createElement("button"); b.textContent = label; if (cls) b.className = cls;
      b.onclick = () => { $("modal").classList.add("hidden"); res(value); };
      $("modal-btns").appendChild(b);
    });
    $("modal").classList.remove("hidden");
  });
}
const confirmBox = (text, ok, danger) => modal(text, [[ok || T("Да", "Yes"), true, danger ? "danger" : ""], [T("Отмена", "Cancel"), false, "ghost"]]);
const alertBox = text => modal(text, [["OK", true, ""]]);
let toastTimer;
function toast(text) { const t = $("toast"); t.textContent = text; t.classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 1800); }

/* ---------------- Argon2id в фоновом потоке ---------------- */
let worker = null, wid = 0; const pending = new Map();
function argon2(password, salt, p = KDF) {
  if (!worker) {
    worker = new Worker("argon2-worker.js");
    worker.onmessage = e => { const cb = pending.get(e.data.id); pending.delete(e.data.id); e.data.error ? cb.rej(new Error(e.data.error)) : cb.res(e.data.tag); };
  }
  return new Promise((res, rej) => { const id = ++wid; pending.set(id, { res, rej }); worker.postMessage({ id, password: enc.encode(password), salt, t: p.t, m: p.m, p: p.p }); });
}

/* ---------------- BIP39 ---------------- */
async function initWords() {
  const list = self.BIP39_WORDS;
  const h = [...new Uint8Array(await C.digest("SHA-256", enc.encode(list.join("\n") + "\n")))].map(b => b.toString(16).padStart(2, "0")).join("");
  if (h !== "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda") throw new Error("Словарь повреждён");
  WORDS = list;
  const t = await entropyToMnemonic(new Uint8Array(16));
  if (t !== Array(11).fill("abandon").concat("about").join(" ")) throw new Error("Самопроверка BIP39 не пройдена");
  if (!self.Argon2.argon2SelfTest()) throw new Error("Самопроверка Argon2id не пройдена");
}
async function entropyToMnemonic(ent) {
  const hash = new Uint8Array(await C.digest("SHA-256", ent));
  let bits = [...ent].map(b => b.toString(2).padStart(8, "0")).join("");
  bits += hash[0].toString(2).padStart(8, "0").slice(0, ent.length / 4);
  const out = [];
  for (let i = 0; i < bits.length; i += 11) out.push(WORDS[parseInt(bits.slice(i, i + 11), 2)]);
  return out.join(" ");
}
const normalizePhrase = s => s.normalize("NFKD").toLowerCase().trim().split(/\s+/).join(" ");
async function validateMnemonic(phrase) {
  const words = phrase.split(" ");
  if (![12, 15, 18, 21, 24].includes(words.length)) return T("Нужно 12 слов (сейчас ", "12 words required (now ") + words.length + ")";
  let bits = "";
  for (const w of words) {
    const i = WORDS.indexOf(w);
    if (i < 0) return T("Неизвестное слово: «", "Unknown word: “") + w + T("»", "”");
    bits += i.toString(2).padStart(11, "0");
  }
  const csLen = words.length / 3, entBits = bits.length - csLen;
  const ent = new Uint8Array(entBits / 8);
  for (let i = 0; i < ent.length; i++) ent[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const hash = new Uint8Array(await C.digest("SHA-256", ent));
  if (hash[0].toString(2).padStart(8, "0").slice(0, csLen) !== bits.slice(entBits)) return T("Ошибка контрольной суммы. Проверьте порядок и написание слов", "Checksum error. Check the order and spelling of the words");
  return null;
}

/* ---------------- Ключи и шифрование ---------------- */
async function phraseToVaultKey(phrase) {
  const base = await C.importKey("raw", enc.encode(phrase), "PBKDF2", false, ["deriveBits"]);
  const seed = await C.deriveBits({ name: "PBKDF2", hash: "SHA-512", salt: enc.encode("mnemonic"), iterations: 2048 }, base, 512);
  const hk = await C.importKey("raw", seed, "HKDF", false, ["deriveKey"]);
  return C.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("seif-vault-v1"), info: enc.encode("vault-key") },
    hk, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
async function vaultId(key) { return b64(await C.digest("SHA-256", await C.exportKey("raw", key))).slice(0, 16); }
async function wrapKeyFrom(pw, prof) {
  if (prof.kdf && prof.kdf.alg === "argon2id") {
    const tag = await argon2(pw, unb64(prof.salt), prof.kdf);
    const k = await C.importKey("raw", tag, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); tag.fill(0); return k;
  }
  // старые профили (PBKDF2) — после входа автоматически переводятся на Argon2id
  const base = await C.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveKey"]);
  return C.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: unb64(prof.salt), iterations: prof.iters || 600000 }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(key, bytes) { const iv = rand(12); return { iv: b64(iv), ct: b64(await C.encrypt({ name: "AES-GCM", iv }, key, bytes)) }; }
async function open(key, box) { return new Uint8Array(await C.decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct))); }
async function wrapVaultKeyRaw(raw, pw) {
  const salt = rand(16), prof = { salt: b64(salt), kdf: { ...KDF } };
  const wk = await wrapKeyFrom(pw, prof);
  prof.wrapped = await seal(wk, raw);
  return prof;
}
async function wrapVaultKey(key, pw) {
  const raw = new Uint8Array(await C.exportKey("raw", key));
  const prof = await wrapVaultKeyRaw(raw, pw); raw.fill(0);
  return prof;
}
// Боевой ключ сессии делаем НЕИЗВЛЕКАЕМЫМ: даже при выполнении кода в странице его нельзя выгрузить.
function importVaultKey(raw) { return C.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]); }

/* ---------------- Хранилище ---------------- */
let vaultKey = null, entries = [], currentId = null, pendingPhrase = null, pendingKey = null, verifyIdx = [];
const store = {
  all() { try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; } },
  save(a) { localStorage.setItem(STORE, JSON.stringify(a)); },
  get() { return this.all().find(p => p.id === currentId) || null; },
  set(p) { const a = this.all(); const i = a.findIndex(x => x.id === p.id); if (i < 0) a.push(p); else a[i] = p; this.save(a); },
  remove(id) { this.save(this.all().filter(x => x.id !== id)); }
};
try { // перенос из первой версии
  const old = JSON.parse(localStorage.getItem("seif.v1"));
  if (old && !store.all().some(p => p.id === old.id)) { old.name = "Мой профиль"; store.set(old); }
  localStorage.removeItem("seif.v1");
} catch {}

function migrateEntry(x) {
  if (x.title === undefined) x.title = x.site || "";
  delete x.site;
  x.type = x.type || "login";
  x.created = x.created || x.t || Date.now(); delete x.t;
  x.updated = x.updated || x.created;
  x.pwChanged = x.pwChanged || x.created;
  return x;
}
async function persist() {
  const s = store.get();
  s.vault = await seal(vaultKey, enc.encode(JSON.stringify(entries)));
  store.set(s);
  if (typeof schedulePush === "function") schedulePush();
}
async function setupDevice(key, pw, vaultBox, name) {
  const id = await vaultId(key);
  const prev = store.all().find(p => p.id === id);
  const w = await wrapVaultKey(key, pw);
  store.set({ v: 3, id, name: name || (prev && prev.name) || T("Профиль", "Profile"), ...w, fails: 0, lockUntil: 0,
              vault: vaultBox || await seal(key, enc.encode("[]")) });
  currentId = id;
  try { const raw = new Uint8Array(await C.exportKey("raw", key)); await ensureSyncIds(store.get(), raw); raw.fill(0); if (syncUrl()) syncPush(store.get()).catch(() => {}); } catch {}
}

/* ---------------- Надёжность пароля ---------------- */
const COMMON = ["password", "qwerty", "123456", "12345678", "111111", "iloveyou", "admin", "welcome", "letmein", "monkey", "dragon", "football", "пароль", "йцукен", "qwertyuiop", "abc123", "1q2w3e", "zaq12wsx"];
function strength(pw) {
  if (!pw) return { score: 0, label: "" };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26; if (/[A-Z]/.test(pw)) pool += 26; if (/[0-9]/.test(pw)) pool += 10;
  if (/[а-яё]/.test(pw)) pool += 33; if (/[А-ЯЁ]/.test(pw)) pool += 33; if (/[^a-zA-Z0-9а-яёА-ЯЁ]/.test(pw)) pool += 33;
  let bits = pw.length * Math.log2(Math.max(pool, 2));
  const low = pw.toLowerCase();
  if (COMMON.some(c => low.includes(c))) bits -= 30;
  if (/(.)\1{2,}/.test(pw)) bits -= 10;
  if (/(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf|йцук)/i.test(pw)) bits -= 15;
  if (new Set(pw).size < pw.length / 3) bits -= 15;
  const score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
  const label = [, T("Слабый", "Weak"), T("Средний", "Fair"), T("Хороший", "Good"), T("Отличный", "Strong")][score];
  return { score, label, bits: Math.max(0, Math.round(bits)) };
}
function bindMeter(inputId) {
  const upd = () => {
    const s = strength($(inputId).value), bar = $(inputId + "-bar");
    bar.style.width = (s.score * 25) + "%"; bar.dataset.s = s.score;
    $(inputId + "-text").textContent = s.label ? s.label + " · ~" + s.bits + T(" бит", " bits") : "";
  };
  $(inputId).addEventListener("input", upd); return upd;
}
const meterPw1 = bindMeter("pw1"), meterCp = bindMeter("cp-new1"), meterEntry = bindMeter("e-pass");
function checkNewPassword(p1, p2) {
  if (p1.length < 12) return T("Минимум 12 символов", "At least 12 characters");
  if (strength(p1).score < 3) return T("Пароль слабоват. Добавьте длины, слов или символов", "Password is too weak. Add length, words or symbols");
  if (p1 !== p2) return T("Пароли не совпадают", "Passwords do not match");
  return null;
}

/* ---------------- Экраны ---------------- */
const views = ["start", "phrase", "verify", "setpw", "restore", "unlock", "vault", "settings", "audit", "import", "guide", "generator", "export", "loading"];
function show(v) { views.forEach(x => $("v-" + x).classList.toggle("hidden", x !== v)); scrollTo(0, 0); }
const busy = (btn, on, label) => { btn.disabled = on; if (label !== undefined) { if (on) { btn.dataset.l = btn.textContent; btn.textContent = label; } else if (btn.dataset.l) btn.textContent = btn.dataset.l; } };

const initial = s => ([...(s || "?").trim()][0] || "?").toUpperCase();
function renderProfiles() {
  const list = store.all();
  if (!list.some(p => p.id === currentId)) {
    let last = null; try { last = localStorage.getItem("vault.last"); } catch {}
    currentId = (list.find(p => p.id === last) || list[0] || {}).id || null;
  }
  $("profiles").innerHTML = list.map(p => {
    const when = p.lastLogin ? T("Последний вход ", "Last sign-in ") + new Date(p.lastLogin).toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long" }) : "";
    return `<button type="button" class="prof${p.id === currentId ? " active" : ""}" data-pid="${esc(p.id)}">
      <span class="avatar${p.id === currentId ? " accent-bg" : ""}">${esc(initial(p.name))}</span>
      <span class="who">${esc(p.name || T("Профиль", "Profile"))}${when ? `<br><small>${esc(when)}</small>` : ""}</span></button>`;
  }).join("");
}
// Всегда сначала показываем лендинг; вход — по кнопке «Войти».
function home() { landing(); }
function landing() { $("b-signin").hidden = !store.all().length; show("start"); }
function gotoUnlock() {
  if (!store.all().length) return landing();
  renderProfiles(); $("unlock-err").textContent = ""; show("unlock"); setTimeout(() => $("unlock-pw").focus(), 50);
}
$("profiles").onclick = e => {
  const b = e.target.closest("[data-pid]"); if (!b) return;
  currentId = b.dataset.pid; renderProfiles(); $("unlock-err").textContent = ""; $("unlock-pw").focus();
};
$("b-signin").onclick = gotoUnlock;
$("b-new3") && ($("b-new3").onclick = () => $("b-new").click());
$("b-new2").onclick = () => $("b-new").click();
document.querySelectorAll("[data-home]").forEach(a => a.onclick = () => { if (WORDS) { cancelToHome(true); } });
document.querySelectorAll("[data-home-lock]").forEach(a => a.onclick = () => lock());
if ($("sec-tiles")) $("sec-tiles").innerHTML = Array.from({ length: 12 }, (_, i) => `<span><i>${i + 1}</i>••••</span>`).join("");

function cancelToHome(toLanding) {
  pendingPhrase = null; pendingKey = null; verifyIdx = [];
  $("words").innerHTML = ""; $("verify-fields").innerHTML = "";
  ["pw1", "pw2", "p-name", "restore-words", "unlock-pw", "cp-old", "cp-new1", "cp-new2"].forEach(id => $(id).value = "");
  $("restore-file").value = ""; $("print-kit").innerHTML = ""; meterPw1(); meterCp();
  if (vaultKey) lock(); else if (toLanding === true) landing(); else home();
}
document.querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => cancelToHome());
let guideFrom = "start";
document.querySelectorAll("[data-guide]").forEach(b => b.onclick = () => { guideFrom = vaultKey ? "vault" : "start"; show("guide"); });
document.addEventListener("click", e => { if (e.target.closest("[data-guide-back]")) { if (guideFrom === "vault" && vaultKey) show("vault"); else cancelToHome(); } });
document.querySelectorAll("[data-back-vault]").forEach(b => b.onclick = () => vaultKey ? openVaultView() : home());

/* ---------------- Создание профиля ---------------- */
$("b-new").onclick = async () => {
  pendingPhrase = await entropyToMnemonic(rand(16));
  $("words").innerHTML = pendingPhrase.split(" ").map((w, i) => `<div><span>${i + 1}</span>${esc(w)}</div>`).join("");
  show("phrase");
};
$("b-phrase-ok").onclick = () => {
  const set = new Set(); const r = new Uint8Array(1);
  while (set.size < 3) { crypto.getRandomValues(r); if (r[0] < 252) set.add(r[0] % 12); }
  verifyIdx = [...set].sort((a, b) => a - b);
  $("verify-fields").innerHTML = verifyIdx.map(i => `<label>${T("Слово №", "Word #")}${i + 1}</label><input data-i="${i}" autocomplete="off" spellcheck="false">`).join("");
  $("verify-err").textContent = ""; show("verify");
};
$("b-print-kit").onclick = () => {
  if (!pendingPhrase) return;
  const words = pendingPhrase.split(" ");
  $("print-kit").innerHTML = `<h1>SHUT — ${T("памятка восстановления", "recovery sheet")}</h1>
    <p>${T("Эти 12 слов — единственный способ восстановить ваш сейф. Храните этот лист в надёжном месте. Никому не показывайте и не фотографируйте.", "These 12 words are the only way to restore your vault. Keep this sheet somewhere safe. Never show or photograph it.")}</p>
    <ol class="pk-words">${words.map(w => `<li>${esc(w)}</li>`).join("")}</ol>
    <p class="pk-note">${T("Создано", "Created")}: ${new Date().toLocaleDateString()} · noname15092025-ctrl.github.io/seif</p>
    <p class="pk-warn">${T("Мастер-пароль сюда НЕ записывайте — держите его только в памяти.", "Do NOT write your master password here — keep it only in your memory.")}</p>`;
  addEventListener("afterprint", () => { $("print-kit").innerHTML = ""; }, { once: true });
  window.print();
};
$("b-back-phrase").onclick = () => show("phrase");
$("b-verify").onclick = async () => {
  const w = pendingPhrase.split(" ");
  const ok = [...$("verify-fields").querySelectorAll("input")].every(inp => inp.value.trim().toLowerCase() === w[+inp.dataset.i]);
  if (!ok) { $("verify-err").textContent = T("Слова не совпадают. Проверьте записанную фразу.", "The words don't match. Check your written phrase."); return; }
  pendingKey = await phraseToVaultKey(pendingPhrase);
  pendingKey._vaultBox = null;
  pendingPhrase = null; $("words").innerHTML = "";
  setSetpwBtn("Создать сейф", "Create vault"); $("setpw-err").textContent = ""; show("setpw");
};
function setSetpwBtn(ru, en) { const b = $("b-setpw"); b.dataset.ru = ru; b.dataset.en = en; b.textContent = (typeof lang !== "undefined" && lang === "en") ? en : ru; }
$("b-setpw").onclick = async e => {
  const p1 = $("pw1").value, p2 = $("pw2").value, pname = $("p-name").value.trim();
  const bad = checkNewPassword(p1, p2); if (bad) { $("setpw-err").textContent = bad; return; }
  busy(e.target, true, T("Шифрую…", "Encrypting…"));
  try {
    await setupDevice(pendingKey, p1, pendingKey._vaultBox || null, pname);
    const raw = new Uint8Array(await C.exportKey("raw", pendingKey));
    vaultKey = await importVaultKey(raw); saveSession(raw, currentId); raw.fill(0); pendingKey = null;
    entries = JSON.parse(dec.decode(await open(vaultKey, store.get().vault))).map(migrateEntry);
    $("pw1").value = $("pw2").value = $("p-name").value = ""; meterPw1();
    openVaultView();
  } catch (err) { $("setpw-err").textContent = T("Ошибка: ", "Error: ") + err.message; }
  busy(e.target, false, "");
};

/* ---------------- Восстановление ---------------- */
$("b-restore").onclick = $("b-forgot").onclick = () => { $("restore-err").textContent = ""; show("restore"); };
document.addEventListener("click", e => { if (e.target.id === "b-restore-hint") { e.preventDefault(); $("b-restore").click(); } });
$("b-restore-go").onclick = async e => {
  const phrase = normalizePhrase($("restore-words").value);
  const bad = await validateMnemonic(phrase);
  if (bad) { $("restore-err").textContent = bad; return; }
  busy(e.target, true);
  try {
    const key = await phraseToVaultKey(phrase), id = await vaultId(key);
    let box = null;
    const f = $("restore-file").files[0];
    if (f) {
      const backup = JSON.parse(await f.text());
      if (backup.id !== id) throw new Error(T("Эта резервная копия от другой фразы", "This backup belongs to a different phrase"));
      box = backup.vault;
    } else { const s = store.all().find(p => p.id === id); if (s) box = s.vault; }
    if (!box && syncUrls().length) {
      try {
        const d = await deriveSync(new Uint8Array(await C.exportKey("raw", key)));
        const best = await syncFetchLatest(d.id, d.auth);
        if (best && best.vault) { await open(key, best.vault); box = best.vault; }
      } catch {}
    }
    if (box) await open(key, box);
    key._vaultBox = box; pendingKey = key;
    $("restore-words").value = ""; $("restore-file").value = "";
    setSetpwBtn("Открыть сейф", "Open the vault"); $("setpw-err").textContent = ""; show("setpw");
  } catch (err) { $("restore-err").textContent = err.name === "OperationError" ? T("Не удалось расшифровать", "Could not decrypt") : err.message; }
  busy(e.target, false);
};

/* ---------------- Вход с ограничением попыток ---------------- */
$("b-unlock").onclick = async e => {
  const s = store.get(); if (!s) { $("unlock-err").textContent = T("Выберите профиль", "Choose a profile"); return; }
  const now = Date.now();
  if (s.lockUntil && s.lockUntil > now) {
    $("unlock-err").textContent = T("Слишком много попыток. Подождите ", "Too many attempts. Wait ") + Math.ceil((s.lockUntil - now) / 1000) + T(" с", " s"); return;
  }
  busy(e.target, true, T("Проверяю…", "Checking…"));
  let authed = false;
  try {
    const pw = $("unlock-pw").value;
    const wk = await wrapKeyFrom(pw, s);
    const raw = await open(wk, s.wrapped);
    vaultKey = await importVaultKey(raw);
    entries = JSON.parse(dec.decode(await open(vaultKey, s.vault))).map(migrateEntry);
    authed = true;
    s.fails = 0; s.lockUntil = 0; s.lastLogin = Date.now();
    saveSession(raw, s.id); try { localStorage.setItem("vault.last", s.id); } catch {}
    try { await ensureSyncIds(s, raw); } catch {}
    if (syncUrl()) setTimeout(() => { const cur = store.get(); if (cur && vaultKey) syncPull(cur).catch(() => {}); }, 200);
    // Переход на текущие параметры Argon2id — НЕ критично для входа: любая ошибка здесь
    // не должна приводить к «Неверный пароль». Новую обёртку применяем, только если она
    // реально открывается тем же паролем (защита от порчи профиля).
    if (!s.kdf || s.kdf.alg !== "argon2id" || s.kdf.m !== KDF.m || s.kdf.t !== KDF.t) {
      try {
        const nw = await wrapVaultKeyRaw(raw, pw);
        const back = await open(await wrapKeyFrom(pw, nw), nw.wrapped);
        if (back.length === raw.length && back.every((b, i) => b === raw[i])) { Object.assign(s, nw); delete s.iters; }
        back.fill(0);
      } catch {}
    }
    raw.fill(0);
    store.set(s);
    $("unlock-pw").value = ""; $("unlock-err").textContent = ""; $("ldial-turn").style.transform = "";
    openVaultView();
  } catch (err) {
    if (authed) { try { store.set(s); } catch {} $("unlock-err").textContent = ""; try { openVaultView(); } catch {} busy(e.target, false, ""); return; }
    s.fails = (s.fails || 0) + 1;
    if (s.fails >= 3) s.lockUntil = Date.now() + Math.min(2 ** (s.fails - 3) * 30000, 3600000); // 30 с, 1 мин, 2 мин… до часа
    store.set(s);
    $("unlock-err").textContent = T("Неверный пароль", "Wrong password") + (s.fails >= 3 ? T(". Следующая попытка через ", ". Next attempt in ") + Math.ceil((s.lockUntil - Date.now()) / 1000) + T(" с", " s") : "");
  }
  busy(e.target, false, "");
};
$("unlock-pw").addEventListener("keydown", e => { if (e.key === "Enter") $("b-unlock").click(); });
$("unlock-pw").addEventListener("input", e => { $("ldial-turn").style.transform = "rotate(" + (e.target.value.length * 37) + "deg)"; });

/* ---------------- Генератор ---------------- */
function randInt(n) { const lim = Math.floor(4294967296 / n) * n, r = new Uint32Array(1); do crypto.getRandomValues(r); while (r[0] >= lim); return r[0] % n; }
function genPassword(o) {
  o = o || { mode: document.querySelector('input[name="gmode"]:checked').value, len: +$("g-len").value, up: $("g-up").checked, low: $("g-low").checked, dig: $("g-dig").checked, sym: $("g-sym").checked };
  const mode = o.mode, len = o.len;
  if (mode === "pin") { let p = ""; for (let i = 0; i < len; i++) p += randInt(10); return p; }
  if (mode === "pron") { // произносимый: чередование согласная/гласная + цифры
    const Cs = "bcdfghjkmnprstvwz", Vs = "aeiou"; let p = "";
    for (let i = 0; i < Math.max(len - 2, 6); i++) { const set = i % 2 ? Vs : Cs; p += set[randInt(set.length)]; }
    return p.charAt(0).toUpperCase() + p.slice(1) + randInt(100);
  }
  if (mode === "words") {
    const n = Math.max(3, Math.round(len / 5)), w = [];
    for (let i = 0; i < n; i++) w.push(WORDS[randInt(2048)]);
    const ci = randInt(n); w[ci] = w[ci].replace(/^./, c => c.toUpperCase());
    return w.join("-") + "-" + randInt(100);
  }
  const sets = [];
  if (o.up) sets.push("ABCDEFGHJKLMNPQRSTUVWXYZ");
  if (o.low) sets.push("abcdefghijkmnopqrstuvwxyz");
  if (o.dig) sets.push("23456789");
  if (o.sym) sets.push("!@#$%^&*-_=+?");
  if (!sets.length) sets.push("abcdefghijkmnopqrstuvwxyz");
  const all = sets.join(""), out = sets.map(s => s[randInt(s.length)]); // хотя бы один символ каждого вида
  while (out.length < len) out.push(all[randInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) { const j = randInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out.join("");
}
$("b-gen").onclick = () => { $("e-pass").value = genPassword(); meterEntry(); };
$("b-gen-opts").onclick = () => $("gen-opts").classList.toggle("hidden");
const updGenUi = () => {
  const words = document.querySelector('input[name="gmode"]:checked').value === "words";
  $("g-len-v").textContent = words ? Math.max(3, Math.round($("g-len").value / 5)) + T(" слов", " words") : $("g-len").value;
  document.querySelector(".chars-opts").classList.toggle("hidden", words);
};
$("g-len").oninput = updGenUi; document.querySelectorAll('input[name="gmode"]').forEach(r => r.onchange = updGenUi);

/* ---------------- Страница генератора ---------------- */
let gpMode = "chars", gpValue = "";
function gpOpts() { return { mode: gpMode, len: +$("gp-len").value, up: $("gp-up").checked, low: $("gp-low").checked, dig: $("gp-dig").checked, sym: $("gp-sym").checked }; }
function gpRun() {
  const o = gpOpts();
  $("gp-len-v").textContent = gpMode === "words" ? Math.max(3, Math.round(o.len / 5)) + T(" слов", " words") : o.len;
  $("gp-sets").classList.toggle("hidden", gpMode !== "chars");
  gpValue = genPassword(o); decryptInto($("gp-out"), gpValue);
  if (gpValue && gpHist[0] !== gpValue) { gpHist.unshift(gpValue); gpHist = gpHist.slice(0, 6); gpRenderHist(); }
  const st = strength(gpValue); $("gp-bar").dataset.s = st.score; $("gp-label").textContent = st.label + " · ~" + st.bits + T(" бит", " bits");
}
$("b-generator").onclick = () => { show("generator"); gpRun(); };
$("gp-again").onclick = gpRun;
$("gp-copy").onclick = () => copySecret(gpValue);
$("gp-len").oninput = gpRun;
["gp-up", "gp-low", "gp-dig", "gp-sym"].forEach(id => $(id).onchange = gpRun);
$("gp-mode").onclick = e => {
  const b = e.target.closest("[data-mode]"); if (!b) return; gpMode = b.dataset.mode;
  $("gp-mode").querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t === b));
  if (gpMode === "pin" && +$("gp-len").value > 12) $("gp-len").value = 6;
  if (gpMode !== "pin" && +$("gp-len").value < 8) $("gp-len").value = 20;
  gpRun();
};

/* ---------------- TOTP (коды 2FA) ---------------- */
function parseTotp(s) {
  s = (s || "").trim(); if (!s) return null;
  let secret = s, digits = 6, period = 30, algo = "SHA-1";
  if (/^otpauth:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      secret = u.searchParams.get("secret") || "";
      digits = +u.searchParams.get("digits") || 6; period = +u.searchParams.get("period") || 30;
      const a = (u.searchParams.get("algorithm") || "SHA1").toUpperCase(); algo = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" }[a] || "SHA-1";
    } catch { return null; }
  }
  secret = secret.replace(/[\s=-]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(secret) || secret.length < 8) return null;
  return { secret, digits: Math.min(Math.max(digits, 6), 8), period: Math.max(period, 10), algo };
}
function base32(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = "", out = [];
  for (const c of s) bits += A.indexOf(c).toString(2).padStart(5, "0");
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(out);
}
const totpKeys = new Map();
async function totpCode(cfg) {
  const id = cfg.secret + cfg.algo;
  if (!totpKeys.has(id)) totpKeys.set(id, await C.importKey("raw", base32(cfg.secret), { name: "HMAC", hash: cfg.algo }, false, ["sign"]));
  const counter = Math.floor(Date.now() / 1000 / cfg.period), msg = new Uint8Array(8);
  let c = counter; for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const h = new Uint8Array(await C.sign("HMAC", totpKeys.get(id), msg)), o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return { code: String(bin % 10 ** cfg.digits).padStart(cfg.digits, "0"), left: cfg.period - Math.floor(Date.now() / 1000) % cfg.period };
}
async function tickTotp() {
  if (!vaultKey || $("v-vault").classList.contains("hidden")) return;
  for (const el of document.querySelectorAll("[data-totp]")) {
    const x = entries.find(y => y.id === el.dataset.totp), cfg = x && parseTotp(x.totp);
    if (!cfg) continue;
    const r = await totpCode(cfg);
    el.querySelector(".code").textContent = r.code.replace(/(\d{3})(?=\d)/, "$1 ");
    el.querySelector(".left").textContent = r.left + T(" с", " s");
  }
}
setInterval(tickTotp, 1000);

/* ---------------- Типы записей с дополнительными полями ---------------- */
// k — ключ, s — секрет (скрыт, кнопки показать/копировать), m — многострочное, d — дата, c — можно копировать
const EXTRA = {
  doc: [{ k: "kind", ru: "Вид документа", en: "Document type", ph: ["Паспорт, СНИЛС, ИНН, права…", "Passport, ID, driver's license…"] },
        { k: "fio", ru: "ФИО", en: "Full name", c: 1 }, { k: "number", ru: "Серия и номер", en: "Number", s: 1 },
        { k: "issuer", ru: "Кем выдан", en: "Issued by" }, { k: "issued", ru: "Дата выдачи", en: "Issue date", d: 1 },
        { k: "expires", ru: "Действует до", en: "Valid until", d: 1 }],
  crypto: [{ k: "network", ru: "Сеть", en: "Network", ph: ["Bitcoin, Ethereum, TON…", "Bitcoin, Ethereum, TON…"] },
        { k: "address", ru: "Адрес кошелька", en: "Wallet address", c: 1, mono: 1 },
        { k: "seed", ru: "Сид-фраза", en: "Seed phrase", s: 1, m: 1, mono: 1 },
        { k: "wpass", ru: "Пароль кошелька", en: "Wallet password", s: 1 }],
  key: [{ k: "product", ru: "Программа или сервис", en: "Product or service" }, { k: "key", ru: "Ключ", en: "Key", s: 1, m: 1, mono: 1 },
        { k: "email", ru: "Зарегистрирован на", en: "Registered to", c: 1 }, { k: "expires", ru: "Действует до", en: "Valid until", d: 1 }],
  bank: [{ k: "holder", ru: "Получатель", en: "Account holder", c: 1 }, { k: "account", ru: "Номер счёта", en: "Account number", s: 1 },
        { k: "bik", ru: "БИК", en: "BIC / SWIFT", c: 1 }, { k: "corr", ru: "Корр. счёт", en: "Correspondent account", c: 1 },
        { k: "inn", ru: "ИНН", en: "Tax ID", c: 1 }],
  contact: [{ k: "relation", ru: "Кем приходится", en: "Relationship" }, { k: "phone", ru: "Телефон", en: "Phone", c: 1 },
        { k: "email", ru: "Email", en: "Email", c: 1 }, { k: "address", ru: "Адрес", en: "Address", m: 1 }]
};
const exLabel = f => lang === "en" ? f.en : f.ru;
function renderExtraForm(values) {
  const fs = EXTRA[formType];
  $("e-extra").innerHTML = fs ? fs.map(f => `<label for="ex-${f.k}">${esc(exLabel(f))}</label>` + (f.m
    ? `<textarea id="ex-${f.k}" class="field${f.mono ? " mono" : ""}" autocomplete="off" spellcheck="false"></textarea>`
    : `<input id="ex-${f.k}" class="field${f.mono ? " mono" : ""}" ${f.d ? 'type="date"' : 'autocomplete="off"'}${f.ph ? ` placeholder="${esc(lang === "en" ? f.ph[1] : f.ph[0])}"` : ""}>`)).join("") : "";
  if (fs && values) fs.forEach(f => { $("ex-" + f.k).value = values[f.k] || ""; });
}
function expiryOf(x) {
  if (x.deletedAt) return null;
  if (x.type === "card" && /^\s*(\d{1,2})\s*\/\s*(\d{2,4})\s*$/.test(x.exp || "")) {
    const [, mm, yy] = x.exp.match(/(\d{1,2})\s*\/\s*(\d{2,4})/); const y = yy.length === 2 ? 2000 + +yy : +yy;
    return new Date(y, +mm, 0, 23, 59);
  }
  const e = x.f && x.f.expires; if (e && /^\d{4}-\d{2}-\d{2}$/.test(e)) return new Date(e + "T23:59:00");
  return null;
}
const EXPIRE_SOON_MS = 90 * 864e5;
const expiringSoon = x => { const d = expiryOf(x); return d && d - Date.now() < EXPIRE_SOON_MS; };
const live = () => entries.filter(x => !x.deletedAt);
const pwEntries = () => live().filter(x => x.type !== "page" && x.type !== "task");
const notesList = () => live().filter(x => x.type === "page");
const tasksList = () => live().filter(x => x.type === "task");
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/* ---------------- Облачная синхронизация (zero-knowledge, несколько бэкендов) ---------------- */
const SYNC_URL_KEY = "vault.sync.url";
// Общие серверы синхронизации по умолчанию — работают у ВСЕХ пользователей из коробки.
// Запись идёт на первый доступный; если он недоступен или упёрся в лимит — на следующий.
// Чтение опрашивает все и берёт самую свежую версию. Добавляйте сюда резервные воркеры.
const DEFAULT_SYNC_URLS = ["https://vault-sync-d1.noname15092025.workers.dev", "https://vault.noname15092025.workers.dev"];
const syncUrls = () => {
  try { const o = (localStorage.getItem(SYNC_URL_KEY) || "").trim();
    const list = o ? o.split(/[\s,]+/).filter(Boolean) : DEFAULT_SYNC_URLS;
    return [...new Set(list.map(u => u.replace(/\/+$/, "")))];
  } catch { return DEFAULT_SYNC_URLS; }
};
const syncUrl = () => syncUrls()[0] || "";
async function deriveSync(raw) {
  const hk = await C.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const bits = n => C.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode("seif-sync-v1"), info: enc.encode(n) }, hk, 256);
  const b64u = b => b64(new Uint8Array(b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { id: b64u(await bits("id")).slice(0, 22), auth: b64u(await bits("auth")) };
}
async function ensureSyncIds(s, raw) {
  if (s.syncId && s.syncAuth) return true;
  if (!raw) return false;
  const d = await deriveSync(raw); s.syncId = d.id; s.syncAuth = d.auth; store.set(s); return true;
}
// Прочитать запись из одного бэкенда (вернуть {v,vault,name} или null)
async function fetchOne(url, id, auth) {
  try {
    const r = await fetch(url + "/v?id=" + id, { headers: { Authorization: "Bearer " + auth }, cache: "no-store", referrerPolicy: "no-referrer" });
    if (!r.ok) return null; const d = await r.json(); return (d && d.vault) ? d : null;
  } catch { return null; }
}
// Выбрать самую свежую версию среди всех бэкендов
async function syncFetchLatest(id, auth, urls) {
  const all = await Promise.all((urls || syncUrls()).map(u => fetchOne(u, id, auth)));
  return all.filter(Boolean).sort((a, b) => (b.v || 0) - (a.v || 0))[0] || null;
}
async function syncPull(s) {
  const urls = syncUrls(); if (!urls.length || !s.syncId || !vaultKey) return { ok: false };
  const best = await syncFetchLatest(s.syncId, s.syncAuth, urls);
  if (!best) return { ok: true, empty: true };
  if (typeof best.v === "number" && typeof s.syncV === "number" && best.v <= s.syncV) return { ok: true, same: true };
  const fresh = JSON.parse(dec.decode(await open(vaultKey, best.vault))).map(migrateEntry);
  entries = fresh; s.syncV = best.v; s.vault = best.vault; if (best.name) s.name = best.name; store.set(s);
  try { renderNav(); render(); } catch {}
  return { ok: true, pulled: true };
}
async function syncPush(s) {
  const urls = syncUrls(); if (!urls.length || !s.syncId) return;
  const v = Date.now(); s.syncV = v; store.set(s);
  const body = JSON.stringify({ v, vault: s.vault, name: s.name });
  let lastErr = null, ok = false;
  for (const url of urls) {
    try {
      const r = await fetch(url + "/v?id=" + s.syncId, { method: "PUT", headers: { Authorization: "Bearer " + s.syncAuth, "Content-Type": "application/json" }, body, referrerPolicy: "no-referrer" });
      if (r.ok || r.status === 409) { ok = true; break; }
      lastErr = new Error("HTTP " + r.status);
    } catch (e) { lastErr = e; }
  }
  if (!ok && lastErr) throw lastErr;
}
const schedulePush = debounce(() => { const s = store.get(); if (s && vaultKey && syncUrls().length) syncPush(s).catch(() => {}); }, 1500);
function attentionSet() {
  const withPass = live().filter(x => x.pass && x.type !== "card");
  const counts = {}; withPass.forEach(x => counts[x.pass] = (counts[x.pass] || 0) + 1);
  return new Set(withPass.filter(x => strength(x.pass).score < 3 || counts[x.pass] > 1 || breached.get(x.id) > 0 ||
    Date.now() - (x.pwChanged || x.created) > 365 * 864e5).map(x => x.id));
}
const TRASH_DAYS = 30;
function purgeTrash() {
  const before = entries.length;
  entries = entries.filter(x => !x.deletedAt || Date.now() - x.deletedAt < TRASH_DAYS * 864e5);
  return entries.length !== before;
}

/* ---------------- Форма записи ---------------- */
let formType = "login", editingId = null;
const TYPE_LABELS = () => ({
  login: { title: T("Сайт / название", "Site / name"), login: T("Логин", "Login"), pass: T("Пароль", "Password") },
  note: { title: T("Название заметки", "Note title") },
  card: { title: T("Название карты (банк)", "Card name (bank)"), login: T("Владелец карты", "Cardholder"), pass: T("PIN-код", "PIN") },
  wifi: { title: T("Название сети (SSID)", "Network name (SSID)"), pass: T("Пароль Wi-Fi", "Wi-Fi password") },
  doc: { title: T("Название", "Name") }, crypto: { title: T("Название кошелька", "Wallet name") },
  key: { title: T("Название", "Name") }, bank: { title: T("Банк", "Bank") }, contact: { title: T("Имя", "Name") }
});
function applyTypeLabels() {
  const L = TYPE_LABELS()[formType];
  document.querySelectorAll("[data-f]").forEach(el => { if (L[el.dataset.f]) el.textContent = L[el.dataset.f]; });
  document.querySelectorAll("#form-card [data-show]").forEach(el => el.classList.toggle("hidden", !el.dataset.show.split(" ").includes(formType)));
  document.querySelectorAll("#type-tabs .tab").forEach(b => b.classList.toggle("active", b.dataset.type === formType));
  const keepVals = {}; (EXTRA[formType] || []).forEach(f => { const el = $("ex-" + f.k); if (el) keepVals[f.k] = el.value; });
  renderExtraForm(keepVals);
  $("form-title").textContent = editingId ? T("Редактирование", "Editing") : T("Новая запись", "New entry");
  $("b-add").textContent = T("Сохранить", "Save");
}
document.querySelectorAll("#type-tabs .tab").forEach(b => b.onclick = () => { formType = b.dataset.type; applyTypeLabels(); });
const FIELDS = { title: "e-title", login: "e-login", url: "e-url", pass: "e-pass", totp: "e-totp", category: "e-cat", note: "e-note", number: "e-number", exp: "e-exp", cvv: "e-cvv" };
function clearForm() {
  Object.values(FIELDS).forEach(id => $(id).value = ""); $("e-fav").checked = false; $("e-extra").innerHTML = ""; $("cf-list").innerHTML = "";
  editingId = null; $("form-err").textContent = ""; $("gen-opts").classList.add("hidden"); meterEntry(); applyTypeLabels();
}
// Свои (произвольные) поля записи — любые пары «название: значение», можно пометить секретными
function cfAddRow(k = "", v = "", sec = false) {
  const row = document.createElement("div"); row.className = "cf-row";
  row.innerHTML = `<input class="field cf-k" maxlength="40" placeholder="${T("Название", "Label")}"><input class="field cf-v" placeholder="${T("Значение", "Value")}"><label class="chk"><input type="checkbox" class="cf-s"> ${T("Скрыть", "Hide")}</label><button class="ib cf-del" type="button" aria-label="×">✕</button>`;
  row.querySelector(".cf-k").value = k; row.querySelector(".cf-v").value = v; row.querySelector(".cf-s").checked = sec;
  row.querySelector(".cf-del").onclick = () => row.remove();
  $("cf-list").appendChild(row);
}
$("b-cf-add").onclick = () => cfAddRow();
function collectCustom() {
  return [...$("cf-list").querySelectorAll(".cf-row")].map(r => ({ k: r.querySelector(".cf-k").value.trim(), v: r.querySelector(".cf-v").value, s: r.querySelector(".cf-s").checked })).filter(c => c.k || c.v.trim());
}
function safeUrl(u) {
  u = (u || "").trim(); if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
  try { const x = new URL(u); return (x.protocol === "https:" || x.protocol === "http:") ? x.href : ""; } catch { return ""; }
}
$("b-add").onclick = async () => {
  const d = {}; for (const [k, id] of Object.entries(FIELDS)) d[k] = $(id).value.trim();
  d.pass = $("e-pass").value; // пробелы в пароле сохраняем
  if (!d.title) { $("form-err").textContent = T("Укажите название", "Enter a name"); return; }
  if (formType === "login" && d.url && !safeUrl(d.url)) { $("form-err").textContent = T("Некорректный адрес сайта", "Invalid website address"); return; }
  if (formType === "login" && d.totp && !parseTotp(d.totp)) { $("form-err").textContent = T("Некорректный ключ 2FA", "Invalid 2FA key"); return; }
  const keep = { login: ["title", "login", "url", "pass", "totp"], note: ["title"], card: ["title", "login", "number", "exp", "cvv", "pass"], wifi: ["title", "pass"] }[formType] || ["title"];
  const now = Date.now();
  const base = { type: formType, category: d.category, note: d.note, fav: $("e-fav").checked };
  keep.forEach(k => base[k] = d[k]);
  if (formType === "login") base.url = safeUrl(d.url);
  if (EXTRA[formType]) { base.f = {}; EXTRA[formType].forEach(f => { const v = $("ex-" + f.k).value; if (v.trim()) base.f[f.k] = f.s || f.m ? v : v.trim(); }); }
  const custom = collectCustom(); if (custom.length) base.custom = custom;
  let id;
  if (editingId) {
    const i = entries.findIndex(x => x.id === editingId), old = entries[i]; id = old.id;
    // история: старый пароль сохраняется при смене (до 10 версий)
    let history = old.history || [];
    if (old.pass && old.pass !== base.pass) history = [{ pass: old.pass, at: now }, ...history].slice(0, 10);
    entries[i] = { ...base, id, created: old.created, used: old.used, updated: now, history, pwChanged: old.pass !== base.pass ? now : old.pwChanged };
  } else {
    id = b64(rand(9)); entries.push({ ...base, id, created: now, updated: now, pwChanged: now });
  }
  await persist(); clearForm(); selectedId = id; renderNav(); render(); showDetail(); toast(T("Сохранено", "Saved"));
};
$("b-edit-cancel").onclick = () => { clearForm(); showDetail(); };
function showForm() { $("detail-view").classList.add("hidden"); $("form-card").classList.remove("hidden"); $("v-vault").classList.add("show-detail"); $("detail").scrollTop = 0; setTimeout(() => $("e-title").focus(), 50); }
function showDetail() { $("form-card").classList.add("hidden"); $("detail-view").classList.remove("hidden"); renderDetail(); }
$("b-new-entry").onclick = () => { if (view === "notes") return newNote(); if (view === "tasks") return $("task-new")?.focus(); clearForm(); showForm(); };
if ($("b-menu")) $("b-menu").onclick = () => $("v-vault").classList.toggle("nav-open");
$("v-vault").addEventListener("click", e => { if (e.target.classList.contains("nav-backdrop")) $("v-vault").classList.remove("nav-open"); });

$("detail").addEventListener("click", e => { if (e.target === $("detail")) { clearForm(); $("form-card").classList.add("hidden"); $("detail-view").classList.remove("hidden"); $("v-vault").classList.remove("show-detail"); } });
document.addEventListener("click", e => { if (e.target.closest("[data-detail-back]")) { clearForm(); $("form-card").classList.add("hidden"); $("detail-view").classList.remove("hidden"); $("v-vault").classList.remove("show-detail"); renderDetail(); } });
function startEdit(x) {
  editingId = x.id; formType = x.type;
  for (const [k, id] of Object.entries(FIELDS)) $(id).value = x[k] || "";
  $("e-fav").checked = !!x.fav; meterEntry();
  $("e-extra").innerHTML = ""; applyTypeLabels(); renderExtraForm(x.f || {});
  $("cf-list").innerHTML = ""; (x.custom || []).forEach(c => cfAddRow(c.k, c.v, c.s));
  showForm();
}

/* ---------------- Список ---------------- */
let filter = "all", selectedId = null, view = "vault";
const navOpen = new Set();
function renderNav() {
  const L = pwEntries(), cats = [...new Set(L.map(x => x.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $("cat-list").innerHTML = cats.map(c => `<option value="${esc(c)}">`).join("");
  const n = f => L.filter(f).length, att = attentionSet();
  const top = [["all", T("Все записи", "All entries"), L.length], ["fav", T("Избранное", "Favorites"), n(x => x.fav)],
    ["recent", T("Недавние", "Recent"), Math.min(n(x => x.used || x.updated !== x.created), 20)]];
  const types = [["t:login", T("Логины", "Logins"), 1], ["t:card", T("Карты", "Cards"), 1], ["t:note", T("Заметки", "Notes"), 1],
    ["t:wifi", "Wi-Fi"], ["t:doc", T("Документы", "Documents")], ["totp", T("Коды 2FA", "2FA codes")], ["t:crypto", T("Криптокошельки", "Crypto wallets")],
    ["t:key", T("Ключи и лицензии", "Keys & licenses")], ["t:bank", T("Банковские счета", "Bank accounts")], ["t:contact", T("Контакты", "Contacts")]]
    .map(([v, l, always]) => [v, l, v === "totp" ? n(x => x.type === "login" && parseTotp(x.totp)) : n(x => x.type === v.slice(2)), always])
    .filter(([v, , c, always]) => always || c > 0 || filter === v);
  const checks = [["attention", T("Требуют внимания", "Need attention"), att.size, "warn"], ["expiring", T("Скоро истекают", "Expiring soon"), n(expiringSoon), "warn"],
    ["nocat", T("Без категории", "Uncategorized"), n(x => !x.category)]].filter(([v, , c]) => c > 0 || filter === v || v === "attention");
  const trash = entries.length - L.length;
  const valid = new Set([...top, ...types, ...checks].map(i => i[0]).concat(cats.map(c => "c:" + c), ["trash"]));
  if (!valid.has(filter)) filter = "all";
  const link = ([v, l, c, w]) => `<a class="nav-item${v === filter && view === "vault" ? " active" : ""}${v === "trash" ? " trash" : ""}" data-filter="${esc(v)}">${esc(l)}<span${w === "warn" && c ? ' class="badge-warn"' : ""}>${c}</span></a>`;
  const activeTasks = tasksList().filter(t => !t.done).length;
  const ws = `<a class="nav-item ws${view === "home" ? " active" : ""}" data-view="home"><svg class="ic wsico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg> ${T("Обзор", "Overview")}<span></span></a>`
    + `<a class="nav-item ws${view === "notes" ? " active" : ""}" data-view="notes"><svg class="ic wsico"><use href="#i-note"/></svg> ${T("Заметки", "Notes")}<span>${notesList().length || ""}</span></a>`
    + `<a class="nav-item ws${view === "tasks" ? " active" : ""}" data-view="tasks"><svg class="ic wsico"><use href="#i-check"/></svg> ${T("Задачи", "Tasks")}<span>${activeTasks || ""}</span></a>`;
  const topK = new Set(top.map(i => i[0])), typeK = new Set(types.map(i => i[0])), checkK = new Set(checks.map(i => i[0]));
  const activeSec = view === "vault" ? (topK.has(filter) ? "pw" : typeK.has(filter) ? "types" : checkK.has(filter) ? "checks" : filter.startsWith("c:") ? "cats" : null) : null;
  const isOpen = k => navOpen.has(k) || k === activeSec;
  const chev = `<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;
  const sec = (k, title, items) => `<div class="nav-sec${isOpen(k) ? " open" : ""}" data-sec="${k}"><button type="button" class="nav-head" data-sec-toggle="${k}"><span>${title}</span>${chev}</button><div class="nav-items">${items}</div></div>`;
  $("nav").innerHTML = ws +
    sec("pw", T("ПАРОЛИ", "PASSWORDS"), top.map(link).join("")) +
    sec("types", T("ТИПЫ", "TYPES"), types.map(link).join("")) +
    sec("checks", T("ПРОВЕРКА", "CHECKS"), checks.map(link).join("")) +
    (cats.length ? sec("cats", T("КАТЕГОРИИ", "CATEGORIES"), cats.map(c => link(["c:" + c, c, n(x => x.category === c)])).join("")) : "") +
    link(["trash", T("Корзина", "Trash"), trash]);
}
$("nav").onclick = e => {
  const st = e.target.closest("[data-sec-toggle]");
  if (st) { const k = st.dataset.secToggle, secEl = st.closest(".nav-sec"); if (secEl.classList.toggle("open")) navOpen.add(k); else navOpen.delete(k); return; }
  $("v-vault").classList.remove("nav-open");
  const w = e.target.closest("[data-view]"); if (w) { setView(w.dataset.view); scrollTo(0, 0); return; }
  const a = e.target.closest("[data-filter]"); if (!a) return;
  if (view !== "vault") setViewChrome("vault");
  view = "vault"; filter = a.dataset.filter; renderNav(); render(); scrollTo(0, 0);
};
function maskCard(n) { const d = (n || "").replace(/\D/g, ""); return d ? "•••• " + d.slice(-4) : ""; }
const subline = x => {
  const f = x.f || {};
  if (x.deletedAt) return T("Удалится ", "Deleted for good on ") + new Date(x.deletedAt + TRASH_DAYS * 864e5).toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long" });
  if (expiringSoon(x)) { const d = expiryOf(x); return (d < Date.now() ? T("Истёк ", "Expired ") : T("Истекает ", "Expires ")) + d.toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "short", year: "numeric" }); }
  switch (x.type) {
    case "card": return maskCard(x.number) || TYPE_NAME(x.type);
    case "note": return TYPE_NAME("note"); case "wifi": return "Wi-Fi";
    case "doc": return f.kind || TYPE_NAME("doc");
    case "crypto": return f.network || (f.address ? f.address.slice(0, 6) + "…" + f.address.slice(-4) : TYPE_NAME("crypto"));
    case "key": return f.product || TYPE_NAME("key");
    case "bank": return f.account ? "•••• " + f.account.replace(/\s/g, "").slice(-4) : TYPE_NAME("bank");
    case "contact": return f.relation || f.phone || f.email || TYPE_NAME("contact");
    default: return x.login || (x.url || "").replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "") || TYPE_NAME(x.type);
  }
};
function visibleList() {
  const q = $("search").value.toLowerCase(), sort = $("sort").value;
  const searchable = x => [x.title, x.login, x.note, x.category, x.url, ...Object.entries(x.f || {}).filter(([k]) => !["seed", "wpass", "key", "account", "number"].includes(k)).map(e => e[1]), ...(x.custom || []).filter(c => !c.s).flatMap(c => [c.k, c.v])].join(" ").toLowerCase();
  let list = (filter === "trash" ? entries.filter(x => x.deletedAt) : pwEntries()).filter(x => searchable(x).includes(q));
  if (filter === "fav") list = list.filter(x => x.fav);
  else if (filter === "recent") return list.filter(x => x.used || x.updated !== x.created).sort((a, b) => Math.max(b.used || 0, b.updated) - Math.max(a.used || 0, a.updated)).slice(0, 20);
  else if (filter === "attention") { const a = attentionSet(); list = list.filter(x => a.has(x.id)); }
  else if (filter === "expiring") return list.filter(expiringSoon).sort((a, b) => expiryOf(a) - expiryOf(b));
  else if (filter === "nocat") list = list.filter(x => !x.category);
  else if (filter === "totp") list = list.filter(x => x.type === "login" && parseTotp(x.totp));
  else if (filter === "trash") return list.sort((a, b) => b.deletedAt - a.deletedAt);
  else if (filter.startsWith("t:")) list = list.filter(x => x.type === filter.slice(2));
  else if (filter.startsWith("c:")) list = list.filter(x => x.category === filter.slice(2));
  const cmp = { title: (a, b) => a.title.localeCompare(b.title), updated: (a, b) => b.updated - a.updated, used: (a, b) => (b.used || 0) - (a.used || 0), created: (a, b) => b.created - a.created }[sort];
  return list.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || cmp(a, b));
}
function render() {
  if (view === "home") return renderHome();
  if (view === "notes") return renderNotes();
  if (view === "tasks") return renderTasks();
  $("note-editor").classList.add("hidden");
  const list = visibleList();
  if (!list.some(x => x.id === selectedId)) selectedId = null;
  // запись выбирается кликом — модалка не открывается автоматически
  $("list-count").textContent = list.length + " " + T(plural(list.length, "запись", "записи", "записей"), list.length === 1 ? "entry" : "entries");
  const att = attentionSet();
  $("list").innerHTML = list.length ? list.map((x, i) => `
    <div class="row${x.id === selectedId ? " active" : ""}" data-id="${esc(x.id)}">
      <span class="ava">${esc(initial(x.title))}</span>
      <span class="t"><b>${esc(x.title)}</b><small${expiringSoon(x) ? ' class="exp-soon"' : ""}>${esc(subline(x))}</small></span>
      ${att.has(x.id) ? `<span class="row-warn" title="${T("Требует внимания", "Needs attention")}"></span>` : ""}
      ${(x.type === "login" && parseTotp(x.totp)) ? `<span class="row-totp" data-totp="${esc(x.id)}" data-copy-totp title="${T("Код 2FA — скопировать", "2FA code — copy")}"><span class="totp-code code">···&nbsp;···</span><span class="left"></span></span>` : ""}
      ${x.login ? `<button type="button" class="row-copy" data-copy-login aria-label="${T("Скопировать логин", "Copy login")}" title="${T("Скопировать логин", "Copy login")}"><svg class="ic"><use href="#i-copy"/></svg></button>` : ""}
      ${x.fav ? `<svg class="ic fav"><use href="#i-star"/></svg>` : ""}
    </div>`).join("") : `<div class="empty">${filter === "trash" ? T("Корзина пуста", "Trash is empty") : filter === "attention" ? T("Всё в порядке — проблемных паролей нет", "All good — no problem passwords") : live().length ? T("Ничего не найдено", "Nothing found") : T("Сейф пока пуст. Нажмите «+ Добавить».", "The safe is empty. Click “+ Add”.")}</div>`;
  $("list").querySelectorAll(".row").forEach((r, i) => r.style.animationDelay = Math.min(i, 8) * 0.04 + "s");
  if ($("form-card").classList.contains("hidden")) renderDetail();
}
function plural(n, one, few, many) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }
$("search").oninput = () => { if (view === "home" && $("search").value) { view = "vault"; filter = "all"; setViewChrome("vault"); renderNav(); } render(); };
$("sort").onchange = render;
$("list").onclick = async e => {
  if (view === "home") {
    const dv = e.target.closest("[data-view]"); if (dv) { setView(dv.dataset.view); return; }
    const df = e.target.closest("[data-filter]"); if (df) { view = "vault"; filter = df.dataset.filter; setViewChrome("vault"); renderNav(); render(); scrollTo(0, 0); return; }
    const op = e.target.closest("[data-open]"); if (op) { view = "vault"; filter = "all"; selectedId = op.dataset.open; setViewChrome("vault"); renderNav(); render(); clearForm(); showDetail(); $("v-vault").classList.add("show-detail"); $("detail").scrollTop = 0; return; }
    return;
  }
  if (view === "tasks") {
    const row = e.target.closest(".task-row"); if (!row) return;
    const x = tasksList().find(t => t.id === row.dataset.id); if (!x) return;
    if (e.target.closest("[data-task-toggle]")) { x.done = !x.done; x.updated = Date.now(); await persist(); renderNav(); renderTasks(); }
    else if (e.target.closest("[data-task-del]")) { x.deletedAt = Date.now(); await persist(); renderNav(); renderTasks(); }
    else if (e.target.closest("[data-task-pri]")) { x.priority = ((x.priority || 0) + 1) % 4; x.updated = Date.now(); await persist(); renderTasks(); }
    else if (e.target.closest("[data-task-cal]")) { const di = row.querySelector(".task-date"); di.showPicker ? di.showPicker() : di.focus(); }
    else if (e.target.closest(".task-text")) { startRenameTask(row, x); }
    return;
  }
  if (view === "notes") {
    const r = e.target.closest(".note-row"); if (!r) return;
    selectedId = r.dataset.id; $("v-vault").classList.add("show-detail"); $("detail").scrollTop = 0; renderNotes();
    return;
  }
  const r = e.target.closest(".row"); if (!r) return;
  if (e.target.closest("[data-copy-totp]")) { const xt = entries.find(y => y.id === r.dataset.id); const cfg = xt && parseTotp(xt.totp); if (cfg) totpCode(cfg).then(rr => { copySecret(rr.code); markUsed(xt); }); return; }
  if (e.target.closest("[data-copy-login]")) { const xi = entries.find(y => y.id === r.dataset.id); if (xi && xi.login) { copySecret(xi.login); markUsed(xi); } return; }
  selectedId = r.dataset.id; clearForm(); showDetail();
  $("list").querySelectorAll(".row").forEach(x => x.classList.toggle("active", x.dataset.id === selectedId));
  $("v-vault").classList.add("show-detail"); $("detail").scrollTop = 0;
};
const ib = (act, icon, label) => `<button type="button" class="ib" data-act="${act}" aria-label="${esc(label)}" title="${esc(label)}"><svg class="ic"><use href="#${icon}"/></svg></button>`;
function field(label, valueHtml, actions = "", cls = "") { return `<p class="d-label">${label}</p><div class="d-field ${cls}"><span>${valueHtml}</span>${actions}</div>`; }
function renderDetail() {
  const x = entries.find(y => y.id === selectedId), box = $("detail-view");
  if (!x) {
    box.innerHTML = `<div class="d-empty"><svg class="ic accent"><use href="#i-logo"/></svg><div>${entries.length ? T("Выберите запись слева", "Select an entry") : T("Добавьте первую запись — она будет зашифрована на этом устройстве.", "Add your first entry — it will be encrypted on this device.")}</div>${entries.length ? "" : `<button data-act="new">${T("+ Добавить", "+ Add")}</button>`}</div>`;
    return;
  }
  const show = T("Показать", "Show"), copy = T("Скопировать", "Copy"), dots = '<span class="dots">••••••••••••</span>';
  const changed = new Date(x.updated || x.created).toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long", year: "numeric" });
  let h = `<div class="d-head"><button class="ib back" data-detail-back aria-label="${T("Назад", "Back")}"><svg class="ic"><use href="#i-back"/></svg></button>
    <span class="ava">${esc(initial(x.title))}</span><div><h2 class="d-title">${esc(x.title)}</h2><span class="d-meta">${TYPE_NAME(x.type)} · ${T("Изменено ", "Changed ")}${changed}</span></div></div>`;
  if (x.login) h += field(x.type === "card" ? T("Владелец", "Cardholder") : T("Логин", "Login"), esc(x.login), ib("copy-login", "i-copy", copy));
  if (x.type === "card" && x.number) {
    h += field(T("Номер карты", "Card number"), `<span data-secret="number">${esc(maskCard(x.number))}</span>`, ib("show", "i-eye", show) + ib("copy-number", "i-copy", copy));
    if (x.exp || x.cvv) h += `<div class="two">${x.exp ? `<div>${field(T("Срок", "Expiry"), esc(x.exp))}</div>` : ""}${x.cvv ? `<div>${field("CVV", `<span data-secret="cvv">•••</span>`)}</div>` : ""}</div>`;
  }
  if (x.pass) {
    const st = strength(x.pass);
    h += field(x.type === "card" ? "PIN" : T("Пароль", "Password"), `<span data-secret="pass">${dots}</span>`, ib("show", "i-eye", show) + ib("copy", "i-copy", copy));
    if (x.type !== "card") h += `<div class="d-strength"><span class="bar"><span data-s="${st.score}"></span></span>${st.label}</div>`;
  }
  const cfg = x.type === "login" && parseTotp(x.totp);
  if (cfg) h += field(T("Код 2FA", "2FA code"), `<span data-totp="${esc(x.id)}"><span class="totp-code code">··· ···</span></span>`, `<span class="totp-left left" data-totp-left></span>` + ib("copy-totp", "i-copy", copy));
  if (x.url) h += field(T("Сайт", "Website"), `<a data-act="open">${esc(x.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a>`, ib("open", "i-ext", T("Открыть", "Open")));
  (EXTRA[x.type] || []).forEach(f => {
    const v = (x.f || {})[f.k]; if (!v) return;
    if (f.s) h += field(exLabel(f), `<span data-secret="f:${f.k}">${dots}</span>`, ib("show", "i-eye", show) + ib("copy-f:" + f.k, "i-copy", copy), f.m ? "note" : "");
    else if (f.d) { const dt = new Date(v + "T12:00:00"), soon = f.k === "expires" && expiringSoon(x);
      h += field(exLabel(f), `<span${soon ? ' class="exp-soon"' : ""}>${esc(dt.toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long", year: "numeric" }))}${soon ? (dt < Date.now() ? T(" · истёк", " · expired") : T(" · скоро истекает", " · expires soon")) : ""}</span>`); }
    else h += field(exLabel(f), esc(v), f.c ? ib("copy-f:" + f.k, "i-copy", copy) : "", (f.m ? "note " : "") + (f.mono ? "mono" : ""));
  });
  if (x.type === "card" && expiringSoon(x)) h += `<p class="trash-note">${expiryOf(x) < Date.now() ? T("Срок действия карты истёк.", "This card has expired.") : T("Срок действия карты скоро закончится.", "This card expires soon.")}</p>`;
  if (x.note) h += field(T("Заметки", "Notes"), esc(x.note), "", "note");
  (x.custom || []).forEach((c, i) => {
    if (c.s) h += field(esc(c.k), `<span data-secret="c:${i}">${dots}</span>`, ib("show", "i-eye", show) + ib("copy-c:" + i, "i-copy", copy));
    else h += field(esc(c.k), esc(c.v), ib("copy-c:" + i, "i-copy", copy));
  });
  if (x.history && x.history.length) h += `<details class="hist"><summary>${T("История паролей", "Password history")} (${x.history.length})</summary>` +
    x.history.map((hh, i) => `<div class="d-field"><span data-secret="h:${i}">${dots}</span><small>${esc(new Date(hh.at).toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU"))}</small>${ib("show", "i-eye", show)}${ib("copy-h:" + i, "i-copy", copy)}</div>`).join("") + `</details>`;
  if (x.category) h += `<span class="d-tag">${esc(x.category)}</span>`;
  if (x.deletedAt) {
    h += `<p class="trash-note">${T("Запись в корзине. Она удалится навсегда ", "This entry is in the trash. It will be deleted for good on ")}${new Date(x.deletedAt + TRASH_DAYS * 864e5).toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "long" })}.</p>` +
      `<div class="d-btns"><button data-act="restore">${T("Восстановить", "Restore")}</button><button class="danger" data-act="purge">${T("Удалить навсегда", "Delete forever")}</button></div>`;
  } else
  h += `<div class="d-btns"><button class="ghost" data-act="edit">${T("Изменить", "Edit")}</button><button class="ghost" data-act="fav">${x.fav ? T("Убрать из избранного", "Unfavorite") : T("В избранное", "Favorite")}</button><button class="danger" data-act="del">${T("В корзину", "Move to trash")}</button></div>`;
  const cp = $("copied"); $("detail").appendChild(cp); cp.classList.add("hidden");
  box.innerHTML = h;
  // таймер TOTP пишет в .code и .left: привязываем элемент обратного отсчёта
  const t = box.querySelector("[data-totp]"); if (t) { t.appendChild(box.querySelector("[data-totp-left]")); }
  tickTotp();
}
function decryptInto(el, text) {
  el.innerHTML = ""; el.classList.add("revealed");
  [...text].forEach((ch, i) => { const sp = document.createElement("span"); sp.className = "dc"; sp.textContent = ch; sp.style.animationDelay = Math.min(i, 24) * 0.05 + "s"; el.appendChild(sp); });
}
async function copySecret(text) {
  try { await navigator.clipboard.writeText(text); } catch { toast(T("Не удалось скопировать", "Copy failed")); return; }
  const box = $("copied"), tm = $("copy-timer");
  if (!$("v-vault").classList.contains("hidden") && !$("detail-view").classList.contains("hidden")) {
    // плашка с таймером над карточкой
    $("detail-view").querySelector(".d-head")?.after(box);
    box.classList.remove("hidden"); tm.classList.remove("run"); void tm.getBoundingClientRect(); tm.classList.add("run");
  } else toast(T("Скопировано. Буфер очистится через 30 с", "Copied. Clipboard clears in 30 s"));
  clearTimeout(copySecret.t);
  copySecret.t = setTimeout(() => { navigator.clipboard.writeText("").catch(() => {}); box.classList.add("hidden"); tm.classList.remove("run"); }, 30000);
}
async function markUsed(x) { x.used = Date.now(); await persist(); }
$("detail-view").onclick = async e => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const act = btn.dataset.act;
  if (act === "new") { clearForm(); showForm(); return; }
  const x = entries.find(y => y.id === selectedId); if (!x) return;
  if (act === "show") {
    const box = btn.closest(".d-field"), s = box.querySelector("[data-secret]");
    const open = s.dataset.open === "1"; s.dataset.open = open ? "" : "1";
    if (s.dataset.secret === "pass") { if (open) s.innerHTML = '<span class="dots">••••••••••••</span>'; else decryptInto(s, x.pass); }
    const sk = s.dataset.secret;
    if (sk.startsWith("f:") || sk.startsWith("h:") || sk.startsWith("c:")) {
      const val = sk.startsWith("f:") ? (x.f || {})[sk.slice(2)] : sk.startsWith("h:") ? x.history[+sk.slice(2)].pass : (x.custom || [])[+sk.slice(2)].v;
      if (open) s.innerHTML = '<span class="dots">••••••••••••</span>'; else decryptInto(s, val);
    }
    if (s.dataset.secret === "number") {
      if (open) s.textContent = maskCard(x.number); else decryptInto(s, x.number);
      const c = $("detail-view").querySelector('[data-secret="cvv"]'); if (c) c.textContent = open ? "•••" : x.cvv;
    }
  }
  if (act === "copy") { await copySecret(x.pass); markUsed(x); }
  if (act === "copy-login") await copySecret(x.login);
  if (act.startsWith("copy-f:")) { await copySecret((x.f || {})[act.slice(7)]); markUsed(x); }
  if (act.startsWith("copy-h:")) await copySecret(x.history[+act.slice(7)].pass);
  if (act.startsWith("copy-c:")) { await copySecret((x.custom || [])[+act.slice(7)].v); markUsed(x); }
  if (act === "restore") { delete x.deletedAt; await persist(); filter = "all"; renderNav(); render(); toast(T("Запись восстановлена", "Entry restored")); }
  if (act === "purge" && await confirmBox(T("Удалить «", "Delete “") + x.title + T("» навсегда? Это нельзя отменить.", "” forever? This cannot be undone."), T("Удалить навсегда", "Delete forever"), true)) {
    entries = entries.filter(y => y !== x); selectedId = null; await persist(); renderNav(); render(); $("v-vault").classList.remove("show-detail");
  }
  if (act === "copy-number") await copySecret(x.number.replace(/\s/g, ""));
  if (act === "copy-totp") { const r = await totpCode(parseTotp(x.totp)); await copySecret(r.code); markUsed(x); }
  if (act === "open") { const u = safeUrl(x.url); if (u) { window.open(u, "_blank", "noopener,noreferrer"); markUsed(x); } }
  if (act === "fav") { x.fav = !x.fav; await persist(); renderNav(); render(); }
  if (act === "edit") startEdit(x);
  if (act === "del") {
    x.deletedAt = Date.now(); selectedId = null; await persist(); renderNav(); render(); $("v-vault").classList.remove("show-detail");
    toast(T("Перемещено в корзину на 30 дней", "Moved to trash for 30 days"));
  }
};

function openVaultView() {
  const s = store.get();
  $("vault-name").textContent = s.name || T("Профиль", "Profile");
  $("vault-avatar").textContent = initial(s.name);
  view = "home"; setViewChrome("home");
  clearForm(); $("form-card").classList.add("hidden"); $("detail-view").classList.remove("hidden"); $("note-editor").classList.add("hidden"); $("v-vault").classList.remove("show-detail");
  if (purgeTrash()) persist();
  renderNav(); render(); show("vault"); resetIdle();
}

/* ---------------- Заметки и Задачи (воркспейс в стиле Notion) ---------------- */
function setViewChrome(v) {
  $("b-new-entry").textContent = v === "notes" ? T("+ Заметка", "+ Note") : v === "tasks" ? T("+ Задача", "+ Task") : T("+ Добавить", "+ Add");
  $("sort").classList.toggle("hidden", v !== "vault");
  $("search").placeholder = v === "notes" ? T("Поиск заметок", "Search notes") : v === "tasks" ? T("Поиск задач", "Search tasks") : T("Поиск по хранилищу", "Search the vault");
  const head = $("ws-head"); if (head) head.classList.toggle("hidden", !(v === "notes" || v === "tasks"));
  const vv = $("v-vault"); if (vv) { vv.classList.remove("ws-notes", "ws-tasks", "ws-home"); if (v === "notes") vv.classList.add("ws-notes"); else if (v === "tasks") vv.classList.add("ws-tasks"); else if (v === "home") vv.classList.add("ws-home"); }
}
function setView(v) {
  view = v; selectedId = null; $("search").value = ""; setViewChrome(v);
  if (v !== "vault") { $("detail-view").classList.add("hidden"); $("form-card").classList.add("hidden"); }
  renderNav(); render();
}
/* Hero-панель раздела в стиле «Дизайн 34»: светлая карточка, крупный заголовок, чипы */
let taskFilter = "all";
function wsHero(title, sub, chips) {
  const h = $("ws-head"); if (!h) return;
  h.innerHTML = `<section class="ws-hero"><div class="ws-hero-l"><span class="ws-hero-sub">${sub}</span><h1 class="ws-hero-t">${title}</h1></div>${chips ? `<div class="ws-chips">${chips}</div>` : ""}</section>`;
}
$("ws-head") && $("ws-head").addEventListener("click", e => {
  const c = e.target.closest("[data-task-filter]"); if (!c) return;
  taskFilter = c.dataset.taskFilter; renderTasks();
});
/* ---------------- Домашний экран «Обзор» (стиль 34) ---------------- */
function greet() { const h = new Date().getHours(); return h < 6 ? T("Доброй ночи", "Good night") : h < 12 ? T("Доброе утро", "Good morning") : h < 18 ? T("Добрый день", "Good afternoon") : T("Добрый вечер", "Good evening"); }
function relTime(ts) { if (!ts) return ""; const d = new Date(ts), now = new Date(); if (d.toDateString() === now.toDateString()) return T("сегодня", "today"); if (d.toDateString() === new Date(now - 864e5).toDateString()) return T("вчера", "yesterday"); return d.toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "short" }); }
function scoreData() {
  const wp = live().filter(x => x.pass && x.type !== "card");
  const c = {}; wp.forEach(x => c[x.pass] = (c[x.pass] || 0) + 1);
  const weak = wp.filter(x => strength(x.pass).score < 3), reused = wp.filter(x => c[x.pass] > 1);
  const oldp = wp.filter(x => Date.now() - (x.pwChanged || x.created) > 365 * 864e5), leaked = wp.filter(x => (breached.get(x.id) || 0) > 0);
  const bad = new Set([...weak, ...reused, ...oldp, ...leaked]).size;
  return { score: wp.length ? Math.round(100 * (1 - bad / wp.length)) : 100, total: live().length, weak: weak.length, leaked: leaked.length };
}
function renderHome() {
  $("note-editor").classList.add("hidden"); $("detail-view").classList.add("hidden"); $("form-card").classList.add("hidden"); $("v-vault").classList.remove("show-detail");
  const s = store.get(), d = scoreData(), L = live();
  const dateStr = new Date().toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { weekday: "long", day: "numeric", month: "long" });
  const name = (s.name || "").trim();
  const cnt = t => L.filter(x => x.type === t).length;
  const cats = [{ n: T("Логины", "Logins"), k: cnt("login"), f: "t:login" }, { n: T("Карты", "Cards"), k: cnt("card"), f: "t:card" }, { n: "Wi-Fi", k: cnt("wifi"), f: "t:wifi" }, { n: T("Заметки", "Notes"), k: notesList().length, v: "notes" }];
  const shapes = ["40% 60% 50% 50%", "60% 40% 30% 70%", "50% 50% 60% 40%", "35% 65% 45% 55%"];
  const catHtml = cats.map((c, i) => `<a class="dash-cat" ${c.v ? `data-view="${c.v}"` : `data-filter="${c.f}"`}><span class="dash-cat-blob" style="border-radius:${shapes[i]}"></span><span class="dash-cat-top"><span class="dash-cat-n">${esc(c.n)}</span><span class="dash-cat-k">${c.k} ${T("шт.", "items")}</span></span><span class="dash-cat-go">›</span></a>`).join("");
  const recent = L.filter(x => x.used || x.updated !== x.created).sort((a, b) => Math.max(b.used || 0, b.updated) - Math.max(a.used || 0, a.updated)).slice(0, 5);
  const recentHtml = recent.length ? recent.map(x => `<a class="dash-rec" data-open="${esc(x.id)}"><span class="dash-rec-ava">${esc(initial(x.title))}</span><span class="dash-rec-n">${esc(x.title)}</span><span class="dash-rec-u">${esc(subline(x))}</span><span class="dash-rec-t">${esc(relTime(Math.max(x.used || 0, x.updated)))}</span></a>`).join("") : `<div class="dash-empty">${T("Пока пусто", "Nothing yet")}</div>`;
  const stat = (k, v, col) => `<div class="dash-stat"><span class="dash-stat-k">${k}</span><span class="dash-stat-v" style="color:${col}">${v}</span></div>`;
  $("list").innerHTML = `
    <section class="dash-hero">
      <div class="dash-hero-l"><span class="dash-date">${esc(dateStr)}</span><h1 class="dash-greet">${esc(greet())}${name ? ", " + esc(name) : ""}</h1></div>
      <div class="dash-cards">
        <div class="dash-score"><div class="dash-score-l"><span class="dash-stat-k">${T("Защита сегодня", "Protection today")}</span><span class="dash-score-v">${d.score} <span>%</span></span></div><span class="dash-dial"><span class="dash-dial-dot"></span></span></div>
        ${stat(T("Записей", "Entries"), d.total, "#111")}${stat(T("Слабые", "Weak"), d.weak, d.weak ? "#C27A1A" : "#111")}${stat(T("Утечки", "Leaks"), d.leaked, d.leaked ? "#C8333A" : "#111")}
      </div>
    </section>
    <h2 class="dash-h2">${T("Категории", "Categories")}</h2>
    <div class="dash-cats">${catHtml}</div>
    <h2 class="dash-h2">${T("Недавние", "Recent")}</h2>
    <div class="dash-recent">${recentHtml}</div>`;
}

/* ---- Markdown (безопасный: экранируем, затем расставляем свои теги) ---- */
function mdInline(s) {
  s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/`([^`]+)`/g, (m, c) => `<code>${c}</code>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  return s;
}
function mdToHtml(src) {
  const escC = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = (src || "").replace(/\r/g, "").split("\n");
  let html = "", i = 0, listTag = null, cbIndex = 0;
  const closeList = () => { if (listTag) { html += `</${listTag}>`; listTag = null; } };
  while (i < lines.length) {
    const ln = lines[i];
    if (/^```/.test(ln)) { let code = ""; i++; while (i < lines.length && !/^```/.test(lines[i])) { code += lines[i] + "\n"; i++; } i++; closeList(); html += `<pre><code>${escC(code)}</code></pre>`; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(ln)) { closeList(); html += "<hr>"; i++; continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; i++; continue; }
    const cb = ln.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (cb) { if (listTag !== "ul") { closeList(); html += '<ul class="md-check">'; listTag = "ul"; } const d = cb[1].toLowerCase() === "x"; html += `<li class="md-task${d ? " done" : ""}"><span class="md-box" data-cb="${cbIndex++}">${d ? "✓" : ""}</span><span>${mdInline(cb[2])}</span></li>`; i++; continue; }
    const ul = ln.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (listTag !== "ul") { closeList(); html += "<ul>"; listTag = "ul"; } html += `<li>${mdInline(ul[1])}</li>`; i++; continue; }
    const ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) { if (listTag !== "ol") { closeList(); html += "<ol>"; listTag = "ol"; } html += `<li>${mdInline(ol[1])}</li>`; i++; continue; }
    const q = ln.match(/^>\s?(.*)$/);
    if (q) { closeList(); html += `<blockquote>${mdInline(q[1])}</blockquote>`; i++; continue; }
    if (/^\s*$/.test(ln)) { closeList(); i++; continue; }
    closeList(); let para = ln; i++;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6}\s|```|>\s?|\s*[-*]\s|\s*\d+\.\s|(-{3,}|\*{3,})\s*$)/.test(lines[i])) { para += "\n" + lines[i]; i++; }
    html += `<p>${mdInline(para).replace(/\n/g, "<br>")}</p>`;
  }
  closeList();
  return html;
}

/* Заметки — тип "page": заголовок + текст (Markdown), автосохранение, режимы правки/просмотра */
let noteMode = "preview";
function renderNotes() {
  const all = notesList(), q = $("search").value.toLowerCase();
  const list = all.filter(x => (x.title + " " + (x.body || "")).toLowerCase().includes(q)).sort((a, b) => b.updated - a.updated);
  if (!list.some(x => x.id === selectedId)) selectedId = null;
  // запись выбирается кликом — модалка не открывается автоматически
  const cnt = all.length + " " + T(plural(all.length, "заметка", "заметки", "заметок"), all.length === 1 ? "note" : "notes");
  $("list-count").textContent = cnt;
  wsHero(T("Заметки", "Notes"), all.length ? cnt : T("Зашифрованы на устройстве", "Encrypted on device"), "");
  $("list").innerHTML = list.length ? list.map(x => `
    <div class="note-row${x.id === selectedId ? " active" : ""}" data-id="${esc(x.id)}">
      <b>${esc(x.title || T("Без названия", "Untitled"))}</b>
      <small>${esc((x.body || "").replace(/[#*`>\-\[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 70)) || T("Пустая заметка", "Empty note")}</small>
    </div>`).join("") : `<div class="empty">${all.length ? T("Ничего не найдено", "Nothing found") : T("Заметок пока нет. Нажмите «+ Заметка».", "No notes yet. Click “+ Note”.")}</div>`;
  renderNoteEditor();
}
async function newNote() {
  const now = Date.now(), id = b64(rand(9));
  entries.push({ type: "page", id, title: "", body: "", created: now, updated: now });
  selectedId = id; noteMode = "edit"; await persist(); renderNav(); renderNotes();
  $("v-vault").classList.add("show-detail"); setTimeout(() => $("note-title") && $("note-title").focus(), 60);
}
async function saveNoteCore() {
  const x = notesList().find(y => y.id === selectedId); if (!x) return;
  if ($("note-title")) x.title = $("note-title").value;
  if ($("note-body")) x.body = $("note-body").value;
  x.updated = Date.now(); await persist();
  const b = $("list").querySelector(`.note-row[data-id="${CSS.escape(selectedId)}"] b`); if (b) b.textContent = x.title || T("Без названия", "Untitled");
  const st = $("note-saved"); if (st) st.textContent = T("Сохранено", "Saved");
}
const saveNote = debounce(saveNoteCore, 400);
function renderNoteEditor() {
  const ed = $("note-editor"); ed.classList.remove("hidden");
  $("detail-view").classList.add("hidden"); $("form-card").classList.add("hidden");
  const x = notesList().find(y => y.id === selectedId);
  if (!x) { ed.innerHTML = `<div class="d-empty"><svg class="ic accent"><use href="#i-logo"/></svg><div>${notesList().length ? T("Выберите заметку слева", "Select a note") : T("Создайте первую заметку — она будет зашифрована.", "Create your first note — it will be encrypted.")}</div>${notesList().length ? "" : `<button data-new-note>${T("+ Заметка", "+ Note")}</button>`}</div>`; return; }
  const edit = noteMode === "edit";
  ed.innerHTML = `<div class="note-ed">
    <div class="note-bar">
      <button class="ib back" data-note-back aria-label="${T("Назад", "Back")}"><svg class="ic"><use href="#i-back"/></svg></button>
      <div class="note-modes"><button class="seg${edit ? " on" : ""}" data-note-mode="edit">${T("✏ Правка", "✏ Edit")}</button><button class="seg${edit ? "" : " on"}" data-note-mode="preview">${T("👁 Просмотр", "👁 Preview")}</button></div>
      <button class="seg-done" data-note-done>${T("Готово", "Done")}</button><button class="ib danger-text" data-note-del>${T("Удалить", "Delete")}</button>
    </div>
    <input id="note-title" class="note-title" maxlength="120" placeholder="${T("Без названия", "Untitled")}">
    ${edit ? `<textarea id="note-body" class="note-body" placeholder="${T("Пишите здесь… Поддерживается Markdown: # заголовок, **жирный**, - список, - [ ] задача", "Write here… Markdown supported: # heading, **bold**, - list, - [ ] task")}" spellcheck="true"></textarea>`
      : `<div class="note-view md" id="note-view">${mdToHtml(x.body) || `<p class="muted">${T("Пусто. Нажмите «Правка».", "Empty. Click “Edit”.")}</p>`}</div>`}
    <div class="note-foot"><span class="muted small" id="note-saved">${T("Изменено ", "Edited ") + new Date(x.updated).toLocaleString()}</span></div>
  </div>`;
  $("note-title").value = x.title; $("note-title").oninput = saveNote;
  if (edit) { $("note-body").value = x.body || ""; $("note-body").oninput = saveNote; }
}
$("note-editor").addEventListener("click", async e => {
  if (e.target.closest("[data-new-note]")) return newNote();
  if (e.target.closest("[data-note-back],[data-note-done]")) { await saveNoteCore(); $("v-vault").classList.remove("show-detail"); return; }
  const mb = e.target.closest("[data-note-mode]"); if (mb) { noteMode = mb.dataset.noteMode; renderNoteEditor(); return; }
  const box = e.target.closest(".md-box"); // клик по чекбоксу в режиме просмотра — переключает в тексте
  if (box) {
    const x = notesList().find(y => y.id === selectedId); if (!x) return;
    let n = +box.dataset.cb, k = -1;
    x.body = x.body.replace(/^(\s*[-*]\s+\[)([ xX])(\]\s+)/gm, (m, a, c, b2) => { k++; return k === n ? a + (c.toLowerCase() === "x" ? " " : "x") + b2 : m; });
    x.updated = Date.now(); await persist(); renderNoteEditor(); return;
  }
  if (e.target.closest("[data-note-del]")) {
    const x = notesList().find(y => y.id === selectedId); if (!x) return;
    if (await confirmBox(T("Удалить заметку?", "Delete this note?"), T("Удалить", "Delete"), true)) { x.deletedAt = Date.now(); selectedId = null; await persist(); renderNav(); renderNotes(); $("v-vault").classList.remove("show-detail"); }
  }
});

/* Задачи — тип "task": текст, галочка, приоритет, срок */
const PRI = () => [{ l: "", c: "" }, { l: T("Низкий", "Low"), c: "low" }, { l: T("Средний", "Medium"), c: "med" }, { l: T("Высокий", "High"), c: "high" }];
function renderTasks() {
  $("detail-view").classList.add("hidden"); $("form-card").classList.add("hidden"); $("note-editor").classList.add("hidden");
  $("v-vault").classList.remove("show-detail");
  const all = tasksList(), q = $("search").value.toLowerCase();
  const list = all.filter(x => (x.title || "").toLowerCase().includes(q)).sort((a, b) =>
    (a.done ? 1 : 0) - (b.done ? 1 : 0) || (b.priority || 0) - (a.priority || 0) ||
    ((a.due || "9999") < (b.due || "9999") ? -1 : (a.due || "9999") > (b.due || "9999") ? 1 : 0) || b.created - a.created);
  const done = all.filter(x => x.done).length, pr = PRI();
  const subc = (all.length - done) + " " + T("активных", "active") + (done ? ` · ${done} ${T("выполнено", "done")}` : "");
  $("list-count").textContent = subc;
  const chip = (k, ru, en) => `<button class="ws-chip${taskFilter === k ? " on" : ""}" data-task-filter="${k}">${T(ru, en)}</button>`;
  wsHero(T("Задачи", "Tasks"), subc, chip("all", "Все", "All") + chip("today", "Сегодня", "Today") + chip("done", "Выполненные", "Done"));
  const todayISO = new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const shown = taskFilter === "done" ? list.filter(x => x.done)
    : taskFilter === "today" ? list.filter(x => !x.done && x.due === todayISO) : list;
  $("list").innerHTML = `<div class="task-add"><input id="task-new" class="field" maxlength="200" placeholder="${T("Новая задача…", "New task…")}"></div>` +
    (shown.length ? shown.map((x, i) => {
      const divider = x.done && (i === 0 || !shown[i - 1].done) ? `<div class="task-divider">${T("Выполнено", "Done")}</div>` : "";
      return divider + (() => {
      const p = pr[x.priority || 0], overdue = !x.done && x.due && new Date(x.due + "T23:59") < Date.now();
      return `<div class="task-row${x.done ? " done" : ""}" data-id="${esc(x.id)}">
        <button class="task-check" data-task-toggle aria-label="${T("Готово", "Done")}">${x.done ? "✓" : ""}</button>
        <button class="task-pri ${p.c}" data-task-pri title="${T("Приоритет", "Priority")}: ${p.l || T("нет", "none")}">⚑</button>
        <span class="task-text">${esc(x.title)}</span>
        <button class="task-cal" data-task-cal title="${T("Срок", "Due date")}">${x.due ? `<span class="task-due${overdue ? " overdue" : ""}">${new Date(x.due + "T12:00").toLocaleDateString(lang === "en" ? "en-GB" : "ru-RU", { day: "numeric", month: "short" })}</span>` : "🗓"}</button>
        <input type="date" class="task-date" value="${esc(x.due || "")}">
        <button class="ib task-del" data-task-del aria-label="×">✕</button>
      </div>`;
      })();
    }).join("") : `<div class="empty">${all.length ? T("Ничего не найдено", "Nothing found") : T("Задач пока нет. Напишите задачу и нажмите Enter.", "No tasks yet. Type one and press Enter.")}</div>`);
  const inp = $("task-new");
  inp.onkeydown = async e => {
    if (e.key === "Enter" && inp.value.trim()) {
      const now = Date.now();
      entries.push({ type: "task", id: b64(rand(9)), title: inp.value.trim(), done: false, priority: 0, due: "", created: now, updated: now });
      await persist(); renderNav(); renderTasks(); setTimeout(() => $("task-new") && $("task-new").focus(), 30);
    }
  };
  $("list").querySelectorAll(".task-date").forEach(di => di.onchange = async () => {
    const x = tasksList().find(t => t.id === di.closest(".task-row").dataset.id); if (!x) return;
    x.due = di.value; x.updated = Date.now(); await persist(); renderTasks();
  });
}
function startRenameTask(row, x) {
  const span = row.querySelector(".task-text");
  const inp = document.createElement("input"); inp.className = "task-rename"; inp.value = x.title; inp.maxLength = 200;
  span.replaceWith(inp); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  const save = async () => { const v = inp.value.trim(); if (v && v !== x.title) { x.title = v; x.updated = Date.now(); await persist(); } renderTasks(); };
  inp.onkeydown = e => { if (e.key === "Enter") inp.blur(); if (e.key === "Escape") { inp.value = x.title; inp.blur(); } };
  inp.onblur = save;
}

/* ---------------- Настройки: смена пароля, имя ---------------- */
$("b-settings").onclick = () => { $("rename").value = store.get().name || ""; $("cp-err").textContent = ""; show("settings"); };
$("b-switch").onclick = () => lock();
$("b-cp").onclick = async e => {
  const s = store.get(), oldPw = $("cp-old").value, p1 = $("cp-new1").value, p2 = $("cp-new2").value;
  const bad = checkNewPassword(p1, p2); if (bad) { $("cp-err").textContent = bad; return; }
  busy(e.target, true, T("Проверяю…", "Checking…"));
  try {
    const raw = await open(await wrapKeyFrom(oldPw, s), s.wrapped); // проверка текущего пароля и получение ключа заново
    Object.assign(s, await wrapVaultKeyRaw(raw, p1)); raw.fill(0); store.set(s);
    ["cp-old", "cp-new1", "cp-new2"].forEach(id => $(id).value = ""); meterCp();
    toast(T("Пароль изменён", "Password changed")); openVaultView();
  } catch { $("cp-err").textContent = T("Текущий пароль неверный", "Current password is wrong"); }
  busy(e.target, false, "");
};
$("b-rename").onclick = () => { const s = store.get(), n = $("rename").value.trim(); if (!n) return; s.name = n; store.set(s); toast(T("Сохранено", "Saved")); openVaultView(); };

/* ---------------- Аудит ---------------- */
let breached = new Map();
function audit() {
  const withPass = live().filter(x => x.pass && x.type !== "card");
  const counts = {}; withPass.forEach(x => counts[x.pass] = (counts[x.pass] || 0) + 1);
  const weak = withPass.filter(x => strength(x.pass).score < 3);
  const reused = withPass.filter(x => counts[x.pass] > 1);
  const old = withPass.filter(x => Date.now() - (x.pwChanged || x.created) > 365 * 864e5);
  const leaked = withPass.filter(x => breached.get(x.id) > 0);
  const sec = (title, list, why) => `<h3>${title} <span class="count${list.length ? " bad" : ""}">${list.length}</span></h3>` +
    (list.length ? `<div>${list.map(x => `<div class="mini"><div><b>${esc(x.title)}</b><small>${esc(why(x))}</small></div><button class="ghost" data-audit-edit="${esc(x.id)}">${T("Изменить", "Edit")}</button></div>`).join("")}</div>`
      : `<p class="muted small">${T("Всё в порядке", "All good")}</p>`);
  const score = withPass.length ? Math.round(100 * (1 - new Set([...weak, ...reused, ...old, ...leaked]).size / withPass.length)) : 100;
  $("audit-body").innerHTML = `<div class="score"><b>${score}</b><span>${T("из 100 — общая оценка", "out of 100 — overall score")}</span></div>` +
    sec(T("Найдены в утечках", "Found in breaches"), leaked, x => T("Встречался в утечках ", "Seen in breaches ") + breached.get(x.id).toLocaleString() + T(" раз — смените срочно", " times — change it now")) +
    sec(T("Слабые пароли", "Weak passwords"), weak, x => strength(x.pass).label) +
    sec(T("Повторяющиеся", "Reused"), reused, x => T("Используется в ", "Used in ") + counts[x.pass] + T(" записях", " entries")) +
    sec(T("Старше года", "Older than a year"), old, x => T("Не менялся с ", "Not changed since ") + new Date(x.pwChanged || x.created).toLocaleDateString());
}
$("b-audit").onclick = () => { audit(); show("audit"); };
$("audit-body").onclick = e => { const id = e.target.dataset.auditEdit; if (!id) return; openVaultView(); selectedId = id; render(); startEdit(entries.find(x => x.id === id)); };
$("b-hibp").onclick = async e => {
  const list = live().filter(x => x.pass && x.type !== "card");
  if (!list.length) return;
  if (!await confirmBox(T("Для проверки будут отправлены первые 5 символов SHA-1-хеша каждого пароля на api.pwnedpasswords.com. Сами пароли не отправляются. Продолжить?",
    "The first 5 characters of the SHA-1 hash of each password will be sent to api.pwnedpasswords.com. The passwords themselves are not sent. Continue?"), T("Проверить", "Check"))) return;
  busy(e.target, true, T("Проверяю…", "Checking…"));
  try {
    const cache = new Map();
    for (const x of list) {
      const h = [...new Uint8Array(await C.digest("SHA-1", enc.encode(x.pass)))].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      const pre = h.slice(0, 5), suf = h.slice(5);
      if (!cache.has(pre)) {
        const r = await fetch("https://api.pwnedpasswords.com/range/" + pre, { headers: { "Add-Padding": "true" }, referrerPolicy: "no-referrer", credentials: "omit" });
        if (!r.ok) throw new Error("HTTP " + r.status);
        cache.set(pre, await r.text());
      }
      const line = cache.get(pre).split("\n").find(l => l.startsWith(suf));
      breached.set(x.id, line ? parseInt(line.split(":")[1], 10) || 0 : 0);
    }
    audit(); renderNav(); toast(T("Проверка завершена", "Check complete"));
  } catch (err) { alertBox(T("Не удалось проверить: ", "Check failed: ") + err.message); }
  busy(e.target, false, "");
};

/* ---------------- Резервная копия ---------------- */
function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileSafe = s => (s || "profile").replace(/[^\p{L}\p{N}_-]+/gu, "_");
$("b-export").onclick = () => {
  const s = store.get();
  download(new Blob([JSON.stringify({ v: 1, id: s.id, vault: s.vault }, null, 1)], { type: "application/json" }), "vault-backup-" + new Date().toISOString().slice(0, 10) + ".json");
};

/* ---------------- Excel: выгрузка ---------------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (const b of u8) c = CRC_T[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const parts = [], central = []; let off = 0;
  const le = (n, len) => { const a = new Uint8Array(len); for (let i = 0; i < len; i++) a[i] = (n >>> (8 * i)) & 255; return a; };
  for (const [name, text] of files) {
    const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const common = [le(20, 2), le(0x800, 2), le(0, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(data.length, 4), le(data.length, 4), le(nm.length, 2), le(0, 2)];
    const local = [le(0x04034b50, 4), ...common, nm, data];
    central.push([le(0x02014b50, 4), le(20, 2), ...common, le(0, 2), le(0, 2), le(0, 2), le(0, 4), le(off, 4), nm]);
    parts.push(...local); off += local.reduce((s, x) => s + x.length, 0);
  }
  const cd = central.flat(), cdSize = cd.reduce((s, x) => s + x.length, 0);
  parts.push(...cd, le(0x06054b50, 4), le(0, 2), le(0, 2), le(files.length, 2), le(files.length, 2), le(cdSize, 4), le(off, 4), le(0, 2));
  return new Blob(parts, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
const xmlEsc = v => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function buildXlsx(rows, widths) {
  const col = i => String.fromCharCode(65 + i);
  const sheetRows = rows.map((r, ri) => `<row r="${ri + 1}">` + r.map((v, ci) =>
    `<c r="${col(ci)}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ""}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`).join("") + "</row>").join("");
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return zip([
    ["[Content_Types].xml", X + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ["_rels/.rels", X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="SHUT" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'],
    ["xl/worksheets/sheet1.xml", X + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' +
      widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + '</cols><sheetData>' + sheetRows + '</sheetData></worksheet>']
  ]);
}
const TYPE_NAME = t => ({ login: T("Пароль", "Password"), note: T("Заметка", "Note"), card: T("Карта", "Card"), wifi: "Wi-Fi", doc: T("Документ", "Document"),
  crypto: T("Криптокошелёк", "Crypto wallet"), key: T("Ключ", "Key"), bank: T("Счёт", "Bank account"), contact: T("Контакт", "Contact") }[t] || t);
/* Выгрузка: выбор записей и колонок */
const EX_COLS = () => [
  ["type", T("Тип", "Type"), 10, x => TYPE_NAME(x.type)], ["title", T("Название", "Name"), 28, x => x.title],
  ["login", T("Логин", "Login"), 26, x => x.login], ["pass", T("Пароль / PIN", "Password / PIN"), 24, x => x.pass],
  ["url", T("Сайт", "Website"), 30, x => x.url], ["category", T("Категория", "Category"), 14, x => x.category],
  ["note", T("Заметки", "Notes"), 40, x => x.note], ["card", T("Данные карты", "Card details"), 28, x => [x.number, x.exp, x.cvv && "CVV " + x.cvv].filter(Boolean).join(" · ")],
  ["totp", T("Ключ 2FA", "2FA key"), 22, x => x.totp], ["extra", T("Доп. поля", "Extra fields"), 40, x => (EXTRA[x.type] || []).filter(f => (x.f || {})[f.k]).map(f => exLabel(f) + ": " + x.f[f.k]).join("\n")],
  ["custom", T("Свои поля", "Custom fields"), 40, x => (x.custom || []).map(c => c.k + ": " + c.v).join("\n")],
  ["dates", T("Даты", "Dates"), 22, x => T("Добавлено ", "Added ") + new Date(x.created).toLocaleDateString() + (x.updated !== x.created ? "\n" + T("Изменено ", "Changed ") + new Date(x.updated).toLocaleDateString() : "")]
];
let exSel = new Set(), exTypes = new Set(), exCats = new Set(), exCols = new Set(["type", "title", "login", "pass", "url", "category", "note", "card", "extra", "custom"]);
function exPool() { return pwEntries().filter(x => (!exTypes.size || exTypes.has(x.type)) && (!exCats.size || exCats.has(x.category || "\u0000"))); }
function renderExport() {
  const L = pwEntries(), types = [...new Set(L.map(x => x.type))], cats = [...new Set(L.map(x => x.category || "\u0000"))];
  const chip = (group, v, label, count, on) => `<button type="button" class="chip-t${on ? " on" : ""}" data-g="${group}" data-v="${esc(v)}">${esc(label)}${count !== undefined ? ` <span>${count}</span>` : ""}</button>`;
  $("ex-types").innerHTML = chip("t", "*", T("Все типы", "All types"), undefined, !exTypes.size) + types.map(t => chip("t", t, TYPE_NAME(t), L.filter(x => x.type === t).length, exTypes.has(t))).join("");
  $("ex-cats").innerHTML = cats.length > 1 || cats[0] !== "\u0000" ? chip("c", "*", T("Все категории", "All categories"), undefined, !exCats.size) +
    cats.map(c => chip("c", c, c === "\u0000" ? T("Без категории", "Uncategorized") : c, L.filter(x => (x.category || "\u0000") === c).length, exCats.has(c))).join("") : "";
  const q = $("ex-search").value.toLowerCase(), pool = exPool();
  $("ex-list").innerHTML = pool.filter(x => (x.title + " " + (x.login || "")).toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title)).map(x =>
    `<label class="ex-item"><input type="checkbox" data-id="${esc(x.id)}"${exSel.has(x.id) ? " checked" : ""}><span class="t">${esc(x.title)}<small>${esc(subline(x))}</small></span><span class="k">${esc(TYPE_NAME(x.type))}</span></label>`).join("")
    || `<p class="muted small">${T("Нет записей под выбранные условия", "No entries match")}</p>`;
  $("ex-cols").innerHTML = EX_COLS().map(([k, l]) => chip("col", k, l, undefined, exCols.has(k))).join("");
  const n = pool.filter(x => exSel.has(x.id)).length;
  $("ex-go").textContent = n ? T("Выгрузить ", "Export ") + n + " " + T(plural(n, "запись", "записи", "записей"), n === 1 ? "entry" : "entries") : T("Выберите записи", "Select entries");
  $("ex-go").disabled = !n || !exCols.size;
}
$("b-xlsx").onclick = () => {
  if (!live().length) { alertBox(T("В профиле пока нет записей.", "This profile has no entries yet.")); return; }
  exTypes = new Set(); exCats = new Set(); exSel = new Set(live().map(x => x.id)); $("ex-search").value = "";
  renderExport(); show("export");
};
$("v-export").addEventListener("click", e => {
  const b = e.target.closest(".chip-t"); if (!b) return;
  const g = b.dataset.g, v = b.dataset.v;
  if (g === "col") { exCols.has(v) ? exCols.delete(v) : exCols.add(v); }
  else {
    const set = g === "t" ? exTypes : exCats;
    if (v === "*") set.clear(); else set.has(v) ? set.delete(v) : set.add(v);
    exSel = new Set(exPool().map(x => x.id)); // при смене фильтра выбираем всё, что под него попало
  }
  renderExport();
});
$("ex-list").addEventListener("change", e => { const id = e.target.dataset.id; if (!id) return; e.target.checked ? exSel.add(id) : exSel.delete(id); renderExport(); });
$("ex-search").oninput = renderExport;
$("ex-all").onclick = () => { exPool().forEach(x => exSel.add(x.id)); renderExport(); };
$("ex-none").onclick = () => { exSel.clear(); renderExport(); };
$("ex-go").onclick = () => {
  const cols = EX_COLS().filter(c => exCols.has(c[0])), list = exPool().filter(x => exSel.has(x.id)).sort((a, b) => a.title.localeCompare(b.title));
  if (!list.length || !cols.length) return;
  const rows = [cols.map(c => c[1]), ...list.map(x => cols.map(c => c[3](x) || ""))];
  download(buildXlsx(rows, cols.map(c => c[2])), "vault-" + fileSafe(store.get().name) + "-" + new Date().toISOString().slice(0, 10) + ".xlsx");
  toast(T("Файл скачан. Удалите его после использования", "File downloaded. Delete it after use"));
};

/* ---------------- Импорт CSV / Excel ---------------- */
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/)[0] || "", delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ";" : (first.includes("\t") && !first.includes(",") ? "\t" : ",");
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}
async function unzip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), files = {};
  let eocd = u8.length - 22; while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Not a zip");
  let p = dv.getUint32(eocd + 16, true); const n = dv.getUint16(eocd + 10, true);
  for (let i = 0; i < n; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), loff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const dstart = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true), data = u8.subarray(dstart, dstart + csize);
    if (/^xl\/(sharedStrings|worksheets\/sheet1)\.xml$/.test(name)) {
      files[name] = method === 0 ? dec.decode(data) : await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text();
    }
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
async function parseXlsx(buf) {
  const f = await unzip(buf), P = new DOMParser();
  const ss = f["xl/sharedStrings.xml"] ? [...P.parseFromString(f["xl/sharedStrings.xml"], "application/xml").getElementsByTagName("si")].map(si => [...si.getElementsByTagName("t")].map(t => t.textContent).join("")) : [];
  const sheet = P.parseFromString(f["xl/worksheets/sheet1.xml"] || "", "application/xml");
  return [...sheet.getElementsByTagName("row")].map(r => {
    const out = [];
    for (const c of r.getElementsByTagName("c")) {
      const ref = c.getAttribute("r") || "", ci = ref ? [...ref.replace(/\d+/g, "")].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1 : out.length;
      const t = c.getAttribute("t"), v = c.getElementsByTagName("v")[0];
      out[ci] = t === "s" ? ss[+v?.textContent] ?? "" : t === "inlineStr" ? [...c.getElementsByTagName("t")].map(x => x.textContent).join("") : v?.textContent ?? "";
    }
    return Array.from(out, x => x ?? "");
  }).filter(r => r.some(v => String(v).trim()));
}
const SYN = {
  title: ["name", "title", "account", "название", "сайт / название", "имя"],
  login: ["username", "login", "login_username", "login name", "user name", "email", "логин", "пользователь"],
  pass: ["password", "login_password", "пароль", "пароль / pin", "password / pin"],
  url: ["url", "login_uri", "web site", "website", "uri", "адрес", "адрес сайта", "сайт"],
  note: ["note", "notes", "comments", "extra", "заметки", "заметка", "описание"],
  category: ["folder", "group", "grouping", "category", "категория", "папка"],
  totp: ["totp", "login_totp", "otp", "otpauth", "2fa"],
  fav: ["favorite", "fav", "избранное"],
  type: ["type", "тип"], number: ["card number", "cardnumber", "номер карты"], exp: ["expiry", "exp", "срок"], cvv: ["cvv", "code"]
};
let importRows = [];
function mapRows(rows) {
  const head = rows[0].map(h => String(h).trim().toLowerCase()), map = {};
  for (const [k, syn] of Object.entries(SYN)) { const i = head.findIndex(h => syn.includes(h)); if (i >= 0) map[k] = i; }
  if (map.title === undefined && map.url !== undefined) map.title = map.url;
  if (map.pass === undefined && map.title === undefined) throw new Error(T("Не найдены колонки с названием или паролем", "No name or password columns found"));
  const TYPE_ALIASES = { note: ["note", "заметка", "securenote", "secure note", "2"], card: ["card", "карта", "3"], wifi: ["wi-fi", "wifi"],
    doc: ["document", "документ", "identity", "4"], crypto: ["crypto", "crypto wallet", "криптокошелёк", "криптокошелек"], key: ["key", "ключ", "license"],
    bank: ["bank", "bank account", "счёт", "счет"], contact: ["contact", "контакт"] };
  const typeOf = v => { v = String(v || "").trim().toLowerCase(); for (const [t, a] of Object.entries(TYPE_ALIASES)) if (a.includes(v)) return t; return "login"; };
  return rows.slice(1).map(r => {
    const g = k => map[k] !== undefined ? String(r[map[k]] ?? "").trim() : "";
    let url = g("url"), title = g("title");
    if (title === url && url) { try { title = new URL(safeUrl(url)).hostname.replace(/^www\./, ""); } catch {} }
    return { type: typeOf(g("type")), title: title || T("Без названия", "Untitled"), login: g("login"), pass: map.pass !== undefined ? String(r[map.pass] ?? "") : "", url: safeUrl(url),
      note: g("note"), category: g("category"), totp: g("totp"), fav: ["1", "true", "да", "yes"].includes(g("fav").toLowerCase()), number: g("number"), exp: g("exp"), cvv: g("cvv") };
  }).filter(x => x.pass || x.login || x.note || x.number);
}
$("b-import").onclick = () => $("import-file").click();
$("import-file").onchange = async () => {
  const f = $("import-file").files[0]; $("import-file").value = ""; if (!f) return;
  $("import-err").textContent = "";
  try {
    const rows = /\.xlsx$/i.test(f.name) ? await parseXlsx(await f.arrayBuffer()) : parseCsv(await f.text());
    if (rows.length < 2) throw new Error(T("Файл пуст", "File is empty"));
    importRows = mapRows(rows);
    const keys = new Set(entries.map(x => x.title + "\u0000" + x.login + "\u0000" + x.pass));
    const dup = importRows.filter(x => keys.has(x.title + "\u0000" + x.login + "\u0000" + x.pass)).length;
    $("import-body").innerHTML = `<p>${T("Файл: ", "File: ")}<b>${esc(f.name)}</b></p><p>${T("Найдено записей: ", "Entries found: ")}<b>${importRows.length}</b>${dup ? T(", из них уже есть: ", ", already present: ") + dup + T(" (будут пропущены)", " (will be skipped)") : ""}</p>` +
      `<div class="preview">${importRows.slice(0, 5).map(x => `<div class="mini"><div><b>${esc(x.title)}</b><small>${esc(x.login)}</small></div></div>`).join("")}${importRows.length > 5 ? `<p class="muted small">${T("и ещё ", "and ")}${importRows.length - 5}${T("…", " more…")}</p>` : ""}</div>` +
      `<div class="note-box">${T("Поддерживаются CSV из Chrome, Edge, Firefox, Bitwarden, KeePass, 1Password и Excel-выгрузка из SHUT. После импорта удалите исходный файл — он не зашифрован.", "Supports CSV from Chrome, Edge, Firefox, Bitwarden, KeePass, 1Password and SHUT's Excel export. Delete the source file after import — it is not encrypted.")}</div>`;
    show("import");
  } catch (err) { alertBox(T("Не удалось прочитать файл: ", "Could not read the file: ") + err.message); }
};
$("b-import-go").onclick = async () => {
  const keys = new Set(entries.map(x => x.title + "\u0000" + x.login + "\u0000" + x.pass)), now = Date.now(); let n = 0;
  for (const x of importRows) {
    const k = x.title + "\u0000" + x.login + "\u0000" + x.pass; if (keys.has(k)) continue; keys.add(k);
    entries.push({ ...x, id: b64(rand(9)), created: now, updated: now, pwChanged: now }); n++;
  }
  importRows = []; await persist(); filter = "all"; openVaultView(); toast(T("Импортировано: ", "Imported: ") + n);
};

/* ---------------- Выход, удаление, автоблокировка ---------------- */
function lock() {
  clearSession();
  vaultKey = null; entries = []; selectedId = null; view = "vault"; breached = new Map(); totpKeys.clear();
  $("list").innerHTML = ""; $("detail-view").innerHTML = ""; $("search").value = ""; $("audit-body").innerHTML = ""; $("import-body").innerHTML = ""; importRows = [];
  clearForm(); home();
}
$("b-logout").onclick = lock;
$("b-wipe").onclick = async () => {
  if (await confirmBox(T("Удалить профиль «", "Delete profile “") + (store.get().name || "") + T("» с этого устройства? Восстановить можно будет только по секретной фразе и резервной копии.", "” from this device? It can only be restored with the secret phrase and a backup."), T("Удалить", "Delete"), true)) { store.remove(currentId); currentId = null; lock(); }
};
let idle, hiddenTimer;
function resetIdle() { clearTimeout(idle); if (vaultKey && LOCK_IDLE_MS > 0) idle = setTimeout(lock, LOCK_IDLE_MS); }
["click", "keydown", "mousemove", "touchstart", "scroll"].forEach(ev => addEventListener(ev, resetIdle, { passive: true }));
document.addEventListener("visibilitychange", () => {
  clearTimeout(hiddenTimer);
  if (document.hidden && vaultKey && LOCK_IDLE_MS > 0) hiddenTimer = setTimeout(lock, LOCK_HIDDEN_MS);
});

/* ---------------- PWA ---------------- */
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; document.querySelectorAll("[data-install]").forEach(b => b.hidden = false); });
document.querySelectorAll("[data-install]").forEach(b => b.onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; document.querySelectorAll("[data-install]").forEach(x => x.hidden = true); });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------------- Запуск ---------------- */
applyTheme();
const SESS_KEY = "vault.session";
function saveSession(raw, id) { if (!stayOn()) return; try { sessionStorage.setItem(SESS_KEY, JSON.stringify({ id, k: b64(raw) })); } catch {} }
function clearSession() { try { sessionStorage.removeItem(SESS_KEY); } catch {} }
async function tryResume() {
  let d = null; try { d = JSON.parse(sessionStorage.getItem(SESS_KEY) || "null"); } catch {}
  if (!d || !d.k || !d.id) return false;
  const s = store.all().find(p => p.id === d.id);
  if (!s) { clearSession(); return false; }
  try {
    const raw = unb64(d.k);
    vaultKey = await importVaultKey(raw);
    entries = JSON.parse(dec.decode(await open(vaultKey, s.vault))).map(migrateEntry);
    raw.fill(0); currentId = s.id;
    openVaultView();
    return true;
  } catch { clearSession(); vaultKey = null; entries = []; return false; }
}
/* Настройки приложения: автоблокировка и сохранение сессии */
if ($("sync-url")) { const o = (() => { try { return localStorage.getItem(SYNC_URL_KEY) || ""; } catch { return ""; } })(); $("sync-url").value = o; }
if ($("b-sync-save")) $("b-sync-save").onclick = () => {
  const list = $("sync-url").value.split(/[\s,]+/).map(x => x.trim().replace(/\/+$/, "")).filter(Boolean);
  const bad = list.find(u => !/^https:\/\/[^\s]+\.[^\s]+$/.test(u));
  if (bad) { $("sync-status").textContent = T("Некорректный адрес: ", "Invalid URL: ") + bad; return; }
  try { localStorage.setItem(SYNC_URL_KEY, list.join("\n")); } catch {}
  $("sync-status").textContent = list.length ? T("Сохранено (" + list.length + "). Нажмите «Синхронизировать сейчас».", "Saved (" + list.length + "). Click \u201cSync now\u201d.") : T("Используются серверы по умолчанию.", "Using default servers.");
};
if ($("b-sync-now")) $("b-sync-now").onclick = async () => {
  const s = store.get(); if (!s || !vaultKey) return;
  if (!syncUrl()) { $("sync-status").textContent = T("Сначала укажите адрес сервера.", "Set the server URL first."); return; }
  if (!s.syncId) { $("sync-status").textContent = T("Перезайдите в сейф, чтобы включить синхронизацию.", "Re-open the vault to enable sync."); return; }
  $("sync-status").textContent = T("Синхронизирую…", "Syncing…");
  try { const pr = await syncPull(store.get()); await syncPush(store.get()); renderNav(); render();
    $("sync-status").textContent = T("Готово.", "Done.") + (pr && pr.pulled ? T(" Подтянул свежую версию из облака.", " Pulled the latest from the cloud.") : T(" Сейф выгружен в облако.", " SHUT pushed to the cloud."));
  } catch (e) { $("sync-status").textContent = T("Ошибка синхронизации: ", "Sync error: ") + e.message; }
};
if ($("set-autolock")) {
  $("set-autolock").value = String(LOCK_IDLE_MS);
  $("set-autolock").onchange = e => { try { localStorage.setItem("vault.autolock", e.target.value); } catch {} LOCK_IDLE_MS = +e.target.value; resetIdle(); };
}
if ($("set-stay")) {
  $("set-stay").checked = stayOn();
  $("set-stay").onchange = e => { try { localStorage.setItem("vault.stay", e.target.checked ? "1" : "0"); } catch {} if (!e.target.checked) clearSession();  };
}

/* Горячие клавиши */
addEventListener("keydown", e => {
  const ae = document.activeElement, inField = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
  const inVault = !$("v-vault").classList.contains("hidden");
  if (e.key === "Escape") { if ($("v-vault").classList.contains("show-detail")) { $("v-vault").classList.remove("show-detail"); } return; }
  if (inField) return;
  if (e.key === "/" && inVault && view === "vault") { e.preventDefault(); $("search").focus(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k" && inVault && view === "vault") { e.preventDefault(); $("b-new-entry").click(); }
});

/* Генератор: пресеты и история */
let gpHist = [];
function gpRenderHist() {
  const el = $("gp-history"); if (!el) return;
  el.classList.toggle("hidden", !gpHist.length);
  el.innerHTML = gpHist.map(v => `<button type="button" class="gp-hchip mono" data-hv="${esc(v)}" title="${T("Скопировать", "Copy")}">${esc(v)}</button>`).join("");
}
if ($("gp-history")) $("gp-history").onclick = e => { const b = e.target.closest("[data-hv]"); if (b) copySecret(b.dataset.hv); };
if ($("gp-presets")) $("gp-presets").onclick = e => {
  const b = e.target.closest("[data-preset]"); if (!b) return;
  const p = b.dataset.preset, set = (m, len) => { gpMode = m; $("gp-len").value = len; $("gp-mode").querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.mode === m)); gpRun(); };
  $("gp-presets").querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === b));
  if (p === "max") set("chars", 24); else if (p === "words") set("words", 24); else if (p === "pin") set("pin", 6); else if (p === "pron") set("pron", 14);
};

initWords().then(async () => { applyLang(); clearForm(); updGenUi(); if (!(await tryResume())) home(); })
  .catch(err => { $("loading-msg").textContent = "Ошибка: " + err.message + ". Обновите страницу."; });
