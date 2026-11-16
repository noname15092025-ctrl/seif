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
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
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
