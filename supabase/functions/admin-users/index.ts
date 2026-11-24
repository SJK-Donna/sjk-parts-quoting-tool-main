// SJK Parts Quoting Tool — admin-users Edge Function.
// Creating logins, resetting someone else's password and deactivating people need the
// service-role key, which must never be in the browser. The Users tab calls this function;
// it checks the caller is an active admin, then does the change.
//
// Deploy: Supabase dashboard → Edge Functions → Deploy a new function → name "admin-users" → paste this file.
// (SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
//
// Body: { action: 'create', email, password, profile }
//       { action: 'update', id, profile }          profile = {name,email,role,title,mobile,office,zoho_user_id}
//       { action: 'active', id, active }
//       { action: 'password', id, password }
import { createClient } from "jsr:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const FIELDS = ["name", "role", "title", "mobile", "office", "zoho_user_id"] as const;
const pick = (p: Record<string, unknown> = {}) => {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) if (p[k] !== undefined) out[k] = String(p[k] ?? "").trim();
  if (out.role !== undefined && out.role !== "admin" && out.role !== "sales") throw new Error("Role must be admin or sales.");
  return out;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Please sign in again." }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: me } = await admin.from("profiles").select("role, active").eq("id", user.id).single();
    if (!me || !me.active || me.role !== "admin") return json({ error: "Only admins can manage users." }, 403);

    const b = await req.json();
    const email = b.email ?? b.profile?.email;

    if (b.action === "create") {
      if (!email || !b.password || String(b.password).length < 8) return json({ error: "Email and a password of 8+ characters are required." }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email: String(email).trim().toLowerCase(), password: String(b.password), email_confirm: true,
        user_metadata: { name: b.profile?.name ?? "" },
      });
      if (error) return json({ error: /already/i.test(error.message) ? "That email is already used." : error.message }, 400);
      const { data: row, error: e2 } = await admin.from("profiles")
        .update({ ...pick(b.profile), active: true }).eq("id", data.user.id).select().single();
      if (e2) return json({ error: e2.message }, 400);
      return json({ profile: row });
    }

    if (!b.id) return json({ error: "Missing user id." }, 400);

    if (b.action === "update") {
      const patch: Record<string, unknown> = pick(b.profile);
      if (email) {
        const e = String(email).trim().toLowerCase();
        const { error } = await admin.auth.admin.updateUserById(b.id, { email: e, email_confirm: true });
        if (error) return json({ error: /already/i.test(error.message) ? "That email is already used." : error.message }, 400);
        patch.email = e;
      }
      const { data: row, error } = await admin.from("profiles").update(patch).eq("id", b.id).select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ profile: row });
    }

    if (b.action === "active") {
      const active = !!b.active;
      const { data: row, error } = await admin.from("profiles").update({ active }).eq("id", b.id).select().single();
      if (error) return json({ error: error.message }, 400);   // e.g. "Keep at least one active admin."
      // Ban/unban the login too, so a deactivated person can't sign in at all.
      const { error: e2 } = await admin.auth.admin.updateUserById(b.id, { ban_duration: active ? "none" : "876000h" });
      if (e2) return json({ error: e2.message }, 400);
      return json({ profile: row });
    }

    if (b.action === "password") {
      if (!b.password || String(b.password).length < 8) return json({ error: "Use at least 8 characters." }, 400);
      const { error } = await admin.auth.admin.updateUserById(b.id, { password: String(b.password) });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
