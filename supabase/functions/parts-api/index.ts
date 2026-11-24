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
//   GET  /zoho/status        → { configured, environment }
//   POST /zoho/connect       { code } from api-console.zoho.com → stores a new Zoho login (admins only)                                  any signed-in person
//   GET  /zoho/accounts?search=word → [{ id, name, address, phone }]          Zoho CRM Accounts
//   GET  /zoho/deal-setup    picklists + layout id for a new deal            any signed-in person
//   GET  /zoho/accounts/:id/deals  the account's Spare Parts deals + defaults for a new one
//   GET  /zoho/deals/by-no?no=GC-07680  find a deal by Deal No.
//   POST /zoho/deals         create a deal (§9.3)                             any signed-in person
//   POST /zoho/deals/:id/proposal  attach a proposal PDF to Proposal Upload
//   GET  /zoho/accounts/:id/contacts → [{ id, name, title, email, phone }]    the account's Contacts
//
// Zoho CRM: set these as function secrets (supabase/README.md → "Connect Zoho CRM"):
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN  (a Zoho "Self Client")
//   Sandbox: also ZOHO_SANDBOX_REFRESH_TOKEN (a code generated for the sandbox) and ZOHO_API_DOMAIN=https://sandbox.zohoapis.com.
//   Zoho binds each token to one environment, so the function picks the sandbox token whenever the API domain is the sandbox.
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
  refresh: "",
  accounts: (Deno.env.get("ZOHO_ACCOUNTS_URL") || "https://accounts.zoho.com").replace(/\/$/, ""),
  api: (Deno.env.get("ZOHO_API_DOMAIN") || "https://www.zohoapis.com").replace(/\/$/, ""),
};
ZOHO.sandbox = /sandbox/i.test(ZOHO.api);
const ZOHO_ENV = ZOHO.sandbox ? "sandbox" : "production";
const ENV_REFRESH = (ZOHO.sandbox ? Deno.env.get("ZOHO_SANDBOX_REFRESH_TOKEN") : "") || Deno.env.get("ZOHO_REFRESH_TOKEN") || "";
// A code pasted in the admin console (POST /zoho/connect) is stored in zoho_cache and takes priority over the secret.
let refreshMem = null;
async function zohoRefresh() {
  if (refreshMem && refreshMem.exp > Date.now()) return refreshMem.v;
  const rows = await db("GET", `/zoho_cache?name=eq.refresh_${ZOHO_ENV}&select=value`);
  const v = (rows && rows[0] && rows[0].value) || ENV_REFRESH;
  refreshMem = { v, exp: Date.now() + 60000 };
  return v;
}
const tokenHash = (t) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
// Cache key per environment AND per login, so a new refresh token (e.g. with more scopes) takes effect at once.
let ZOHO_CACHE = "access_token_" + ZOHO_ENV;
const zohoConfigured = async () => !!(ZOHO.id && ZOHO.secret && (await zohoRefresh()));
let zohoMem = { token: "", exp: 0, key: "" };
async function zohoToken() {
  const refresh = await zohoRefresh();
  ZOHO_CACHE = `access_token_${ZOHO_ENV}_${tokenHash(refresh)}`;
  if (zohoMem.token && zohoMem.key === ZOHO_CACHE && Date.now() < zohoMem.exp) return zohoMem.token;
  // Shared cache in the database: Zoho allows only a few new access tokens per 10 minutes.
  const rows = await db("GET", `/zoho_cache?name=eq.${ZOHO_CACHE}&select=value,expires_at`);
  if (rows && rows[0] && new Date(rows[0].expires_at).getTime() > Date.now() + 60000) {
    zohoMem = { token: rows[0].value, exp: new Date(rows[0].expires_at).getTime() - 60000, key: ZOHO_CACHE };
    return zohoMem.token;
  }
  const q = new URLSearchParams({ refresh_token: refresh, client_id: ZOHO.id, client_secret: ZOHO.secret, grant_type: "refresh_token" });
  const res = await fetch(`${ZOHO.accounts}/oauth/v2/token?${q}`, { method: "POST" });
  const j = await res.json().catch(() => ({}));
  if (!j.access_token) throw Object.assign(new Error("Zoho sign-in failed: " + (j.error || res.status)), { status: 502 });
  const exp = Date.now() + (Number(j.expires_in) || 3600) * 1000;
  await db("POST", "/zoho_cache", { name: ZOHO_CACHE, value: j.access_token, expires_at: new Date(exp).toISOString() }, "resolution=merge-duplicates");
  zohoMem = { token: j.access_token, exp: exp - 60000, key: ZOHO_CACHE };
  return zohoMem.token;
}
const zohoErr = (r) => !r ? "no answer" : [r.code, r.details && (r.details.api_name || (r.details.expected_data_type && "expected " + r.details.expected_data_type)), r.message].filter(Boolean).join(": ");
// One Zoho request with token refresh. body: object (sent as JSON) or FormData (multipart, for files).
async function zohoRaw(method, path, body?) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = { Authorization: "Zoho-oauthtoken " + (await zohoToken()) };
    let payload = undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await fetch(ZOHO.api + "/crm/v8" + path, { method, headers, body: payload });
    if (res.status === 204) return { data: [] };                       // no matches
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 && attempt === 0) {                         // token expired early: get a new one once
      zohoMem = { token: "", exp: 0 };
      await db("DELETE", `/zoho_cache?name=eq.${ZOHO_CACHE}`);
      continue;
    }
    if (!res.ok) {
      const msg = j.data && j.data[0] ? zohoErr(j.data[0]) : String(j.message || j.code || res.status);
      if (/environment/i.test(msg)) throw Object.assign(new Error("Zoho: the Zoho login is for " + (ZOHO.sandbox ? "production, but the tool is set to the sandbox. Set ZOHO_SANDBOX_REFRESH_TOKEN (supabase/README.md)." : "the sandbox, but the tool is set to production.")), { status: 502 });
      if (/scope/i.test(msg)) throw Object.assign(new Error("Zoho: the Zoho login is missing a permission (" + msg + "). Generate a new code with the scope in supabase/README.md."), { status: 502 });
      throw Object.assign(new Error("Zoho: " + msg), { status: res.status >= 500 ? 502 : 400 });
    }
    return j;
  }
  throw Object.assign(new Error("Zoho: not authorised"), { status: 502 });
}
const zoho = (method, path, body?) => zohoRaw(method, path, body);

