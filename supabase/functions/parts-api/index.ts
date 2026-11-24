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
//   GET  /users              all sign-ins with role, position, status          admins only
//   POST /users              add a sign-in {email,password,name,role,title,mobile}  admins only
//   PATCH /users/:id         change role, name, position, mobile, active      admins only
//   POST /users/:id/password set a new password                               admins only
//   GET  /parts              the price list (parts_data.json)                 any signed-in person
//   PUT  /parts              upload a new price list                          admins only
//   GET  /zoho/status        → { configured }                                  any signed-in person
//   GET  /zoho/accounts?search=word → [{ id, name, address, phone }]          Zoho CRM Accounts
//   GET  /zoho/accounts/:id/contacts → [{ id, name, title, email, phone }]    the account's Contacts
//
// Zoho CRM: set these as function secrets (supabase/README.md → "Connect Zoho CRM"):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN  (a Zoho "Self Client")
//   optional ZOHO_ACCOUNTS_URL (default https://accounts.zoho.com), ZOHO_API_DOMAIN (default https://www.zohoapis.com)
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

// ---------- Zoho CRM (REST v8 with an OAuth refresh token kept in function secrets) ----------
const ZOHO = {
  id: Deno.env.get("ZOHO_CLIENT_ID") || "",
  secret: Deno.env.get("ZOHO_CLIENT_SECRET") || "",
  refresh: Deno.env.get("ZOHO_REFRESH_TOKEN") || "",
  accounts: (Deno.env.get("ZOHO_ACCOUNTS_URL") || "https://accounts.zoho.com").replace(/\/$/, ""),
  api: (Deno.env.get("ZOHO_API_DOMAIN") || "https://www.zohoapis.com").replace(/\/$/, ""),
};
const zohoConfigured = () => !!(ZOHO.id && ZOHO.secret && ZOHO.refresh);
let zohoMem = { token: "", exp: 0 };
async function zohoToken() {
  if (zohoMem.token && Date.now() < zohoMem.exp) return zohoMem.token;
  // Shared cache in the database: Zoho allows only a few new access tokens per 10 minutes.
  const rows = await db("GET", `/zoho_cache?name=eq.access_token&select=value,expires_at`);
  if (rows && rows[0] && new Date(rows[0].expires_at).getTime() > Date.now() + 60000) {
    zohoMem = { token: rows[0].value, exp: new Date(rows[0].expires_at).getTime() - 60000 };
    return zohoMem.token;
  }
  const q = new URLSearchParams({ refresh_token: ZOHO.refresh, client_id: ZOHO.id, client_secret: ZOHO.secret, grant_type: "refresh_token" });
  const res = await fetch(`${ZOHO.accounts}/oauth/v2/token?${q}`, { method: "POST" });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw Object.assign(new Error("Zoho sign-in failed: " + (j.error || res.status)), { status: 502 });
  const exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  await db("POST", "/zoho_cache", { name: "access_token", value: j.access_token, expires_at: new Date(exp).toISOString() }, "resolution=merge-duplicates");
  zohoMem = { token: j.access_token, exp: exp - 60000 };
  return zohoMem.token;
}
async function zoho(method, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(ZOHO.api + "/crm/v8" + path, { method, headers: { Authorization: "Zoho-oauthtoken " + (await zohoToken()) } });
    if (res.status === 204) return { data: [] };                       // no matches
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && attempt === 0) {                         // token expired early: get a new one once
      zohoMem = { token: "", exp: 0 };
      await db("DELETE", `/zoho_cache?name=eq.access_token`);
      continue;
    }
    if (!res.ok) throw Object.assign(new Error("Zoho: " + (j.message || j.code || res.status)), { status: 502 });
    return j;
  }
  throw Object.assign(new Error("Zoho: not authorised"), { status: 502 });
}
const joinAddr = (...parts) => [...new Set(parts.map((p) => String(p || "").trim()).filter(Boolean))].join(", ");

