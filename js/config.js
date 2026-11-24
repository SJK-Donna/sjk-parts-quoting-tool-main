/* SJK Parts Quoting Tool — runtime configuration.
 *
 * storeMode:
 *   'local'    — demo: users, costing and quotes are kept in this browser only.
 *   'supabase' — shared database + real logins (see supabase/README.md). Fill in the two keys below
 *                from Supabase → Project Settings → API. The anon key is safe to publish: what each
 *                person can read or change is enforced by the database rules in supabase/schema.sql.
 *
 * zohoMode:
 *   'mock' — built-in demo CRM stored in this browser (no real Zoho calls). Use for demos and UI testing.
 *   'api'  — calls YOUR backend at apiBase, which holds the Zoho OAuth refresh token and talks to
 *            Zoho CRM (Sandbox first, then production). See README.md → "Connecting the backend".
 */
window.SJK_CONFIG = {
  storeMode: 'local',
  supabaseUrl: '',        // e.g. 'https://abcdefghijklmnop.supabase.co'
  supabaseAnonKey: '',    // the "anon public" key

  zohoMode: 'mock',
  apiBase: '/api',
  zohoDealUrl: 'https://crm.zoho.com/crm/org756940602/tab/Potentials/',
  dataUrl: 'data/parts_data.json'
};
