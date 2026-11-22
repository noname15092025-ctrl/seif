/*
  Vault Sync — бесплатный zero-knowledge бэкенд на Cloudflare Workers.
  Хранит ТОЛЬКО зашифрованный сейф (шифротекст). Сервер не видит паролей и ключей.
  Развёртывание — см. SYNC-SETUP.md.

  Нужен KV-namespace, привязанный как переменная окружения VAULT.
*/
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,PUT,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "86400",
};
async function sha256hex(s) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
// Подписка на календари (Google, iCloud, Outlook…): эти сервисы не разрешают браузеру
// скачивать календарь напрямую, поэтому SHUT просит этот воркер забрать .ics по ссылке.
// Доступно только владельцу сейфа (тот же токен, что и для синхронизации). Ничего не сохраняется.
const ICS_MAX = 3 * 1024 * 1024;
async function icsProxy(url) {
  const raw = (url.searchParams.get("u") || "").trim().replace(/^webcal:\/\//i, "https://");
  let t; try { t = new URL(raw); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
  if (t.protocol !== "https:" && t.protocol !== "http:") return new Response("bad url", { status: 400, headers: CORS });
  let r; try { r = await fetch(t.toString(), { headers: { "User-Agent": "SHUT-calendar/1.0", Accept: "text/calendar,*/*" }, redirect: "follow" }); }
  catch { return new Response("upstream error", { status: 502, headers: CORS }); }
  if (!r.ok) return new Response("upstream " + r.status, { status: 502, headers: CORS });
  if ((+r.headers.get("content-length") || 0) > ICS_MAX) return new Response("too large", { status: 413, headers: CORS });
  const text = await r.text();
  if (text.length > ICS_MAX) return new Response("too large", { status: 413, headers: CORS });
  if (!/BEGIN:VCALENDAR/.test(text.slice(0, 4000))) return new Response("not a calendar", { status: 415, headers: CORS });
  return new Response(text, { headers: { ...CORS, "Content-Type": "text/calendar; charset=utf-8", "Cache-Control": "no-store" } });
}
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const id = (url.searchParams.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!id || !auth) return new Response("bad request", { status: 400, headers: CORS });
    const authHash = await sha256hex(auth);
    const key = "v:" + id;
    try {
      if (url.pathname === "/ics" && req.method === "GET") {
        const acc = await env.VAULT.get(key, { type: "json" });
        if (!acc || acc.a !== authHash) return new Response("forbidden", { status: 403, headers: CORS });
        return await icsProxy(url);
      }
      if (req.method === "GET") {
        const rec = await env.VAULT.get(key, { type: "json" });
        if (!rec) return new Response("{}", { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
        if (rec.a !== authHash) return new Response("forbidden", { status: 403, headers: CORS });
        return new Response(JSON.stringify({ v: rec.v, vault: rec.vault, name: rec.name }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      if (req.method === "PUT") {
        const body = await req.json();
        if (!body || !body.vault) return new Response("bad body", { status: 400, headers: CORS });
        const existing = await env.VAULT.get(key, { type: "json" });
        if (existing && existing.a !== authHash) return new Response("forbidden", { status: 403, headers: CORS });
        if (existing && typeof body.v === "number" && typeof existing.v === "number" && body.v < existing.v)
          return new Response(JSON.stringify({ conflict: true, v: existing.v }), { status: 409, headers: { ...CORS, "Content-Type": "application/json" } });
        await env.VAULT.put(key, JSON.stringify({ a: authHash, v: body.v || Date.now(), vault: body.vault, name: body.name || "" }));
        return new Response("ok", { headers: CORS });
      }
      return new Response("method not allowed", { status: 405, headers: CORS });
    } catch (e) {
      return new Response("error", { status: 500, headers: CORS });
    }
  },
};
