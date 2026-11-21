"use strict";
/* ======================================================================
   SHUT · Календарь: события шифруются вместе с сейфом (тип записи "event").
   Вид «День / Неделя / Месяц», мини-календарь, повторы, напоминания,
   ссылка на видеовстречу, место, гости, описание, цвет.
   Время хранится локальным ("2026-11-21T14:30"), без пересчёта поясов.
   ====================================================================== */
const CAL_HOUR_PX = 48;
const CAL_COLORS = 8;
let calView = (() => { try { return localStorage.getItem("vault.calview") || ""; } catch { return ""; } })() || (innerWidth <= 600 ? "day" : "week");
let calDate = new Date(); calDate.setHours(0, 0, 0, 0);
let calMini = null;          // месяц мини-календаря (Date 1-го числа) или null = как calDate
let calScrolled = false;     // первый показ недели прокручивает к рабочему времени
const calFired = new Set();  // уже показанные напоминания

/* ---------- даты ---------- */
const cPad = n => String(n).padStart(2, "0");
const cYmd = d => d.getFullYear() + "-" + cPad(d.getMonth() + 1) + "-" + cPad(d.getDate());
const cHm = d => cPad(d.getHours()) + ":" + cPad(d.getMinutes());
function cParse(s) { // "YYYY-MM-DD" или "YYYY-MM-DDTHH:MM" → локальная дата
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s || ""); if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}
const cAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const cDayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const cWeekStart = d => { const x = cDayStart(d), w = (x.getDay() + 6) % 7; return cAddDays(x, -w); }; // неделя с понедельника
const cSameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const cLoc = () => lang === "en" ? "en-GB" : "ru-RU";
const cMonthName = d => { const s = d.toLocaleDateString(cLoc(), { month: "long", year: "numeric" }); return s.charAt(0).toUpperCase() + s.slice(1).replace(" г.", ""); };
const cWd = d => d.toLocaleDateString(cLoc(), { weekday: "short" }).replace(".", "");
const cTimeLabel = d => d.toLocaleTimeString(cLoc(), { hour: "2-digit", minute: "2-digit" });

/* ---------- события и повторы ---------- */
const eventsList = () => live().filter(x => x.type === "event");
function evBounds(e) {
  if (e.allDay) { const s = cParse(e.start), en = cParse(e.end || e.start) || s; return [s, cAddDays(en, 1)]; }
  const s = cParse(e.start), en = cParse(e.end); return [s, en && en > s ? en : new Date(s.getTime() + 36e5)];
}
// Все вхождения события в интервале [from, to)
function evOccurrences(e, from, to) {
  const [S, E] = evBounds(e); if (!S) return [];
  const dur = E - S, out = [], rep = e.repeat || "none";
  const push = s => { const en = new Date(s.getTime() + dur); if (s < to && en > from) out.push({ e, s, en }); };
  if (rep === "none") { push(S); return out; }
  const until = e.until ? cAddDays(cParse(e.until), 1) : null;
  const stop = until && until < to ? until : to;
  if (rep === "daily" || rep === "weekly") {
    const step = rep === "daily" ? 1 : 7;
    let k = Math.max(0, Math.floor((from - S - dur) / (step * 864e5)) - 1);
    for (let i = 0; i < 1000; i++, k++) { const s = cAddDays(S, k * step); if (s >= stop) break; push(s); }
  } else if (rep === "weekdays") {
    let s = new Date(S);
    if (from - S > 864e5 * 8) s = cAddDays(S, Math.floor((from - S) / 864e5) - 7);
    for (let i = 0; i < 1000 && s < stop; i++, s = cAddDays(s, 1)) { const wd = s.getDay(); if (wd !== 0 && wd !== 6 && s >= S) push(s); }
  } else if (rep === "monthly" || rep === "yearly") {
    for (let k = 0; k < 2400; k++) {
      const s = new Date(S); if (rep === "monthly") s.setMonth(S.getMonth() + k, 1); else s.setFullYear(S.getFullYear() + k, S.getMonth(), 1);
      const dim = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate(); if (S.getDate() > dim) continue; // нет такого числа в этом месяце
      s.setDate(S.getDate()); if (s >= stop) break; push(s);
    }
  }
  return out;
}
function occInRange(from, to) {
  const q = ($("search").value || "").trim().toLowerCase();
  const all = [];
  eventsList().forEach(e => { if (q && ![e.title, e.location, e.note].join(" ").toLowerCase().includes(q)) return; all.push(...evOccurrences(e, from, to)); });
  return all.sort((a, b) => a.s - b.s || (b.en - b.s) - (a.en - a.s));
}
const occKey = o => o.e.id + "|" + o.s.getTime();
const evTimeText = o => o.e.allDay ? T("Весь день", "All day") : cTimeLabel(o.s) + " – " + cTimeLabel(o.en);

