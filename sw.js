"use strict";
// Офлайн-режим: файлы приложения кешируются. Сначала сеть (чтобы получать обновления), при отсутствии сети — кеш.
const CACHE = "vault-v9";
const FILES = ["./", "index.html", "style.css", "app.js", "argon2.js", "argon2-worker.js", "wordlist.js",
  "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // внешние запросы (проверка утечек) не трогаем
  // no-cache: всегда сверяемся с сервером, чтобы получать новую версию сразу после обновления
  e.respondWith(fetch(url.href, { cache: "no-cache", credentials: "same-origin" }).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
});
