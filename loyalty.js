"use strict";
/* ======================================================================
   SHUT · Скидочные карты: каталог магазинов, штрихкод на экране, сканер.
   Всё работает на устройстве: номер карты никуда не отправляется.
   ====================================================================== */

// Каталог популярных сетей (Беларусь, Россия, онлайн). Логотипов нет — плитка в фирменном цвете с названием.
// c — цвет фона, t — цвет текста (по умолчанию белый).
const LOYALTY_BRANDS = [
  // Беларусь
  ["Евроопт", "#E30613"], ["Хит!", "#E30613"], ["Грошык", "#F7B500", "#111"], ["Гиппо", "#00843D"], ["Соседи", "#F39200"],
  ["Корона", "#0B3D91"], ["Санта", "#D7141A"], ["Green", "#2BA84A"], ["Алми", "#E2001A"], ["Виталюр", "#00965E"],
  ["Белмаркет", "#E4002B"], ["Рублёвский", "#C8102E"], ["ProStore", "#0057A8"], ["Mile", "#E30613"], ["Остров чистоты", "#1E5BB8"],
  ["Три цены", "#3A3A3A"], ["Fix Price", "#8DC63F", "#0B3B8C"], ["Мила", "#E6007E"], ["Буслік", "#F58220"], ["Детский мир", "#0072BC"],
  ["5 элемент", "#E30613"], ["Электросила", "#0055A4"], ["OZ.by", "#0FA14A"], ["Белвиллесден", "#00965E"], ["Гаврош", "#E30613"],
  ["Магия", "#7B2B83"], ["Летуаль", "#111111"], ["Sportmaster", "#1C1C1C"], ["Belwest", "#111111"], ["Марко", "#7A1F2B"],
  ["Купилка", "#F39200"], ["Еплюс", "#1D1D1B", "#9BD83F"], ["Белоруснефть", "#0B5394"], ["А-100", "#E30613"], ["Лукойл", "#E30613"],
  // Россия
  ["Пятёрочка", "#E31E24"], ["Перекрёсток", "#0B6E2E"], ["Магнит", "#E30613"], ["Лента", "#003F87"], ["Ашан", "#E2001A"],
  ["ВкусВилл", "#2DB34A"], ["Дикси", "#F37021"], ["Глобус", "#F9B200", "#111"], ["О'кей", "#E30613"], ["Метро", "#002D72", "#FFDD00"],
  ["Ozon", "#005BFF"], ["Wildberries", "#A73AFD"], ["Lamoda", "#111111"], ["Золотое яблоко", "#111111", "#E7C766"], ["Рив Гош", "#111111"],
  ["М.Видео", "#E30613"], ["Эльдорадо", "#1C1C1C", "#E7FF2E"], ["DNS", "#FC8507"], ["Леруа Мерлен", "#78BE20"], ["Детский мир (РФ)", "#0072BC"],
  ["ИКЕА", "#0058A3", "#FFDA1A"], ["Спортмастер", "#E30613"], ["Аптека Ригла", "#00A0DF"], ["Читай-город", "#E30613"]
].map(([n, c, t]) => ({ n, c, t: t || "#FFFFFF" }));
const brandByName = n => LOYALTY_BRANDS.find(b => b.n.toLowerCase() === String(n || "").trim().toLowerCase()) || null;
// Цвет для своего магазина (не из каталога) — стабильный, от названия
function brandColor(name) {
  const b = brandByName(name); if (b) return b;
  let h = 0; for (const ch of String(name || "?")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return { n: name, c: `hsl(${h % 360} 45% 34%)`, t: "#FFFFFF" };
}

/* ---------------- Штрихкоды (SVG) ---------------- */
const C128 = ["212222","222122","222221","121223","121322","131222","122213","122312","132212","221213","221312","231212","112232","122132","122231","113222","123122","123221","223211","221132","221231","213212","223112","312131","311222","321122","321221","312212","322112","322211","212123","212321","232121","111323","131123","131321","112313","132113","132311","211313","231113","231311","112133","112331","132131","113123","113321","133121","313121","211331","231131","213113","213311","213131","311123","311321","331121","312113","312311","332111","314111","221411","431111","111224","111422","121124","121421","141122","141221","112214","112412","122114","122411","142112","142211","241211","221114","413111","241112","134111","111242","121142","121241","114212","124112","124211","411212","421112","421211","212141","214121","412121","111143","111341","131141","114113","114311","411113","411311","113141","114131","311141","411131","211412","211214","211232","2331112"];
// Code 128: только цифры чётной длины — набор C (компактнее), иначе набор B
function code128Modules(text) {
  const codes = [];
  if (/^\d+$/.test(text) && text.length % 2 === 0 && text.length >= 4) {
    codes.push(105); for (let i = 0; i < text.length; i += 2) codes.push(+text.slice(i, i + 2));
  } else {
    codes.push(104);
    for (const ch of text) { const v = ch.charCodeAt(0) - 32; if (v < 0 || v > 94) return null; codes.push(v); }
  }
  let sum = codes[0]; for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, 106);
  let bits = "";
  codes.forEach(c => [...C128[c]].forEach((w, i) => bits += (i % 2 ? "0" : "1").repeat(+w)));
  return bits;
}
const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const EAN_G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const EAN_R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const EAN_P = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];
function eanValid(d) {
  if (!/^\d{8}$|^\d{13}$/.test(d)) return false;
  const n = d.split("").map(Number), chk = n.pop();
  const s = n.reverse().reduce((a, v, i) => a + v * (i % 2 ? 1 : 3), 0);
  return (10 - s % 10) % 10 === chk;
}
function ean13Modules(d) {
  const p = EAN_P[+d[0]]; let bits = "101";
  for (let i = 1; i <= 6; i++) bits += (p[i - 1] === "L" ? EAN_L : EAN_G)[+d[i]];
  bits += "01010";
  for (let i = 7; i <= 12; i++) bits += EAN_R[+d[i]];
  return bits + "101";
}
function ean8Modules(d) {
  let bits = "101"; for (let i = 0; i < 4; i++) bits += EAN_L[+d[i]];
  bits += "01010"; for (let i = 4; i < 8; i++) bits += EAN_R[+d[i]];
  return bits + "101";
}
// Формат: если сканер сказал EAN — EAN; если 13/8 цифр с верной контрольной суммой — EAN; иначе Code 128
function barcodeFormat(num, hint) {
  const d = String(num || "").replace(/\s/g, "");
  if ((hint === "qr_code" || hint === "qr")) return "qr";
  if (eanValid(d) && (!hint || /ean/.test(hint) || hint === "auto")) return d.length === 13 ? "ean13" : "ean8";
  return "code128";
}
// SVG-разметка штрихкода. Возвращает "" для QR (показываем номер крупно).
function barcodeSvg(num, fmt) {
  const d = String(num || "").replace(/\s/g, "");
  fmt = fmt && fmt !== "auto" ? fmt : barcodeFormat(d);
  let bits = null;
  if (fmt === "ean13" && eanValid(d) && d.length === 13) bits = ean13Modules(d);
  else if (fmt === "ean8" && eanValid(d) && d.length === 8) bits = ean8Modules(d);
  else if (fmt !== "qr") bits = code128Modules(d);
  if (!bits) return "";
  const q = 10, w = bits.length + q * 2; let rects = "", i = 0;
  while (i < bits.length) {
    if (bits[i] === "1") { let j = i; while (bits[j] === "1") j++; rects += `<rect x="${i + q}" y="0" width="${j - i}" height="60"/>`; i = j; } else i++;
  }
  return `<svg class="bc-svg" viewBox="0 0 ${w} 60" preserveAspectRatio="none" role="img" aria-label="${d}">${rects}</svg>`;
}

