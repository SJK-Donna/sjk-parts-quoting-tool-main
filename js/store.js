/* SJK Parts Quoting Tool — local persistence.
 * Everything here lives in the browser (localStorage) so the tool runs as static files.
 * In production, replace each function with a call to your backend; the shapes match SPEC §4.2.
 */
(function () {
  'use strict';
  const NS = 'sjkq.';
  const mem = {};
  const get = (k, d) => {
    try { const v = localStorage.getItem(NS + k); return v == null ? d : JSON.parse(v); }
    catch (e) { return k in mem ? mem[k] : d; }
  };
  const set = (k, v) => {
    mem[k] = v;
    try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ }
  };
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const now = () => new Date().toISOString();

  async function sha256(t) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  /* ---------- users (SPEC §2, §7.4) ---------- */
  const DEMO_USERS = [
    { id: 'u_admin', name: 'Admin User', email: 'admin@sjkguahan.com', role: 'admin', title: 'General Manager',
      mobile: '', office: 'SJK Manila', active: true },
    { id: 'u_sales', name: 'Sales Rep', email: 'sales@sjkguahan.com', role: 'sales', title: 'Service Executive',
      mobile: '', office: 'SJK Manila', active: true }
  ];
  const DEMO_PASSWORD = 'demo1234';

  async function ensureUsers() {
    let users = get('users', null);
    if (!users) {
      const h = await sha256(DEMO_PASSWORD);
      users = DEMO_USERS.map(u => Object.assign({ pw: h }, u));
      set('users', users);
    }
    return users;
  }

  const Store = {
    sha256, uid, now,
    DEMO_PASSWORD,

    /* users */
    backend: 'local',
    flush: async () => {},
    users: () => get('users', []),
    saveUsers: u => set('users', u),
    async createUser(fields, password) {
      const us = get('users', []);
      us.push(Object.assign({ id: uid('u_'), active: true, pw: await sha256(password) }, fields));
      set('users', us);
    },
    async updateUser(id, fields) {
      const us = get('users', []); Object.assign(us.find(x => x.id === id), fields); set('users', us);
    },
    async setActive(id, active) {
      const us = get('users', []); us.find(x => x.id === id).active = !!active; set('users', us);
    },
    async setPassword(id, password) {
      const us = get('users', []); us.find(x => x.id === id).pw = await sha256(password); set('users', us);
    },
    dataset: () => get('dataset', null),
    publishDataset: async data => set('dataset', data),
    clearDataset: async () => set('dataset', null),
    async login(email, password) {
      const users = await ensureUsers();
      const h = await sha256(password);
      const u = users.find(x => x.email.toLowerCase() === String(email).trim().toLowerCase());
      if (!u || u.pw !== h) throw new Error('Wrong email or password.');
      if (!u.active) throw new Error('This account is deactivated. Ask an admin.');
      set('session', { userId: u.id, at: now() });
      return u;
    },
    logout: async () => set('session', null),
    async currentUser() {
      const users = await ensureUsers();
      const s = get('session', null);
      return s ? users.find(u => u.id === s.userId && u.active) || null : null;
    },

    /* costing settings — append-only history; latest row is live (SPEC §4.2) */
    settingsHistory: () => get('settings', []),
    liveSettings() { const h = get('settings', []); return h.length ? h[h.length - 1] : null; },
    saveSettings(values, user) {
      const h = get('settings', []);
      const row = { id: uid('s_'), values, created_at: now(), created_by: user ? user.name : '' };
      h.push(row); if (h.length > 50) h.splice(0, h.length - 50);
      set('settings', h);
      return row;
    },

    /* per-part admin overrides: weight, category, hazmat, notes (SPEC §5.4, §7.5) */
    partEdits: () => get('partEdits', {}),
    savePartEdit(pn, edit) {
      const all = get('partEdits', {});
      const clean = {};
      Object.keys(edit).forEach(k => { if (edit[k] !== '' && edit[k] != null && edit[k] !== false) clean[k] = edit[k]; });
      if (Object.keys(clean).length) all[pn] = clean; else delete all[pn];
      set('partEdits', all);
    },

    /* sales UI state */
    mode: () => get('mode', 'sea'),
    setMode: m => set('mode', m),
    draft: () => get('draft', null),
    saveDraft: d => set('draft', d),

    /* quotes with versions (SPEC §4.2, §8.1) */
    quotes: () => get('quotes', []),
    quote: id => get('quotes', []).find(q => q.id === id) || null,
    saveQuote(q) {
      const all = get('quotes', []);
      const i = all.findIndex(x => x.id === q.id);
      q.updated_at = now();
      if (i >= 0) all[i] = q; else all.unshift(q);
      set('quotes', all);
      return q;
    },

    /* support log of Zoho requests (SPEC §9.5) */
    log(entry) {
      const l = get('zohoLog', []);
      l.unshift(Object.assign({ at: now() }, entry));
      set('zohoLog', l.slice(0, 200));
    },
    zohoLog: () => get('zohoLog', []),

    /* raw access for the mock CRM */
    _get: get, _set: set
  };

  window.Store = Store;
})();
