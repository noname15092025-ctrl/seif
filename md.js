"use strict";
/* ======================================================================
   SHUT · Markdown для заметок. Безопасный: сначала экранируем текст, потом
   расставляем только свои теги. Поддерживает:
   # заголовки, **жирный**, *курсив*, ~~зачёркнутый~~, ==выделение==, ||спойлер||,
   `код`, ```блок кода```, > цитата, > [!ВАЖНО] callout, ---, ссылки [текст](https://…),
   [[Заметка]] / [[Заметка|подпись]], списки (вложенные через 2 пробела или Tab),
   - [ ] задачи с подзадачами, таблицы | a | b | с формулами (=SUM(B1:B3), =B1*C1, =SUM(ABOVE)),
   сноски [^1] … [^1]: текст.
   ====================================================================== */
const mdEsc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function mdInline(s, ctx) {
  ctx = ctx || {};
  const code = [];
  s = mdEsc(s).replace(/`([^`]+)`/g, (m, c) => { code.push(c); return "\u0000" + (code.length - 1) + "\u0000"; });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
  s = s.replace(/\|\|([^|\n]+)\|\|/g, '<span class="md-spoiler" tabindex="0" title="Показать">$1</span>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g, (m, t, label) => {
    const title = t.trim(), exists = ctx.noteExists ? ctx.noteExists(title.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')) : true;
    return `<a class="md-wiki${exists ? "" : " missing"}" data-wiki="${title}" href="#">${(label || t).trim()}</a>`;
  });
  s = s.replace(/\[\^([^\]\s]+)\]/g, (m, id) => {
    if (!ctx.fn) return m;
    let n = ctx.fn.order.indexOf(id); if (n < 0) { ctx.fn.order.push(id); n = ctx.fn.order.length - 1; }
    return `<sup class="md-fn"><a href="#fn-${ctx.fn.uid}-${n + 1}" data-fn="${n + 1}">${n + 1}</a></sup>`;
  });
  s = s.replace(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu, '$1<span class="md-tag" data-tag="$2">#$2</span>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${code[+i]}</code>`);
}

