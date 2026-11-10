"use strict";
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
const KDF = { alg: "argon2id", m: 19456, t: 2, p: 1 };
const LOCK_IDLE_MS = 5 * 60 * 1000, LOCK_HIDDEN_MS = 60 * 1000;
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
  $("b-lang").textContent = lang === "en" ? "RU" : "EN";
  $("guide-ru").classList.toggle("hidden", lang === "en");
  $("guide-en").classList.toggle("hidden", lang !== "en");
  document.title = T("Vault — хранилище паролей", "Vault — password manager");
  applyTypeLabels();
  if (vaultKey) { renderChips(); render(); }
  if (!$("v-start").classList.contains("hidden")) home();
}
$("b-lang").onclick = () => { lang = lang === "en" ? "ru" : "en"; try { localStorage.setItem("vault.lang", lang); } catch {} applyLang(); };

/* ---------------- Тема ---------------- */
let theme = (() => { try { return localStorage.getItem("vault.theme") || "dark"; } catch { return "dark"; } })();
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $("b-theme").textContent = theme === "dark" ? "☀" : "☾";
  document.querySelector('meta[name="theme-color"]').content = theme === "dark" ? "#070707" : "#f6f6f6";
}
$("b-theme").onclick = () => { theme = theme === "dark" ? "light" : "dark"; try { localStorage.setItem("vault.theme", theme); } catch {} applyTheme(); };

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
async function wrapVaultKey(key, pw) {
  const salt = rand(16), prof = { salt: b64(salt), kdf: { ...KDF } };
  const wk = await wrapKeyFrom(pw, prof);
  const raw = new Uint8Array(await C.exportKey("raw", key));
  prof.wrapped = await seal(wk, raw); raw.fill(0);
  return prof;
}

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
}
async function setupDevice(key, pw, vaultBox, name) {
  const id = await vaultId(key);
  const prev = store.all().find(p => p.id === id);
  const w = await wrapVaultKey(key, pw);
  store.set({ v: 3, id, name: name || (prev && prev.name) || T("Профиль", "Profile"), ...w, fails: 0, lockUntil: 0,
              vault: vaultBox || await seal(key, enc.encode("[]")) });
  currentId = id;
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
  if (p1.length < 10) return T("Минимум 10 символов", "At least 10 characters");
  if (strength(p1).score < 2) return T("Пароль слишком простой. Добавьте слов или символов", "Password is too weak. Add more words or characters");
  if (p1 !== p2) return T("Пароли не совпадают", "Passwords do not match");
  return null;
}

/* ---------------- Экраны ---------------- */
const views = ["start", "phrase", "verify", "setpw", "restore", "unlock", "vault", "settings", "audit", "import", "guide", "loading"];
function show(v) { views.forEach(x => $("v-" + x).classList.toggle("hidden", x !== v)); scrollTo(0, 0); }
const busy = (btn, on, label) => { btn.disabled = on; if (label !== undefined) { if (on) { btn.dataset.l = btn.textContent; btn.textContent = label; } else if (btn.dataset.l) btn.textContent = btn.dataset.l; } };

function home() {
  const list = store.all();
  $("profiles").innerHTML = list.length ? list.map(p => `
    <div class="entry"><div><b>${esc(p.name || T("Профиль", "Profile"))}</b></div>
    <button class="shrink" data-pid="${esc(p.id)}">${T("Войти", "Sign in")}</button></div>`).join("")
    : `<p class="sub">${T("На этом устройстве пока нет профилей.", "No profiles on this device yet.")}</p>`;
  show("start");
}
$("profiles").onclick = e => {
  const id = e.target.dataset.pid; if (!id) return;
  currentId = id; $("unlock-name").textContent = store.get().name || T("Профиль", "Profile");
  $("unlock-err").textContent = ""; show("unlock"); $("unlock-pw").focus();
};
$("b-other").onclick = () => { currentId = null; home(); };