/* ---------- отрисовка ---------- */
function renderCalendar() {
  $("detail-view").classList.add("hidden"); $("form-card").classList.add("hidden"); $("note-editor").classList.add("hidden");
  $("v-vault").classList.remove("show-detail");
  $("list-count").textContent = "";
  let range, title, grid;
  if (calView === "month") {
    const first = new Date(calDate.getFullYear(), calDate.getMonth(), 1), gs = cWeekStart(first);
    range = [gs, cAddDays(gs, 42)]; title = cMonthName(calDate); grid = calMonthGrid(gs);
  } else {
    const days = calView === "day" ? [cDayStart(calDate)] : Array.from({ length: 7 }, (_, i) => cAddDays(cWeekStart(calDate), i));
    range = [days[0], cAddDays(days[days.length - 1], 1)];
    const a = days[0], b = days[days.length - 1];
    title = calView === "day" ? a.toLocaleDateString(cLoc(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })
      : a.getMonth() === b.getMonth() ? cMonthName(a) : a.toLocaleDateString(cLoc(), { month: "short" }) + " – " + b.toLocaleDateString(cLoc(), { month: "short", year: "numeric" });
    title = title.charAt(0).toUpperCase() + title.slice(1);
    grid = calTimeGrid(days);
  }
  const seg = (v, ru, en) => `<button type="button" class="cal-seg${calView === v ? " on" : ""}" data-cal-view="${v}">${T(ru, en)}</button>`;
  $("list").innerHTML = `<div class="cal">
    <div class="cal-bar">
      <button type="button" class="cal-today" data-cal-today>${T("Сегодня", "Today")}</button>
      <button type="button" class="cal-nav" data-cal-step="-1" aria-label="${T("Назад", "Previous")}">‹</button>
      <button type="button" class="cal-nav" data-cal-step="1" aria-label="${T("Вперёд", "Next")}">›</button>
      <h1 class="cal-title">${esc(title)}</h1>
      <div class="cal-segs">${seg("day", "День", "Day")}${seg("week", "Неделя", "Week")}${seg("month", "Месяц", "Month")}</div>
    </div>
    <div class="cal-wrap"><aside class="cal-side">${calMiniHtml()}${calUpcomingHtml()}</aside><div class="cal-main">${grid}</div></div>
  </div>`;
  calLayout();
}

