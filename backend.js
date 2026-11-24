/* SJK Parts Costing — connection to the shared backend.
 *
 * The interface (index.html) is the one described in the Sales Tool Guide and Admin Console Guide.
 * It needs only two shared records and one password check from the backend:
 *
 *   settings/current   the costing settings everyone prices with (forex, freight, duties, margins, weights)
 *   settings/locks     which sections are locked:  { find?, quote?, setup? }
 *   unlock             checks a section password and says which sections it opens
 *
 * Leave apiBase empty and the tool works like the guide's "saved on this device only" case.
 * Set apiBase and implement the endpoints below, and costing + passwords are shared by everyone.
 *
 * ── REST contract (JSON, HTTPS) ───────────────────────────────────────────────────────────────
 * GET  {apiBase}/settings/current   → 200 { ...settings, updatedAt }        404 if never saved
 * PUT  {apiBase}/settings/current   body { ...settings, updatedAt }         needs the Admin console token
 * GET  {apiBase}/settings/locks     → 200 { find:{hash,setAt}, quote:{...}, setup:{...} }   (only locked sections)
 *        `hash` here is NOT secret: return an opaque version string (e.g. the setAt time or a random id that
 *        changes whenever that password changes). Changing it makes everyone enter the new password.
 *        Never send the real salt/hash to the browser.
 * PUT  {apiBase}/settings/locks     body { find:{salt,hash,setAt}, ... }    needs the Admin console token
 *        The page sends the whole set of sections every time. For each section:
 *          - has `salt` + `hash`  → a new password: store salt + hash (hash = SHA-256(salt + ":" + password))
 *          - has no `salt`        → unchanged (it's the copy you sent from GET): keep what you have
 *          - left out of the body → unlocked (open to everyone): delete it
 * POST {apiBase}/unlock             body { section, password }
 *        → 200 { token, sections:[...] } every section whose stored hash = SHA-256(salt + ":" + password)
 *        → 401 when the password is wrong. The token proves which sections were opened; the page sends it
 *        back as "Authorization: Bearer <token>" on every PUT. Only accept PUTs from a token that opened
 *        "setup" (the Admin console). While the Admin console has NO password, accept PUTs without a token
 *        (the guide's "open to everyone with the link"), so the admin can set the first passwords.
 *        Tokens should expire (e.g. after 12 hours) and stop working when the Admin console password changes.
 * Reply 401/403 to a PUT the caller may not make; the page then shows "Only editors can change costing."
 *
 * Settings shape (all numbers unless noted; defaults in index.html → DEF):
 *   fx, fxBuf, seaBasis ('pct'|'kg'), seaUSpct, seaCNpct, seaUSkg, seaCNkg, airBasis, airUSpct, airCNpct,
 *   airUSkg, airCNkg, ins, duty, cnFee, broker, misc, vatCost (bool), margin, floor, round,
 *   kg { category: kg per unit }, updatedAt (ISO time)
 */
(function () {
  'use strict';
  var CONFIG = {
    apiBase: 'https://pitfqmvanfnaxsdajhzr.supabase.co/functions/v1/parts-api',   // empty = no shared backend
    pollSeconds: 15,      // how often open screens check for costing/password changes
    partsUrl: ''          // optional: serve parts_data.json from the backend instead of data/parts_data.json
  };
  if (!CONFIG.apiBase) return;

  var base = CONFIG.apiBase.replace(/\/$/, '');
  var TOKEN_KEY = 'sjk_backend_token';
  var token = null;
  try { token = sessionStorage.getItem(TOKEN_KEY); } catch (e) { /* private mode */ }
  function setToken(t) { token = t; try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) {} }

  function request(method, path, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(base + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { var e = new Error('Not allowed'); e.code = 'invalid_argument'; throw e; }
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('Backend error ' + res.status);
        return res.status === 204 ? null : res.json();
      });
  }

  // The page talks to storage through doc(path).set(...) and doc(path).onSnapshot(...).
  var listeners = {};   // path -> [{deliver}]
  function snap(data) { return { exists: data != null, data: function () { return data; }, metadata: { fromCache: false } }; }
  function doc(path) {
    return {
      // After a successful save, show it to this page's listeners at once (before the page prints
      // "Saved for everyone ✓"), so the next poll doesn't redraw the screen with the same values.
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
    partsUrl: CONFIG.partsUrl || null,
    doc: doc,
    unlock: function (section, password) {
      return request('POST', '/unlock', { section: section, password: password }).then(function (r) {
        if (!r) return [];
        if (r.token) setToken(r.token);
        return r.sections || [];
      }, function () { return []; });
    },
    lock: function () { setToken(null); }
    // canEdit: function () { return Promise.resolve(true); }   // optional: true = never ask for passwords
  };
})();
