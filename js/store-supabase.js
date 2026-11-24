/* SJK Parts Quoting Tool — Supabase persistence (used when SJK_CONFIG.storeMode === 'supabase').
 *
 * Same interface as js/store.js, so app.js works with either. How it works:
 *   - Sign-in uses Supabase Auth (email + password). Roles come from the `profiles` table.
 *   - After sign-in everything the person may see is loaded once into memory; the app reads from
 *     that copy synchronously, exactly as it does with browser storage.
 *   - Every change updates the copy at once and is written to Supabase in the background, one
 *     write at a time per record so a later save can never be overtaken by an earlier one.
 *     A failed write fires a `store:error` event (the app shows it as a red message).
 *   - Changes other people make (costing, part edits, price lists, quotes, users) arrive live and
 *     fire a `store:change` event.
 *   - The draft quote and the Sea/Air choice stay in this browser (per-device convenience).
 * Tables and security rules: supabase/schema.sql. Admin user management: supabase/functions/admin-users.
 */
(function () {
  'use strict';
  const CFG = window.SJK_CONFIG || {};
  if (CFG.storeMode !== 'supabase') return;

  const Local = window.Store;
  const emit = (type, detail) => window.dispatchEvent(new CustomEvent('store:' + type, { detail }));

  // If the Supabase library or keys are missing, refuse to sign in rather than silently using browser storage.
  const broken = !window.supabase ? 'The database library did not load. Check the internet connection and reload.'
    : !CFG.supabaseUrl || !CFG.supabaseAnonKey ? 'Database not configured: set supabaseUrl and supabaseAnonKey in js/config.js.' : null;
  if (broken) {
    window.Store = Object.assign({}, Local, {
      async login() { throw new Error(broken); },
      async currentUser() { return null; }
    });
    return;
  }

  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'sjkq.auth' }
  });

  const C = { profiles: [], settings: [], edits: {}, dataset: null, quotes: [], log: [] };
  let me = null, channel = null;

  const toUser = p => ({ id: p.id, email: p.email, name: p.name, role: p.role, title: p.title, mobile: p.mobile,
    office: p.office, zohoUserId: p.zoho_user_id, active: p.active });
  const toProfile = u => ({ name: u.name, email: u.email, role: u.role, title: u.title || '', mobile: u.mobile || '',
    office: u.office || '', zoho_user_id: u.zohoUserId || '' });
  const toSettingsRow = r => ({ id: r.id, values: r.values, created_at: r.created_at, created_by: r.created_by_name });

  async function run(query, what) {
    const { data, error } = await query;
    if (error) throw new Error(what + ': ' + error.message);
    return data;
  }

  /* ---------- background writes: one chain per record, newest state wins ---------- */
  const chains = {};
  let pending = 0;
  function queue(key, what, fn) {
    pending++;
    chains[key] = (chains[key] || Promise.resolve())
      .then(fn)
      .then(res => { if (res && res.error) throw res.error; })
      .catch(err => { console.error(what, err); emit('error', { what, message: err.message || String(err) }); })
      .finally(() => { pending--; });
    return chains[key];
  }
  const flush = () => Promise.all(Object.values(chains));
  window.addEventListener('beforeunload', e => { if (pending) { e.preventDefault(); e.returnValue = ''; } });

  /* ---------- load + live updates ---------- */
  async function profileOf(userId) {
    return run(sb.from('profiles').select('*').eq('id', userId).maybeSingle(), 'Profile');
  }

  async function loadAll() {
    const [profiles, settings, edits, lists, quotes] = await Promise.all([
      run(sb.from('profiles').select('*').order('name'), 'Users'),
      run(sb.from('settings').select('*').order('created_at', { ascending: false }).limit(50), 'Costing'),
      run(sb.from('part_edits').select('pn, edit'), 'Part edits'),
      run(sb.from('price_lists').select('id, data').eq('active', true).order('id', { ascending: false }).limit(1), 'Price list'),
      run(sb.from('quotes').select('data').order('updated_at', { ascending: false }).limit(5000), 'Quotes')
    ]);
    C.profiles = profiles.map(toUser);
    C.settings = settings.reverse().map(toSettingsRow);
    C.edits = Object.fromEntries(edits.map(r => [r.pn, r.edit]));
    C.dataset = lists[0] ? lists[0].data : null;
    C.quotes = quotes.map(r => r.data);
    C.log = [];
    if (me.role === 'admin') {
      const log = await run(sb.from('zoho_log').select('at, entry').order('id', { ascending: false }).limit(200), 'Zoho log');
      C.log = log.map(r => Object.assign({ at: r.at }, r.entry));
    }
  }

  function subscribe() {
    if (channel) return;
    channel = sb.channel('sjk-shared')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'settings' }, p => {
        if (C.settings.some(s => s.id === p.new.id)) return;          // our own save coming back
        C.settings.push(toSettingsRow(p.new));
        emit('change', { what: 'settings', by: p.new.created_by_name });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'part_edits' }, p => {
        if (p.eventType === 'DELETE') delete C.edits[p.old.pn]; else C.edits[p.new.pn] = p.new.edit;
        emit('change', { what: 'edits' });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'price_lists' }, () => emit('change', { what: 'dataset' }))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'quotes' }, p => {
        if (!p.new || !p.new.data) return;
        const q = p.new.data, i = C.quotes.findIndex(x => x.id === q.id);
        if (i >= 0 && (C.quotes[i].updated_at || '') > (q.updated_at || '')) return;   // we already have newer
        if (i >= 0) C.quotes[i] = q; else C.quotes.unshift(q);
        emit('change', { what: 'quotes', id: q.id });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, p => {
        if (!p.new || !p.new.id) return;
        const u = toUser(p.new), i = C.profiles.findIndex(x => x.id === u.id);
        if (i >= 0) C.profiles[i] = u; else C.profiles.push(u);
        if (me && u.id === me.id && !u.active) { emit('change', { what: 'deactivated' }); return; }
        emit('change', { what: 'users' });
      })
      .subscribe();
  }

  async function begin(profile) {
    me = toUser(profile);
    await loadAll();
    subscribe();
    return me;
  }

  /* ---------- admin user management (through the admin-users Edge Function) ---------- */
  async function adminUsers(body) {
    const { data, error } = await sb.functions.invoke('admin-users', { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* not JSON */ }
      throw new Error(msg);
    }
    if (data && data.profile) {
      const u = toUser(data.profile), i = C.profiles.findIndex(x => x.id === u.id);
      if (i >= 0) C.profiles[i] = u; else C.profiles.push(u);
    }
    return data;
  }

  const Store = {
    sha256: Local.sha256, uid: Local.uid, now: Local.now,
    mode: Local.mode, setMode: Local.setMode, draft: Local.draft, saveDraft: Local.saveDraft,
    _get: Local._get, _set: Local._set,       // demo CRM only
    backend: 'supabase',
    flush,

    /* ---------- auth ---------- */
    async login(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email: String(email).trim().toLowerCase(), password });
      if (error) throw new Error(/invalid login/i.test(error.message) ? 'Wrong email or password.'
        : /banned/i.test(error.message) ? 'This account is deactivated. Ask an admin.' : error.message);
      const p = await profileOf(data.user.id);
      if (!p || !p.active) { await sb.auth.signOut(); throw new Error('This account is deactivated. Ask an admin.'); }
      return begin(p);
    },
    async logout() {
      await flush();
      if (channel) { sb.removeChannel(channel); channel = null; }
      await sb.auth.signOut();
      me = null;
    },
    async currentUser() {
      const { data } = await sb.auth.getSession();
      if (!data.session) return null;
      try {
        const p = await profileOf(data.session.user.id);
        if (!p || !p.active) { await sb.auth.signOut(); return null; }
        return await begin(p);
      } catch (e) { console.error(e); return null; }
    },

    /* ---------- users ---------- */
    users: () => C.profiles,
    async createUser(fields, password) {
      await adminUsers({ action: 'create', email: fields.email, password, profile: toProfile(fields) });
    },
    async updateUser(id, fields) {
      const cur = C.profiles.find(u => u.id === id) || {};
      const profile = toProfile(fields);
      if (cur.email && cur.email.toLowerCase() === String(fields.email).toLowerCase()) delete profile.email;
      await adminUsers({ action: 'update', id, profile });
    },
    async setActive(id, active) { await adminUsers({ action: 'active', id, active }); },
    async setPassword(id, password) {
      if (me && id === me.id) {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw new Error(error.message);
      } else await adminUsers({ action: 'password', id, password });
    },

    /* ---------- costing ---------- */
    settingsHistory: () => C.settings,
    liveSettings: () => C.settings.length ? C.settings[C.settings.length - 1] : null,
    saveSettings(values, user) {
      const row = { id: crypto.randomUUID(), values: JSON.parse(JSON.stringify(values)), created_at: new Date().toISOString(),
        created_by: user ? user.name : '' };
      C.settings.push(row);
      queue('settings', 'Costing not saved', () => sb.from('settings').insert({
        id: row.id, values: row.values, created_by: me.id, created_by_name: row.created_by }));
      return row;
    },

    /* ---------- part edits ---------- */
    partEdits: () => C.edits,
    savePartEdit(pn, edit) {
      const clean = {};
      Object.keys(edit).forEach(k => { if (edit[k] !== '' && edit[k] != null && edit[k] !== false) clean[k] = edit[k]; });
      if (Object.keys(clean).length) C.edits[pn] = clean; else delete C.edits[pn];
      queue('edit:' + pn, 'Part edit not saved', () => C.edits[pn]
        ? sb.from('part_edits').upsert({ pn, edit: C.edits[pn], updated_at: new Date().toISOString(), updated_by: me.id })
        : sb.from('part_edits').delete().eq('pn', pn));
    },

    /* ---------- published price list ---------- */
    dataset: () => C.dataset,
    async publishDataset(data) {
      await run(sb.from('price_lists').update({ active: false }).eq('active', true), 'Price list');
      await run(sb.from('price_lists').insert({ version: String(data.v || ''), data, created_by: me.id, created_by_name: me.name }), 'Price list');
      C.dataset = data;
    },
    async clearDataset() {
      await run(sb.from('price_lists').update({ active: false }).eq('active', true), 'Price list');
      C.dataset = null;
    },

    /* ---------- quotes ---------- */
    quotes: () => C.quotes,
    quote: id => C.quotes.find(q => q.id === id) || null,
    saveQuote(q) {
      q.updated_at = new Date().toISOString();
      const i = C.quotes.findIndex(x => x.id === q.id);
      if (i >= 0) C.quotes[i] = q; else C.quotes.unshift(q);
      // Writes whatever the quote looks like when its turn comes, so rapid saves collapse to the latest state.
      queue('quote:' + q.id, 'Quote not saved', () => {
        const cur = C.quotes.find(x => x.id === q.id) || q;
        return sb.from('quotes').upsert({ id: cur.id, created_by: cur.createdBy, status: cur.status || 'draft',
          data: JSON.parse(JSON.stringify(cur)), updated_at: cur.updated_at });
      });
      return q;
    },

    /* ---------- Zoho support log ---------- */
    log(entry) {
      const row = Object.assign({ at: new Date().toISOString() }, entry);
      C.log.unshift(row); C.log.length = Math.min(C.log.length, 200);
      queue('log', 'Log not saved', () => sb.from('zoho_log').insert({ entry }));
    },
    zohoLog: () => C.log
  };

  window.Store = Store;
})();