/* ---------- формулы в таблицах ---------- */
const MD_FN = {
  SUM: a => a.reduce((x, y) => x + y, 0), PRODUCT: a => a.reduce((x, y) => x * y, 1),
  AVG: a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, AVERAGE: a => MD_FN.AVG(a),
  MEDIAN: a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; },
  MIN: a => a.length ? Math.min(...a) : 0, MAX: a => a.length ? Math.max(...a) : 0, COUNT: a => a.length,
  ABS: a => Math.abs(a[0]), SQRT: a => Math.sqrt(a[0]), ROUND: a => { const p = 10 ** (a[1] || 0); return Math.round(a[0] * p) / p; },
  FLOOR: a => Math.floor(a[0]), CEIL: a => Math.ceil(a[0])
};
const mdNum = v => { if (typeof v === "number") return v; const s = String(v ?? "").replace(/\s/g, "").replace(/[^\d.,\-]/g, "").replace(",", "."); return s && !isNaN(+s) ? +s : NaN; };
const mdColIdx = L => L.split("").reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
// grid — значения тела таблицы (строки данных), r,c — текущая ячейка. A1 = первая строка данных, первый столбец.
function mdFormula(expr, grid, r, c, depth) {
  if (depth > 20) throw new Error("цикл");
  const src = expr.toUpperCase().replace(/\s+/g, ""); let i = 0;
  const cell = (rr, cc) => { if (rr === r && cc === c) throw new Error("цикл"); const raw = (grid[rr] || [])[cc]; if (raw == null) return NaN; const t = String(raw).trim(); return t.startsWith("=") ? mdFormula(t.slice(1), grid, rr, cc, depth + 1) : mdNum(t); };
  const range = (a, b) => { const out = []; for (let rr = Math.min(a.r, b.r); rr <= Math.max(a.r, b.r); rr++) for (let cc = Math.min(a.c, b.c); cc <= Math.max(a.c, b.c); cc++) { const v = cell(rr, cc); if (!isNaN(v)) out.push(v); } return out; };
  const ref = () => { const m = /^([A-Z]{1,2})(\d{1,4})/.exec(src.slice(i)); if (!m) return null; i += m[0].length; return { c: mdColIdx(m[1]), r: +m[2] - 1 }; };
  const args = () => { // аргументы функции: диапазоны, ABOVE/LEFT, выражения
    const out = []; if (src[i] === ")") { i++; return out; }
    for (;;) {
      if (src.startsWith("ABOVE", i)) { i += 5; for (let rr = 0; rr < r; rr++) { const v = cell(rr, c); if (!isNaN(v)) out.push(v); } }
      else if (src.startsWith("LEFT", i)) { i += 4; for (let cc = 0; cc < c; cc++) { const v = cell(r, cc); if (!isNaN(v)) out.push(v); } }
      else { const save = i, a = ref(); if (a && src[i] === ":") { i++; const b = ref(); if (!b) throw new Error("диапазон"); out.push(...range(a, b)); } else { i = save; out.push(expr0()); } }
      if (src[i] === ",") { i++; continue; } if (src[i] === ")") { i++; return out; } throw new Error("скобка");
    }
  };
  const atom = () => {
    if (src[i] === "(") { i++; const v = expr0(); if (src[i++] !== ")") throw new Error("скобка"); return v; }
    if (src[i] === "-") { i++; return -atom(); }
    const fm = /^([A-Z]{2,8})\(/.exec(src.slice(i)); if (fm && MD_FN[fm[1]]) { i += fm[0].length; return MD_FN[fm[1]](args()); }
    if (/^(PI)\b/.test(src.slice(i))) { i += 2; return Math.PI; }
    const a = ref(); if (a) return cell(a.r, a.c);
    const nm = /^\d+(?:[.,]\d+)?/.exec(src.slice(i)); if (nm) { i += nm[0].length; return +nm[0].replace(",", "."); }
    throw new Error("значение");
  };
  const term = () => { let v = atom(); while (src[i] === "*" || src[i] === "/" || src[i] === "%") { const o = src[i++], b = atom(); v = o === "*" ? v * b : o === "/" ? v / b : v % b; } return v; };
  const expr0 = () => { let v = term(); while (src[i] === "+" || src[i] === "-") { const o = src[i++], b = term(); v = o === "+" ? v + b : v - b; } return v; };
  const v = expr0(); if (i < src.length) throw new Error("лишнее"); return v;
}
const mdFmtNum = v => !isFinite(v) ? "—" : Math.abs(v) >= 1e15 ? v.toExponential(3) : (Math.round(v * 1e6) / 1e6).toLocaleString(typeof lang !== "undefined" && lang === "en" ? "en-GB" : "ru-RU", { maximumFractionDigits: 6 });
const mdSplitRow = ln => { let s = ln.trim(); if (s.startsWith("|")) s = s.slice(1); if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1); return s.split(/(?<!\\)\|/).map(x => x.trim().replace(/\\\|/g, "|")); };
function mdTable(head, align, rows, ctx) {
  const al = a => a ? ` class="md-${a}"` : "";
  const body = rows.map((row, r) => "<tr>" + head.map((_, c) => {
    const raw = row[c] ?? "";
    if (/^=/.test(raw)) {
      let out; try { out = `<span class="md-calc" title="${mdEsc(raw)}">${mdFmtNum(mdFormula(raw.slice(1), rows, r, c, 0))}</span>`; }
      catch (e) { out = `<span class="md-calc err" title="${mdEsc(raw)}">#${typeof T === "function" ? T("ОШИБКА", "ERROR") : "ERR"}</span>`; }
      return `<td${al(align[c] || "right")}>${out}</td>`;
    }
    return `<td${al(align[c])}>${mdInline(raw, ctx)}</td>`;
  }).join("") + "</tr>").join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((h, c) => `<th${al(align[c])}>${mdInline(h, ctx)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/* ---------- разметка блоков ---------- */
let mdUid = 0;
function mdToHtml(src, opts) {
  opts = opts || {};
  const ctx = { noteExists: opts.noteExists, fn: { order: [], uid: ++mdUid } };
  const lines = (src || "").replace(/\r/g, "").split("\n");
  // сноски: "[^id]: текст" выносим вниз
  const fnDefs = {}; const rest = [];
  lines.forEach(l => { const m = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(l); if (m) fnDefs[m[1]] = m[2]; else rest.push(l); });
  let html = "", i = 0, cbIndex = 0;
  const L = rest;
  const isList = ln => /^(\s*)([-*+]|\d+\.)\s+/.test(ln);
  const indentOf = ln => { const m = /^(\s*)/.exec(ln)[1].replace(/\t/g, "  "); return Math.floor(m.length / 2); };
  while (i < L.length) {
    const ln = L[i];
    if (/^```/.test(ln)) { const lang_ = ln.slice(3).trim(); let code = ""; i++; while (i < L.length && !/^```/.test(L[i])) { code += L[i] + "\n"; i++; } i++; html += `<pre${lang_ ? ` data-lang="${mdEsc(lang_)}"` : ""}><code>${mdEsc(code)}</code></pre>`; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { html += "<hr>"; i++; continue; }
    const h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { const txt = h[2]; const slug = txt.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, ""); html += `<h${h[1].length} id="h-${mdEsc(slug)}">${mdInline(txt, ctx)}</h${h[1].length}>`; i++; continue; }
    // таблица: строка с |, затем разделитель |---|:--:|
    if (/\|/.test(ln) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(L[i + 1])) {
      const head = mdSplitRow(ln), align = mdSplitRow(L[i + 1]).map(a => /^:-+:$/.test(a) ? "center" : /-:$/.test(a) ? "right" : /^:-/.test(a) ? "left" : "");
      i += 2; const rows = [];
      while (i < L.length && /\|/.test(L[i]) && !/^\s*$/.test(L[i])) { rows.push(mdSplitRow(L[i])); i++; }
      html += mdTable(head, align, rows, ctx); continue;
    }
    // цитата / callout
    if (/^>\s?/.test(ln)) {
      const q = []; while (i < L.length && /^>\s?/.test(L[i])) { q.push(L[i].replace(/^>\s?/, "")); i++; }
      const co = /^\[!([^\]]+)\]\s*(.*)$/.exec(q[0] || "");
      if (co) { const kind = co[1].toLowerCase(); html += `<div class="md-callout md-co-${/важно|warn|warning|caution/.test(kind) ? "warn" : /совет|tip|ok|success/.test(kind) ? "tip" : "note"}"><b>${mdInline(co[2] || co[1], ctx)}</b>${q.slice(1).length ? `<div>${mdToHtmlInner(q.slice(1).join("\n"), ctx)}</div>` : ""}</div>`; }
      else html += `<blockquote>${mdToHtmlInner(q.join("\n"), ctx)}</blockquote>`;
      continue;
    }
    // списки (вложенные)
    if (isList(ln)) {
      const stack = [];
      while (i < L.length && (isList(L[i]) || (/^\s{2,}\S/.test(L[i]) && stack.length))) {
        const cur = L[i];
        if (!isList(cur)) { html += "<br>" + mdInline(cur.trim(), ctx); i++; continue; }
        const lvl = indentOf(cur), ordered = /^\s*\d+\./.test(cur);
        const cb = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(cur);
        const tag = ordered ? "ol" : "ul", cls = cb ? ' class="md-check"' : "";
        while (stack.length > lvl + 1) html += `</li></${stack.pop()}>`;
        if (stack.length === lvl + 1) html += "</li>";
        while (stack.length < lvl + 1) { stack.push(tag); html += `<${tag}${cls}>`; }
        if (cb) { const d = cb[1].toLowerCase() === "x"; html += `<li class="md-task${d ? " done" : ""}"><span class="md-box" data-cb="${cbIndex++}" role="checkbox" aria-checked="${d}">${d ? "✓" : ""}</span><span>${mdInline(cb[2], ctx)}</span>`; }
        else html += `<li>${mdInline(cur.replace(/^\s*([-*+]|\d+\.)\s+/, ""), ctx)}`;
        i++;
      }
      while (stack.length) html += `</li></${stack.pop()}>`;
      continue;
    }
    if (/^\s*$/.test(ln)) { i++; continue; }
    let para = ln; i++;
    while (i < L.length && !/^\s*$/.test(L[i]) && !/^(#{1,6}\s|```|>|(-{3,}|\*{3,})\s*$)/.test(L[i]) && !isList(L[i]) && !(/\|/.test(L[i]) && i + 1 < L.length && /^\s*\|?\s*:?-{2,}/.test(L[i + 1]))) { para += "\n" + L[i]; i++; }
    html += `<p>${mdInline(para, ctx).replace(/\n/g, "<br>")}</p>`;
  }
  if (ctx.fn.order.length) html += `<section class="md-fns"><ol>${ctx.fn.order.map((id, n) => `<li id="fn-${ctx.fn.uid}-${n + 1}">${fnDefs[id] != null ? mdInline(fnDefs[id], ctx) : "—"}</li>`).join("")}</ol></section>`;
  return html;
}
// вложенный разбор (цитаты, callout) — без сносок и без сквозной нумерации чекбоксов
function mdToHtmlInner(src, ctx) { return mdToHtml(src, { noteExists: ctx.noteExists }).replace(/data-cb="\d+"/g, ""); }