function calTimeGrid(days) {
  const today = new Date(), from = days[0], to = cAddDays(days[days.length - 1], 1);
  const occ = occInRange(from, to);
  const head = days.map(d => `<div class="cg-dh${cSameDay(d, today) ? " today" : ""}"><span class="cg-wd">${esc(cWd(d))}</span><button type="button" class="cg-dn" data-cal-day="${cYmd(d)}">${d.getDate()}</button></div>`).join("");
  const allday = days.map(d => {
    const ds = cDayStart(d), de = cAddDays(ds, 1);
    const evs = occ.filter(o => (o.e.allDay || o.en - o.s >= 864e5) && o.s < de && o.en > ds);
    return `<div class="cg-ad" data-cal-allday="${cYmd(d)}">${evs.map(o => `<button type="button" class="cg-chip c-${o.e.color || 0}" data-occ="${esc(occKey(o))}">${esc(o.e.title || T("Без названия", "(No title)"))}</button>`).join("")}</div>`;
  }).join("");
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="cg-h"><span>${h ? cTimeLabel(new Date(2000, 0, 1, h)) : ""}</span></div>`).join("");
  const cols = days.map(d => {
    const ds = cDayStart(d), de = cAddDays(ds, 1);
    const evs = occ.filter(o => !o.e.allDay && o.en - o.s < 864e5 && o.s < de && o.en > ds).map(o => ({ o, s: Math.max(o.s, ds), en: Math.min(o.en, de) }));
    // раскладка пересечений по колонкам
    const placed = []; let cluster = [], clusterEnd = 0;
    const flush = () => { const n = Math.max(...cluster.map(c => c.col)) + 1; cluster.forEach(c => c.n = n); cluster = []; };
    evs.sort((a, b) => a.s - b.s || b.en - a.en).forEach(it => {
      if (cluster.length && it.s >= clusterEnd) flush();
      const used = new Set(cluster.filter(c => c.en > it.s).map(c => c.col)); let col = 0; while (used.has(col)) col++;
      it.col = col; cluster.push(it); placed.push(it); clusterEnd = Math.max(clusterEnd, it.en);
    });
    if (cluster.length) flush();
    const evHtml = placed.map(it => {
      const top = (it.s - ds) / 36e5 * CAL_HOUR_PX, h = Math.max(20, (it.en - it.s) / 36e5 * CAL_HOUR_PX - 2);
      const short = it.en - it.s <= 45 * 6e4;
      return `<button type="button" class="cg-ev c-${it.o.e.color || 0}${short ? " short" : ""}" data-occ="${esc(occKey(it.o))}" data-top="${top}" data-h="${h}" data-col="${it.col}" data-n="${it.n}">
        <b>${esc(it.o.e.title || T("Без названия", "(No title)"))}</b><span>${esc(cTimeLabel(it.o.s) + " – " + cTimeLabel(it.o.en))}${it.o.e.meet ? " · 🎥" : ""}</span></button>`;
    }).join("");
    const nowLine = cSameDay(d, today) ? `<span class="cg-now" data-top="${(today - ds) / 36e5 * CAL_HOUR_PX}"></span>` : "";
    return `<div class="cg-col${cSameDay(d, today) ? " today" : ""}" data-cal-col="${cYmd(d)}">${evHtml}${nowLine}</div>`;
  }).join("");
  return `<div class="cg cg-n${days.length}">
    <div class="cg-headrow"><div class="cg-gut"></div>${head}</div>
    <div class="cg-adrow"><div class="cg-gut cg-adl">${T("весь день", "all day")}</div>${allday}</div>
    <div class="cg-body" id="cg-body"><div class="cg-inner"><div class="cg-hours">${hours}</div>${cols}</div></div>
  </div>`;
}

function calMonthGrid(gs) {
  const today = new Date(), occ = occInRange(gs, cAddDays(gs, 42));
  const wds = Array.from({ length: 7 }, (_, i) => `<div class="cm-wd">${esc(cWd(cAddDays(gs, i)))}</div>`).join("");
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = cAddDays(gs, i), de = cAddDays(d, 1);
    const evs = occ.filter(o => o.s < de && o.en > d);
    const more = evs.length > 3 ? `<button type="button" class="cm-more" data-cal-day="${cYmd(d)}">${T("ещё ", "+")}${evs.length - 3}</button>` : "";
    return `<div class="cm-cell${d.getMonth() !== calDate.getMonth() ? " out" : ""}${cSameDay(d, today) ? " today" : ""}" data-cal-cell="${cYmd(d)}">
      <button type="button" class="cm-dn" data-cal-day="${cYmd(d)}">${d.getDate()}</button>
      ${evs.slice(0, 3).map(o => `<button type="button" class="cm-ev c-${o.e.color || 0}${o.e.allDay ? " ad" : ""}" data-occ="${esc(occKey(o))}">${o.e.allDay ? "" : `<i>${esc(cTimeLabel(o.s))}</i> `}${esc(o.e.title || T("Без названия", "(No title)"))}</button>`).join("")}${more}</div>`;
  }).join("");
  return `<div class="cm"><div class="cm-head">${wds}</div><div class="cm-grid">${cells}</div></div>`;
}

function calMiniHtml() {
  const m = calMini || new Date(calDate.getFullYear(), calDate.getMonth(), 1), gs = cWeekStart(m), today = new Date();
  const ws = cWeekStart(calDate), we = cAddDays(ws, 7);
  const wds = Array.from({ length: 7 }, (_, i) => `<span>${esc(cWd(cAddDays(gs, i)).slice(0, 2))}</span>`).join("");
  const has = new Set(); occInRange(gs, cAddDays(gs, 42)).forEach(o => has.add(cYmd(o.s)));
  const days = Array.from({ length: 42 }, (_, i) => {
    const d = cAddDays(gs, i), inSel = calView === "week" ? d >= ws && d < we : calView === "day" ? cSameDay(d, calDate) : false;
    return `<button type="button" class="mm-d${d.getMonth() !== m.getMonth() ? " out" : ""}${cSameDay(d, today) ? " today" : ""}${inSel ? " sel" : ""}${has.has(cYmd(d)) ? " has" : ""}" data-cal-pick="${cYmd(d)}">${d.getDate()}</button>`;
  }).join("");
  return `<div class="mm"><div class="mm-top"><b>${esc(cMonthName(m))}</b><span><button type="button" class="mm-nav" data-mm-step="-1" aria-label="‹">‹</button><button type="button" class="mm-nav" data-mm-step="1" aria-label="›">›</button></span></div>
    <div class="mm-wds">${wds}</div><div class="mm-days">${days}</div></div>`;
}
function calUpcomingHtml() {
  const now = new Date(), occ = occInRange(now, cAddDays(now, 60)).slice(0, 6);
  return `<div class="cal-up"><p class="cal-up-h">${T("Ближайшие", "Upcoming")}</p>${occ.length ? occ.map(o => `<button type="button" class="cal-up-i" data-occ="${esc(occKey(o))}"><span class="cal-dot c-${o.e.color || 0}"></span><span><b>${esc(o.e.title || T("Без названия", "(No title)"))}</b><small>${esc(o.s.toLocaleDateString(cLoc(), { day: "numeric", month: "short" }) + ", " + (o.e.allDay ? T("весь день", "all day") : cTimeLabel(o.s)))}</small></span></button>`).join("") : `<p class="cal-up-empty">${T("Событий нет", "No events")}</p>`}</div>`;
}

// Позиции событий ставим через CSSOM (CSP запрещает style="" в разметке)
function calLayout() {
  document.querySelectorAll(".cg-ev").forEach(el => {
    const n = +el.dataset.n || 1, c = +el.dataset.col || 0;
    el.style.top = el.dataset.top + "px"; el.style.height = el.dataset.h + "px";
    el.style.left = `calc(${(c / n) * 100}% + 2px)`; el.style.width = `calc(${100 / n}% - 4px)`;
  });
  document.querySelectorAll(".cg-now").forEach(el => el.style.top = el.dataset.top + "px");
  const body = $("cg-body");
  if (body && !calScrolled) { const h = new Date().getHours(); body.scrollTop = Math.max(0, (Math.min(h, 17) - 1.5) * CAL_HOUR_PX); calScrolled = true; }
}

/* ---------- окно события ---------- */
function calNew(start, allDay) {
  let s = start ? new Date(start) : null;
  if (!s) { s = new Date(); s.setMinutes(s.getMinutes() < 30 ? 30 : 60, 0, 0); if (!cSameDay(s, calDate) && calView !== "month") { s = new Date(calDate); s.setHours(10, 0, 0, 0); } }
  const en = new Date(s.getTime() + 36e5);
  calOpenPop({ id: null, title: "", allDay: !!allDay, start: allDay ? cYmd(s) : cYmd(s) + "T" + cHm(s), end: allDay ? cYmd(s) : cYmd(en) + "T" + cHm(en), repeat: "none", color: 0, remind: allDay ? -1 : 10 });
}
function calOpenPop(e, occ) {
  const isNew = !e.id;
  const [S, E] = evBounds(e); const endDay = e.allDay ? cAddDays(E, -1) : E;
  const wdName = S.toLocaleDateString(cLoc(), { weekday: "long" });
  const opt = (v, l, cur) => `<option value="${v}"${String(cur) === String(v) ? " selected" : ""}>${esc(l)}</option>`;
  const reps = [["none", T("Не повторяется", "Does not repeat")], ["daily", T("Каждый день", "Daily")], ["weekdays", T("По будням (пн–пт)", "Every weekday (Mon–Fri)")],
    ["weekly", T("Каждую неделю: ", "Weekly on ") + wdName], ["monthly", T("Каждый месяц, ", "Monthly on day ") + S.getDate() + T("-го числа", "")], ["yearly", T("Каждый год, ", "Annually on ") + S.toLocaleDateString(cLoc(), { day: "numeric", month: "long" })]];
  const rems = [[-1, T("Без напоминания", "No reminder")], [0, T("В момент начала", "At start time")], [5, T("За 5 минут", "5 minutes before")], [10, T("За 10 минут", "10 minutes before")],
    [30, T("За 30 минут", "30 minutes before")], [60, T("За 1 час", "1 hour before")], [1440, T("За 1 день", "1 day before")]];
  const colors = Array.from({ length: CAL_COLORS }, (_, i) => `<button type="button" class="cp-color c-${i}${(e.color || 0) === i ? " on" : ""}" data-cp-color="${i}" aria-label="${T("Цвет", "Color")} ${i + 1}"></button>`).join("");
  const ov = document.createElement("div"); ov.className = "cal-pop-ov";
  ov.innerHTML = `<div class="cal-pop" role="dialog" aria-modal="true">
    <div class="cp-top"><span class="cp-grip"></span><button type="button" class="cp-x" data-cp-close aria-label="${T("Закрыть", "Close")}">✕</button></div>
    <input class="cp-title" id="cp-title" maxlength="200" placeholder="${T("Добавьте название", "Add title")}" value="${esc(e.title || "")}">
    ${occ && !isNew && (e.repeat || "none") !== "none" ? `<p class="cp-note">${T("Повторяющееся событие: изменения применятся ко всем повторам.", "Recurring event: changes apply to all occurrences.")}</p>` : ""}
    ${e.meet && !isNew ? `<button type="button" class="cp-join" data-cp-join>🎥 ${T("Подключиться к встрече", "Join meeting")}</button>` : ""}
    <div class="cp-row"><span class="cp-ic">🕘</span><div class="cp-f">
      <div class="cp-when">
        <input type="date" id="cp-sd" class="field" value="${cYmd(S)}">
        <input type="time" id="cp-st" class="field cp-t" step="900" value="${cHm(S)}">
        <span class="cp-dash">–</span>
        <input type="time" id="cp-et" class="field cp-t" step="900" value="${cHm(E)}">
        <input type="date" id="cp-ed" class="field" value="${cYmd(endDay)}">
      </div>
      <div class="cp-sub"><label class="chk"><input type="checkbox" id="cp-ad"${e.allDay ? " checked" : ""}> ${T("Весь день", "All day")}</label>
        <select id="cp-rep" class="field slim">${reps.map(([v, l]) => opt(v, l, e.repeat || "none")).join("")}</select></div>
      <div class="cp-sub cp-until${(e.repeat || "none") === "none" ? " hidden" : ""}"><label for="cp-until">${T("Повторять до (необязательно)", "Repeat until (optional)")}</label><input type="date" id="cp-until" class="field" value="${esc(e.until || "")}"></div>
    </div></div>
    <div class="cp-row"><span class="cp-ic">👥</span><div class="cp-f"><input id="cp-guests" class="field" placeholder="${T("Добавьте гостей (email через запятую)", "Add guests (comma-separated emails)")}" value="${esc(e.guests || "")}" autocomplete="off"></div></div>
    <div class="cp-row"><span class="cp-ic">🎥</span><div class="cp-f">
      <input id="cp-meet" class="field" inputmode="url" placeholder="${T("Ссылка на видеовстречу (Meet, Zoom, Telegram…)", "Video call link (Meet, Zoom, Telegram…)")}" value="${esc(e.meet || "")}" autocomplete="off">
      <div class="cp-btns"><button type="button" class="ghost cp-small" data-cp-jitsi>${T("Создать ссылку Jitsi Meet", "Create a Jitsi Meet link")}</button><button type="button" class="ghost cp-small" data-cp-meet-open>${T("Открыть", "Open")}</button><button type="button" class="ghost cp-small" data-cp-meet-copy>${T("Скопировать", "Copy")}</button></div>
    </div></div>
    <div class="cp-row"><span class="cp-ic">📍</span><div class="cp-f"><input id="cp-loc" class="field" placeholder="${T("Добавьте место", "Add location")}" value="${esc(e.location || "")}" autocomplete="off"></div></div>
    <div class="cp-row"><span class="cp-ic">≡</span><div class="cp-f"><textarea id="cp-note" class="field" rows="3" placeholder="${T("Добавьте описание", "Add description")}">${esc(e.note || "")}</textarea></div></div>
    <div class="cp-row"><span class="cp-ic">🔔</span><div class="cp-f"><select id="cp-rem" class="field slim">${rems.map(([v, l]) => opt(v, l, e.remind ?? -1)).join("")}</select></div></div>
    <div class="cp-row"><span class="cp-ic">🎨</span><div class="cp-f cp-colors">${colors}</div></div>
    <div class="err" id="cp-err"></div>
    <div class="cp-actions">${isNew ? "" : `<button type="button" class="danger cp-del" data-cp-del>${T("Удалить", "Delete")}</button>`}<span></span>
      <button type="button" class="ghost" data-cp-close>${T("Отмена", "Cancel")}</button><button type="button" class="cp-save" data-cp-save>${T("Сохранить", "Save")}</button></div>
  </div>`;
  document.body.appendChild(ov);
  let color = e.color || 0;
  const g = id => ov.querySelector("#" + id);
  const syncAd = () => { const ad = g("cp-ad").checked; ov.querySelectorAll(".cp-t, .cp-dash").forEach(x => x.classList.toggle("hidden", ad)); };
  syncAd();
  g("cp-ad").onchange = syncAd;
  g("cp-rep").onchange = () => ov.querySelector(".cp-until").classList.toggle("hidden", g("cp-rep").value === "none");
  // сдвиг конца вместе с началом
  let prevStart = cParse(g("cp-sd").value + "T" + g("cp-st").value);
  const shiftEnd = () => {
    const ns = cParse(g("cp-sd").value + "T" + (g("cp-st").value || "00:00")); if (!ns || !prevStart) return;
    const pe = cParse(g("cp-ed").value + "T" + (g("cp-et").value || "00:00")); if (!pe) return;
    const ne = new Date(pe.getTime() + (ns - prevStart)); g("cp-ed").value = cYmd(ne); g("cp-et").value = cHm(ne); prevStart = ns;
  };
  g("cp-sd").onchange = shiftEnd; g("cp-st").onchange = shiftEnd;
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = ev => { if (ev.key === "Escape") close(); if (ev.key === "Enter" && ev.target.id === "cp-title") save(); };
  document.addEventListener("keydown", onKey);
  const meetUrl = () => safeUrl(g("cp-meet").value);
  const save = async () => {
    const title = g("cp-title").value.trim(), ad = g("cp-ad").checked;
    let st = ad ? g("cp-sd").value : g("cp-sd").value + "T" + g("cp-st").value, enS = ad ? g("cp-ed").value : g("cp-ed").value + "T" + g("cp-et").value;
    const sD = cParse(st), eD = cParse(enS);
    if (!sD) { g("cp-err").textContent = T("Укажите дату", "Enter a date"); return; }
    if (!eD || (ad ? eD < sD : eD <= sD)) { if (ad) enS = st; else { const x = new Date(sD.getTime() + 36e5); enS = cYmd(x) + "T" + cHm(x); } }
    const mv = g("cp-meet").value.trim(); if (mv && !meetUrl()) { g("cp-err").textContent = T("Некорректная ссылка на встречу", "Invalid meeting link"); return; }
    const rem = +g("cp-rem").value;
    const data = { title: title || T("Без названия", "(No title)"), allDay: ad, start: st, end: enS, repeat: g("cp-rep").value, until: g("cp-rep").value !== "none" ? g("cp-until").value : "",
      meet: mv ? meetUrl() : "", location: g("cp-loc").value.trim(), guests: g("cp-guests").value.trim(), note: g("cp-note").value, remind: rem, color };
    const now = Date.now();
    if (isNew) entries.push({ type: "event", id: b64(rand(9)), created: now, updated: now, pwChanged: now, ...data });
    else { const i = entries.findIndex(x => x.id === e.id); if (i < 0) return close(); entries[i] = { ...entries[i], ...data, updated: now }; }
    await persist(); close(); renderNav(); render();
    toast(isNew ? T("Событие создано", "Event created") : T("Событие сохранено", "Event saved"));
    if (rem >= 0 && "Notification" in window && Notification.permission === "default") { try { Notification.requestPermission(); } catch {} }
  };
  ov.onclick = async ev => {
    if (ev.target === ov || ev.target.closest("[data-cp-close]")) return close();
    const c = ev.target.closest("[data-cp-color]"); if (c) { color = +c.dataset.cpColor; ov.querySelectorAll(".cp-color").forEach(x => x.classList.toggle("on", x === c)); return; }
    if (ev.target.closest("[data-cp-save]")) return save();
    if (ev.target.closest("[data-cp-jitsi]")) { const id = "SHUT-" + [...rand(9)].map(b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""); g("cp-meet").value = "https://meet.jit.si/" + id; return; }
    if (ev.target.closest("[data-cp-meet-open]") || ev.target.closest("[data-cp-join]")) { const u = ev.target.closest("[data-cp-join]") ? e.meet : meetUrl(); if (u) window.open(u, "_blank", "noopener,noreferrer"); else toast(T("Сначала вставьте ссылку", "Paste a link first")); return; }
    if (ev.target.closest("[data-cp-meet-copy]")) { const u = meetUrl(); if (u) { try { await navigator.clipboard.writeText(u); toast(T("Ссылка скопирована", "Link copied")); } catch {} } return; }
    if (ev.target.closest("[data-cp-del]")) {
      if (!(await confirmBox(T("Удалить событие «", "Delete event “") + (e.title || "") + T("»?", "”?") + ((e.repeat || "none") !== "none" ? T(" Удалятся все повторы.", " All occurrences will be deleted.") : ""), T("Удалить", "Delete"), true))) return;
      const x = entries.find(y => y.id === e.id); if (x) { x.deletedAt = Date.now(); await persist(); }
      close(); renderNav(); render(); toast(T("Событие в корзине", "Event moved to trash"));
    }
  };
  setTimeout(() => { if (isNew) g("cp-title").focus(); }, 30);
}

/* ---------- клики по календарю ---------- */
function calFindOcc(key) {
  const [id, ts] = key.split("|"); const e = entries.find(x => x.id === id); return e ? { e, s: new Date(+ts) } : null;
}
function calClick(ev) {
  const t = ev.target;
  const o = t.closest("[data-occ]"); if (o) { const f = calFindOcc(o.dataset.occ); if (f) calOpenPop(f.e, f); return true; }
  const v = t.closest("[data-cal-view]"); if (v) { calView = v.dataset.calView; try { localStorage.setItem("vault.calview", calView); } catch {} calMini = null; renderCalendar(); return true; }
  if (t.closest("[data-cal-today]")) { calDate = cDayStart(new Date()); calMini = null; calScrolled = false; renderCalendar(); return true; }
  const st = t.closest("[data-cal-step]"); if (st) {
    const k = +st.dataset.calStep;
    if (calView === "month") calDate = new Date(calDate.getFullYear(), calDate.getMonth() + k, 1); else calDate = cAddDays(calDate, k * (calView === "day" ? 1 : 7));
    calMini = null; renderCalendar(); return true;
  }
  const mm = t.closest("[data-mm-step]"); if (mm) { const m = calMini || new Date(calDate.getFullYear(), calDate.getMonth(), 1); calMini = new Date(m.getFullYear(), m.getMonth() + +mm.dataset.mmStep, 1); renderCalendar(); return true; }
  const pk = t.closest("[data-cal-pick]"); if (pk) { calDate = cParse(pk.dataset.calPick); calMini = null; renderCalendar(); return true; }
  const dd = t.closest("[data-cal-day]"); if (dd) { calDate = cParse(dd.dataset.calDay); calView = "day"; calMini = null; renderCalendar(); return true; }
  const ad = t.closest("[data-cal-allday]"); if (ad) { calNew(cParse(ad.dataset.calAllday), true); return true; }
  const cell = t.closest("[data-cal-cell]"); if (cell) { const d = cParse(cell.dataset.calCell); d.setHours(10, 0, 0, 0); calNew(d, false); return true; }
  const col = t.closest("[data-cal-col]"); if (col) {
    const r = col.getBoundingClientRect(), min = Math.max(0, Math.min(23.5 * 60, Math.floor((ev.clientY - r.top) / CAL_HOUR_PX * 2) * 30));
    const d = cParse(col.dataset.calCol); d.setMinutes(min); calNew(d, false); return true;
  }
  return false;
}

/* ---------- напоминания (работают, пока сейф открыт) ---------- */
function calRemindTick() {
  if (typeof vaultKey === "undefined" || !vaultKey) return;
  const now = Date.now();
  occInRangeAll(new Date(now - 864e5), new Date(now + 2 * 864e5)).forEach(o => {
    const r = o.e.remind; if (r == null || r < 0) return;
    const at = (o.e.allDay ? new Date(o.s.getTime() + 9 * 36e5) : o.s).getTime() - (o.e.allDay ? 0 : r * 6e4);
    const key = occKey(o) + "|" + r;
    if (at <= now && at > now - 2 * 6e4 && !calFired.has(key)) {
      calFired.add(key);
      const body = evTimeText(o) + (o.e.location ? " · " + o.e.location : "");
      try { if ("Notification" in window && Notification.permission === "granted") new Notification(o.e.title || "SHUT", { body, tag: key }); } catch {}
      toast("🔔 " + (o.e.title || "") + " — " + body);
    }
  });
}
function occInRangeAll(from, to) { const all = []; eventsList().forEach(e => all.push(...evOccurrences(e, from, to))); return all; }
setInterval(calRemindTick, 30000);

// Количество событий сегодня — для счётчика в меню
function calTodayCount() { const d = cDayStart(new Date()); return occInRangeAll(d, cAddDays(d, 1)).length; }
