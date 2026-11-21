"use strict";
/* ======================================================================
   SHUT · Единый выбор даты в стиле сайта для всех <input type="date">.
   Нативное окно браузера перекрасить нельзя, поэтому на устройствах с мышью
   открываем своё. На телефонах остаётся системное «колесо» (оно удобнее пальцем),
   но в тёмной теме (color-scheme: dark).
   Значение поля остаётся обычным ISO "YYYY-MM-DD", события input/change шлются как от браузера.
   ====================================================================== */
(() => {
  const fine = () => matchMedia("(pointer: fine)").matches;
  const pad = n => String(n).padStart(2, "0");
  const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const parse = s => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const isEn = () => (typeof lang !== "undefined" && lang === "en");
  const L = (ru, en) => isEn() ? en : ru;
  const loc = () => isEn() ? "en-GB" : "ru-RU";
  let pop = null, input = null, view = null;

  function close() {
    if (!pop) return;
    pop.remove(); pop = null; input = null;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", onKey, true);
    removeEventListener("resize", close);
    document.removeEventListener("scroll", onScroll, true);
  }
  const outside = e => { if (pop && !pop.contains(e.target) && e.target !== input) close(); };
  const onScroll = e => { if (pop && !pop.contains(e.target)) place(); };
  function onKey(e) {
    if (!pop) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); input && input.focus(); }
  }
  function set(v) {
    const el = input; if (!el) return;
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    close();
  }
  function anchorOf(el) {
    if (el.offsetWidth > 2 && el.offsetHeight > 2) return el;
    return el.closest(".task-row")?.querySelector(".task-cal") || el.parentElement || el;
  }
  function place() {
    if (!pop || !input) return;
    const r = anchorOf(input).getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    let left = Math.min(Math.max(8, r.left), innerWidth - w - 8);
    let top = r.bottom + 6; if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pop.style.left = left + "px"; pop.style.top = Math.max(8, top) + "px";
  }
  function render() {
    const cur = parse(input.value), today = new Date(); today.setHours(0, 0, 0, 0);
    const min = parse(input.min), max = parse(input.max);
    const first = new Date(view.getFullYear(), view.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - (first.getDay() + 6) % 7);
    let title = first.toLocaleDateString(loc(), { month: "long", year: "numeric" }).replace(" г.", "");
    title = title.charAt(0).toUpperCase() + title.slice(1);
    const wds = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return `<span>${d.toLocaleDateString(loc(), { weekday: "short" }).replace(".", "").slice(0, 2)}</span>`; }).join("");
    const days = Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const off = (min && d < min) || (max && d > max);
      const cls = ["dp-d", d.getMonth() !== view.getMonth() ? "out" : "", +d === +today ? "today" : "", cur && +d === +cur ? "sel" : ""].filter(Boolean).join(" ");
      return `<button type="button" class="${cls}" data-dp="${iso(d)}"${off ? " disabled" : ""}>${d.getDate()}</button>`;
    }).join("");
    pop.innerHTML = `<div class="dp-top"><button type="button" class="dp-nav" data-dp-step="-1" aria-label="${L("Предыдущий месяц", "Previous month")}">‹</button>
      <b class="dp-title">${title}</b><button type="button" class="dp-nav" data-dp-step="1" aria-label="${L("Следующий месяц", "Next month")}">›</button></div>
      <div class="dp-wds">${wds}</div><div class="dp-days">${days}</div>
      <div class="dp-foot"><button type="button" class="dp-link" data-dp-clear>${L("Очистить", "Clear")}</button><button type="button" class="dp-link" data-dp-today>${L("Сегодня", "Today")}</button></div>`;
  }
  function open(el) {
    if (el.disabled || el.readOnly) return;
    if (pop && input === el) return close();
    close();
    input = el; view = parse(el.value) || new Date(); view = new Date(view.getFullYear(), view.getMonth(), 1);
    pop = document.createElement("div"); pop.className = "dp-pop"; pop.setAttribute("role", "dialog");
    pop.addEventListener("mousedown", e => e.preventDefault()); // фокус остаётся в поле
    pop.addEventListener("click", e => {
      const s = e.target.closest("[data-dp-step]"); if (s) { view = new Date(view.getFullYear(), view.getMonth() + +s.dataset.dpStep, 1); render(); return; }
      const d = e.target.closest("[data-dp]"); if (d && !d.disabled) { set(d.dataset.dp); return; }
      if (e.target.closest("[data-dp-today]")) { set(iso(new Date())); return; }
      if (e.target.closest("[data-dp-clear]")) { set(""); return; }
    });
    pop.addEventListener("wheel", e => { e.preventDefault(); view = new Date(view.getFullYear(), view.getMonth() + (e.deltaY > 0 ? 1 : -1), 1); render(); }, { passive: false });
    render(); document.body.appendChild(pop); place();
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    addEventListener("resize", close);
    document.addEventListener("scroll", onScroll, true);
  }
  /* ---------- время: список с шагом 15 минут ---------- */
  const tmin = s => { const m = /^(\d{2}):(\d{2})/.exec(s || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const tstr = m => pad(Math.floor(m / 60) % 24) + ":" + pad(m % 60);
  const durText = d => { const h = Math.floor(d / 60), m = d % 60; return [h ? h + L(" ч", " h") : "", m ? m + L(" мин", " min") : ""].filter(Boolean).join(" "); };
  function openTime(el) {
    if (el.disabled || el.readOnly) return;
    if (pop && input === el) return close();
    close();
    input = el;
    const from = el.dataset.durFrom ? tmin(document.getElementById(el.dataset.durFrom)?.value) : null;
    const cur = tmin(el.value);
    const slots = []; for (let m = 0; m < 1440; m += 15) slots.push(m);
    if (cur != null && !slots.includes(cur)) { slots.push(cur); slots.sort((a, b) => a - b); }
    pop = document.createElement("div"); pop.className = "dp-pop tp-pop"; pop.setAttribute("role", "listbox");
    pop.innerHTML = `<div class="tp-list">${slots.map(m => {
      const d = from != null ? m - from : null;
      const lbl = new Date(2000, 0, 1, Math.floor(m / 60), m % 60).toLocaleTimeString(loc(), { hour: "2-digit", minute: "2-digit" });
      return `<button type="button" class="tp-i${m === cur ? " sel" : ""}" data-tp="${tstr(m)}">${lbl}${d != null && d > 0 ? `<small>${durText(d)}</small>` : ""}</button>`;
    }).join("")}</div>`;
    pop.addEventListener("mousedown", e => e.preventDefault());
    pop.addEventListener("click", e => { const b = e.target.closest("[data-tp]"); if (b) set(b.dataset.tp); });
    document.body.appendChild(pop); place();
    const list = pop.querySelector(".tp-list"), sel = pop.querySelector(".tp-i.sel") || pop.querySelector(`[data-tp="${tstr(Math.round((from ?? 540) / 15) * 15)}"]`);
    if (sel) list.scrollTop = sel.offsetTop - list.clientHeight / 2 + sel.offsetHeight / 2;
    document.addEventListener("mousedown", outside, true);
    document.addEventListener("keydown", onKey, true);
    addEventListener("resize", close);
    document.addEventListener("scroll", onScroll, true);
  }

  const isDate = el => el && el.tagName === "INPUT" && el.type === "date";
  const isTime = el => el && el.tagName === "INPUT" && el.type === "time";
  const openAny = el => isDate(el) ? open(el) : openTime(el);
  // Мышь: клик по полю открывает наше окно; дату/время по-прежнему можно напечатать
  document.addEventListener("click", e => { const el = e.target; if ((isDate(el) || isTime(el)) && fine()) { e.preventDefault(); openAny(el); } }, true);
  document.addEventListener("keydown", e => { const el = e.target; if ((isDate(el) || isTime(el)) && (e.key === "Enter" || (e.altKey && e.key === "ArrowDown"))) { e.preventDefault(); openAny(el); } }, true);
  // Палец: не даём открыться системному колесу — показываем своё окно снизу экрана
  let tStart = null;
  document.addEventListener("touchstart", e => { const t = e.touches[0]; tStart = t ? [t.clientX, t.clientY] : null; }, { capture: true, passive: true });
  document.addEventListener("touchend", e => { const el = e.target; if (!(isDate(el) || isTime(el))) return; const t = e.changedTouches[0]; if (tStart && t && Math.hypot(t.clientX - tStart[0], t.clientY - tStart[1]) > 10) return; e.preventDefault(); openAny(el); }, { capture: true, passive: false });
  // Код, который сам открывает выбор (кнопка срока у задачи), тоже получает наше окно
  const native = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = function () { if (isDate(this) || isTime(this)) return openAny(this); return native && native.call(this); };
})();
