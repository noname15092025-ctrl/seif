"use strict";
/* ======================================================================
   SHUT · Календарь: события шифруются вместе с сейфом (тип записи "event").
   Вид «День / Неделя / Месяц», мини-календарь, повторы, напоминания,
   ссылка на видеовстречу, место, гости, описание, цвет.
   Время хранится локальным ("2026-11-21T14:30"), без пересчёта поясов.
   ====================================================================== */
const CAL_HOUR_PX = 48;
const CAL_COLORS = 8;
// Линейные иконки (в стиле остального интерфейса), вместо эмодзи
const CI_PATHS = {
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  users: '<circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.6-3 2.9-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><path d="M15.5 6.3a3 3 0 0 1 0 5.6M17.5 14.6c1.6.6 2.7 2.1 3 4.4"/>',
  video: '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.5l5-3v9l-5-3"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>',
  text: '<path d="M4.5 7h15M4.5 12h15M4.5 17h9"/>',
  bell: '<path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5h-14z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  task: '<rect x="4.5" y="4.5" width="15" height="15" rx="4"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.3 0 1.8-.9 1.4-1.9-.5-1.1.2-2.3 1.4-2.3h2.1a3.6 3.6 0 0 0 3.6-3.6C20.5 7.6 16.7 3.5 12 3.5z"/><circle cx="7.8" cy="11" r="1.1"/><circle cx="10.5" cy="7.6" r="1.1"/><circle cx="14.6" cy="7.8" r="1.1"/>'
};
const ci = n => `<svg class="ci" viewBox="0 0 24 24" aria-hidden="true">${CI_PATHS[n]}</svg>`;
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
  const ex = e.ex && e.ex.length ? new Set(e.ex) : null; // удалённые/вынесенные отдельно повторы
  const push = s => { if (ex && ex.has(cYmd(s))) return; const en = new Date(s.getTime() + dur); if (s < to && en > from) out.push({ e, s, en }); };
  if (rep === "none") { push(S); return out; }
  const until = e.until ? cAddDays(cParse(e.until), 1) : null;
  const stop = until && until < to ? until : to;
  const N = Math.max(1, Math.min(99, Math.floor(+e.every || 1))); // «каждые N»
  if (rep === "daily" || rep === "weekly") {
    const step = (rep === "daily" ? 1 : 7) * N;
    let k = Math.max(0, Math.floor((from - S - dur) / (step * 864e5)) - 1);
    for (let i = 0; i < 1000; i++, k++) { const s = cAddDays(S, k * step); if (s >= stop) break; push(s); }
  } else if (rep === "weekdays") {
    let s = new Date(S);
    if (from - S > 864e5 * 8) s = cAddDays(S, Math.floor((from - S) / 864e5) - 7);
    for (let i = 0; i < 1000 && s < stop; i++, s = cAddDays(s, 1)) { const wd = s.getDay(); if (wd !== 0 && wd !== 6 && s >= S) push(s); }
  } else if (rep === "monthly" || rep === "yearly") {
    for (let k = 0; k < 2400; k += N) {
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
  const ob = $("cg-body"), keepScroll = ob && calScrolled ? ob.scrollTop : null;
  $("list").innerHTML = `<div class="cal">
    <div class="cal-bar">
      <button type="button" class="cal-today" data-cal-today>${T("Сегодня", "Today")}</button>
      <button type="button" class="cal-nav" data-cal-step="-1" aria-label="${T("Назад", "Previous")}">‹</button>
      <button type="button" class="cal-nav" data-cal-step="1" aria-label="${T("Вперёд", "Next")}">›</button>
      <h1 class="cal-title">${esc(title)}</h1>
      <div class="cal-segs">${seg("day", "День", "Day")}${seg("week", "Неделя", "Week")}${seg("month", "Месяц", "Month")}</div>
    </div>
    <div class="cal-wrap"><aside class="cal-side">${calMiniHtml()}${calUpcomingHtml()}<div class="cal-io"><label class="cal-io-b">${ci("upload")}${T("Импорт .ics", "Import .ics")}<input type="file" accept=".ics,text/calendar" hidden data-cal-import></label><button type="button" class="cal-io-b" data-cal-export>${ci("download")}${T("Экспорт .ics", "Export .ics")}</button></div><p class="cal-io-hint">${T("Из Google Календаря: Настройки → Импорт и экспорт → Экспорт, распакуйте архив и выберите файл .ics.", "From Google Calendar: Settings → Import &amp; export → Export, unzip and pick the .ics file.")}</p></aside><div class="cal-main">${grid}</div></div>
  </div>`;
  calLayout();
  const nb = $("cg-body"); if (nb && keepScroll != null) nb.scrollTop = keepScroll; // перерисовка не сбрасывает прокрутку
}

function calTimeGrid(days) {
  const today = new Date(), from = days[0], to = cAddDays(days[days.length - 1], 1);
  const occ = occInRange(from, to);
  const head = days.map(d => `<div class="cg-dh${cSameDay(d, today) ? " today" : ""}"><span class="cg-wd">${esc(cWd(d))}</span><button type="button" class="cg-dn" data-cal-day="${cYmd(d)}">${d.getDate()}</button></div>`).join("");
  const allday = days.map(d => {
    const ds = cDayStart(d), de = cAddDays(ds, 1);
    const evs = occ.filter(o => (o.e.allDay || o.en - o.s >= 864e5) && o.s < de && o.en > ds);
    return `<div class="cg-ad" data-cal-allday="${cYmd(d)}">${evs.map(o => `<button type="button" class="cg-chip c-${o.e.color || 0}" data-occ="${esc(occKey(o))}">${esc(o.e.title || T("Без названия", "(No title)"))}</button>`).join("")}${calTaskChips(cYmd(d), "cg-chip")}</div>`;
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
        <b>${esc(it.o.e.title || T("Без названия", "(No title)"))}</b><span class="cg-t">${esc(cTimeLabel(it.o.s) + " – " + cTimeLabel(it.o.en))}${it.o.e.meet ? " · " + T("видео", "video") : ""}</span><i class="cg-rs" data-rs aria-hidden="true"></i></button>`;
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
      ${evs.slice(0, 3).map(o => `<button type="button" class="cm-ev c-${o.e.color || 0}${o.e.allDay ? " ad" : ""}" data-occ="${esc(occKey(o))}">${o.e.allDay ? "" : `<i>${esc(cTimeLabel(o.s))}</i> `}${esc(o.e.title || T("Без названия", "(No title)"))}</button>`).join("")}${calTaskChips(cYmd(d), "cm-ev")}${more}</div>`;
  }).join("");
  return `<div class="cm"><div class="cm-head">${wds}</div><div class="cm-grid">${cells}</div></div>`;
}

function calMiniHtml() {
  const m = calMini || new Date(calDate.getFullYear(), calDate.getMonth(), 1), gs = cWeekStart(m), today = new Date();
  const ws = cWeekStart(calDate), we = cAddDays(ws, 7);
  const wds = Array.from({ length: 7 }, (_, i) => `<span>${esc(cWd(cAddDays(gs, i)).slice(0, 2))}</span>`).join("");
  const has = new Set(); occInRange(gs, cAddDays(gs, 42)).forEach(o => has.add(cYmd(o.s))); calTasks().forEach(t => has.add(t.due));
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
  document.querySelectorAll(".cg-ev").forEach(el => el.addEventListener("pointerdown", calDragStart));
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
  const recurring = !isNew && (e.repeat || "none") !== "none";
  let [S, E] = evBounds(e);
  const [S0] = evBounds(e); // начало всей серии
  if (occ && recurring) { const dur = E - S; S = new Date(occ.s); E = new Date(S.getTime() + dur); } // показываем выбранный повтор
  const endDay = e.allDay ? cAddDays(E, -1) : E;
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
    ${recurring ? `<p class="cp-note">${T("Повторяющееся событие — при сохранении или удалении спросим, к каким повторам применить.", "Recurring event — on save or delete you'll choose which occurrences it applies to.")}</p>` : ""}
    ${e.meet && !isNew ? `<a class="cp-join" data-cp-join href="${esc(e.meet)}" target="_blank" rel="noopener noreferrer">${ci("video")} ${T("Подключиться к встрече", "Join meeting")}</a>` : ""}
    <div class="cp-row"><span class="cp-ic">${ci("clock")}</span><div class="cp-f">
      <div class="cp-when">
        <input type="date" id="cp-sd" class="field" value="${cYmd(S)}">
        <input type="time" id="cp-st" class="field cp-t" step="900" value="${cHm(S)}">
        <span class="cp-dash">–</span>
        <input type="time" id="cp-et" data-dur-from="cp-st" class="field cp-t" step="900" value="${cHm(E)}">
        <input type="date" id="cp-ed" class="field" value="${cYmd(endDay)}">
      </div>
      <div class="cp-sub"><label class="chk"><input type="checkbox" id="cp-ad"${e.allDay ? " checked" : ""}> ${T("Весь день", "All day")}</label>
        <select id="cp-rep" class="field slim">${reps.map(([v, l]) => opt(v, l, e.repeat || "none")).join("")}</select></div>
      <div class="cp-sub cp-every${["daily", "weekly", "monthly", "yearly"].includes(e.repeat || "none") ? "" : " hidden"}"><label for="cp-every">${T("Интервал: каждые", "Every")}</label><input type="number" id="cp-every" class="field cp-n" min="1" max="99" value="${Math.max(1, +e.every || 1)}"><span id="cp-every-u"></span></div>
      <div class="cp-sub cp-until${(e.repeat || "none") === "none" ? " hidden" : ""}"><label for="cp-until">${T("Повторять до (необязательно)", "Repeat until (optional)")}</label><input type="date" id="cp-until" class="field" value="${esc(e.until || "")}"></div>
    </div></div>
    <div class="cp-row"><span class="cp-ic">${ci("users")}</span><div class="cp-f"><input id="cp-guests" class="field" placeholder="${T("Добавьте гостей (email через запятую)", "Add guests (comma-separated emails)")}" value="${esc(e.guests || "")}" autocomplete="off"></div></div>
    <div class="cp-row"><span class="cp-ic">${ci("video")}</span><div class="cp-f">
      <input id="cp-meet" class="field" inputmode="url" placeholder="${T("Ссылка на видеовстречу (Meet, Zoom, Telegram…)", "Video call link (Meet, Zoom, Telegram…)")}" value="${esc(e.meet || "")}" autocomplete="off">
      <div class="cp-btns"><button type="button" class="ghost cp-small" data-cp-jitsi>${T("Создать ссылку Jitsi Meet", "Create a Jitsi Meet link")}</button><a class="ghost cp-small cp-link-btn" data-cp-meet-open href="${esc(e.meet || "")}" target="_blank" rel="noopener noreferrer">${T("Открыть", "Open")}</a><button type="button" class="ghost cp-small" data-cp-meet-copy>${T("Скопировать", "Copy")}</button></div>
    </div></div>
    <div class="cp-row"><span class="cp-ic">${ci("pin")}</span><div class="cp-f"><input id="cp-loc" class="field" placeholder="${T("Добавьте место", "Add location")}" value="${esc(e.location || "")}" autocomplete="off"></div></div>
    <div class="cp-row"><span class="cp-ic">${ci("text")}</span><div class="cp-f"><textarea id="cp-note" class="field" rows="3" placeholder="${T("Добавьте описание", "Add description")}">${esc(e.note || "")}</textarea></div></div>
    <div class="cp-row"><span class="cp-ic">${ci("bell")}</span><div class="cp-f"><div id="cp-rems">${(evReminds(e).length ? evReminds(e) : isNew ? [] : []).map(v => `<div class="cp-rem-r"><select class="field slim cp-rem">${rems.slice(1).map(([vv, l]) => opt(vv, l, v)).join("")}</select><button type="button" class="ib cp-rem-x" data-rem-del aria-label="×">✕</button></div>`).join("")}</div>
      <button type="button" class="ghost cp-small" data-rem-add>${T("+ Напоминание", "+ Reminder")}</button></div></div>
    <div class="cp-row"><span class="cp-ic">${ci("palette")}</span><div class="cp-f cp-colors">${colors}</div></div>
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
  const everyUnit = () => { const n = Math.max(1, +g("cp-every").value || 1), r = g("cp-rep").value;
    const f = (one, few, many) => T(n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many, "");
    g("cp-every-u").textContent = r === "daily" ? f("день", "дня", "дней") || (n > 1 ? "days" : "day") : r === "weekly" ? f("неделю", "недели", "недель") || (n > 1 ? "weeks" : "week") : r === "monthly" ? f("месяц", "месяца", "месяцев") || (n > 1 ? "months" : "month") : f("год", "года", "лет") || (n > 1 ? "years" : "year"); };
  g("cp-rep").onchange = () => { const r = g("cp-rep").value; ov.querySelector(".cp-until").classList.toggle("hidden", r === "none"); ov.querySelector(".cp-every").classList.toggle("hidden", !["daily", "weekly", "monthly", "yearly"].includes(r)); everyUnit(); };
  g("cp-every").oninput = everyUnit; everyUnit();
  const remRow = v => `<div class="cp-rem-r"><select class="field slim cp-rem">${rems.slice(1).map(([vv, l]) => opt(vv, l, v)).join("")}</select><button type="button" class="ib cp-rem-x" data-rem-del aria-label="×">✕</button></div>`;
  if (isNew && e.remind != null && e.remind >= 0 && !g("cp-rems").children.length) g("cp-rems").innerHTML = remRow(e.remind);
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
  g("cp-meet").addEventListener("input", () => { const a = ov.querySelector("[data-cp-meet-open]"); if (a) a.href = meetUrl() || ""; });
  const save = async () => {
    const title = g("cp-title").value.trim(), ad = g("cp-ad").checked;
    let st = ad ? g("cp-sd").value : g("cp-sd").value + "T" + g("cp-st").value, enS = ad ? g("cp-ed").value : g("cp-ed").value + "T" + g("cp-et").value;
    const sD = cParse(st), eD = cParse(enS);
    if (!sD) { g("cp-err").textContent = T("Укажите дату", "Enter a date"); return; }
    if (!eD || (ad ? eD < sD : eD <= sD)) { if (ad) enS = st; else { const x = new Date(sD.getTime() + 36e5); enS = cYmd(x) + "T" + cHm(x); } }
    const mv = g("cp-meet").value.trim(); if (mv && !meetUrl()) { g("cp-err").textContent = T("Некорректная ссылка на встречу", "Invalid meeting link"); return; }
    const reminds = [...new Set([...ov.querySelectorAll(".cp-rem")].map(s => +s.value))].sort((a, b) => a - b).slice(0, 5);
    const rem = reminds.length ? reminds[0] : -1;
    const rp = g("cp-rep").value, every = ["daily", "weekly", "monthly", "yearly"].includes(rp) ? Math.max(1, Math.min(99, Math.floor(+g("cp-every").value || 1))) : 1;
    const data = { title: title || T("Без названия", "(No title)"), allDay: ad, start: st, end: enS, repeat: rp, every, until: rp !== "none" ? g("cp-until").value : "",
      meet: mv ? meetUrl() : "", location: g("cp-loc").value.trim(), guests: g("cp-guests").value.trim(), note: g("cp-note").value, remind: rem, reminds, color };
    if (isNew) entries.push(calMakeEvent(data));
    else {
      const scope = recurring ? await calScope(false) : "all"; if (!scope) return;
      const x = entries.find(y => y.id === e.id); if (!x) return close();
      calApplyEdit(x, data, S, S0, scope);
    }
    await persist(); close(); renderNav(); render();
    toast(isNew ? T("Событие создано", "Event created") : T("Событие сохранено", "Event saved"));
    if (rem >= 0 && "Notification" in window && Notification.permission === "default") { try { Notification.requestPermission(); } catch {} }
  };
  ov.onclick = async ev => {
    if (ev.target === ov || ev.target.closest("[data-cp-close]")) return close();
    const c = ev.target.closest("[data-cp-color]"); if (c) { color = +c.dataset.cpColor; ov.querySelectorAll(".cp-color").forEach(x => x.classList.toggle("on", x === c)); return; }
    if (ev.target.closest("[data-cp-save]")) return save();
    if (ev.target.closest("[data-rem-add]")) { const box = g("cp-rems"); if (box.children.length >= 5) { toast(T("Не больше 5 напоминаний", "Up to 5 reminders")); return; } const used = [...box.querySelectorAll(".cp-rem")].map(s => +s.value); const next = [10, 60, 1440, 30, 5, 0].find(v => !used.includes(v)) ?? 10; box.insertAdjacentHTML("beforeend", remRow(next)); return; }
    const rd = ev.target.closest("[data-rem-del]"); if (rd) { rd.closest(".cp-rem-r").remove(); return; }
    if (ev.target.closest("[data-cp-jitsi]")) { const id = "SHUT-" + [...rand(9)].map(b => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join(""); g("cp-meet").value = "https://meet.jit.si/" + id; return; }
    const mo = ev.target.closest("[data-cp-meet-open]"); if (mo) { const u = meetUrl(); if (!u) { ev.preventDefault(); toast(T("Сначала вставьте ссылку", "Paste a link first")); } else mo.href = u; return; }
    if (ev.target.closest("[data-cp-join]")) return; // обычная ссылка — браузер откроет сам
    if (ev.target.closest("[data-cp-meet-copy]")) { const u = meetUrl(); if (u) { try { await navigator.clipboard.writeText(u); toast(T("Ссылка скопирована", "Link copied")); } catch {} } return; }
    if (ev.target.closest("[data-cp-del]")) {
      const scope = recurring ? await calScope(true) : (await confirmBox(T("Удалить событие «", "Delete event “") + (e.title || "") + T("»?", "”?"), T("Удалить", "Delete"), true)) ? "all" : null;
      if (!scope) return;
      const x = entries.find(y => y.id === e.id); if (!x) return close();
      const msg = calApplyDelete(x, S, S0, scope); await persist();
      close(); renderNav(); render(); toast(msg);
    }
  };
  setTimeout(() => { if (isNew) g("cp-title").focus(); }, 30);
}

/* ---------- повторы: «только это / это и последующие / все» ---------- */
const cFmt = (d, allDay) => allDay ? cYmd(d) : cYmd(d) + "T" + cHm(d);
function calMakeEvent(data) { const now = Date.now(); return { type: "event", id: b64(rand(9)), created: now, updated: now, pwChanged: now, ...data }; }
function calScope(isDel) {
  return modal(isDel ? T("Удалить повторяющееся событие:", "Delete recurring event:") : T("Сохранить изменения повторяющегося события:", "Save changes to recurring event:"),
    [[T("Только это событие", "This event"), "one"], [T("Это и последующие", "This and following"), "next", "ghost"], [T("Все события", "All events"), "all", "ghost"], [T("Отмена", "Cancel"), null, "ghost"]]);
}
// x — исходная серия, data — данные из формы, occS — начало выбранного повтора, S0 — начало серии
function calApplyEdit(x, data, occS, S0, scope) {
  const now = Date.now(), recurring = (x.repeat || "none") !== "none";
  if (!recurring || scope === "all") {
    if (recurring) { // сдвигаем всю серию на столько же, на сколько передвинули выбранный повтор
      const nS = cParse(data.start), nE = cParse(data.end), shift = nS - occS;
      const base = new Date(S0.getTime() + shift), len = nE - nS;
      data = { ...data, start: cFmt(base, data.allDay), end: cFmt(new Date(base.getTime() + len), data.allDay) };
      if (data.allDay !== !!x.allDay) x.ex = []; // поменялся тип — старые исключения теряют смысл
    }
    Object.assign(x, data, { updated: now }); return;
  }
  const day = cYmd(occS);
  if (scope === "one") {
    x.ex = [...new Set([...(x.ex || []), day])]; x.updated = now;
    entries.push(calMakeEvent({ ...data, repeat: "none", until: "" }));
    return;
  }
  // это и последующие: старая серия заканчивается накануне, новая начинается с выбранного дня
  if (day === cYmd(S0)) { Object.assign(x, data, { updated: now }); return; }
  x.until = cYmd(cAddDays(cDayStart(occS), -1)); x.updated = now;
  entries.push(calMakeEvent({ ...data, ex: (x.ex || []).filter(d => d >= day) }));
}
function calApplyDelete(x, occS, S0, scope) {
  const now = Date.now(), day = cYmd(occS);
  if (scope === "one") { x.ex = [...new Set([...(x.ex || []), day])]; x.updated = now; return T("Повтор удалён", "Occurrence deleted"); }
  if (scope === "next" && day !== cYmd(S0)) { x.until = cYmd(cAddDays(cDayStart(occS), -1)); x.updated = now; return T("Последующие повторы удалены", "Following occurrences deleted"); }
  x.deletedAt = now; return T("Событие в корзине", "Event moved to trash");
}

/* ---------- клики по календарю ---------- */
function calFindOcc(key) {
  const [id, ts] = key.split("|"); const e = entries.find(x => x.id === id); if (!e) return null;
  const [S, E] = evBounds(e), s = new Date(+ts); return { e, s, en: new Date(s.getTime() + (E - S)) };
}
function calClick(ev) {
  if (calDragged) { calDragged = false; return true; } // клик сразу после перетаскивания — не открываем окно
  const t = ev.target;
  const o = t.closest("[data-occ]"); if (o) { const f = calFindOcc(o.dataset.occ); if (f) calOpenPop(f.e, f); return true; }
  const v = t.closest("[data-cal-view]"); if (v) { calView = v.dataset.calView; try { localStorage.setItem("vault.calview", calView); } catch {} calMini = null; renderCalendar(); return true; }
  const tk = t.closest("[data-cal-task]"); if (tk) { const x = entries.find(y => y.id === tk.dataset.calTask); if (x) { x.done = !x.done; x.updated = Date.now(); persist(); renderNav(); renderCalendar(); toast(x.done ? T("Задача выполнена", "Task done") : T("Задача снова активна", "Task reopened")); } return true; }
  if (t.closest("[data-cal-export]")) { calExportIcs(); return true; }
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
  occInRangeAll(new Date(now - 864e5), new Date(now + 3 * 864e5)).forEach(o => evReminds(o.e).forEach(r => {
    const at = evRemindAt(o, r).getTime();
    const key = occKey(o) + "|" + r;
    if (at <= now && at > now - 2 * 6e4 && !calFired.has(key)) {
      calFired.add(key);
      const n = calNotifText(o, r);
      try { if ("Notification" in window && Notification.permission === "granted") new Notification(n.title, { body: n.body, tag: key }); } catch {}
      toast(n.title + " — " + n.body);
    }
  }));
}
function occInRangeAll(from, to) { const all = []; eventsList().forEach(e => all.push(...evOccurrences(e, from, to))); return all; }
setInterval(calRemindTick, 30000);

// Количество событий сегодня — для счётчика в меню
function calTodayCount() { const d = cDayStart(new Date()); return occInRangeAll(d, cAddDays(d, 1)).length; }

/* ---------- перетаскивание и растягивание событий мышью (шаг 15 минут) ---------- */
let calDragged = false;
function calDragStart(ev) {
  if (ev.button !== 0 || ev.pointerType !== "mouse") return; // на телефоне палец прокручивает сетку
  const el = ev.currentTarget, f = calFindOcc(el.dataset.occ); if (!f) return;
  const resize = !!ev.target.closest("[data-rs]");
  const cols = [...document.querySelectorAll(".cg-col")], col0 = cols.indexOf(el.parentElement);
  const colW = el.parentElement.getBoundingClientRect().width;
  const top0 = parseFloat(el.dataset.top), h0 = parseFloat(el.dataset.h);
  const x0 = ev.clientX, y0 = ev.clientY, step = CAL_HOUR_PX / 4;
  let moved = false, dMin = 0, dDay = 0;
  const label = el.querySelector(".cg-t");
  const fmtRange = (s, e) => cTimeLabel(s) + " – " + cTimeLabel(e);
  const move = e => {
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    if (!moved) { moved = true; el.classList.add("dragging"); document.body.classList.add("cal-dragging"); }
    dMin = Math.round(dy / step) * 15;
    if (resize) {
      dMin = Math.max(dMin, 15 - Math.round((f.en - f.s) / 6e4)); // не короче 15 минут
      el.style.height = Math.max(step - 2, h0 + dMin / 60 * CAL_HOUR_PX) + "px";
      if (label) label.textContent = fmtRange(f.s, new Date(f.en.getTime() + dMin * 6e4));
    } else {
      dDay = cols.length > 1 ? Math.max(-col0, Math.min(cols.length - 1 - col0, Math.round(dx / colW))) : 0;
      const top = Math.max(0, Math.min(24 * CAL_HOUR_PX - step, top0 + dMin / 60 * CAL_HOUR_PX));
      dMin = Math.round((top - top0) / CAL_HOUR_PX * 60 / 15) * 15;
      el.style.top = top + "px";
      const target = cols[col0 + dDay]; if (target && el.parentElement !== target) target.appendChild(el);
      el.style.left = "2px"; el.style.width = "calc(100% - 4px)";
      const ns = new Date(cAddDays(f.s, dDay).getTime() + dMin * 6e4);
      if (label) label.textContent = fmtRange(ns, new Date(ns.getTime() + (f.en - f.s)));
    }
  };
  const up = async () => {
    removeEventListener("pointermove", move); removeEventListener("pointerup", up);
    document.body.classList.remove("cal-dragging");
    if (!moved) return; // обычный клик — откроется окно события
    calDragged = true; setTimeout(() => { calDragged = false; }, 0);
    if (!dMin && !dDay) { renderCalendar(); return; }
    const x = entries.find(y => y.id === f.e.id); if (!x) return renderCalendar();
    const ns = resize ? f.s : new Date(cAddDays(f.s, dDay).getTime() + dMin * 6e4);
    const ne = resize ? new Date(f.en.getTime() + dMin * 6e4) : new Date(ns.getTime() + (f.en - f.s));
    const data = { title: x.title, allDay: false, start: cFmt(ns, false), end: cFmt(ne, false), repeat: x.repeat || "none", until: x.until || "",
      meet: x.meet || "", location: x.location || "", guests: x.guests || "", note: x.note || "", remind: x.remind ?? -1, reminds: evReminds(x), every: x.every || 1, color: x.color || 0 };
    const recurring = (x.repeat || "none") !== "none";
    const scope = recurring ? await calScope(false) : "all";
    if (!scope) return renderCalendar();
    calApplyEdit(x, data, f.s, evBounds(x)[0], scope);
    await persist(); renderNav(); renderCalendar();
    toast(resize ? T("Длительность изменена", "Duration changed") : T("Событие перенесено", "Event moved"));
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up);
}

// Текст «когда» для выгрузки
function evWhenText(x) { const [S, E] = evBounds(x); if (x.allDay) { const e = cAddDays(E, -1); return cYmd(S) + (cYmd(e) !== cYmd(S) ? " – " + cYmd(e) : "") + T(" (весь день)", " (all day)"); } return cYmd(S) + " " + cHm(S) + " – " + (cSameDay(S, E) ? "" : cYmd(E) + " ") + cHm(E); }

/* ---------- импорт / экспорт .ics (Google Календарь, Outlook, Apple) ---------- */
const ICS_FREQ = { daily: "FREQ=DAILY", weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY", yearly: "FREQ=YEARLY" };
const icsEsc = s => String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsUnesc = s => String(s || "").replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1");
const icsDT = (s, allDay) => allDay ? s.replace(/-/g, "") : s.replace(/[-:]/g, "") + "00";
function icsFold(line) { // строки длиннее 75 символов переносятся по стандарту
  const out = []; let s = line;
  while (s.length > 73) { out.push(s.slice(0, 73)); s = " " + s.slice(73); }
  out.push(s); return out.join("\r\n");
}
function calExportIcs() {
  const list = eventsList(); if (!list.length) { toast(T("Событий пока нет", "No events yet")); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SHUT//Calendar//RU", "CALSCALE:GREGORIAN"];
  list.forEach(e => {
    const [S, E] = evBounds(e);
    L.push("BEGIN:VEVENT", "UID:" + (e.uid || e.id + "@shut"), "DTSTAMP:" + stamp);
    if (e.allDay) { L.push("DTSTART;VALUE=DATE:" + cYmd(S).replace(/-/g, ""), "DTEND;VALUE=DATE:" + cYmd(E).replace(/-/g, "")); }
    else { L.push("DTSTART:" + icsDT(cFmt(S, false), false), "DTEND:" + icsDT(cFmt(E, false), false)); }
    L.push("SUMMARY:" + icsEsc(e.title));
    const rep = ICS_FREQ[e.repeat || "none"];
    if (rep) L.push("RRULE:" + rep + ((+e.every || 1) > 1 && e.repeat !== "weekdays" ? ";INTERVAL=" + Math.floor(+e.every) : "") + (e.until ? ";UNTIL=" + e.until.replace(/-/g, "") + (e.allDay ? "" : "T235959") : ""));
    (e.ex || []).forEach(d => L.push(e.allDay ? "EXDATE;VALUE=DATE:" + d.replace(/-/g, "") : "EXDATE:" + d.replace(/-/g, "") + "T" + cHm(S).replace(":", "") + "00"));
    if (e.location) L.push("LOCATION:" + icsEsc(e.location));
    const desc = [e.note, e.meet && T("Видеовстреча: ", "Video call: ") + e.meet].filter(Boolean).join("\n\n");
    if (desc) L.push("DESCRIPTION:" + icsEsc(desc));
    if (e.meet) L.push("URL:" + e.meet);
    (e.guests || "").split(/[,;\s]+/).filter(g => /@/.test(g)).forEach(g => L.push("ATTENDEE:mailto:" + g));
    evReminds(e).forEach(r => L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(e.title), "TRIGGER:-PT" + r + "M", "END:VALARM"));
    L.push("END:VEVENT");
  });
  L.push("END:VCALENDAR");
  download(new Blob([L.map(icsFold).join("\r\n") + "\r\n"], { type: "text/calendar" }), "shut-calendar-" + cYmd(new Date()) + ".ics");
  toast(T("Выгружено событий: ", "Events exported: ") + list.length);
}
// Разбор даты из .ics: 20261121, 20261121T140000, 20261121T110000Z (UTC → местное время)
function icsParseDT(v, params) {
  const allDay = /VALUE=DATE(;|$)/i.test(params || "") || /^\d{8}$/.test(v);
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v.trim()); if (!m) return null;
  let d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0))) : new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return { d, allDay };
}
function icsParse(text) {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const evs = []; let cur = null, inAlarm = false;
  for (const raw of lines) {
    if (raw === "BEGIN:VEVENT") { cur = { attendees: [], exdates: [] }; continue; }
    if (raw === "END:VEVENT") { if (cur) evs.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (raw === "BEGIN:VALARM") { inAlarm = true; continue; } if (raw === "END:VALARM") { inAlarm = false; continue; }
    const i = raw.indexOf(":"); if (i < 0) continue;
    const head = raw.slice(0, i), val = raw.slice(i + 1), [name, ...pp] = head.split(";"), params = pp.join(";"), N = name.toUpperCase();
    if (inAlarm) { if (N === "TRIGGER") { const m = /^-?P(?:(\d+)W)?(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(val); if (m) { const v = (+(m[1] || 0)) * 10080 + (+(m[2] || 0)) * 1440 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)); (cur.reminds = cur.reminds || []).push(v); if (cur.remind == null) cur.remind = v; } } continue; }
    if (N === "UID") cur.uid = val.trim();
    else if (N === "SUMMARY") cur.title = icsUnesc(val);
    else if (N === "DESCRIPTION") cur.note = icsUnesc(val);
    else if (N === "LOCATION") cur.location = icsUnesc(val);
    else if (N === "URL") cur.url = val.trim();
    else if (N === "DTSTART") cur.start = icsParseDT(val, params);
    else if (N === "DTEND") cur.end = icsParseDT(val, params);
    else if (N === "DURATION") { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(val); if (m) cur.dur = ((+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0))) * 6e4; }
    else if (N === "RRULE") cur.rrule = val.trim();
    else if (N === "EXDATE") val.split(",").forEach(v => { const p = icsParseDT(v, params); if (p) cur.exdates.push(cYmd(p.d)); });
    else if (N === "RECURRENCE-ID") cur.recId = icsParseDT(val, params);
    else if (N === "ATTENDEE") { const m = /mailto:(.+)$/i.exec(val); if (m) cur.attendees.push(m[1].trim()); }
    else if (N === "X-GOOGLE-CONFERENCE") cur.conf = val.trim();
    else if (N === "STATUS" && /CANCELLED/i.test(val)) cur.cancelled = true;
  }
  return evs;
}
function icsRepeat(rr) {
  if (!rr) return { repeat: "none" };
  const p = Object.fromEntries(rr.split(";").map(kv => kv.split("=")).map(([k, v]) => [k.toUpperCase(), v]));
  const every = Math.max(1, Math.min(99, parseInt(p.INTERVAL || "1", 10) || 1));
  let repeat = { DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly" }[p.FREQ] || "none";
  if (repeat === "weekly" && p.BYDAY) { const days = p.BYDAY.split(",").sort().join(","); if (days === "FR,MO,TH,TU,WE" && every === 1) repeat = "weekdays"; else if (p.BYDAY.includes(",")) return { repeat: "none", unsupported: true }; }
  if (repeat === "monthly" && (p.BYDAY || p.BYSETPOS)) return { repeat: "none", unsupported: true }; // «каждый 2-й вторник» пока не поддерживается
  let until = ""; if (p.UNTIL && /^[0-9]{8}/.test(p.UNTIL)) until = p.UNTIL.slice(0, 4) + "-" + p.UNTIL.slice(4, 6) + "-" + p.UNTIL.slice(6, 8); // дата из UNTIL как есть, без сдвига пояса
  return every > 1 ? { repeat, every, until, count: p.COUNT ? +p.COUNT : 0 } : { repeat, until, count: p.COUNT ? +p.COUNT : 0 };
}
// Разобранные VEVENT → данные событий SHUT (общая часть импорта и подписок)
// skipUid(uid) → true, если серию надо пропустить (уже есть в календаре)
function icsBuild(raw, skipUid) {
  let simplified = 0, skipped = 0;
  const conv = r => {
    if (!r.start) return null;
    const allDay = r.start.allDay, S = r.start.d;
    let E = r.end ? r.end.d : r.dur ? new Date(S.getTime() + r.dur) : allDay ? cAddDays(S, 1) : new Date(S.getTime() + 36e5);
    if (allDay) E = cAddDays(E, -1); // в .ics конец дня — исключительно
    if (E < S) E = new Date(S);
    const rep = icsRepeat(r.rrule); if (rep.unsupported) simplified++;
    let until = rep.until || "";
    if (!until && rep.count && rep.repeat !== "none") { // COUNT → дата окончания
      const tmp = { allDay, start: cFmt(S, allDay), end: cFmt(allDay ? S : E, allDay), repeat: rep.repeat, every: rep.every || 1 };
      const occ = evOccurrences(tmp, S, cAddDays(S, 3700)).slice(0, rep.count); if (occ.length) until = cYmd(occ[occ.length - 1].s);
    }
    const text = [r.note, r.location, r.url].join(" ");
    const meet = r.conf || (/(https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us|teams\.microsoft\.com|meet\.jit\.si|t\.me)\/[^\s"<>]+)/i.exec(text) || [])[1] || "";
    return { title: r.title || T("Без названия", "(No title)"), allDay, start: cFmt(S, allDay), end: cFmt(E, allDay), repeat: rep.repeat, every: rep.every || 1, until,
      ex: r.exdates.slice(), meet: safeUrl(meet) || "", location: r.location || "", guests: r.attendees.join(", "), note: r.note || "",
      remind: r.remind != null ? r.remind : -1, reminds: [...new Set(r.reminds || [])].slice(0, 5), color: 1, uid: r.uid || "" };
  };
  const events = [], masters = new Map();
  raw.filter(r => !r.recId).forEach(r => {
    if (r.cancelled) return;
    if (r.uid && skipUid && skipUid(r.uid)) { skipped++; return; }
    const d = conv(r); if (!d) return; events.push(d); if (r.uid) masters.set(r.uid, d);
  });
  // изменённые отдельные повторы (RECURRENCE-ID): исключаем из серии и добавляем отдельным событием
  raw.filter(r => r.recId).forEach(r => {
    const m = masters.get(r.uid); if (!m) return;
    m.ex = [...new Set([...(m.ex || []), cYmd(r.recId.d)])];
    if (r.cancelled) return;
    const d = conv(r); if (d) events.push({ ...d, repeat: "none", until: "", uid: "" });
  });
  return { events, simplified, skipped };
}
async function calImportIcs(file) {
  let text; try { text = await file.text(); } catch { toast(T("Не удалось прочитать файл", "Could not read the file")); return; }
  if (!/BEGIN:VCALENDAR/.test(text)) { alertBox(T("Это не файл календаря .ics", "This is not an .ics calendar file")); return; }
  const known = new Set(eventsList().map(e => e.uid).filter(Boolean));
  const b = icsBuild(icsParse(text), uid => known.has(uid));
  b.events.forEach(d => entries.push(calMakeEvent(d)));
  await persist(); renderNav(); render();
  alertBox(T("Импортировано событий: ", "Events imported: ") + b.events.length + (b.skipped ? T(". Уже были в календаре: ", ". Already in calendar: ") + b.skipped : "") +
    (b.simplified ? T(". Сложных повторов (например, «каждый 2-й вторник месяца»): ", ". Complex repeats (e.g. 2nd Tuesday of the month): ") + b.simplified + T(" — добавлены только первым событием, проверьте их", " — added as the first event only, please check them") : "") + ".");
}

document.addEventListener("change", e => { const f = e.target.closest && e.target.closest("[data-cal-import]"); if (f && f.files[0]) { calImportIcs(f.files[0]); f.value = ""; } });

// Задачи со сроком — в календаре (в полосе «весь день» и в месяце)
function calTasks() { const q = ($("search").value || "").trim().toLowerCase(); return tasksList().filter(t => t.due && (!q || (t.title || "").toLowerCase().includes(q))); }
function calTaskChips(day, cls) { return calTasks().filter(t => t.due === day).map(t => `<button type="button" class="${cls} cal-task${t.done ? " done" : ""}" data-cal-task="${esc(t.id)}" title="${T("Отметить выполненной", "Mark done")}">${ci("task")}<span>${esc(t.title || T("Задача", "Task"))}</span></button>`).join(""); }

// Главная: ближайшие события на 7 дней
function homeUpcomingHtml() {
  const now = new Date(), occ = occInRangeAll(now, cAddDays(cDayStart(now), 8)).sort((a, b) => a.s - b.s).slice(0, 4);
  if (!occ.length) return "";
  const day = d => cSameDay(d, now) ? T("Сегодня", "Today") : cSameDay(d, cAddDays(now, 1)) ? T("Завтра", "Tomorrow") : d.toLocaleDateString(cLoc(), { weekday: "short", day: "numeric", month: "short" });
  return `<div class="dash-recent-head"><h2 class="dash-h2">${T("Ближайшие события", "Upcoming events")}</h2><button type="button" class="cats-more" data-view="calendar">${T("Календарь", "Calendar")} ›</button></div>
    <div class="home-up">${occ.map(o => `<button type="button" class="home-up-i" data-home-occ="${esc(occKey(o))}"><span class="cal-dot c-${o.e.color || 0}"></span><span class="home-up-t"><b>${esc(o.e.title || T("Без названия", "(No title)"))}</b><small>${esc(day(o.s) + " · " + (o.e.allDay ? T("весь день", "all day") : cTimeLabel(o.s) + " – " + cTimeLabel(o.en)))}${o.e.meet ? " · " + T("видеовстреча", "video call") : ""}</small></span>${ci("clock")}</button>`).join("")}</div>`;
}

/* ---------- iOS-приложение: локальные уведомления о событиях ----------
   Планируются на самом телефоне (без сервера) и срабатывают, даже когда приложение закрыто.
   Перепланируются при каждом сохранении сейфа и при входе. На сайте ничего не делают. */
let calNativeTimer = null;
function calScheduleNative() {
  if (typeof isNative !== "function" || !isNative()) return;
  clearTimeout(calNativeTimer);
  calNativeTimer = setTimeout(async () => {
    const LN = capPlugin("LocalNotifications"); if (!LN || !vaultKey) return;
    try {
      const perm = await LN.checkPermissions();
      if (perm.display !== "granted") { const r = await LN.requestPermissions(); if (r.display !== "granted") return; }
      const pend = await LN.getPending(); if (pend.notifications && pend.notifications.length) await LN.cancel({ notifications: pend.notifications.map(n => ({ id: n.id })) });
      const now = Date.now(), list = [];
      occInRangeAll(new Date(now), new Date(now + 15 * 864e5)).forEach(o => evReminds(o.e).forEach(r => {
        const at = evRemindAt(o, r);
        if (at.getTime() <= now + 5000 || at.getTime() > now + 14 * 864e5) return;
        let h = 0; for (const ch of occKey(o) + "|" + r) h = (h * 31 + ch.charCodeAt(0)) | 0;
        const n = calNotifText(o, r);
        list.push({ id: Math.abs(h) % 2147483000 + 1, title: n.title, body: n.body, schedule: { at, allowWhileIdle: true } });
      }));
      list.sort((a, b) => a.schedule.at - b.schedule.at);
      if (list.length) await LN.schedule({ notifications: list.slice(0, 60) }); // iOS хранит до 64 запланированных
    } catch {}
  }, 800);
}
function calCancelNative() { if (typeof isNative !== "function" || !isNative()) return; const LN = capPlugin("LocalNotifications"); if (LN) LN.getPending().then(p => p.notifications && p.notifications.length && LN.cancel({ notifications: p.notifications.map(n => ({ id: n.id })) })).catch(() => {}); }

/* ---------- разбор фразы для быстрого добавления (Ctrl+K), используется в notes-plus.js ---------- */
const QA_WD = { "пн": 1, "понедельник": 1, "вт": 2, "вторник": 2, "ср": 3, "среда": 3, "среду": 3, "чт": 4, "четверг": 4, "пт": 5, "пятница": 5, "пятницу": 5, "сб": 6, "суббота": 6, "субботу": 6, "вс": 0, "воскресенье": 0,
  "mon": 1, "monday": 1, "tue": 2, "tuesday": 2, "wed": 3, "wednesday": 3, "thu": 4, "thursday": 4, "fri": 5, "friday": 5, "sat": 6, "saturday": 6, "sun": 0, "sunday": 0 };
const QA_MON = ["янв", "фев", "мар", "апр", "мая|май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const QA_MON_EN = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function qaParse(input, now) {
  now = now || new Date();
  let s = " " + input.trim() + " ", kind = "", date = null, time = null, dur = null, remind = null, repeat = "none", every = 1;
  const cut = re => { const m = re.exec(s); if (m) s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length); return m; };
  let m;
  if ((m = cut(/^\s*(заметка|заметку|note)[:\s]/i))) kind = "note";
  else if ((m = cut(/^\s*(задача|задачу|task|todo)[:\s]/i))) kind = "task";
  else if ((m = cut(/^\s*(событие|встреча|event)[:\s]/i))) kind = "event";
  if (kind !== "note") {
    if ((m = cut(/\s(напомнить|напоминание|remind(?:\s+me)?)\s+(?:за\s+|in\s+)?(\d+)?\s*(мин[а-яё]*|min[a-z]*|m|час[а-яё]*|ч|hours?|h|д(?:ень|ня|ней)|days?|d)(?:\s+до)?(?=\s)/i))) {
      const n = +(m[2] || 1), u = m[3].toLowerCase(); remind = /^(час|ч|h)/.test(u) ? n * 60 : /^(д|d)/.test(u) ? n * 1440 : n;
    }
    const NUMW = { "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6 };
    if ((m = cut(/\s(?:каждые|каждых|every)\s+(\d{1,2}|два|две|три|четыре|пять|шесть|two|three|four|five|six)\s+(дн[а-яё]*|сут[а-яё]*|days?|недел[а-яё]*|weeks?|месяц[а-яё]*|months?|год[а-яё]*|лет|years?)(?=\s)/i))) {
      every = +m[1] || NUMW[m[1].toLowerCase()] || 1; const u = m[2].toLowerCase();
      repeat = /^(дн|сут|day)/.test(u) ? "daily" : /^(недел|week)/.test(u) ? "weekly" : /^(месяц|month)/.test(u) ? "monthly" : "yearly";
    }
    else if ((m = cut(/\s(каждый день|ежедневно|daily|every day)(?=\s)/i))) repeat = "daily";
    else if ((m = cut(/\s(по будням|в будни|weekdays|every weekday)(?=\s)/i))) repeat = "weekdays";
    else if ((m = cut(/\s(каждую неделю|еженедельно|weekly|every week)(?=\s)/i))) repeat = "weekly";
    else if ((m = cut(/\s(каждый месяц|ежемесячно|monthly|every month)(?=\s)/i))) repeat = "monthly";
    else if ((m = cut(/\s(каждый год|ежегодно|yearly|every year)(?=\s)/i))) repeat = "yearly";
    if ((m = cut(/\s(?:на\s+|for\s+)?(\d+(?:[.,]\d+)?)\s*(час[а-яё]*|ч|hours?|h|мин[а-яё]*|min[a-z]*|m)(?=\s)/i))) { const n = +m[1].replace(",", "."), u = m[2].toLowerCase(); dur = /^(час|ч|h)/.test(u) ? Math.round(n * 60) : Math.round(n); }
    else if ((m = cut(/\s(?:на\s+)?(полчаса|час|an hour|half an hour)(?=\s)/i))) dur = /пол|half/i.test(m[1]) ? 30 : 60;
    const okT = (h, mi) => h < 24 && mi < 60;
    if ((m = /\s(?:в\s+|at\s+)?([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?(?=\s)/i.exec(s)) || (m = /\s(?:в|at)\s+([01]?\d|2[0-3])\.([0-5]\d)(?=\s)/i.exec(s))) {
      s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
      let h = +m[1]; if (m[3]) h = h % 12 + (/pm/i.test(m[3]) ? 12 : 0); if (okT(h, +m[2])) time = [h, +m[2]];
    }
    else if ((m = cut(/\s(?:в|at)\s+(\d{1,2})\s*(am|pm|утра|дня|вечера|ч)?(?=\s)/i))) { let h = +m[1]; if (/pm|дня|вечера/i.test(m[2] || "") && h < 12) h += 12; if (/am|утра/i.test(m[2] || "") && h === 12) h = 0; time = [h, 0]; }
    else if ((m = cut(/\s(\d{1,2})\s*(am|pm)(?=\s)/i))) { let h = +m[1] % 12 + (/pm/i.test(m[2]) ? 12 : 0); time = [h, 0]; }
    const d0 = new Date(now); d0.setHours(0, 0, 0, 0);
    if ((m = cut(/\s(послезавтра|day after tomorrow)(?=\s)/i))) date = cAddDays(d0, 2);
    else if ((m = cut(/\s(завтра|tomorrow)(?=\s)/i))) date = cAddDays(d0, 1);
    else if ((m = cut(/\s(сегодня|today|tonight)(?=\s)/i))) date = d0;
    else if ((m = cut(/\s(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?(?=\s)/))) { let y = m[3] ? +m[3] : d0.getFullYear(); if (y < 100) y += 2000; date = new Date(y, +m[2] - 1, +m[1]); if (!m[3] && date < d0) date.setFullYear(y + 1); }
    else if ((m = cut(new RegExp("\\s(\\d{1,2})\\s+(" + QA_MON.join("|") + "|" + QA_MON_EN.join("|") + ")[а-яa-z]*\\.?(?:\\s+(\\d{4}))?(?=\\s)", "i")))) {
      const k = m[2].toLowerCase(); let mi = QA_MON.findIndex(p => new RegExp("^(" + p + ")").test(k)); if (mi < 0) mi = QA_MON_EN.findIndex(p => k.startsWith(p));
      let y = m[3] ? +m[3] : d0.getFullYear(); date = new Date(y, mi, +m[1]); if (!m[3] && date < d0) date.setFullYear(y + 1);
    }
    else if ((m = cut(/\s(?:в|во|on|next)?\s*(пн|вт|ср|чт|пт|сб|вс|понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)(?=\s)/i))) {
      const wd = QA_WD[m[1].toLowerCase()]; let add = (wd - d0.getDay() + 7) % 7; if (add === 0) add = 7; date = cAddDays(d0, add);
    }
  }
  const title = s.replace(/\s+/g, " ").trim().replace(/^[,.:;\-–—]+|[,.:;\-–—]+$/g, "").trim();
  if (!kind) kind = time || repeat !== "none" ? "event" : "task";
  if (kind === "event" && !date) { date = new Date(now); date.setHours(0, 0, 0, 0); if (time && (time[0] * 60 + time[1]) <= now.getHours() * 60 + now.getMinutes() && repeat === "none") date = cAddDays(date, 1); }
  return every > 1 ? { kind, title, date, time, dur, remind, repeat, every } : { kind, title, date, time, dur, remind, repeat };
}

/* ---------- напоминания: до 5 на событие, скрытие названий ---------- */
// Список «за сколько минут» (старые события хранили одно значение в remind)
function evReminds(e) { const a = Array.isArray(e.reminds) ? e.reminds : (e.remind != null && e.remind >= 0 ? [e.remind] : []); return [...new Set(a.filter(v => v >= 0))].slice(0, 5); }
// Когда сработает: для «весь день» — в 9:00 дня события минус смещение (за 1 день → 9:00 накануне)
function evRemindAt(o, r) { return o.e.allDay ? new Date(o.s.getTime() + 9 * 36e5 - (r >= 1440 ? r : 0) * 6e4) : new Date(o.s.getTime() - r * 6e4); }
const calHideTitles = () => { try { return localStorage.getItem("vault.notif.hide") === "1"; } catch { return false; } };
function calNotifText(o, r) {
  const lead = r === 0 ? T("Сейчас", "Now") : r < 60 ? T("Через ", "In ") + r + T(" мин", " min") : r < 1440 ? T("Через ", "In ") + Math.round(r / 60) + T(" ч", " h") : T("Завтра", "Tomorrow");
  if (calHideTitles()) return { title: T("SHUT — напоминание", "SHUT — reminder"), body: lead + " · " + evTimeText(o) };
  return { title: o.e.title || "SHUT", body: lead + " · " + evTimeText(o) + (o.e.location ? " · " + o.e.location : "") };
}
// Настройки: «Скрывать названия событий в уведомлениях»
(() => { const cb = document.getElementById("set-notif-hide"); if (!cb) return; cb.checked = calHideTitles();
  cb.onchange = () => { try { localStorage.setItem("vault.notif.hide", cb.checked ? "1" : "0"); } catch {} if (typeof calScheduleNative === "function") calScheduleNative(); }; })();
