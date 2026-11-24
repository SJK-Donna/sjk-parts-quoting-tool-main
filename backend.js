/* SJK Parts Costing — sign-in and connection to the shared backend (Supabase).
 *
 * The interface (index.html) is the one described in the Sales Tool Guide and Admin Console Guide.
 * Access has the guide's two layers:
 *   Layer 1 — who can open the tool: everyone signs in with their own email + password (Supabase Auth).
 *             Role "admin" = the guide's Editor (changes costing and passwords, never asked for section
 *             passwords). Role "sales" = the guide's Viewer (uses the tool, sees costing read-only).
 *   Layer 2 — section passwords (Passwords & access tab), exactly as in the guide.
 *
 * Fill in supabaseUrl and anonKey (Supabase → Project Settings → API Keys → "publishable" or "anon public"
 * key). That key is meant to be public. Leave anonKey empty and the tool runs without sign-in, saving
 * costing on this device only (the guide's troubleshooting case).
 *
 * ── REST contract of the parts-api function (JSON, every call carries the person's session) ──────
 * GET  /me                  → { email, name, role }                    401 if not signed in / deactivated
 * GET  /settings/current    → { ...settings, updatedAt }  (404 if never saved)
 * PUT  /settings/current    admins only (403 otherwise → "Only editors can change costing.")
 * GET  /settings/locks      → { find:{hash,setAt}, quote:{...}, setup:{...} }  version strings only, never hashes
 * PUT  /settings/locks      admins only. Per section: has salt+hash = new password; no salt = keep; missing = remove
 * POST /unlock { section, password } → { sections:[...] } that this password opens, 401 if wrong
 * Code: supabase/functions/parts-api/index.ts · tables: supabase/parts-api.sql · steps: supabase/README.md
 */
