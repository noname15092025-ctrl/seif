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

  // отклик на нажатие для кнопок верхней панели
  ["b-new-entry", "b-menu"].forEach(id => { const el = $(id); if (el) el.addEventListener("click", tap); });
})();
