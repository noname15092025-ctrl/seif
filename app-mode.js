"use strict";
/* ======================================================================
   SHUT · Режим мобильного приложения (Android / iPhone).
   Включается только внутри приложения (Capacitor), на сайте ничего не меняет.
   Для проверки в браузере: index.html?app=1
   - нижняя панель вкладок: Главная · Сейф · Задачи · Календарь · Заметки;
   - вместо «+ Добавить» — круглая кнопка над панелью;
   - меню (генератор, аудит, настройки, блокировка) — по кнопке-аватару слева сверху;
   - окна выезжают снизу, нажатия дают отклик, без «сайтовых» эффектов наведения.
   ====================================================================== */
(() => {
  const forced = /[?&]app=1\b/.test(location.search);
  if (!((typeof NATIVE !== "undefined" && NATIVE) || forced)) return;
  document.documentElement.classList.add("is-app");

  const vv = $("v-vault"); if (!vv) return;
  const ico = d => `<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const TABS = [
    ["home", T("Главная", "Home"), ico('<path d="M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>')],
    ["vault", T("Сейф", "Vault"), ico('<rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>')],
    ["tasks", T("Задачи", "Tasks"), ico('<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>')],
    ["calendar", T("Календарь", "Calendar"), ico('<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>')],
    ["notes", T("Заметки", "Notes"), ico('<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M8.5 13h7M8.5 17h5"/>')],
  ];
  const bar = document.createElement("nav");
  bar.className = "app-tabs"; bar.setAttribute("aria-label", T("Разделы", "Sections"));
  bar.innerHTML = TABS.map(([v, l, i]) => `<button type="button" class="app-tab" data-tab="${v}">${i}<span>${l}</span></button>`).join("");
  vv.appendChild(bar);

  const tap = () => { try { navigator.vibrate && navigator.vibrate(6); } catch {} };
  const sync = v => bar.querySelectorAll(".app-tab").forEach(b => b.classList.toggle("on", b.dataset.tab === v));

  bar.onclick = e => {
    const b = e.target.closest(".app-tab"); if (!b) return;
    tap();
    const v = b.dataset.tab;
    document.querySelectorAll(".cal-pop-ov, .qa-ov").forEach(o => o.remove());
    vv.classList.remove("nav-open", "show-detail");
    if (v === view && v !== "vault") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    if (v === "vault") { view = "vault"; filter = "all"; selectedId = null; $("search").value = ""; setViewChrome("vault"); renderNav(); render(); }
    else setView(v);
    window.scrollTo(0, 0);
  };

  // Крупный заголовок раздела (как в приложениях iOS / Android) и кнопка поиска вместо постоянного поля
  const top = vv.querySelector(".list-top");
  const title = document.createElement("h1"); title.className = "app-title";
  top.after(title);
  const sBtn = document.createElement("button");
  sBtn.type = "button"; sBtn.className = "ib app-search-btn"; sBtn.setAttribute("aria-label", T("Поиск", "Search"));
  sBtn.innerHTML = ico('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>');
  top.appendChild(sBtn);
  sBtn.onclick = () => {
    tap();
    if (view === "home") { qaOpen(); return; } // на главной — поиск по всему сейфу
    const on = !vv.classList.contains("app-search-on");
    vv.classList.toggle("app-search-on", on);
    if (on) setTimeout(() => $("search").focus(), 30);
    else if ($("search").value) { $("search").value = ""; render(); }
  };
  const NAMES = { home: "", vault: T("Сейф", "Vault"), tasks: T("Задачи", "Tasks"), calendar: T("Календарь", "Calendar"), notes: T("Заметки", "Notes") };
  const setTitle = v => { title.textContent = NAMES[v] || ""; title.classList.toggle("hidden", !NAMES[v]); };

  // подсветка активной вкладки при любом переключении раздела (в том числе из меню и виджета)
  const origChrome = setViewChrome;
  setViewChrome = function (v) {
    origChrome(v); sync(v); setTitle(v);
    if (!$("search").value) vv.classList.remove("app-search-on");
  };
  setTitle(typeof view !== "undefined" ? view : "home");
  sync(typeof view !== "undefined" ? view : "home");

  // Календарь: полоска дней недели над сеткой (как в календаре телефона) и листание свайпом
  if (typeof renderCalendar === "function") {
    const origCal = renderCalendar;
    renderCalendar = function () { origCal.apply(this, arguments); try { weekStrip(); } catch {} };
  }
  function weekStrip() {
    if (calView !== "day") return;
    const bar = document.querySelector(".cal-bar"); if (!bar) return;
    const d0 = cDayStart(calDate), mon = cAddDays(d0, -((d0.getDay() + 6) % 7)), today = cDayStart(new Date());
    let h = '<div class="app-week">';
    for (let i = 0; i < 7; i++) {
      const d = cAddDays(mon, i);
      h += `<button type="button" class="aw-d${+d === +d0 ? " on" : ""}${+d === +today ? " today" : ""}" data-aw="${i}"><span>${d.toLocaleDateString(cLoc(), { weekday: "short" }).replace(".", "")}</span><b>${d.getDate()}</b></button>`;
    }
    const tt = bar.querySelector(".cal-title"); if (tt) { const s = d0.toLocaleDateString(cLoc(), { day: "numeric", month: "long" }); tt.textContent = +d0 === +today ? T("Сегодня, ", "Today, ") + s : s; }
    bar.insertAdjacentHTML("afterend", h + "</div>");
    bar.nextElementSibling.onclick = e => { const b = e.target.closest("[data-aw]"); if (!b) return; tap(); calDate = cAddDays(mon, +b.dataset.aw); renderCalendar(); };
  }
  let sx = 0, sy = 0;
  $("list").addEventListener("touchstart", e => { const t = e.touches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  $("list").addEventListener("touchend", e => {
    if (view !== "calendar" || document.querySelector(".cal-pop-ov")) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) { const b = document.querySelector(`[data-cal-step="${dx < 0 ? 1 : -1}"]`); if (b) b.click(); }
  }, { passive: true });

  // Задачи: нажатие на задачу открывает карточку-шторку (название, срок, приоритет, подзадачи).
  // Закрывается крестиком, нажатием мимо или системной кнопкой «Назад»; изменения сохраняются при закрытии.
  $("list").addEventListener("click", e => {
    if (view !== "tasks") return;
    const row = e.target.closest(".task-row"); if (!row || e.target.closest("button, input, a")) return;
    const x = tasksList().find(t => t.id === row.dataset.id); if (!x) return;
    e.stopPropagation(); e.preventDefault(); tap(); taskSheet(x);
  }, true);
  function taskSheet(x) {
    const PR = [[0, T("Нет", "None")], [1, T("Низкий", "Low")], [2, T("Средний", "Medium")], [3, T("Высокий", "High")]];
    const subs = x.subs || [];
    const ov = document.createElement("div"); ov.className = "cal-pop-ov";
    ov.innerHTML = `<div class="cal-pop ts-pop" role="dialog" aria-modal="true">
      <div class="cp-top"><button type="button" class="ts-done${x.done ? " on" : ""}" data-ts-done>${x.done ? T("✓ Выполнена", "✓ Done") : T("Отметить выполненной", "Mark as done")}</button><button type="button" class="cp-x" data-ts-x aria-label="${T("Закрыть", "Close")}">✕</button></div>
      <textarea class="ts-title" rows="2" maxlength="200" placeholder="${T("Название задачи", "Task name")}">${esc(x.title || "")}</textarea>
      <label class="ts-l">${T("Срок", "Due date")}</label>
      <div class="ts-row"><input type="date" class="field ts-due" value="${esc(x.due || "")}"><button type="button" class="ghost ts-clear" data-ts-nodue>${T("Без срока", "No date")}</button></div>
      <label class="ts-l">${T("Приоритет", "Priority")}</label>
      <div class="ts-pri">${PR.map(([v, l]) => `<button type="button" class="ts-p p${v}${(x.priority || 0) === v ? " on" : ""}" data-ts-pri="${v}">${l}</button>`).join("")}</div>
      ${subs.length ? `<label class="ts-l">${T("Подзадачи", "Subtasks")} · ${subs.filter(s => s.done).length}/${subs.length}</label><div class="ts-subs">${subs.map((s, i) => `<button type="button" class="ts-sub${s.done ? " on" : ""}" data-ts-sub="${i}"><i>${s.done ? "✓" : ""}</i><span>${esc(s.t || "")}</span></button>`).join("")}</div>` : ""}
      <div class="ts-foot"><button type="button" class="ghost ts-del" data-ts-del>${T("Удалить", "Delete")}</button><button type="button" class="cp-save" data-ts-x>${T("Готово", "Done")}</button></div>
    </div>`;
    document.body.appendChild(ov);
    let pri = x.priority || 0, done = !!x.done, due = x.due || "", changed = false;
    const title = ov.querySelector(".ts-title"), dueI = ov.querySelector(".ts-due");
    dueI.onchange = () => { due = dueI.value; changed = true; };
    const close = async del => {
      if (!document.body.contains(ov)) return;
      ov.remove();
      if (del) { x.deletedAt = Date.now(); }
      else {
        const t = title.value.trim();
        if (t && t !== x.title) { x.title = t; changed = true; }
        if (pri !== (x.priority || 0)) { x.priority = pri; changed = true; }
        if (done !== !!x.done) { x.done = done; changed = true; }
        if (due !== (x.due || "")) { x.due = due; changed = true; }
        if (!changed) return;
        x.updated = Date.now();
      }
      await persist(); renderNav(); renderTasks();
    };
    ov.onclick = e => {
      if (e.target === ov || e.target.closest("[data-ts-x]")) return close(false);
      if (e.target.closest("[data-ts-del]")) return close(true);
      const d = e.target.closest("[data-ts-done]");
      if (d) { tap(); done = !done; d.classList.toggle("on", done); d.textContent = done ? T("✓ Выполнена", "✓ Done") : T("Отметить выполненной", "Mark as done"); return; }
      const p = e.target.closest("[data-ts-pri]");
      if (p) { tap(); pri = +p.dataset.tsPri; ov.querySelectorAll("[data-ts-pri]").forEach(b => b.classList.toggle("on", b === p)); return; }
      if (e.target.closest("[data-ts-nodue]")) { due = ""; dueI.value = ""; changed = true; return; }
      const s = e.target.closest("[data-ts-sub]");
      if (s) { tap(); const it = subs[+s.dataset.tsSub]; it.done = !it.done; changed = true; s.classList.toggle("on", it.done); s.querySelector("i").textContent = it.done ? "✓" : ""; }
    };
    ov.addEventListener("keydown", e => { if (e.key === "Escape") close(false); });
  }

  // События: нажатие на существующее событие открывает карточку просмотра, редактор — по кнопке «Изменить»
  if (typeof calOpenPop === "function") {
    const origPop = calOpenPop;
    calOpenPop = function (e, occ, ...rest) {
      if (!e || !e.id) return origPop.call(this, e, occ, ...rest); // новое событие — сразу редактор
      eventSheet(e, occ, () => origPop.call(this, e, occ, ...rest));
    };
  }
  function eventSheet(e, occ, edit) {
    let [S, E] = evBounds(e);
    if (occ && occ.s) { const dur = E - S; S = new Date(occ.s); E = new Date(S.getTime() + dur); }
    const today = cDayStart(new Date());
    const dayTxt = d => { const k = Math.round((cDayStart(d) - today) / 864e5); return k === 0 ? T("Сегодня", "Today") : k === 1 ? T("Завтра", "Tomorrow") : k === -1 ? T("Вчера", "Yesterday") : d.toLocaleDateString(cLoc(), { weekday: "short", day: "numeric", month: "long" }); };
    const when = e.allDay ? dayTxt(S) + T(", весь день", ", all day") : dayTxt(S) + ", " + cHm(S) + " – " + (cSameDay(S, E) ? "" : dayTxt(E) + ", ") + cHm(E);
    const REP = { daily: T("Каждый день", "Daily"), weekdays: T("По будням", "Weekdays"), weekly: T("Каждую неделю", "Weekly"), monthly: T("Каждый месяц", "Monthly"), yearly: T("Каждый год", "Yearly") };
    const row = (ic, txt) => `<div class="es-row"><span class="es-ic">${ic}</span><div>${txt}</div></div>`;
    const ov = document.createElement("div"); ov.className = "cal-pop-ov";
    ov.innerHTML = `<div class="cal-pop es-pop" role="dialog" aria-modal="true">
      <div class="cp-top"><span></span><button type="button" class="cp-x" data-es-x aria-label="${T("Закрыть", "Close")}">✕</button></div>
      <div class="es-head"><i class="es-dot c-${e.color || 0}"></i><h2>${esc(e.title || T("Без названия", "(No title)"))}</h2></div>
      ${row(ico('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'), esc(when))}
      ${e.repeat && e.repeat !== "none" ? row(ico('<path d="M4 12a8 8 0 0 1 13.7-5.6L20 9M20 4v5h-5M20 12a8 8 0 0 1-13.7 5.6L4 15M4 20v-5h5"/>'), esc(REP[e.repeat] || e.repeat) + (e.until ? T(" до ", " until ") + esc(e.until) : "")) : ""}
      ${e.location ? row(ico('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'), esc(e.location)) : ""}
      ${e.guests ? row(ico('<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.6c1.6.6 2.7 2 3 4.4"/>'), esc(e.guests)) : ""}
      ${e.meet ? `<button type="button" class="es-meet" data-es-meet>${T("Подключиться к встрече", "Join meeting")}</button>` : ""}
      ${e.note ? `<div class="es-note">${esc(e.note)}</div>` : ""}
      <div class="ts-foot"><span></span><button type="button" class="cp-save" data-es-edit>${T("Изменить", "Edit")}</button></div>
    </div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.onclick = ev => {
      if (ev.target === ov || ev.target.closest("[data-es-x]")) return close();
      if (ev.target.closest("[data-es-edit]")) { tap(); close(); edit(); return; }
      if (ev.target.closest("[data-es-meet]")) { const u = safeUrl(e.meet); if (u) openExternal(u); }
    };
    ov.addEventListener("keydown", ev => { if (ev.key === "Escape") close(); });
  }

  // отклик на нажатие для кнопок верхней панели
  ["b-new-entry", "b-menu"].forEach(id => { const el = $(id); if (el) el.addEventListener("click", tap); });
})();