function cancelToHome() {
  pendingPhrase = null; pendingKey = null; verifyIdx = [];
  $("words").innerHTML = ""; $("verify-fields").innerHTML = "";
  ["pw1", "pw2", "p-name", "restore-words", "unlock-pw", "cp-old", "cp-new1", "cp-new2"].forEach(id => $(id).value = "");
  $("restore-file").value = ""; meterPw1(); meterCp();
  if (vaultKey) lock(); else { currentId = null; home(); }
}
document.querySelectorAll("[data-cancel]").forEach(b => b.onclick = cancelToHome);
$("logo").onclick = () => { if (WORDS) cancelToHome(); };
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
$("b-back-phrase").onclick = () => show("phrase");
$("b-verify").onclick = async () => {
  const w = pendingPhrase.split(" ");
  const ok = [...$("verify-fields").querySelectorAll("input")].every(inp => inp.value.trim().toLowerCase() === w[+inp.dataset.i]);
  if (!ok) { $("verify-err").textContent = T("Слова не совпадают. Проверьте записанную фразу.", "The words don't match. Check your written phrase."); return; }
  pendingKey = await phraseToVaultKey(pendingPhrase);
  pendingKey._vaultBox = null;
  pendingPhrase = null; $("words").innerHTML = "";
  $("setpw-err").textContent = ""; show("setpw");
};
$("b-setpw").onclick = async e => {
  const p1 = $("pw1").value, p2 = $("pw2").value, pname = $("p-name").value.trim();
  const bad = checkNewPassword(p1, p2); if (bad) { $("setpw-err").textContent = bad; return; }
  busy(e.target, true, T("Шифрую…", "Encrypting…"));
  try {
    await setupDevice(pendingKey, p1, pendingKey._vaultBox || null, pname);
    vaultKey = pendingKey; pendingKey = null;
    entries = JSON.parse(dec.decode(await open(vaultKey, store.get().vault))).map(migrateEntry);
    $("pw1").value = $("pw2").value = $("p-name").value = ""; meterPw1();
    openVaultView();
  } catch (err) { $("setpw-err").textContent = T("Ошибка: ", "Error: ") + err.message; }
  busy(e.target, false, "");
};

/* ---------------- Восстановление ---------------- */
$("b-restore").onclick = $("b-forgot").onclick = () => { $("restore-err").textContent = ""; show("restore"); };
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
    if (box) await open(key, box);
    key._vaultBox = box; pendingKey = key;
    $("restore-words").value = ""; $("restore-file").value = "";
    $("setpw-err").textContent = ""; show("setpw");
  } catch (err) { $("restore-err").textContent = err.name === "OperationError" ? T("Не удалось расшифровать", "Could not decrypt") : err.message; }
  busy(e.target, false);
};

/* ---------------- Вход с ограничением попыток ---------------- */
$("b-unlock").onclick = async e => {
  const s = store.get(); if (!s) return home();
  const now = Date.now();
  if (s.lockUntil && s.lockUntil > now) {
    $("unlock-err").textContent = T("Слишком много попыток. Подождите ", "Too many attempts. Wait ") + Math.ceil((s.lockUntil - now) / 1000) + T(" с", " s"); return;
  }
  busy(e.target, true, T("Проверяю…", "Checking…"));
  try {
    const pw = $("unlock-pw").value;
    const wk = await wrapKeyFrom(pw, s);
    const raw = await open(wk, s.wrapped);
    vaultKey = await C.importKey("raw", raw, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]); raw.fill(0);
    entries = JSON.parse(dec.decode(await open(vaultKey, s.vault))).map(migrateEntry);
    s.fails = 0; s.lockUntil = 0;
    if (!s.kdf || s.kdf.alg !== "argon2id") Object.assign(s, await wrapVaultKey(vaultKey, pw), { iters: undefined }); // переход на Argon2id
    store.set(s);
    $("unlock-pw").value = ""; $("unlock-err").textContent = "";
    openVaultView();
  } catch {
    s.fails = (s.fails || 0) + 1;
    if (s.fails >= 3) s.lockUntil = Date.now() + Math.min(2 ** (s.fails - 3) * 30000, 3600000); // 30 с, 1 мин, 2 мин… до часа
    store.set(s);
    $("unlock-err").textContent = T("Неверный пароль", "Wrong password") + (s.fails >= 3 ? T(". Следующая попытка через ", ". Next attempt in ") + Math.ceil((s.lockUntil - Date.now()) / 1000) + T(" с", " s") : "");
  }
  busy(e.target, false, "");
};
$("unlock-pw").addEventListener("keydown", e => { if (e.key === "Enter") $("b-unlock").click(); });

