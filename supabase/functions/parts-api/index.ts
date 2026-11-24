// SJK Parts Costing — parts-api Edge Function.
// The backend for index.html (the interface in the Sales Tool Guide and Admin Console Guide).
// Implements the REST contract at the top of backend.js:
//
//   GET  /settings/current   costing settings (404 until first save)
//   PUT  /settings/current   save costing                      — needs the Admin console token
//   GET  /settings/locks     which sections are locked (version strings only, never hashes)
//   PUT  /settings/locks     set / change / remove passwords   — needs the Admin console token
//   POST /unlock             { section, password } → { token, sections }
//
// While the Admin console has no password, saves are accepted without a token (the guide's
// "open to everyone with the link"), so the first admin can set the passwords.
//
// Deploy: Supabase → Edge Functions → Deploy a new function → Via Editor → name it parts-api →
// paste this file → Deploy. Then open the function's Details and turn OFF "Verify JWT"
// (the tool sends its own unlock token, not a Supabase login).
// Tables: supabase/parts-api.sql. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

const SECTIONS = ["find", "quote", "setup"];
const TOKEN_HOURS = 12;
const MAX_FAILS = 10;            // wrong passwords per IP …
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

// ---------- database (PostgREST with the service-role key; no imports needed) ----------
const DB_URL = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "") + "/rest/v1";
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
function dbHeaders(extra = {}) {
  const h = { apikey: KEY, "Content-Type": "application/json", ...extra };
  if (!KEY.startsWith("sb_")) h.Authorization = "Bearer " + KEY;   // legacy JWT keys also go in Authorization
  return h;
}
async function db(method, path, body?, prefer?) {
  const res = await fetch(DB_URL + path, {
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
const putSetting = async (name, value) => {
  await db("POST", "/shared_settings", { name, value, updated_at: new Date().toISOString() }, "resolution=merge-duplicates");
  await db("POST", "/settings_history", { name, value });
};

// ---------- helpers ----------
async function sha256(t) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const isHex = (s, n?) => typeof s === "string" && /^[0-9a-f]+$/.test(s) && (n === undefined || s.length === n);
const lockVersion = async (l) => "v" + (await sha256(l.salt + ":" + l.hash)).slice(0, 16);
const clientIp = (req) => (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error("Too large"), { status: 413 });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("Not JSON"), { status: 400 }); }
}

// Admin rights = the Admin console has no password, or the caller holds a valid token that opened it.
async function isAdmin(req, locks) {
  if (!locks || !locks.setup) return true;
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || token.length > 200) return false;
  const rows = await db("GET", `/unlock_tokens?token=eq.${encodeURIComponent(token)}&select=sections,setup_version,expires_at`);
  const t = rows && rows[0];
  return !!t && t.sections.includes("setup") && t.setup_version === locks.setup.salt && new Date(t.expires_at) > new Date();
}

// ---------- handler ----------
export async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const path = new URL(req.url).pathname.replace(/^.*?\/parts-api/, "").replace(/\/$/, "") || "/";
  try {
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
      const locks = await getSetting("locks");
      if (!(await isAdmin(req, locks))) return reply(403, { error: "Only the Admin console can change costing." });
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) return reply(400, { error: "Settings must be an object." });
      if (!(+body.fx > 0)) return reply(400, { error: "Forex rate must be above zero." });
      if (+body.margin >= 90 || +body.floor >= 90) return reply(400, { error: "Margins must be below 90%." });
      await putSetting("current", body);
      return reply(204);
    }

    if (path === "/settings/locks" && req.method === "PUT") {
      const old = (await getSetting("locks")) || {};
      if (!(await isAdmin(req, old))) return reply(403, { error: "Only the Admin console can change passwords." });
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
      await putSetting("locks", next);
      return reply(204);
    }

    if (path === "/unlock" && req.method === "POST") {
      const ip = clientIp(req), since = new Date(Date.now() - FAIL_WINDOW_MIN * 60000).toISOString();
      const fails = await db("GET", `/unlock_failures?ip=eq.${encodeURIComponent(ip)}&at=gt.${since}&select=id&limit=${MAX_FAILS}`);
      if (fails.length >= MAX_FAILS) return reply(429, { error: `Too many wrong passwords. Try again in ${FAIL_WINDOW_MIN} minutes.` });
      const body = await readJson(req);
      const pw = typeof body.password === "string" ? body.password : "";
      const locks = (await getSetting("locks")) || {};
      const opened = [];
      if (pw && pw.length <= 200) for (const k of SECTIONS) if (locks[k] && (await sha256(locks[k].salt + ":" + pw)) === locks[k].hash) opened.push(k);
      if (!opened.length) {
        await db("POST", "/unlock_failures", { ip });
        await sleep(400);
        return reply(401, { error: "Wrong password." });
      }
      const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
      await db("POST", "/unlock_tokens", {
        token, sections: opened, setup_version: locks.setup ? locks.setup.salt : "",
        expires_at: new Date(Date.now() + TOKEN_HOURS * 3600000).toISOString(),
      });
      // housekeeping
      await db("DELETE", `/unlock_tokens?expires_at=lt.${new Date().toISOString()}`);
      await db("DELETE", `/unlock_failures?at=lt.${new Date(Date.now() - 86400000).toISOString()}`);
      return reply(200, { token, sections: opened });
    }

    return reply(404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    return reply(e.status || 500, { error: e.status ? e.message : "Server error" });
  }
}

Deno.serve(handle);
