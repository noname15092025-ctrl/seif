/* Argon2id (RFC 9106, версия 0x13) и BLAKE2b на чистом JavaScript.
   Проверяется по официальным тестовым векторам при запуске (см. argon2SelfTest). */
"use strict";
(function (root) {
  // ---------- BLAKE2b (64-битные слова как пары 32-битных: lo, hi) ----------
  const IV = new Uint32Array([
    0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
    0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19]);
  const SIGMA = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
    11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
    7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
    9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
    2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
    12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
    13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
    6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
    10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3];
  const v = new Uint32Array(32), m = new Uint32Array(32);

  function add64(a, b) { // v[a] += v[b]
    const lo = v[a] + v[b], hi = v[a + 1] + v[b + 1] + (lo / 0x100000000 >= 1 ? 1 : 0);
    v[a] = lo; v[a + 1] = hi;
  }
  function add64c(a, lo0, hi0) { // v[a] += (hi0:lo0)
    let lo = v[a] + lo0; if (lo0 < 0) lo += 0x100000000;
    let hi = v[a + 1] + hi0; if (lo >= 0x100000000) hi++;
    v[a] = lo; v[a + 1] = hi;
  }
  function G(a, b, c, d, ix, iy) {
    const x0 = m[ix], x1 = m[ix + 1], y0 = m[iy], y1 = m[iy + 1];
    add64(a, b); add64c(a, x0, x1);
    let xl = v[d] ^ v[a], xh = v[d + 1] ^ v[a + 1]; v[d] = xh; v[d + 1] = xl;              // ror 32
    add64(c, d);
    xl = v[b] ^ v[c]; xh = v[b + 1] ^ v[c + 1];
    v[b] = (xl >>> 24) ^ (xh << 8); v[b + 1] = (xh >>> 24) ^ (xl << 8);                     // ror 24
    add64(a, b); add64c(a, y0, y1);
    xl = v[d] ^ v[a]; xh = v[d + 1] ^ v[a + 1];
    v[d] = (xl >>> 16) ^ (xh << 16); v[d + 1] = (xh >>> 16) ^ (xl << 16);                   // ror 16
    add64(c, d);
    xl = v[b] ^ v[c]; xh = v[b + 1] ^ v[c + 1];
    v[b] = (xh >>> 31) ^ (xl << 1); v[b + 1] = (xl >>> 31) ^ (xh << 1);                     // ror 63
  }
  function compress(ctx, last) {
    for (let i = 0; i < 16; i++) { v[i] = ctx.h[i]; v[i + 16] = IV[i]; }
    v[24] ^= ctx.t; v[25] ^= ctx.t / 0x100000000;
    if (last) { v[28] = ~v[28]; v[29] = ~v[29]; }
    for (let i = 0; i < 32; i++) m[i] = ctx.b[4 * i] ^ (ctx.b[4 * i + 1] << 8) ^ (ctx.b[4 * i + 2] << 16) ^ (ctx.b[4 * i + 3] << 24);
    for (let i = 0; i < 12; i++) {
      const s = i * 16;
      G(0, 8, 16, 24, SIGMA[s] * 2, SIGMA[s + 1] * 2);
      G(2, 10, 18, 26, SIGMA[s + 2] * 2, SIGMA[s + 3] * 2);
      G(4, 12, 20, 28, SIGMA[s + 4] * 2, SIGMA[s + 5] * 2);
      G(6, 14, 22, 30, SIGMA[s + 6] * 2, SIGMA[s + 7] * 2);
      G(0, 10, 20, 30, SIGMA[s + 8] * 2, SIGMA[s + 9] * 2);
      G(2, 12, 22, 24, SIGMA[s + 10] * 2, SIGMA[s + 11] * 2);
      G(4, 14, 16, 26, SIGMA[s + 12] * 2, SIGMA[s + 13] * 2);
      G(6, 8, 18, 28, SIGMA[s + 14] * 2, SIGMA[s + 15] * 2);
    }
    for (let i = 0; i < 16; i++) ctx.h[i] = ctx.h[i] ^ v[i] ^ v[i + 16];
  }
  function b2bInit(outlen) {
    const ctx = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0, outlen };
    for (let i = 0; i < 16; i++) ctx.h[i] = IV[i];
    ctx.h[0] ^= 0x01010000 ^ outlen;
    return ctx;
  }
  function b2bUpdate(ctx, input) {
    for (let i = 0; i < input.length; i++) {
      if (ctx.c === 128) { ctx.t += ctx.c; compress(ctx, false); ctx.c = 0; }
      ctx.b[ctx.c++] = input[i];
    }
  }
  function b2bFinal(ctx) {
    ctx.t += ctx.c;
    while (ctx.c < 128) ctx.b[ctx.c++] = 0;
    compress(ctx, true);
    const out = new Uint8Array(ctx.outlen);
    for (let i = 0; i < ctx.outlen; i++) out[i] = ctx.h[i >> 2] >> (8 * (i & 3));
    return out;
  }
  function blake2b(input, outlen = 64) { const c = b2bInit(outlen); b2bUpdate(c, input); return b2bFinal(c); }

  // ---------- Argon2 ----------
  const le32 = n => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);
  function concat(...arrs) { const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }
  function Hprime(T, X) {
    const inp = concat(le32(T), X);
    if (T <= 64) return blake2b(inp, T);
    const out = new Uint8Array(T), r = Math.ceil(T / 32) - 2;
    let V = blake2b(inp, 64); out.set(V.subarray(0, 32), 0);
    for (let i = 1; i < r; i++) { V = blake2b(V, 64); out.set(V.subarray(0, 32), i * 32); }
    V = blake2b(V, T - 32 * r); out.set(V, r * 32);
    return out;
  }

  // Блок = 128 слов по 64 бита = 256 uint32 (lo, hi)
  const R = new Uint32Array(256), Z = new Uint32Array(256);
  function fBlaMka(B, a, b) { // B[a] = B[a] + B[b] + 2*lo(B[a])*lo(B[b])  (64 бита)
    const x = B[a], y = B[b];
    // 32x32→64 умножение через 16-битные части
    const x0 = x & 0xffff, x1 = x >>> 16, y0 = y & 0xffff, y1 = y >>> 16;
    const p00 = x0 * y0, p01 = x0 * y1, p10 = x1 * y0;
    let mlo = p00 + ((p01 & 0xffff) + (p10 & 0xffff)) * 65536;
    let mhi = x1 * y1 + (p01 >>> 16) + (p10 >>> 16);
    const c0 = Math.floor(mlo / 4294967296); mlo -= c0 * 4294967296; mhi += c0;
    // ×2
    mhi = mhi * 2 + (mlo >= 2147483648 ? 1 : 0); mlo = (mlo * 2) % 4294967296;
    let lo = x + y + mlo;
    const c1 = Math.floor(lo / 4294967296);
    B[a] = lo; B[a + 1] = B[a + 1] + B[b + 1] + mhi + c1;
  }
  function rotr(B, i, n) {
    const l = B[i], h = B[i + 1];
    if (n === 32) { B[i] = h; B[i + 1] = l; }
    else if (n < 32) { B[i] = (l >>> n) | (h << (32 - n)); B[i + 1] = (h >>> n) | (l << (32 - n)); }
    else { n -= 32; B[i] = (h >>> n) | (l << (32 - n)); B[i + 1] = (l >>> n) | (h << (32 - n)); }
  }
  function GB(B, a, b, c, d) {
    fBlaMka(B, a, b); B[d] ^= B[a]; B[d + 1] ^= B[a + 1]; rotr(B, d, 32);
    fBlaMka(B, c, d); B[b] ^= B[c]; B[b + 1] ^= B[c + 1]; rotr(B, b, 24);
    fBlaMka(B, a, b); B[d] ^= B[a]; B[d + 1] ^= B[a + 1]; rotr(B, d, 16);
    fBlaMka(B, c, d); B[b] ^= B[c]; B[b + 1] ^= B[c + 1]; rotr(B, b, 63);
  }
  function P(B, w) { // w — индексы 16 слов (в uint32 = *2)
    GB(B, w[0], w[4], w[8], w[12]); GB(B, w[1], w[5], w[9], w[13]);
    GB(B, w[2], w[6], w[10], w[14]); GB(B, w[3], w[7], w[11], w[15]);
    GB(B, w[0], w[5], w[10], w[15]); GB(B, w[1], w[6], w[11], w[12]);
    GB(B, w[2], w[7], w[8], w[13]); GB(B, w[3], w[4], w[9], w[14]);
  }
  const ROWS = [], COLS = [];
  for (let i = 0; i < 8; i++) {
    const r = [], c = [];
    for (let j = 0; j < 16; j++) r.push((16 * i + j) * 2);
    for (let j = 0; j < 8; j++) { c.push((2 * i + 16 * j) * 2, (2 * i + 1 + 16 * j) * 2); }
    ROWS.push(r); COLS.push(c);
  }
  // out = G(X, Y) (xorInto: out ^= G(X,Y))
  function compressG(mem, xOff, yOff, outOff, xorInto) {
    for (let i = 0; i < 256; i++) R[i] = mem[xOff + i] ^ mem[yOff + i];
    Z.set(R);
    for (let i = 0; i < 8; i++) P(Z, ROWS[i]);
    for (let i = 0; i < 8; i++) P(Z, COLS[i]);
    if (xorInto) for (let i = 0; i < 256; i++) mem[outOff + i] ^= Z[i] ^ R[i];
    else for (let i = 0; i < 256; i++) mem[outOff + i] = Z[i] ^ R[i];
  }

  function argon2id({ password, salt, secret = new Uint8Array(0), ad = new Uint8Array(0), t, m, p, tagLength = 32 }) {
    const mPrime = 4 * p * Math.floor(m / (4 * p)), q = mPrime / p, seg = q / 4;
    const H0 = blake2b(concat(le32(p), le32(tagLength), le32(m), le32(t), le32(0x13), le32(2),
      le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad), 64);
    const mem = new Uint32Array(mPrime * 256);
    const blk = (lane, col) => (lane * q + col) * 256;
    const load = (off, bytes) => { for (let i = 0; i < 256; i++) mem[off + i] = bytes[4 * i] | (bytes[4 * i + 1] << 8) | (bytes[4 * i + 2] << 16) | (bytes[4 * i + 3] << 24); };
    for (let l = 0; l < p; l++) {
      load(blk(l, 0), Hprime(1024, concat(H0, le32(0), le32(l))));
      load(blk(l, 1), Hprime(1024, concat(H0, le32(1), le32(l))));
    }
    // вспомогательная память для адресов Argon2i: [zero | input | addr | tmp]
    const aux = new Uint32Array(256 * 4);
    const ZERO = 0, INP = 256, ADDR = 512;
    function nextAddresses() {
      // ADDR = G(0, G(0, INP))
      const tmp = new Uint32Array(256 * 3); // используем compressG на отдельном буфере
      tmp.set(aux.subarray(INP, INP + 256), 256);
      compressG(tmp, 0, 256, 512, false);         // tmp[512] = G(0, input)
      compressG(tmp, 0, 512, 256, false);         // tmp[256] = G(0, tmp[512])
      aux.set(tmp.subarray(256, 512), ADDR);
    }
    for (let pass = 0; pass < t; pass++) {
      for (let slice = 0; slice < 4; slice++) {
        for (let lane = 0; lane < p; lane++) {
          const indep = pass === 0 && slice < 2;
          if (indep) {
            aux.fill(0, INP, INP + 256);
            aux[INP] = pass; aux[INP + 2] = lane; aux[INP + 4] = slice; aux[INP + 6] = mPrime;
            aux[INP + 8] = t; aux[INP + 10] = 2; aux[INP + 12] = 0;
          }
          let start = 0;
          if (pass === 0 && slice === 0) { start = 2; if (indep) { aux[INP + 12]++; nextAddresses(); } }
          for (let idx = start; idx < seg; idx++) {
            const col = slice * seg + idx;
            const prevCol = col === 0 ? q - 1 : col - 1;
            let J1, J2;
            if (indep) {
              if (idx % 128 === 0) { aux[INP + 12]++; nextAddresses(); }
              J1 = aux[ADDR + 2 * (idx % 128)]; J2 = aux[ADDR + 2 * (idx % 128) + 1];
            } else {
              const po = blk(lane, prevCol); J1 = mem[po]; J2 = mem[po + 1];
            }
            let refLane = J2 % p;
            if (pass === 0 && slice === 0) refLane = lane;
            const same = refLane === lane;
            let W;
            if (pass === 0) {
              W = slice * seg + (same ? idx - 1 : (idx === 0 ? -1 : 0));
            } else {
              W = q - seg + (same ? idx - 1 : (idx === 0 ? -1 : 0));
            }
            // x = J1^2 / 2^32; y = W*x / 2^32
            const x = mulHi(J1, J1), y = mulHi(W, x);
            const rel = W - 1 - y;
            const startPos = pass === 0 ? 0 : (slice === 3 ? 0 : (slice + 1) * seg);
            const refCol = (startPos + rel) % q;
            compressG(mem, blk(lane, prevCol), blk(refLane, refCol), blk(lane, col), pass > 0);
          }
        }
      }
    }
    const C = new Uint32Array(256);
    for (let l = 0; l < p; l++) { const o = blk(l, q - 1); for (let i = 0; i < 256; i++) C[i] ^= mem[o + i]; }
    const cb = new Uint8Array(1024);
    for (let i = 0; i < 256; i++) { cb[4 * i] = C[i]; cb[4 * i + 1] = C[i] >>> 8; cb[4 * i + 2] = C[i] >>> 16; cb[4 * i + 3] = C[i] >>> 24; }
    mem.fill(0);
    return Hprime(tagLength, cb);
  }
  function mulHi(a, b) { // floor(a*b / 2^32) для 32-битных a, b
    const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
    const lo = a0 * b0, mid1 = a1 * b0 + (lo >>> 16), mid2 = a0 * b1 + (mid1 & 0xffff);
    return (a1 * b1 + (mid1 >>> 16) + (mid2 >>> 16)) >>> 0;
  }

  const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, "0")).join("");
  function argon2SelfTest() {
    const fill = (n, b) => new Uint8Array(n).fill(b);
    const ok1 = hex(blake2b(new TextEncoder().encode("abc"))) ===
      "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923";
    const ok2 = hex(argon2id({ password: fill(32, 1), salt: fill(16, 2), secret: fill(8, 3), ad: fill(12, 4), t: 3, m: 32, p: 4 })) ===
      "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659";
    return ok1 && ok2;
  }
  root.Argon2 = { argon2id, blake2b, argon2SelfTest, hex };
})(typeof self !== "undefined" ? self : globalThis);