// Задачи внутри текста заметки: [{index, line, level, done, text}] — индекс совпадает с data-cb
function mdTasks(src) {
  const out = []; let n = 0, inCode = false;
  (src || "").replace(/\r/g, "").split("\n").forEach((ln, line) => {
    if (/^```/.test(ln)) { inCode = !inCode; return; }
    if (inCode || /^>/.test(ln)) return;
    const m = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(ln);
    if (m) out.push({ index: n++, line, level: Math.floor(m[1].replace(/\t/g, "  ").length / 2), done: m[2].toLowerCase() === "x", text: m[3] });
  });
  return out;
}
// Переключить n-ю задачу в тексте (та же нумерация, что у mdTasks)
function mdToggleTask(src, n) {
  const lines = (src || "").replace(/\r/g, "").split("\n"); const t = mdTasks(src).find(x => x.index === n); if (!t) return src;
  lines[t.line] = lines[t.line].replace(/^(\s*[-*+]\s+\[)([ xX])(\])/, (m, a, c, b) => a + (c.toLowerCase() === "x" ? " " : "x") + b);
  return lines.join("\n");
}
// Теги #слово в тексте (не заголовки, не код)
function mdTags(src) {
  const set = new Set(); let inCode = false;
  (src || "").split("\n").forEach(ln => { if (/^```/.test(ln)) { inCode = !inCode; return; } if (inCode) return; ln.replace(/`[^`]*`/g, "").replace(/(^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu, (m, p, t) => { set.add(t.toLowerCase()); return m; }); });
  return [...set];
}
// Ссылки [[…]] в тексте
function mdLinks(src) { const out = new Set(); (src || "").replace(/\[\[([^\]|\n]+)(?:\|[^\]\n]+)?\]\]/g, (m, t) => { out.add(t.trim().toLowerCase()); return m; }); return [...out]; }
