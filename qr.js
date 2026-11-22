"use strict";
/* ======================================================================
   SHUT · Генератор QR-кода (ISO/IEC 18004), без сторонних библиотек.
   Байтовый режим, уровень коррекции L, версии 1–6 (до 134 байт) —
   этого хватает для кода подключения устройства. Проверено распознаванием ZXing в tests.html.
   ====================================================================== */
const QR_TOTAL = [0, 26, 44, 70, 100, 134, 172];      // всего кодовых слов в версии
const QR_EC_L = [0, 7, 10, 15, 20, 26, 18];          // слов коррекции на блок (уровень L)
const QR_BLOCKS_L = [0, 1, 1, 1, 1, 1, 2];           // блоков (уровень L)
const QR_ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
function qrGfMul(x, y) { let z = 0; for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
function qrRsDivisor(deg) {
  const r = new Array(deg).fill(0); r[deg - 1] = 1; let root = 1;
  for (let i = 0; i < deg; i++) { for (let j = 0; j < r.length; j++) { r[j] = qrGfMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = qrGfMul(root, 0x02); }
  return r;
}
function qrRsRemainder(data, div) {
  const r = new Array(div.length).fill(0);
  for (const b of data) { const f = b ^ r.shift(); r.push(0); div.forEach((c, i) => r[i] ^= qrGfMul(c, f)); }
  return r;
}
function qrEncode(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1; while (ver <= 6 && bytes.length > QR_TOTAL[ver] - QR_EC_L[ver] * QR_BLOCKS_L[ver] - 2) ver++;
  if (ver > 6) throw new Error("QR: слишком длинные данные");
  const dataCap = QR_TOTAL[ver] - QR_EC_L[ver] * QR_BLOCKS_L[ver];
  // биты: режим 0100, длина (8 бит), данные, терминатор, выравнивание, заполнители
  const bits = []; const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, dataCap * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let p = 0; data.length < dataCap; p ^= 1) data.push(p ? 0x11 : 0xEC);
  // блоки + коррекция, перемежение
  const nb = QR_BLOCKS_L[ver], ecLen = QR_EC_L[ver], div = qrRsDivisor(ecLen), total = QR_TOTAL[ver];
  const shortLen = Math.floor(total / nb), nShort = nb - total % nb, blocks = [];
  for (let i = 0, k = 0; i < nb; i++) {
    const dl = shortLen - ecLen + (i < nShort ? 0 : 1), dat = data.slice(k, k + dl); k += dl;
    const ec = qrRsRemainder(dat, div); if (i < nShort) dat.push(0); blocks.push(dat.concat(ec));
  }
  const cw = [];
  for (let i = 0; i < blocks[0].length; i++) blocks.forEach((b, j) => { if (i !== shortLen - ecLen || j >= nShort) cw.push(b[i]); });
  // матрица
  const size = ver * 4 + 17, m = Array.from({ length: size }, () => new Array(size).fill(false)), fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setF = (x, y, d) => { m[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy; if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = QR_ALIGN[ver];
  al.forEach((ay, i) => al.forEach((ax, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
  const drawFormat = mask => {
    const d = (1 << 3) | mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    const b = ((d << 10) | r) ^ 0x5412, g = i => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) setF(8, i, g(i));
    setF(8, 7, g(6)); setF(8, 8, g(7)); setF(7, 8, g(8));
    for (let i = 9; i < 15; i++) setF(14 - i, 8, g(i));
    for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, g(i));
    for (let i = 8; i < 15; i++) setF(8, size - 15 + i, g(i));
    setF(8, size - 8, true);
  };
  drawFormat(0); // резервируем область формата
  // размещение данных змейкой
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - v : v;
      if (!fn[y][x] && i < cw.length * 8) { m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
    }
  }
  const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
    (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const apply = k => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[k](x, y)) m[y][x] = !m[y][x]; };
  const penalty = () => { // упрощённая оценка: серии, блоки 2×2, баланс тёмных
    let p = 0, dark = 0;
    for (let y = 0; y < size; y++) { let run = 1; for (let x = 1; x < size; x++) { if (m[y][x] === m[y][x - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let x = 0; x < size; x++) { let run = 1; for (let y = 1; y < size; y++) { if (m[y][x] === m[y - 1][x]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
    m.forEach(r => r.forEach(c => { if (c) dark++; }));
    return p + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best = 0, bestP = Infinity;
  for (let k = 0; k < 8; k++) { apply(k); drawFormat(k); const p = penalty(); if (p < bestP) { bestP = p; best = k; } apply(k); }
  apply(best); drawFormat(best);
  return { size, modules: m, version: ver, mask: best };
}
// SVG (тёмные модули на белом, поле 4 модуля)
function qrSvg(text, px) {
  const q = qrEncode(text), n = q.size + 8; let d = "";
  q.modules.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x + 4} ${y + 4}h1v1h-1z`; }));
  return `<svg class="qr-svg" viewBox="0 0 ${n} ${n}"${px ? ` width="${px}" height="${px}"` : ""} shape-rendering="crispEdges" role="img" aria-label="QR"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
