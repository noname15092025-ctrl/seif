/*
  Vault Sync (R2) — бесплатный zero-knowledge бэкенд на Cloudflare Workers + R2.
  R2 free: 10 ГБ хранилища, ~1 млн записей/мес. Хранит только зашифрованный сейф.
  Протокол тот же, что у KV/D1-воркеров.

  Нужен R2-бакет, привязанный как переменная окружения BUCKET.
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
// Одноразовые ссылки «Поделиться»: зашифрованная запись лежит здесь, пока её не откроют один раз.
// Ключ расшифровки остаётся в ссылке после «#» и сюда не попадает. Положить может только владелец сейфа.
const SHARE_MAX = 200 * 1024, SHARE_TTL_MAX = 7 * 86400;
const shareJson = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
async function shareRoute(req, env, url) {
  const sid = (url.searchParams.get("s") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (sid.length < 16) return shareJson({ error: "bad id" }, 400);
  if (req.method === "GET") {
    const rec = await shareTake(env, sid); // прочитать и сразу удалить
    if (!rec || (rec.exp && rec.exp < Date.now())) return shareJson({ gone: true }, 404);
    return shareJson({ data: rec.data });
  }
  if (req.method === "PUT") {
    const id = (url.searchParams.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!id || !auth || !(await shareOwnerOk(env, id, await sha256hex(auth)))) return shareJson({ error: "forbidden" }, 403);
    const text = await req.text(); if (text.length > SHARE_MAX) return shareJson({ error: "too large" }, 413);
    let body; try { body = JSON.parse(text); } catch { return shareJson({ error: "bad body" }, 400); }
    if (!body || !body.data) return shareJson({ error: "bad body" }, 400);
    const ttl = Math.max(60, Math.min(SHARE_TTL_MAX, Math.floor(+body.ttl || 86400)));
    await sharePut(env, sid, { data: body.data, exp: Date.now() + ttl * 1000 }, ttl);
    return shareJson({ ok: true });
  }
  return shareJson({ error: "method" }, 405);
}
async function shareOwnerOk(env, id, authHash) { const o = await env.BUCKET.get("v/" + id); if (!o) return false; const r = JSON.parse(await o.text()); return r.a === authHash; }
async function sharePut(env, sid, rec) { await env.BUCKET.put("s/" + sid, JSON.stringify(rec)); }
async function shareTake(env, sid) { const o = await env.BUCKET.get("s/" + sid); if (!o) return null; await env.BUCKET.delete("s/" + sid); return JSON.parse(await o.text()); }

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    { const u0 = new URL(req.url); if (u0.pathname === "/s") { try { return await shareRoute(req, env, u0); } catch { return new Response("error", { status: 500, headers: CORS }); } } }
    const url = new URL(req.url);
    const id = (url.searchParams.get("id") || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!id || !auth) return new Response("bad request", { status: 400, headers: CORS });
    const authHash = await sha256hex(auth);
    const key = "v/" + id;
    try {
      if (req.method === "GET") {
        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response("{}", { status: 404, headers: { ...CORS, "Content-Type": "application/json" } });
        const rec = JSON.parse(await obj.text());
        if (rec.a !== authHash) return new Response("forbidden", { status: 403, headers: CORS });
        return new Response(JSON.stringify({ v: rec.v, vault: rec.vault, name: rec.name }), { headers: { ...CORS, "Content-Type": "application/json" } });
      }
      if (req.method === "PUT") {
        const body = await req.json();
        if (!body || !body.vault) return new Response("bad body", { status: 400, headers: CORS });
        const existingObj = await env.BUCKET.get(key);
        if (existingObj) {
          const ex = JSON.parse(await existingObj.text());
          if (ex.a !== authHash) return new Response("forbidden", { status: 403, headers: CORS });
          if (typeof body.v === "number" && typeof ex.v === "number" && body.v < ex.v)
            return new Response(JSON.stringify({ conflict: true, v: ex.v }), { status: 409, headers: { ...CORS, "Content-Type": "application/json" } });
        }
        await env.BUCKET.put(key, JSON.stringify({ a: authHash, v: body.v || Date.now(), vault: body.vault, name: body.name || "" }));
        return new Response("ok", { headers: CORS });
      }
      return new Response("method not allowed", { status: 405, headers: CORS });
    } catch (e) {
      return new Response("error", { status: 500, headers: CORS });
    }
  },
};