// Users list / edits (admins). Only these profile fields can be changed through the API.
const userOut = (p) => ({ id: p.id, email: p.email, name: p.name || "", role: p.role, title: p.title || "", mobile: p.mobile || "", active: !!p.active });
function profilePatch(b, creating) {
  const out = {};
  if (b.role !== undefined) { if (b.role !== "admin" && b.role !== "sales") throw Object.assign(new Error("Role must be admin or sales."), { status: 400 }); out.role = b.role; }
  for (const k of ["name", "title", "mobile"]) if (b[k] !== undefined) out[k] = String(b[k]).trim().slice(0, 120);
  if (b.active !== undefined) out.active = !!b.active;
  if (creating) { out.active = true; if (!out.role) out.role = "sales"; }
  return out;
}

// The signed-in person (active profile) or null.
async function currentUser(req) {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.length > 8000) return null;
  const res = await fetch(SUPA + "/auth/v1/user", { headers: { apikey: ANON, Authorization: "Bearer " + jwt } });
  if (!res.ok) return null;
  const u = await res.json();
  if (!u || !u.id) return null;
  const rows = await db("GET", `/profiles?id=eq.${encodeURIComponent(u.id)}&select=*`);
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
async function readJson(req, limit = MAX_BODY) {
  const text = await req.text();
  if (text.length > limit) throw Object.assign(new Error("Too large"), { status: 413 });
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

    if (path === "/me" && req.method === "GET") return reply(200, { email: me.email, name: me.name, role: me.role, title: me.title || "", mobile: me.mobile || "" });

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

    // ---------- users (admins add and manage sales and admin sign-ins) ----------
    if (path === "/users" && req.method === "GET") {
      if (!admin) return reply(403, { error: "Only admins can manage users." });
      const rows = await db("GET", "/profiles?select=*&order=role.asc,name.asc");
      return reply(200, (rows || []).map(userOut));
    }
    if (path === "/users" && req.method === "POST") {
      if (!admin) return reply(403, { error: "Only admins can add users." });
      const b = await readJson(req);
      const email = String(b.email || "").trim().toLowerCase(), password = String(b.password || "");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply(400, { error: "Enter a valid email address." });
      if (password.length < 8) return reply(400, { error: "The temporary password needs at least 8 characters." });
      const res = await fetch(SUPA + "/auth/v1/admin/users", {
        method: "POST", headers: dbHeaders(),
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name: String(b.name || "").trim() } }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return reply(400, { error: /already|exists|registered/i.test(JSON.stringify(j)) ? "That email already has a sign-in." : (j.msg || j.message || "Could not create the sign-in.") });
      // The database trigger made the profile; now set the details the admin chose.
      await db("PATCH", `/profiles?id=eq.${j.id}`, profilePatch(b, true));
      const rows = await db("GET", `/profiles?id=eq.${j.id}&select=*`);
      return reply(200, userOut(rows[0]));
    }
    const um = path.match(/^\/users\/([0-9a-f-]{36})(\/password)?$/);
    if (um && (req.method === "PATCH" || req.method === "POST")) {
      if (!admin) return reply(403, { error: "Only admins can manage users." });
      const id = um[1], b = await readJson(req);
      if (um[2] && req.method === "POST") {                                   // reset password
        if (String(b.password || "").length < 8) return reply(400, { error: "The new password needs at least 8 characters." });
        const r = await fetch(`${SUPA}/auth/v1/admin/users/${id}`, { method: "PUT", headers: dbHeaders(), body: JSON.stringify({ password: String(b.password) }) });
        if (!r.ok) return reply(400, { error: "Could not set the password." });
        return reply(200, { ok: true });
      }
      if (req.method !== "PATCH" || um[2]) return reply(404, { error: "Not found" });
      const patch = profilePatch(b, false);
      if (id === me.id && (patch.role === "sales" || patch.active === false)) return reply(400, { error: "You can't remove your own admin access. Ask another admin." });
      if (patch.role === "sales" || patch.active === false) {               // never leave the tool without an active admin
        const admins = await db("GET", "/profiles?role=eq.admin&active=eq.true&select=id");
        if (!(admins || []).some((a) => a.id !== id)) return reply(400, { error: "Keep at least one active admin." });
      }
      if (!Object.keys(patch).length) return reply(400, { error: "Nothing to change." });
      await db("PATCH", `/profiles?id=eq.${id}`, patch);
      if ("active" in patch) {                                                // deactivated people can't sign in at all
        await fetch(`${SUPA}/auth/v1/admin/users/${id}`, { method: "PUT", headers: dbHeaders(), body: JSON.stringify({ ban_duration: patch.active ? "none" : "876000h" }) });
      }
      const rows = await db("GET", `/profiles?id=eq.${id}&select=*`);
      return rows && rows[0] ? reply(200, userOut(rows[0])) : reply(404, { error: "User not found." });
    }

    // ---------- price list (dealer costs stay behind sign-in) ----------
    if (path === "/parts" && req.method === "GET") {
      const rows = await db("GET", "/price_list?select=data&order=id.desc&limit=1");
      return rows && rows[0] ? reply(200, rows[0].data) : reply(404, { error: "No price list uploaded yet." });
    }
    if (path === "/parts" && req.method === "PUT") {
      if (!admin) return reply(403, { error: "Only admins can upload the price list." });
      const d = await readJson(req, 5 * 1024 * 1024);
      const ok = d && Array.isArray(d.rows) && Array.isArray(d.models) && Array.isArray(d.cats) && d.rows.length > 0 &&
        d.rows.every((r) => Array.isArray(r) && typeof r[0] === "string" && (r[2] === null || typeof r[2] === "number"));
      if (!ok) return reply(400, { error: "That file is not a parts_data.json price list." });
      await db("POST", "/price_list", { version: String(d.v || ""), data: d, created_by: me.email });
      const keep = await db("GET", "/price_list?select=id&order=id.desc&limit=5");   // keep the last 5 versions
      if (keep && keep.length === 5) await db("DELETE", `/price_list?id=lt.${keep[4].id}`);
      return reply(200, { version: String(d.v || ""), parts: d.rows.length });
    }

    // ---------- Zoho CRM customers ----------
    if (path === "/zoho/status" && req.method === "GET") return reply(200, { configured: zohoConfigured() });
    if (path.startsWith("/zoho/") && !zohoConfigured()) return reply(503, { error: "Zoho CRM is not connected yet." });

    if (path === "/zoho/accounts" && req.method === "GET") {
      const word = (new URL(req.url).searchParams.get("search") || "").trim();
      if (word.length < 2) return reply(200, []);
      const j = await zoho("GET", `/Accounts/search?word=${encodeURIComponent(word.slice(0, 100))}` +
        `&fields=Account_Name,Billing_Street,Billing_City,Billing_State,Phone&per_page=15`);
      return reply(200, (j.data || []).map((a) => ({
        id: a.id, name: a.Account_Name || "", address: joinAddr(a.Billing_Street, a.Billing_City, a.Billing_State), phone: a.Phone || "",
      })));
    }

    const m = path.match(/^\/zoho\/accounts\/(\d{5,25})\/contacts$/);
    if (m && req.method === "GET") {
      const j = await zoho("GET", `/Accounts/${m[1]}/Contacts?fields=First_Name,Last_Name,Title,Email,Mobile,Phone&per_page=100`);
      return reply(200, (j.data || []).map((c) => ({
        id: c.id, name: [c.First_Name, c.Last_Name].filter(Boolean).join(" "), title: c.Title || "", email: c.Email || "", phone: c.Mobile || c.Phone || "",
      })));
    }

    return reply(404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    return reply(e.status || 500, { error: e.status ? e.message : "Server error" });
  }
}

Deno.serve(handle);