/* ---------------- Сканер (камера или фото) ---------------- */
// Нативный BarcodeDetector есть в Chrome на Android. На iPhone (Safari) его нет —
// тогда используется библиотека ZXing из vendor/zxing.min.js, если она подключена.
const SCAN_FORMATS = ["ean_13", "ean_8", "code_128", "code_39", "code_93", "codabar", "itf", "upc_a", "upc_e", "qr_code", "pdf417", "data_matrix"];
const ZX_FMT = { EAN_13: "ean_13", EAN_8: "ean_8", CODE_128: "code_128", CODE_39: "code_39", CODE_93: "code_93", CODABAR: "codabar", ITF: "itf", UPC_A: "upc_a", UPC_E: "upc_e", QR_CODE: "qr_code", PDF_417: "pdf417", DATA_MATRIX: "data_matrix" };
let zxLoad = null;
function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  if (zxLoad) return zxLoad;
  zxLoad = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = "vendor/zxing.min.js";
    s.onload = () => window.ZXing ? res(window.ZXing) : rej(new Error("zxing"));
    s.onerror = () => { zxLoad = null; rej(new Error("zxing")); };
    document.head.appendChild(s);
  });
  return zxLoad;
}
async function nativeDetector() {
  if (!("BarcodeDetector" in window)) return null;
  try {
    const sup = await BarcodeDetector.getSupportedFormats();
    const f = SCAN_FORMATS.filter(x => sup.includes(x)); if (!f.length) return null;
    return new BarcodeDetector({ formats: f });
  } catch { return null; }
}
async function makeDecoder() {
  const nd = await nativeDetector();
  if (nd) return async src => { const r = await nd.detect(src); return r && r[0] ? { text: r[0].rawValue, format: r[0].format } : null; };
  const ZX = await loadZxing();
  const reader = new ZX.MultiFormatReader();
  const hints = new Map(); hints.set(ZX.DecodeHintType.TRY_HARDER, true); reader.setHints(hints);
  const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });
  return async src => {
    const w = src.videoWidth || src.naturalWidth || src.width, h = src.videoHeight || src.naturalHeight || src.height;
    if (!w || !h) return null;
    const k = Math.min(1, 1280 / Math.max(w, h)); cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    const lum = new ZX.HTMLCanvasElementLuminanceSource(cv);
    try { const r = reader.decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(lum)));
      return { text: r.getText(), format: ZX_FMT[ZX.BarcodeFormat[r.getBarcodeFormat()]] || "" }; }
    catch { return null; }
  };
}
// Открывает окно сканера. Возвращает {text, format} или null.
function scanBarcode() {
  return new Promise(async resolve => {
    const ov = document.createElement("div"); ov.className = "scan-ov";
    ov.innerHTML = `<div class="scan-box"><video class="scan-video" playsinline muted></video><span class="scan-frame"></span>
      <p class="scan-msg">${T("Наведите камеру на штрихкод карты", "Point the camera at the card barcode")}</p>
      <div class="scan-btns"><label class="pill ghost scan-photo">${T("Из фото", "From photo")}<input type="file" accept="image/*" hidden></label>
      <button type="button" class="pill scan-close">${T("Отмена", "Cancel")}</button></div></div>`;
    document.body.appendChild(ov);
    const video = ov.querySelector("video"), msg = ov.querySelector(".scan-msg");
    let stream = null, done = false, decode = null;
    const finish = r => {
      if (done) return; done = true;
      if (stream) stream.getTracks().forEach(t => t.stop());
      ov.remove(); resolve(r);
    };
    ov.querySelector(".scan-close").onclick = () => finish(null);
    try { decode = await makeDecoder(); }
    catch { msg.textContent = T("На этом устройстве сканер недоступен. Введите номер вручную.", "Scanning is not available on this device. Enter the number manually."); return; }
    ov.querySelector("input[type=file]").onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      const img = new Image(); const url = URL.createObjectURL(f); img.src = url;
      try { await img.decode(); const r = await decode(img); URL.revokeObjectURL(url);
        if (r) finish(r); else msg.textContent = T("На фото штрихкод не найден. Попробуйте ближе и ровнее.", "No barcode found in the photo. Try closer and straighter."); }
      catch { URL.revokeObjectURL(url); msg.textContent = T("Не удалось открыть фото", "Could not open the photo"); }
    };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { msg.textContent = T("Камера недоступна — выберите фото штрихкода.", "Camera unavailable — choose a photo of the barcode."); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch { msg.textContent = T("Нет доступа к камере. Разрешите камеру в настройках или выберите фото.", "No camera access. Allow the camera in settings or choose a photo."); return; }
    if (done) { stream.getTracks().forEach(t => t.stop()); return; }
    video.srcObject = stream; try { await video.play(); } catch {}
    const tick = async () => {
      if (done) return;
      if (video.readyState >= 2) { try { const r = await decode(video); if (r && r.text) { if (navigator.vibrate) navigator.vibrate(40); return finish(r); } } catch {} }
      setTimeout(tick, 180);
    };
    tick();
  });
}