/* ---------------- Генератор ---------------- */
function randInt(n) { const lim = Math.floor(4294967296 / n) * n, r = new Uint32Array(1); do crypto.getRandomValues(r); while (r[0] >= lim); return r[0] % n; }
function genPassword() {
  const mode = document.querySelector('input[name="gmode"]:checked').value, len = +$("g-len").value;
  if (mode === "words") {
    const n = Math.max(3, Math.round(len / 5)), w = [];
    for (let i = 0; i < n; i++) w.push(WORDS[randInt(2048)]);
    const ci = randInt(n); w[ci] = w[ci].replace(/^./, c => c.toUpperCase());
    return w.join("-") + "-" + randInt(100);
  }
  const sets = [];
  if ($("g-up").checked) sets.push("ABCDEFGHJKLMNPQRSTUVWXYZ");
  if ($("g-low").checked) sets.push("abcdefghijkmnopqrstuvwxyz");
  if ($("g-dig").checked) sets.push("23456789");
  if ($("g-sym").checked) sets.push("!@#$%^&*-_=+?");
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

/* ---------------- Форма записи ---------------- */
let formType = "login", editingId = null;
const TYPE_LABELS = () => ({
  login: { title: T("Сайт / название", "Site / name"), login: T("Логин", "Login"), pass: T("Пароль", "Password") },
  note: { title: T("Название заметки", "Note title") },
  card: { title: T("Название карты (банк)", "Card name (bank)"), login: T("Владелец карты", "Cardholder"), pass: T("PIN-код", "PIN") },
  wifi: { title: T("Название сети (SSID)", "Network name (SSID)"), pass: T("Пароль Wi-Fi", "Wi-Fi password") }
});
function applyTypeLabels() {
  const L = TYPE_LABELS()[formType];
  document.querySelectorAll("[data-f]").forEach(el => { if (L[el.dataset.f]) el.textContent = L[el.dataset.f]; });
  document.querySelectorAll("#form-card [data-show]").forEach(el => el.classList.toggle("hidden", !el.dataset.show.split(" ").includes(formType)));
  document.querySelectorAll("#type-tabs .tab").forEach(b => b.classList.toggle("active", b.dataset.type === formType));
  $("form-title").textContent = editingId ? T("Редактирование", "Editing") : T("Новая запись", "New entry");
  $("b-add").textContent = editingId ? T("Сохранить", "Save") : T("Добавить", "Add");
}
document.querySelectorAll("#type-tabs .tab").forEach(b => b.onclick = () => { formType = b.dataset.type; applyTypeLabels(); });
const FIELDS = { title: "e-title", login: "e-login", url: "e-url", pass: "e-pass", totp: "e-totp", category: "e-cat", note: "e-note", number: "e-number", exp: "e-exp", cvv: "e-cvv" };
function clearForm() {
  Object.values(FIELDS).forEach(id => $(id).value = ""); $("e-fav").checked = false;
  editingId = null; $("b-edit-cancel").classList.add("hidden"); $("form-err").textContent = ""; meterEntry(); applyTypeLabels();
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
  const keep = { login: ["title", "login", "url", "pass", "totp"], note: ["title"], card: ["title", "login", "number", "exp", "cvv", "pass"], wifi: ["title", "pass"] }[formType];
  const now = Date.now();
  const base = { type: formType, category: d.category, note: d.note, fav: $("e-fav").checked };
  keep.forEach(k => base[k] = d[k]);
  if (formType === "login") base.url = safeUrl(d.url);
  if (editingId) {
    const i = entries.findIndex(x => x.id === editingId), old = entries[i];
    entries[i] = { ...base, id: old.id, created: old.created, used: old.used, updated: now, pwChanged: old.pass !== base.pass ? now : old.pwChanged };
  } else {
    entries.push({ ...base, id: b64(rand(9)), created: now, updated: now, pwChanged: now });
  }
  await persist(); clearForm(); renderChips(); render(); toast(T("Сохранено", "Saved"));
};
$("b-edit-cancel").onclick = clearForm;
function startEdit(x) {
  editingId = x.id; formType = x.type;
  for (const [k, id] of Object.entries(FIELDS)) $(id).value = x[k] || "";
  $("e-fav").checked = !!x.fav; meterEntry();
  $("b-edit-cancel").classList.remove("hidden"); applyTypeLabels();
  $("form-card").scrollIntoView({ behavior: "smooth" });
}

/* ---------------- Список ---------------- */
let filter = "all";
function renderChips() {
  const cats = [...new Set(entries.map(x => x.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $("cat-list").innerHTML = cats.map(c => `<option value="${esc(c)}">`).join("");
  const types = [["login", T("Пароли", "Passwords")], ["note", T("Заметки", "Notes")], ["card", T("Карты", "Cards")], ["wifi", "Wi-Fi"]].filter(([t]) => entries.some(x => x.type === t));
  const chips = [["all", T("Все", "All")], ["fav", T("Избранное", "Favorites")], ...types.map(([t, l]) => ["t:" + t, l]), ...cats.map(c => ["c:" + c, c])];
  if (!chips.some(c => c[0] === filter)) filter = "all";
  $("chips").innerHTML = chips.map(([v, l]) => `<button class="chip${v === filter ? " active" : ""}" data-filter="${esc(v)}">${esc(l)}</button>`).join("");
}
$("chips").onclick = e => { const f = e.target.dataset.filter; if (f === undefined) return; filter = f; renderChips(); render(); };
function maskCard(n) { const d = (n || "").replace(/\D/g, ""); return d ? "•••• " + d.slice(-4) : ""; }
function render() {
  const q = $("search").value.toLowerCase(), sort = $("sort").value;
  let list = entries.filter(x => [x.title, x.login, x.note, x.category, x.url].join(" ").toLowerCase().includes(q));
  if (filter === "fav") list = list.filter(x => x.fav);
  else if (filter.startsWith("t:")) list = list.filter(x => x.type === filter.slice(2));
  else if (filter.startsWith("c:")) list = list.filter(x => x.category === filter.slice(2));
  const cmp = { title: (a, b) => a.title.localeCompare(b.title), updated: (a, b) => b.updated - a.updated, used: (a, b) => (b.used || 0) - (a.used || 0), created: (a, b) => b.created - a.created }[sort];
  list.sort((a, b) => (b.fav ? 1 : 0) - (a.fav ? 1 : 0) || cmp(a, b));
  $("list").innerHTML = list.length ? list.map(x => {
    const hasPass = !!x.pass, cfg = x.type === "login" && parseTotp(x.totp);
    const sub = x.type === "card" ? [maskCard(x.number), x.exp].filter(Boolean).join(" · ") : x.login;
    return `<div class="entry" data-id="${esc(x.id)}">
      <div class="entry-main">
        <b>${x.fav ? '<span class="star">★</span> ' : ""}${esc(x.title)} <span class="kind">${TYPE_NAME(x.type)}</span></b>
        ${sub ? `<small>${esc(sub)}</small>` : ""}
        ${x.category ? `<span class="tag">#${esc(x.category)}</span>` : ""}
        ${hasPass ? `<div class="pw" data-pw>••••••••</div>` : ""}
        ${x.type === "card" && x.number ? `<div class="pw hidden" data-card>${esc(x.number)}${x.cvv ? " · CVV " + esc(x.cvv) : ""}</div>` : ""}
        ${cfg ? `<div class="totp" data-totp="${esc(x.id)}"><span class="code">··· ···</span> <span class="left"></span></div>` : ""}
        ${x.note ? `<div class="note">${esc(x.note)}</div>` : ""}
      </div>
      <div class="entry-actions">
        ${hasPass || x.type === "card" ? `<button class="ghost" data-act="show">${T("Показать", "Show")}</button>` : ""}
        ${x.login ? `<button class="ghost" data-act="copy-login">${T("Логин", "Login")}</button>` : ""}
        ${hasPass ? `<button class="ghost" data-act="copy">${T("Пароль", "Password")}</button>` : ""}
        ${cfg ? `<button class="ghost" data-act="copy-totp">2FA</button>` : ""}
        ${x.type === "card" && x.number ? `<button class="ghost" data-act="copy-number">${T("Номер", "Number")}</button>` : ""}
        ${x.url ? `<button class="ghost" data-act="open">${T("Открыть", "Open")}</button>` : ""}
        <button class="ghost" data-act="fav" title="${T("Избранное", "Favorite")}">${x.fav ? "★" : "☆"}</button>
        <button class="ghost" data-act="edit">${T("Изменить", "Edit")}</button>
        <button class="ghost" data-act="del" class="ghost danger-text">${T("Удалить", "Delete")}</button>
      </div>
    </div>`;
  }).join("") : `<p class="sub">${entries.length ? T("Ничего не найдено.", "Nothing found.") : T("Пока пусто.", "Nothing here yet.")}</p>`;
  tickTotp();
}
$("search").oninput = render; $("sort").onchange = render;
async function copySecret(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { toast(T("Не удалось скопировать", "Copy failed")); return; }
  toast(T("Скопировано. Буфер очистится через 30 с", "Copied. Clipboard clears in 30 s"));
  clearTimeout(copySecret.t);
  copySecret.t = setTimeout(() => navigator.clipboard.writeText("").catch(() => {}), 30000);
}
async function markUsed(x) { x.used = Date.now(); await persist(); }
$("list").onclick = async e => {
  const btn = e.target.closest("[data-act]"); if (!btn) return;
  const act = btn.dataset.act, row = btn.closest(".entry"), x = entries.find(y => y.id === row.dataset.id); if (!x) return;
  if (act === "show") {
    const el = row.querySelector("[data-pw]"); if (el) el.textContent = el.textContent.startsWith("•") ? x.pass : "••••••••";
    const c = row.querySelector("[data-card]"); if (c) c.classList.toggle("hidden");
  }
  if (act === "copy") { await copySecret(x.pass); markUsed(x); }
  if (act === "copy-login") { await copySecret(x.login); }
  if (act === "copy-number") { await copySecret(x.number.replace(/\s/g, "")); }
  if (act === "copy-totp") { const r = await totpCode(parseTotp(x.totp)); await copySecret(r.code); markUsed(x); }
  if (act === "open") { const u = safeUrl(x.url); if (u) { window.open(u, "_blank", "noopener,noreferrer"); markUsed(x); } }
  if (act === "fav") { x.fav = !x.fav; await persist(); render(); }
  if (act === "edit") startEdit(x);
  if (act === "del" && await confirmBox(T("Удалить запись «", "Delete entry “") + x.title + T("»?", "”?"), T("Удалить", "Delete"), true)) {
    entries = entries.filter(y => y !== x); if (editingId === x.id) clearForm(); await persist(); renderChips(); render();
  }
};

function openVaultView() {
  $("vault-name").textContent = store.get().name || T("Профиль", "Profile");
  renderChips(); render(); show("vault"); resetIdle();
}

/* ---------------- Настройки: смена пароля, имя ---------------- */
$("b-settings").onclick = () => { $("rename").value = store.get().name || ""; $("cp-err").textContent = ""; show("settings"); };
$("b-cp").onclick = async e => {
  const s = store.get(), oldPw = $("cp-old").value, p1 = $("cp-new1").value, p2 = $("cp-new2").value;
  const bad = checkNewPassword(p1, p2); if (bad) { $("cp-err").textContent = bad; return; }
  busy(e.target, true, T("Проверяю…", "Checking…"));
  try {
    await open(await wrapKeyFrom(oldPw, s), s.wrapped); // проверка текущего пароля
    Object.assign(s, await wrapVaultKey(vaultKey, p1)); store.set(s);
    ["cp-old", "cp-new1", "cp-new2"].forEach(id => $(id).value = ""); meterCp();
    toast(T("Пароль изменён", "Password changed")); openVaultView();
  } catch { $("cp-err").textContent = T("Текущий пароль неверный", "Current password is wrong"); }
  busy(e.target, false, "");
};
$("b-rename").onclick = () => { const s = store.get(), n = $("rename").value.trim(); if (!n) return; s.name = n; store.set(s); toast(T("Сохранено", "Saved")); openVaultView(); };

/* ---------------- Аудит ---------------- */
let breached = new Map();
function audit() {
  const withPass = entries.filter(x => x.pass && x.type !== "card");
  const counts = {}; withPass.forEach(x => counts[x.pass] = (counts[x.pass] || 0) + 1);
  const weak = withPass.filter(x => strength(x.pass).score < 3);
  const reused = withPass.filter(x => counts[x.pass] > 1);
  const old = withPass.filter(x => Date.now() - (x.pwChanged || x.created) > 365 * 864e5);
  const leaked = withPass.filter(x => breached.get(x.id) > 0);
  const sec = (title, list, why) => `<h3>${title} <span class="count${list.length ? " bad" : ""}">${list.length}</span></h3>` +
    (list.length ? `<div>${list.map(x => `<div class="entry compact"><div><b>${esc(x.title)}</b><small>${esc(why(x))}</small></div><button class="ghost shrink" data-audit-edit="${esc(x.id)}">${T("Изменить", "Edit")}</button></div>`).join("")}</div>`
      : `<p class="sub tight">${T("Всё в порядке", "All good")}</p>`);
  const score = withPass.length ? Math.round(100 * (1 - new Set([...weak, ...reused, ...old, ...leaked]).size / withPass.length)) : 100;
  $("audit-body").innerHTML = `<div class="score"><b>${score}</b><span>${T("из 100 — общая оценка", "out of 100 — overall score")}</span></div>` +
    sec(T("Найдены в утечках", "Found in breaches"), leaked, x => T("Встречался в утечках ", "Seen in breaches ") + breached.get(x.id).toLocaleString() + T(" раз — смените срочно", " times — change it now")) +
    sec(T("Слабые пароли", "Weak passwords"), weak, x => strength(x.pass).label) +
    sec(T("Повторяющиеся", "Reused"), reused, x => T("Используется в ", "Used in ") + counts[x.pass] + T(" записях", " entries")) +
    sec(T("Старше года", "Older than a year"), old, x => T("Не менялся с ", "Not changed since ") + new Date(x.pwChanged || x.created).toLocaleDateString());
}
$("b-audit").onclick = () => { audit(); show("audit"); };
$("audit-body").onclick = e => { const id = e.target.dataset.auditEdit; if (!id) return; show("vault"); startEdit(entries.find(x => x.id === id)); };
$("b-hibp").onclick = async e => {
  const list = entries.filter(x => x.pass && x.type !== "card");
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
    audit(); toast(T("Проверка завершена", "Check complete"));
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
    ["xl/workbook.xml", X + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Vault" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", X + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ["xl/styles.xml", X + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>'],
    ["xl/worksheets/sheet1.xml", X + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' +
      widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + '</cols><sheetData>' + sheetRows + '</sheetData></worksheet>']
  ]);
}
const TYPE_NAME = t => ({ login: T("Пароль", "Password"), note: T("Заметка", "Note"), card: T("Карта", "Card"), wifi: "Wi-Fi" }[t] || t);
$("b-xlsx").onclick = async () => {
  if (!entries.length) { alertBox(T("В профиле пока нет записей.", "This profile has no entries yet.")); return; }
  if (!await confirmBox(T("Внимание: файл Excel НЕ зашифрован. Любой, кто получит его, увидит все пароли. Удалите файл, когда он станет не нужен. Продолжить?",
    "Warning: the Excel file is NOT encrypted. Anyone who gets it will see all passwords. Delete the file when you no longer need it. Continue?"), T("Выгрузить", "Export"))) return;
  const rows = [[T("Тип", "Type"), T("Название", "Name"), T("Логин", "Login"), T("Пароль", "Password"), T("Сайт", "Website"), T("Категория", "Category"), T("Заметки", "Notes"), T("Номер карты", "Card number"), T("Срок", "Expiry"), "CVV", "2FA", T("Добавлено", "Added")],
    ...entries.map(x => [TYPE_NAME(x.type), x.title, x.login, x.pass, x.url, x.category, x.note, x.number, x.exp, x.cvv, x.totp, new Date(x.created).toLocaleString()])];
  download(buildXlsx(rows, [10, 28, 26, 24, 30, 14, 40, 20, 8, 6, 20, 18]), "vault-" + fileSafe(store.get().name) + "-" + new Date().toISOString().slice(0, 10) + ".xlsx");
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
  title: ["name", "title", "account", "название", "сайт / название", "сайт", "имя"],
  login: ["username", "login", "login_username", "login name", "user name", "email", "логин", "пользователь"],
  pass: ["password", "login_password", "пароль"],
  url: ["url", "login_uri", "web site", "website", "uri", "адрес", "адрес сайта"],
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
  const typeOf = v => { v = String(v || "").toLowerCase(); return ["note", "заметка", "securenote", "2"].includes(v) ? "note" : ["card", "карта", "3"].includes(v) ? "card" : v === "wi-fi" || v === "wifi" ? "wifi" : "login"; };
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
      `<div class="preview">${importRows.slice(0, 5).map(x => `<div class="entry compact"><div><b>${esc(x.title)}</b><small>${esc(x.login)}</small></div></div>`).join("")}${importRows.length > 5 ? `<p class="sub tight">${T("и ещё ", "and ")}${importRows.length - 5}${T("…", " more…")}</p>` : ""}</div>` +
      `<div class="warn">${T("Поддерживаются CSV из Chrome, Edge, Firefox, Bitwarden, KeePass, 1Password и Excel-выгрузка из Vault. После импорта удалите исходный файл — он не зашифрован.", "Supports CSV from Chrome, Edge, Firefox, Bitwarden, KeePass, 1Password and Vault's Excel export. Delete the source file after import — it is not encrypted.")}</div>`;
    show("import");
  } catch (err) { alertBox(T("Не удалось прочитать файл: ", "Could not read the file: ") + err.message); }
};
$("b-import-go").onclick = async () => {
  const keys = new Set(entries.map(x => x.title + "\u0000" + x.login + "\u0000" + x.pass)), now = Date.now(); let n = 0;
  for (const x of importRows) {
    const k = x.title + "\u0000" + x.login + "\u0000" + x.pass; if (keys.has(k)) continue; keys.add(k);
    entries.push({ ...x, id: b64(rand(9)), created: now, updated: now, pwChanged: now }); n++;
  }
  importRows = []; await persist(); openVaultView(); toast(T("Импортировано: ", "Imported: ") + n);
};

/* ---------------- Выход, удаление, автоблокировка ---------------- */
function lock() {
  vaultKey = null; entries = []; currentId = null; breached = new Map(); totpKeys.clear();
  $("list").innerHTML = ""; $("search").value = ""; $("audit-body").innerHTML = ""; $("import-body").innerHTML = ""; importRows = [];
  clearForm(); home();
}
$("b-logout").onclick = lock;
$("b-wipe").onclick = async () => {
  if (await confirmBox(T("Удалить профиль «", "Delete profile “") + (store.get().name || "") + T("» с этого устройства? Восстановить можно будет только по секретной фразе и резервной копии.", "” from this device? It can only be restored with the secret phrase and a backup."), T("Удалить", "Delete"), true)) { store.remove(currentId); lock(); }
};
let idle, hiddenTimer;
function resetIdle() { clearTimeout(idle); if (vaultKey) idle = setTimeout(lock, LOCK_IDLE_MS); }
["click", "keydown", "mousemove", "touchstart", "scroll"].forEach(ev => addEventListener(ev, resetIdle, { passive: true }));
document.addEventListener("visibilitychange", () => {
  clearTimeout(hiddenTimer);
  if (document.hidden && vaultKey) hiddenTimer = setTimeout(lock, LOCK_HIDDEN_MS);
});

/* ---------------- PWA ---------------- */
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("b-install").hidden = false; });
$("b-install").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("b-install").hidden = true; };
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

/* ---------------- Запуск ---------------- */
applyTheme();
initWords().then(() => { applyLang(); clearForm(); updGenUi(); home(); })
  .catch(err => { $("loading-msg").textContent = "Ошибка: " + err.message + ". Обновите страницу."; });
