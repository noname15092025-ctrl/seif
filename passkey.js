"use strict";
/* ======================================================================
   SHUT · Вход по ключу доступа (passkey) на сайте — аналог Face ID в iOS-приложении.
   Используется расширение WebAuthn PRF: ключ доступа (Windows Hello, Touch ID, Android,
   iCloud Keychain, аппаратный ключ) после проверки лица/отпечатка/PIN выдаёт секрет,
   из которого получается ключ шифрования. Им зашифрован ключ сейфа.
   Мастер-пароль нигде не хранится; без самого ключа доступа сохранённое не расшифровать.
   Сервера нет: всё происходит в браузере.
   ====================================================================== */
const pkSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext) && !(typeof NATIVE !== "undefined" && NATIVE);
const PK_INFO = new TextEncoder().encode("SHUT passkey vault key v1");
async function pkWrapKey(prfOut, salt) {
  const base = await crypto.subtle.importKey("raw", prfOut, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: PK_INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function pkAssert(pk) {
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), userVerification: "required", timeout: 120000,
    allowCredentials: [{ type: "public-key", id: unb64(pk.id) }],
    extensions: { prf: { eval: { first: unb64(pk.salt) } } } } });
  const r = cred && cred.getClientExtensionResults().prf;
  if (!r || !r.results || !r.results.first) throw Object.assign(new Error("prf"), { code: "noprf" });
  return new Uint8Array(r.results.first);
}
// Включение: проверяем мастер-пароль, создаём ключ доступа, шифруем им ключ сейфа
async function pkEnable(pw) {
  const s = store.get(); if (!s) return;
  let raw;
  try { raw = await open(await wrapKeyFrom(pw, s), s.wrapped); }
  catch { throw Object.assign(new Error("pw"), { code: "pw" }); }
  try {
    const salt = rand(32);
    const cred = await navigator.credentials.create({ publicKey: {
      challenge: rand(32), rp: { name: "SHUT" },
      user: { id: rand(16), name: (s.name || "SHUT") + " · SHUT", displayName: s.name || "SHUT" },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" }, timeout: 120000,
      extensions: { prf: { eval: { first: salt } } } } });
    const ext = cred.getClientExtensionResults().prf;
    if (!ext || ext.enabled === false) throw Object.assign(new Error("prf"), { code: "noprf" });
    const pk = { id: b64(new Uint8Array(cred.rawId)), salt: b64(salt) };
    let out = ext.results && ext.results.first ? new Uint8Array(ext.results.first) : await pkAssert(pk); // часть ключей отдаёт секрет только при входе
    const wk = await pkWrapKey(out, salt); out.fill(0);
    pk.box = await seal(wk, raw); pk.at = Date.now();
    s.pk = pk; store.set(s);
  } finally { raw.fill(0); }
}
function pkDisable() { const s = store.get(); if (s && s.pk) { delete s.pk; store.set(s); } }
// Вход
let pkBusy = false;
async function pkUnlock() {
  const s = store.get(); if (!s || !s.pk || pkBusy || vaultKey) return;
  pkBusy = true; $("unlock-err").textContent = "";
  let raw = null;
  try {
    const out = await pkAssert(s.pk);
    raw = await open(await pkWrapKey(out, unb64(s.pk.salt)), s.pk.box); out.fill(0);
  } catch (e) {
    pkBusy = false;
    if (e && e.name === "NotAllowedError") return; // отменили окно
    $("unlock-err").textContent = e && e.code === "noprf" ? T("Этот ключ доступа не поддерживает вход в сейф. Войдите по паролю.", "This passkey can't unlock the vault. Sign in with your password.")
      : T("Не удалось войти по ключу доступа. Войдите по паролю.", "Passkey sign-in failed. Sign in with your password.");
    return;
  }
  try {
    vaultKey = await importVaultKey(raw);
    entries = JSON.parse(dec.decode(await open(vaultKey, s.vault))).map(migrateEntry);
  } catch { raw.fill(0); vaultKey = null; entries = []; pkBusy = false; $("unlock-err").textContent = T("Сохранённый ключ не подошёл — войдите по паролю.", "The saved key didn't fit — sign in with your password."); return; }
  s.fails = 0; s.lockUntil = 0; s.lastLogin = Date.now();
  saveSession(raw, s.id); try { localStorage.setItem("vault.last", s.id); } catch {}
  try { await ensureSyncIds(s, raw); } catch {}
  raw.fill(0); store.set(s);
  if (syncUrl()) setTimeout(() => { const cur = store.get(); if (cur && vaultKey) syncPull(cur).catch(() => {}); }, 200);
  $("unlock-pw").value = ""; pkBusy = false;
  openVaultView();
}
function pkUpdateBtn() {
  const b = $("b-pk"); if (!b) return;
  const s = currentId && store.all().find(p => p.id === currentId);
  b.classList.toggle("hidden", !(pkSupported() && s && s.pk));
}
function pkRefreshSetting() {
  const row = $("pk-row"); if (!row) return;
  const s = store.get(), on = !!(s && s.pk);
  row.classList.toggle("hidden", !pkSupported());
  $("pk-on").classList.toggle("hidden", !on); $("pk-off").classList.toggle("hidden", on);
  $("pk-err").textContent = ""; $("pk-pw").value = "";
}
if ($("b-pk")) $("b-pk").onclick = () => pkUnlock();
if ($("b-pk-en")) $("b-pk-en").onclick = async e => {
  const pw = $("pk-pw").value; if (!pw) { $("pk-err").textContent = T("Введите мастер-пароль", "Enter your master password"); return; }
  busy(e.target, true, T("Создаю ключ…", "Creating passkey…"));
  try { await pkEnable(pw); pkRefreshSetting(); toast(T("Вход по ключу доступа включён", "Passkey sign-in is on")); }
  catch (err) {
    $("pk-err").textContent = err.code === "pw" ? T("Неверный мастер-пароль", "Wrong master password")
      : err.code === "noprf" ? T("Этот браузер или ключ доступа не поддерживает нужную функцию (PRF). Попробуйте Chrome, Edge или Safari 18+ с ключом в Google или iCloud.", "This browser or passkey doesn't support the required feature (PRF). Try Chrome, Edge or Safari 18+ with a Google or iCloud passkey.")
      : err.name === "NotAllowedError" ? T("Создание ключа отменено", "Passkey creation was cancelled") : T("Не удалось создать ключ доступа: ", "Could not create a passkey: ") + (err.message || "");
  }
  busy(e.target, false, "");
};
if ($("b-pk-off")) $("b-pk-off").onclick = async () => {
  if (!(await confirmBox(T("Выключить вход по ключу доступа на этом устройстве? Сам ключ останется в менеджере ключей — его можно удалить там.", "Turn off passkey sign-in on this device? The passkey itself stays in your passkey manager — you can delete it there."), T("Выключить", "Turn off"), true))) return;
  pkDisable(); pkRefreshSetting(); toast(T("Вход по ключу доступа выключен", "Passkey sign-in is off"));
};