/* ---------------- Интеграция с формой и карточкой (вызывается из app.js) ---------------- */
let loyaltyFmt = "auto"; // формат, который сообщил сканер (ean_13, code_128…), или auto

// Фирменные цвета ставим через CSSOM: CSP сайта запрещает style="" в разметке
function paintBrands(root) {
  root.querySelectorAll("[data-brand]").forEach(el => { const b = brandColor(el.dataset.brand); el.style.background = b.c; el.style.color = b.t; });
}

// Автоопределение магазина по номеру: ищем среди ваших карт ту, у которой совпадает начало номера
// (сети выдают номера сериями). Данные не покидают устройство.
function guessBrand(num) {
  const d = String(num || "").replace(/\s/g, ""); if (d.length < 6) return null;
  let best = null, bestLen = 0;
  live().forEach(x => {
    if (x.type !== "loyalty" || x.id === editingId || !x.f || !x.f.num) return;
    const o = x.f.num; let i = 0; while (i < o.length && i < d.length && o[i] === d[i]) i++;
    if (i >= 5 && i > bestLen && Math.abs(o.length - d.length) <= 1) { best = x.title; bestLen = i; }
  });
  return best;
}

function loyaltyFormSetup() {
  const title = $("e-title");
  if (formType !== "loyalty") { title.removeAttribute("list"); title.placeholder = ""; return; }
  if (!$("brand-list")) {
    const dl = document.createElement("datalist"); dl.id = "brand-list";
    dl.innerHTML = LOYALTY_BRANDS.map(b => `<option value="${esc(b.n)}">`).join(""); document.body.appendChild(dl);
  }
  title.setAttribute("list", "brand-list");
  title.placeholder = T("Начните вводить: Евроопт, Гиппо…", "Start typing the store name…");
  const num = $("ex-num"); if (!num || num.dataset.ready) return;
  num.dataset.ready = "1"; num.setAttribute("inputmode", "numeric");
  const tools = document.createElement("div"); tools.className = "lc-tools";
  tools.innerHTML = `<button type="button" class="ghost lc-scan" id="b-lc-scan">${ci("camera")}${T("Сканировать штрихкод", "Scan barcode")}</button><span class="lc-guess muted small" id="lc-guess"></span><div class="lc-preview" id="lc-preview"></div>`;
  num.after(tools);
  const upd = () => {
    const v = num.value.replace(/\s/g, "");
    const g = !title.value.trim() && guessBrand(v);
    $("lc-guess").innerHTML = g ? `${T("Похоже на карту", "Looks like a card from")} <a href="#" id="lc-guess-use">«${esc(g)}»</a>` : "";
    const a = $("lc-guess-use"); if (a) a.onclick = e => { e.preventDefault(); title.value = g; formDirty = true; upd(); };
    $("lc-preview").innerHTML = v.length >= 4 ? barcodeSvg(v, barcodeFormat(v, loyaltyFmt)) : "";
  };
  num.addEventListener("input", () => { loyaltyFmt = "auto"; upd(); });
  title.addEventListener("input", upd);
  $("b-lc-scan").onclick = async () => {
    const r = await scanBarcode(); if (!r) return;
    num.value = r.text.trim(); loyaltyFmt = r.format || "auto"; formDirty = true;
    const g = !title.value.trim() && guessBrand(num.value); if (g) title.value = g;
    upd(); if (!title.value.trim()) title.focus();
    toast(T("Номер считан", "Number scanned"));
  };
  upd();
}

// Крупный штрихкод для кассы
function showBarcodeFull(x) {
  const f = x.f || {}, svg = barcodeSvg(f.num, f.fmt);
  const ov = document.createElement("div"); ov.className = "lc-full";
  ov.innerHTML = `<div class="lc-full-head" data-brand="${esc(x.title)}"><span>${esc(x.title)}</span><button type="button" class="lc-full-x" aria-label="${T("Закрыть", "Close")}">✕</button></div>
    <div class="lc-full-code">${svg}<span class="lc-full-num mono">${esc(f.num || "")}</span></div>
    <p class="lc-full-tip">${T("Прибавьте яркость экрана, если касса не считывает", "Turn up screen brightness if the scanner can't read it")}</p>`;
  paintBrands(ov); document.body.appendChild(ov);
  const onKey = e => { if (e.key === "Escape") close(); };
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  ov.querySelector(".lc-full-x").onclick = close; ov.onclick = e => { if (e.target === ov) close(); };
  document.addEventListener("keydown", onKey);
}
