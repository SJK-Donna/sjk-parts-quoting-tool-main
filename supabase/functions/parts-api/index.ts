// SJK Parts Costing — parts-api Edge Function.
// The backend for index.html (the interface in the Sales Tool Guide and Admin Console Guide).
//
// Everyone signs in (Supabase Auth); every request carries their session. Role comes from the
// `profiles` table: admin = the guide's Editor, sales = the guide's Viewer.
//
//   GET  /me                 → { email, name, role }
//   GET  /settings/current   costing settings (404 until first save)          any signed-in person
//   PUT  /settings/current   save costing                                    admins only
//   GET  /settings/locks     which sections are locked (version strings only, never hashes)
//   PUT  /settings/locks     set / change / remove section passwords         admins only
//   POST /unlock             { section, password } → { sections }             any signed-in person
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it parts-api →
// paste this file → Deploy. Turn OFF "Verify JWT" in the function's settings: the function checks
// the session itself (works with both the legacy and the new Supabase key types).
// Tables: supabase/parts-api.sql. SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY
// are provided by Supabase automatically.

const SECTIONS = ["find", "quote", "setup"];
const MAX_FAILS = 10;            // wrong section passwords per person …
const FAIL_WINDOW_MIN = 15;      // … within this many minutes before unlock is paused
const MAX_BODY = 64 * 1024;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const reply = (status, body?) =>
  new Response(body === undefined ? null : JSON.stringify(body),
    { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---------- Supabase access (REST with the service-role key; no imports needed) ----------
const SUPA = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") || KEY;
function dbHeaders(extra = {}) {
  const h = { apikey: KEY, "Content-Type": "application/json", ...extra };
  if (!KEY.startsWith("sb_")) h.Authorization = "Bearer " + KEY;   // legacy JWT keys also go in Authorization
  return h;
}
async function db(method, path, body?, prefer?) {
  const res = await fetch(SUPA + "/rest/v1" + path, {
    method, headers: dbHeaders(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`database ${method} ${path.split("?")[0]}: ${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}
const getSetting = async (name) => {
  const rows = await db("GET", `/shared_settings?name=eq.${name}&select=value`);
  return rows && rows.length ? rows[0].value : null;
};
const putSetting = async (name, value, by) => {
  await db("POST", "/shared_settings", { name, value, updated_at: new Date().toISOString() }, "resolution=merge-duplicates");
  await db("POST", "/settings_history", { name, value, changed_by: by });
};

// The signed-in person (active profile) or null.
async function currentUser(req) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.length > 8000) return null;
  const res = await fetch(SUPA + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + jwt } });
  if (!res.ok) return null;
  const u = await res.json();
  if (!u || !u.id) return null;
  const rows = await db("GET", `/profiles?id=eq.${encodeURIComponent(u.id)}&select=id,email,name,role,active`);
  const p = rows && rows[0];
  return p && p.active ? p : null;
}

// ---------- helpers ----------
async function sha256(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const isHex = (s, n?) => typeof s === "string" && /^[0-9a-f]+$/.test(s) && (n === undefined || s.length === n);
const lockVersion = async (l) => "v" + (await sha256(l.salt + ":" + l.hash)).slice(0, 16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("Too large"), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("Not JSON"), { status: 400 }); }
}

// ---------- handler ----------
export async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname.replace(/^.*?\/parts-api/, "").replace(/\/$/, "") || "/";
  try {
    const me = await currentUser(req);
    if (!me) return reply(401, { error: "Please sign in." });
    const admin = me.role === "admin";

    if (path === "/me" && req.method === "GET") return reply(200, { email: me.email, name: me.name, role: me.role });

    if (path === "/settings/current" && req.method === "GET") {
      const v = await getSetting("current");
      return v ? reply(200, v) : reply(404, { error: "Not saved yet" });
    }

    if (path === "/settings/locks" && req.method === "GET") {
      const locks = (await getSetting("locks")) || {};
      const out = {};
      for (const k of SECTIONS) if (locks[k]) out[k] = { hash: await lockVersion(locks[k]), setAt: locks[k].setAt || "" };
      return reply(200, out);
    }

    if (path === "/settings/current" && req.method === "PUT") {
      if (!admin) return reply(403, { error: "Only admins can change costing." });
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Settings must be an object." });
      if (!(+body.fx > 0)) return reply(400, { error: "Forex rate must be above zero." });
      if (+body.margin >= 90 || +body.floor >= 90) return reply(400, { error: "Margins must be below 90%." });
      await putSetting("current", body, me.email);
      return reply(204);
    }

    if (path === "/settings/locks" && req.method === "PUT") {
      if (!admin) return reply(403, { error: "Only admins can change passwords." });
      const old = (await getSetting("locks")) || {};
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Locks must be an object." });
      const next = {};
      for (const k of SECTIONS) {
        const v = body[k];
        if (!v) continue;                                            // left out → unlocked
        if (v.salt !== undefined) {                                  // new password
          if (!isHex(v.salt) || v.salt.length < 8 || v.salt.length > 64 || !isHex(v.hash, 64)) return reply(400, { error: `Bad password data for ${k}.` });
          next[k] = { salt: v.salt, hash: v.hash, setAt: new Date().toISOString() };
        } else if (old[k]) next[k] = old[k];                         // unchanged copy from GET → keep
      }
      await putSetting("locks", next, me.email);
      return reply(204);
    }

    if (path === "/unlock" && req.method === "POST") {
      const since = new Date(Date.now() - FAIL_WINDOW_MIN * 60000).toISOString();
      const fails = await db("GET", `/unlock_failures?ip=eq.${encodeURIComponent(me.id)}&at=gt.${since}&select=id&limit=${MAX_FAILS}`);
      if (fails.length >= MAX_FAILS) return reply(429, { error: `Too many wrong passwords. Try again in ${FAIL_WINDOW_MIN} minutes.` });
      const body = await readJson(req);
      const pw = typeof body.password === "string" ? body.password : "";
      const locks = (await getSetting("locks")) || {};
      const opened = [];
      if (pw && pw.length <= 200) for (const k of SECTIONS) if (locks[k] && (await sha256(locks[k].salt + ":" + pw)) === locks[k].hash) opened.push(k);
      if (!opened.length) {
        await db("POST", "/unlock_failures", { ip: me.id });          // counted per person
        await sleep(400);
        return reply(401, { error: "Wrong password." });
      }
      await db("DELETE", `/unlock_failures?at=lt.${new Date(Date.now() - 86400000).toISOString()}`);
      return reply(200, { sections: opened });
    }

    return reply(404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    return reply(e.status || 500, { error: e.status ? e.message : "Server error" });
  }
}

Deno.serve(handle);