// ---------- deals (SPEC §9.3) ----------
const DEAL_FIELDS = "Deal_Name,Deal_No,Stage,Pipeline,Amount,Closing_Date,Type,Business_Type,Industry_B2B,Industry_B2C,SJK_Office_Location,Pick_List_6,GO_Chance,GET_Chance,Street,City,Lead_Source,Proposal_Upload,Modified_Time";
const DEFAULT_FIELDS = ["Type", "Business_Type", "Industry_B2B", "Industry_B2C", "SJK_Office_Location", "Pick_List_6", "GO_Chance", "GET_Chance", "Street", "City", "Lead_Source"];
const REQUIRED = ["Deal_Name", "Type", "Business_Type", "SJK_Office_Location", "Pick_List_6", "Amount", "GO_Chance", "GET_Chance", "Street", "City", "Closing_Date"];
const PICKLIST_FIELDS = ["Type", "Business_Type", "Industry_B2B", "Industry_B2C", "SJK_Office_Location", "Pick_List_6", "GO_Chance", "GET_Chance", "Lead_Source"];
const fileName = (f) => (f && (f.File_Name__s || f.file_Name || f.name || f.File_Name)) || "";
const dealOut = (d) => ({
  id: d.id, no: d.Deal_No || "", name: d.Deal_Name || "", stage: d.Stage || "", pipeline: d.Pipeline || "",
  amount: d.Amount ?? null, closingDate: d.Closing_Date || "", proposals: (Array.isArray(d.Proposal_Upload) ? d.Proposal_Upload : []).map(fileName).filter(Boolean),
});
let setupMem = null;
async function dealSetup() {
  if (setupMem && setupMem.exp > Date.now()) return setupMem.v;
  const key = ZOHO.sandbox ? "deal_setup_sandbox" : "deal_setup";
  const rows = await db("GET", `/zoho_cache?name=eq.${key}&select=value,expires_at`);
  if (rows && rows[0] && new Date(rows[0].expires_at).getTime() > Date.now()) {
    setupMem = { v: JSON.parse(rows[0].value), exp: new Date(rows[0].expires_at).getTime() };
    return setupMem.v;
  }
  const [fields, layouts] = await Promise.all([zoho("GET", "/settings/fields?module=Deals"), zoho("GET", "/settings/layouts?module=Deals")]);
  const picklists = {};
  for (const f of fields.fields || []) {
    if (PICKLIST_FIELDS.includes(f.api_name)) picklists[f.api_name] = (f.pick_list_values || []).map((p) => p.actual_value).filter((v) => v && v !== "-None-");
  }
  const lay = (layouts.layouts || []).find((l) => (l.name || "").trim().toLowerCase() === "service layout new");
  const v = { picklists, layoutId: lay ? lay.id : null };
  const exp = Date.now() + 6 * 3600000;
  await db("POST", "/zoho_cache", { name: key, value: JSON.stringify(v), expires_at: new Date(exp).toISOString() }, "resolution=merge-duplicates");
  setupMem = { v, exp };
  return v;
}
let usersMem = null;
async function zohoUserId(email) {
  if (!usersMem || usersMem.exp < Date.now()) {
    const j = await zoho("GET", "/users?type=ActiveUsers&per_page=200");
    usersMem = { list: j.users || [], exp: Date.now() + 3600000 };
  }
  const u = usersMem.list.find((x) => String(x.email || "").toLowerCase() === String(email || "").toLowerCase());
  return u ? u.id : null;
}
// Duplicate guard (§9.5): the deal created for this quote, if any (its Description carries "[quote <id>]").
async function findDealForQuote(quoteId) {
  try {
    const j = await zoho("POST", "/coql", { select_query: `select id from Deals where Description like '%[quote ${quoteId}]%' limit 1` });
    const id = j.data && j.data[0] && j.data[0].id;
    if (!id) return null;
    const d = await zoho("GET", `/Deals/${id}?fields=${DEAL_FIELDS}`);
    return (d.data || [])[0] || null;
  } catch (e) { console.error("duplicate check skipped:", e.message); return null; }
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
    if (path === "/zoho/status" && req.method === "GET") return reply(200, { configured: await zohoConfigured(), environment: ZOHO_ENV });
    // Admins connect Zoho by pasting a code from api-console.zoho.com (Self Client → Generate Code).
    // The stored Client ID/Secret do the exchange; the new login is tested before it replaces the old one.
    if (path === "/zoho/connect" && req.method === "POST") {
      if (!admin) return reply(403, { error: "Only admins can connect Zoho." });
      if (!ZOHO.id || !ZOHO.secret) return reply(400, { error: "ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET are not set in Supabase yet (supabase/README.md)." });
      const code = String((await readJson(req)).code || "").trim();
      if (!/^1000\.[0-9a-f]{10,}\.[0-9a-f]{10,}$/i.test(code)) return reply(400, { error: "That doesn't look like a Zoho code. It starts with 1000. and has two dots." });
      const q = new URLSearchParams({ grant_type: "authorization_code", client_id: ZOHO.id, client_secret: ZOHO.secret, code });
      const res = await fetch(`${ZOHO.accounts}/oauth/v2/token?${q}`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!j.refresh_token) return reply(400, { error: j.error === "invalid_code" ? "Zoho says this code was already used or has expired. Generate a new one and paste it within 10 minutes."
        : j.error === "invalid_client" ? "Zoho doesn't accept the Client ID / Secret stored in Supabase. Check ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET."
        : "Zoho didn't accept the code (" + (j.error || res.status) + "). Generate a new one and try again." });
      const t = await fetch(ZOHO.api + "/crm/v8/settings/layouts?module=Deals", { headers: { Authorization: "Zoho-oauthtoken " + j.access_token } });
      if (!t.ok) {
        const tj = await t.json().catch(() => ({}));
        return reply(400, { error: /environment/i.test(JSON.stringify(tj))
          ? `This code is for the other Zoho environment. The tool is set to ${ZOHO_ENV === "sandbox" ? "the Sandbox" : "production"}: generate the code again and choose ${ZOHO_ENV === "sandbox" ? "the Sandbox (sjkguahan)" : "your production organisation"}.`
          : "Zoho refused the new login: " + (tj.message || tj.code || t.status) + ". Nothing was changed." });
      }
      await db("POST", "/zoho_cache", { name: `refresh_${ZOHO_ENV}`, value: j.refresh_token, expires_at: "2100-01-01T00:00:00Z" }, "resolution=merge-duplicates");
      refreshMem = null; zohoMem = { token: "", exp: 0, key: "" }; setupMem = null; usersMem = null;
      return reply(200, { ok: true, environment: ZOHO_ENV });
    }
    if (path.startsWith("/zoho/") && !(await zohoConfigured())) return reply(503, { error: "Zoho CRM is not connected yet." });

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

    // ---------- Zoho CRM deals (SPEC §9) ----------
    // Deal setup: required-field picklists + the "Service Layout New" layout id (cached 6 h per environment).
    if (path === "/zoho/deal-setup" && req.method === "GET") return reply(200, await dealSetup());

    // The account's Spare Parts deals (to link a proposal) + defaults for a new deal from its most recent one.
    const ad = path.match(/^\/zoho\/accounts\/(\d{5,25})\/deals$/);
    if (ad && req.method === "GET") {
      const j = await zoho("GET", `/Accounts/${ad[1]}/Deals?fields=${DEAL_FIELDS}&per_page=200&sort_by=Modified_Time&sort_order=desc`);
      const all = (j.data || []).filter((d) => d.Pipeline === "Spare Parts");
      const last = all[0] || null;
      return reply(200, {
        deals: all.map(dealOut),
        hasClosedWon: (j.data || []).some((d) => d.Stage === "Closed Won"),
        defaults: last ? Object.fromEntries(DEFAULT_FIELDS.map((k) => [k, last[k] ?? null])) : null,
      });
    }

    // Find a deal by its Deal No. (e.g. GC-07680).
    if (path === "/zoho/deals/by-no" && req.method === "GET") {
      const no = (new URL(req.url).searchParams.get("no") || "").trim().toUpperCase();
      if (!/^[A-Z]{1,6}-?\d{2,10}$/.test(no)) return reply(400, { error: "Type a Deal No. like GC-07680." });
      const j = await zoho("GET", `/Deals/search?criteria=${encodeURIComponent(`(Deal_No:equals:${no})`)}&fields=${DEAL_FIELDS},Account_Name`);
      const d = (j.data || [])[0];
      if (!d) return reply(404, { error: `No deal ${no} in Zoho.` });
      return reply(200, { ...dealOut(d), accountId: d.Account_Name?.id || "", accountName: d.Account_Name?.name || "" });
    }

    // Create a deal (§9.3). The server sets pipeline, layout, stage, owner and the quote id for the duplicate guard.
    if (path === "/zoho/deals" && req.method === "POST") {
      const b = await readJson(req);
      const quoteId = String(b.quoteId || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      if (!quoteId) return reply(400, { error: "Missing quote id." });
      // Duplicate guard (§9.5): a retry must not create a second deal for the same quote.
      const dup = await findDealForQuote(quoteId);
      if (dup) return reply(200, { ...dealOut(dup), existing: true });
      const setup = await dealSetup();
      const f = b.fields || {};
      const missing = REQUIRED.filter((k) => f[k] === undefined || f[k] === null || f[k] === "" || (Array.isArray(f[k]) && !f[k].length));
      if (!b.accountId) missing.unshift("Account_Name");
      const ind = f.Business_Type === "Business-to-Consumer" ? "Industry_B2C" : "Industry_B2B";
      if (!f[ind]) missing.push(ind);
      if (missing.length) return reply(400, { error: "Missing: " + missing.join(", ") });
      for (const [k, opts] of Object.entries(setup.picklists)) {     // values must match Zoho exactly
        const vals = Array.isArray(f[k]) ? f[k] : f[k] == null || f[k] === "" ? [] : [f[k]];
        const bad = vals.find((v) => !opts.includes(v));
        if (bad !== undefined) return reply(400, { error: `"${bad}" is not a ${k} value in Zoho.` });
      }
      const record = {
        Layout: setup.layoutId ? { id: setup.layoutId } : undefined,
        Deal_Name: String(f.Deal_Name).slice(0, 120),
        Pipeline: "Spare Parts", Stage: "Proposal/Price Quote", Lead_Creation: "Service",
        Account_Name: { id: String(b.accountId) },
        Contact_Name: b.contactId ? { id: String(b.contactId) } : undefined,
        Type: f.Type, Business_Type: f.Business_Type, [ind]: f[ind],
        SJK_Office_Location: f.SJK_Office_Location, Pick_List_6: f.Pick_List_6,
        Amount: Number(f.Amount), GO_Chance: f.GO_Chance, GET_Chance: f.GET_Chance,
        Street: f.Street, City: f.City, Closing_Date: f.Closing_Date,
        Lead_Source: f.Lead_Source || undefined,
        Description: `${String(f.Description || "").slice(0, 400)} [quote ${quoteId}]`,
      };
      const owner = await zohoUserId(me.email);
      if (owner) record.Owner = { id: owner };
      const created = await zoho("POST", "/Deals", { data: [record], trigger: ["workflow"] });
      const r = (created.data || [])[0] || {};
      if (r.code !== "SUCCESS") return reply(400, { error: "Zoho: " + zohoErr(r) });
      const d = await zoho("GET", `/Deals/${r.details.id}?fields=${DEAL_FIELDS}`);
      return reply(200, { ...dealOut((d.data || [])[0] || { id: r.details.id }), created: true, ownerSet: !!owner });
    }

    // Attach a proposal PDF to a deal's Proposal Upload field (adds; earlier versions stay).
    const dp = path.match(/^\/zoho\/deals\/(\d{5,25})\/proposal$/);
    if (dp && req.method === "POST") {
      const b = await readJson(req, 15 * 1024 * 1024);
      const name = String(b.fileName || "proposal.pdf").replace(/[\\/:*?"<>|]/g, "").slice(0, 150);
      const bytes = Uint8Array.from(atob(String(b.pdfBase64 || "")), (c) => c.charCodeAt(0));
      if (bytes.length < 100 || String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") return reply(400, { error: "That is not a PDF." });
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/pdf" }), name);
      const up = await zohoRaw("POST", "/files", form);
      const fileId = up?.data?.[0]?.details?.id;
      if (!fileId) return reply(502, { error: "Zoho: the PDF upload failed (" + zohoErr(up?.data?.[0] || up) + ")" });
      const upd = await zoho("PUT", `/Deals/${dp[1]}`, { data: [{ Proposal_Upload: [{ file_id: fileId }] }] });
      const r = (upd.data || [])[0] || {};
      if (r.code !== "SUCCESS") return reply(400, { error: "Zoho: " + zohoErr(r) });
      const d = await zoho("GET", `/Deals/${dp[1]}?fields=${DEAL_FIELDS}`);
      return reply(200, { ...dealOut((d.data || [])[0] || { id: dp[1] }), fileId });
    }

    return reply(404, { error: "Not found" });
  } catch (e) {
    console.error(e);
    return reply(e.status || 500, { error: e.status ? e.message : "Server error" });
  }
}

Deno.serve(handle);