(function () {
  'use strict';
  var CONFIG = {
    supabaseUrl: 'https://pitfqmvanfnaxsdajhzr.supabase.co',
    anonKey: 'sb_publishable_RzgLVPOx8-0x3RzMeBSP0g_AlJUkWnr',   // publishable key (public by design)
    pollSeconds: 15,      // how often open screens check for costing/password changes
    partsUrl: ''          // optional: serve parts_data.json from the backend instead of data/parts_data.json
  };
  if (!CONFIG.supabaseUrl || !CONFIG.anonKey) return;

  var $ = function (s) { return document.querySelector(s); };
  var base = (CONFIG.apiBase || CONFIG.supabaseUrl.replace(/\/$/, '') + '/functions/v1/parts-api').replace(/\/$/, '');
  var sb = window.supabase && window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sjk_auth' }
  });
  var me = null;

  function showSignIn(msg) {
    $('#signin').hidden = false;
    $('#sierr').textContent = msg || '';
    setTimeout(function () { ($('#sie').value ? $('#sip') : $('#sie')).focus(); }, 50);
  }
  if (!sb) { showSignIn('Could not load the sign-in library. Check the internet connection and reload.'); return; }

  async function accessToken() {
    var s = await sb.auth.getSession();          // refreshes an expired session automatically
    return s.data.session ? s.data.session.access_token : null;
  }

  async function request(method, path, body) {
    var headers = { 'Content-Type': 'application/json' }, t = await accessToken();
    if (t) headers.Authorization = 'Bearer ' + t;
    var res = await fetch(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && path !== '/me' && path !== '/unlock') { signedOut('Your session ended. Please sign in again.'); }
    if (res.status === 401 || res.status === 403) { var e = new Error('Not allowed'); e.code = 'invalid_argument'; e.status = res.status; throw e; }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('Backend error ' + res.status);
    return res.status === 204 ? null : res.json();
  }

  function signedOut(msg) {
    try { sessionStorage.removeItem('sjk_unl'); } catch (e) {}
    sb.auth.signOut().finally(function () { location.reload(); });
    if (msg) try { sessionStorage.setItem('sjk_signin_msg', msg); } catch (e) {}
  }

  // ---- sign-in: `ready` resolves once a signed-in, active person is known ----
  var NO_ACCESS = 'This account has no access to the tool. Ask your manager.';
  var NO_PROFILE = 'Signed in, but your role could not be read. Ask your admin to run supabase/parts-api.sql.';
  var whyFailed = function (err) { return err && err.code === 'invalid_argument' ? NO_ACCESS : NO_PROFILE; };
  // Without the parts-api function: read the person's own role straight from the profiles table
  // (allowed by the "read own profile" rule in parts-api.sql). Costing then saves on this device only.
  async function ownProfile() {
    var u = await sb.auth.getUser();
    if (u.error || !u.data.user) throw new Error('No user');
    var r = await sb.from('profiles').select('email,name,role,active').eq('id', u.data.user.id).maybeSingle();
    if (r.error) throw new Error(r.error.message);
    if (!r.data || !r.data.active) { var e = new Error('No access'); e.code = 'invalid_argument'; throw e; }
    return r.data;
  }
  var ready = new Promise(function (resolve) {
    async function finish() {
      var viaServer = null;
      try { viaServer = await request('GET', '/me'); }
      catch (err) { if (err.code === 'invalid_argument') throw err; }   // function says: no access
      if (viaServer && viaServer.role) { me = viaServer; window.SJK_BACKEND.shared = true; }
      else { me = await ownProfile(); window.SJK_BACKEND.shared = false; }   // parts-api not deployed yet
      $('#signin').hidden = true;
      var so = $('#signout');
      so.hidden = false; so.title = 'Signed in as ' + me.email + (me.role === 'admin' ? ' (admin)' : '');
      resolve(me);
    }
    $('#sif').addEventListener('submit', async function (e) {
      e.preventDefault();
      var btn = $('#sif button'); btn.disabled = true; $('#sierr').textContent = '';
      var r = await sb.auth.signInWithPassword({ email: $('#sie').value.trim().toLowerCase(), password: $('#sip').value });
      if (r.error) {
        btn.disabled = false;
        $('#sierr').textContent = /invalid login/i.test(r.error.message) ? 'Wrong email or password — try again.' : r.error.message;
        $('#sip').select(); return;
      }
      try { await finish(); }
      catch (err) { btn.disabled = false; await sb.auth.signOut(); $('#sierr').textContent = whyFailed(err); }
    });
    $('#signout').addEventListener('click', function () { signedOut(); });

    var note = null; try { note = sessionStorage.getItem('sjk_signin_msg'); sessionStorage.removeItem('sjk_signin_msg'); } catch (e) {}
    accessToken().then(function (t) {
      if (!t) return showSignIn(note);
      finish().catch(function (err) { sb.auth.signOut().then(function () { showSignIn(whyFailed(err)); }); });
    });
  });

  // ---- storage interface used by index.html: doc(path).set(...) / doc(path).onSnapshot(...) ----
  var listeners = {};
  function snap(data) { return { exists: data != null, data: function () { return data; }, metadata: { fromCache: false } }; }
  function doc(path) {
    return {
      // After a successful save, show it to this page at once so the next poll doesn't redraw the screen.
      set: function (data) {
        return request('PUT', '/' + path, data).then(function () {
          (listeners[path] || []).forEach(function (l) { l.deliver(JSON.parse(JSON.stringify(data))); });
        });
      },
      onSnapshot: function (onData, onError) {
        var last, stopped = false, first = true;
        var l = { deliver: function (data) { last = JSON.stringify(data); first = false; onData(snap(data)); } };
        (listeners[path] = listeners[path] || []).push(l);
        function tick() {
          if (stopped) return;
          request('GET', '/' + path).then(function (data) {
            var key = JSON.stringify(data);
            if (first || key !== last) { last = key; first = false; onData(snap(data)); }
          }, function (err) { if (first && onError) onError(err); })
            .then(function () { setTimeout(tick, CONFIG.pollSeconds * 1000); });
        }
        tick();
        return function () { stopped = true; listeners[path] = (listeners[path] || []).filter(function (x) { return x !== l; }); };
      }
    };
  }

  window.SJK_BACKEND = {
    ready: ready,
    shared: null,         // after sign-in: true = parts-api reachable (shared costing), false = this device only
    partsUrl: CONFIG.partsUrl || null,
    doc: doc,
    canEdit: function () { return Promise.resolve(!!me && me.role === 'admin'); },   // admin = the guide's Editor
    unlock: function (section, password) {
      return request('POST', '/unlock', { section: section, password: password })
        .then(function (r) { return (r && r.sections) || []; }, function () { return []; });
    },
    signOut: function () { signedOut(); }
  };
})();
