/* SJK Parts Quoting Tool — Zoho CRM adapter (SPEC §9).
 *
 * Two implementations share one interface:
 *   MockZoho — a demo CRM kept in this browser, for trying the full flow without touching Zoho.
 *   ApiZoho  — calls your backend (config.apiBase). The backend holds the OAuth refresh token and
 *              forwards to Zoho CRM REST. Endpoints it must provide are listed on each method.
 *
 * Interface (all async):
 *   picklists()                         → { Lead_Source:[...], ... }  (GET /settings/fields?module=Deals)
 *   searchAccounts(text)                → [{id, Account_Name, Billing_Street, Billing_City, Phone}]
 *   contacts(accountId)                 → [{id, First_Name, Last_Name, Title, Email, Mobile}]
 *   accountHistory(accountId)           → { hasClosedWon, lastDeal: {§9.3 fields} | null }
 *   createAccount(data) / createContact(data) → record ({duplicate:true, record} if Zoho flags a duplicate)
 *   findDealByQuoteId(quoteId)          → deal | null    (duplicate guard before retrying a create)
 *   createDeal(fields)                  → { id }
 *   getDeal(id)                         → { id, Deal_No, ... }
 *   uploadProposal(dealId, doc)         → { file_id }   doc = {fileName, html}. Backend renders the PDF
 *                                        (headless Chrome), POST /files, then PUT Deals Proposal_Upload.
 *   updateDeal(id, fields)              → { id }
 *   addNote(dealId, title, content)     → { id }
 */
(function () {
  'use strict';
  const S = window.Store;

  const PICKLISTS = {
    Type: ['New Business', 'Existing Business'],
    Business_Type: ['Business-to-Business', 'Business-to-Consumer'],
    Industry_B2B: ['Golf', 'Resort/Hospitality'],
    Industry_B2C: ['Industrial Sector', 'Golf', 'Non-Golf', 'Malls', 'Universities', 'Parks', 'Municipalities', 'Farms'],
    SJK_Office_Location: ['SJK Manila', 'SJK Vismin', 'SJK Sta. Rosa'],
    GO_Chance: ['25%', '50%', '75%', '100%'],
    GET_Chance: ['25%', '50%', '75%', '100%'],
    // Placeholder list — production loads the real values from Zoho at start-up.
    Lead_Source: ['Repeat Client', 'Referral', 'Walk-in', 'Website', 'Social Media', 'Trade Show', 'Cold Call', 'Other'],
    Pick_List_6: ['GCPH Wear & Tear', 'Battery', 'Tires', 'GMPH Wear & Tear']
  };

  /* Fictional demo customers. */
  const SEED = {
    accounts: [
      { id: 'A1001', Account_Name: 'Sample Golf & Country Club', Billing_Street: 'Km 30 Sample Road', Billing_City: 'Silang, Cavite', Phone: '0917 000 0000' },
      { id: 'A1002', Account_Name: 'Demo Bay Resort', Billing_Street: '12 Shoreline Drive', Billing_City: 'Lapu-Lapu, Cebu', Phone: '0918 000 0001' },
      { id: 'A1003', Account_Name: 'Example State University', Billing_Street: '1 Campus Avenue', Billing_City: 'Quezon City', Phone: '02 8000 0002' },
      { id: 'A1004', Account_Name: 'Test Industrial Park Corp.', Billing_Street: 'Lot 4 Phase 2', Billing_City: 'Santa Rosa, Laguna', Phone: '049 000 0003' },
      { id: 'A1005', Account_Name: 'Placeholder Highlands Golf', Billing_Street: 'Upper Ridge Road', Billing_City: 'Tagaytay', Phone: '046 000 0004' }
    ],
    contacts: [
      { id: 'C2001', account: 'A1001', First_Name: 'Juan', Last_Name: 'Dela Cruz', Title: 'Fleet Manager', Email: 'juan.delacruz@example.com', Mobile: '0917 000 0000' },
      { id: 'C2002', account: 'A1001', First_Name: 'Maria', Last_Name: 'Santos', Title: 'Purchasing', Email: 'maria.santos@example.com', Mobile: '0917 000 0005' },
      { id: 'C2003', account: 'A1002', First_Name: 'Ana', Last_Name: 'Reyes', Title: 'Operations Head', Email: 'ana.reyes@example.com', Mobile: '0918 000 0006' },
      { id: 'C2004', account: 'A1003', First_Name: 'Jose', Last_Name: 'Garcia', Title: 'Facilities Director', Email: 'jose.garcia@example.edu', Mobile: '0919 000 0007' },
      { id: 'C2005', account: 'A1004', First_Name: 'Liza', Last_Name: 'Mendoza', Title: 'Admin Manager', Email: 'liza.mendoza@example.com', Mobile: '0920 000 0008' }
    ],
    deals: [
      { id: 'D3001', Deal_No: 'GC-07651', Account_Name: { id: 'A1001' }, Stage: 'Closed Won', Type: 'Existing Business',
        Business_Type: 'Business-to-Business', Industry_B2B: 'Golf', SJK_Office_Location: ['SJK Manila'], Lead_Source: 'Repeat Client' },
      { id: 'D3002', Deal_No: 'GC-07629', Account_Name: { id: 'A1002' }, Stage: 'Negotiation/Review', Type: 'New Business',
        Business_Type: 'Business-to-Business', Industry_B2B: 'Resort/Hospitality', SJK_Office_Location: ['SJK Vismin'], Lead_Source: 'Referral' }
    ],
    nextDealNo: 7700, files: [], notes: []
  };

  const db = () => S._get('mockCrm', null) || JSON.parse(JSON.stringify(SEED));
  const save = d => S._set('mockCrm', d);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const outage = () => !!S._get('mockOutage', false);

  function zohoError(code, message, status) { const e = new Error(code + ': ' + message); e.code = code; e.status = status || 400; return e; }

  async function call(name, fn) {
    await wait(180 + Math.random() * 220);
    if (outage() && name !== 'picklists') {
      const e = zohoError('SERVICE_UNAVAILABLE', 'Zoho CRM is not reachable (simulated outage)', 503);
      S.log({ op: name, ok: false, error: e.message });
      throw e;
    }
    try { const r = fn(); S.log({ op: name, ok: true }); return r; }
    catch (e) { S.log({ op: name, ok: false, error: e.message }); throw e; }
  }

  function checkMandatory(f) {
    const req = ['Deal_Name', 'Pipeline', 'Stage', 'Account_Name', 'Type', 'Business_Type', 'SJK_Office_Location',
      'Pick_List_6', 'Amount', 'GO_Chance', 'GET_Chance', 'Street', 'City', 'Closing_Date'];
    for (const k of req) {
      const v = f[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) throw zohoError('MANDATORY_NOT_FOUND', k);
    }
    if (f.Pipeline !== 'Spare Parts') throw zohoError('INVALID_DATA', 'Pipeline');
  }

  const MockZoho = {
    mode: 'mock',
    picklists: () => call('picklists', () => JSON.parse(JSON.stringify(PICKLISTS))),
    searchAccounts: text => call('searchAccounts', () => {
      const t = String(text || '').toLowerCase();
      return db().accounts.filter(a => a.Account_Name.toLowerCase().includes(t)).slice(0, 10);
    }),
    contacts: accountId => call('contacts', () => db().contacts.filter(c => c.account === accountId)),
    accountHistory: accountId => call('accountHistory', () => {
      const deals = db().deals.filter(d => d.Account_Name && d.Account_Name.id === accountId);
      return { hasClosedWon: deals.some(d => d.Stage === 'Closed Won'), lastDeal: deals[deals.length - 1] || null };
    }),
    createAccount: data => call('createAccount', () => {
      const d = db();
      const dup = d.accounts.find(a => a.Account_Name.trim().toLowerCase() === String(data.Account_Name).trim().toLowerCase());
      if (dup) return { duplicate: true, record: dup };
      const rec = Object.assign({ id: S.uid('A') }, data); d.accounts.push(rec); save(d); return rec;
    }),
    createContact: data => call('createContact', () => {
      if (!data.Last_Name) throw zohoError('MANDATORY_NOT_FOUND', 'Last_Name');
      const d = db();
      const dup = data.Email && d.contacts.find(c => c.Email && c.Email.toLowerCase() === data.Email.toLowerCase());
      if (dup) return { duplicate: true, record: dup };
      const rec = Object.assign({ id: S.uid('C') }, data); d.contacts.push(rec); save(d); return rec;
    }),
    findDealByQuoteId: quoteId => call('findDealByQuoteId', () =>
      db().deals.find(x => (x.Description || '').includes('[' + quoteId + ']')) || null),
    createDeal: fields => call('createDeal', () => {
      checkMandatory(fields);
      const d = db();
      const rec = Object.assign({ id: S.uid('D'), Deal_No: 'GC-' + String(d.nextDealNo++).padStart(5, '0') }, fields);
      d.deals.push(rec); save(d); return { id: rec.id };
    }),
    getDeal: id => call('getDeal', () => {
      const r = db().deals.find(x => x.id === id); if (!r) throw zohoError('INVALID_DATA', 'deal id'); return r;
    }),
    updateDeal: (id, fields) => call('updateDeal', () => {
      const d = db(); const r = d.deals.find(x => x.id === id); if (!r) throw zohoError('INVALID_DATA', 'deal id');
      Object.assign(r, fields); save(d); return { id };
    }),
    uploadProposal: (dealId, file) => call('uploadProposal', () => {
      const d = db(); const r = d.deals.find(x => x.id === dealId); if (!r) throw zohoError('INVALID_DATA', 'deal id');
      const fid = S.uid('F');
      d.files.push({ id: fid, deal: dealId, name: file.fileName, size: (file.html || '').length });
      r.Proposal_Upload = (r.Proposal_Upload || []).concat([{ file_id: fid, name: file.fileName }]);  // add, keep earlier versions
      save(d); return { file_id: fid };
    }),
    addNote: (dealId, title, content) => call('addNote', () => {
      const d = db(); const n = { id: S.uid('N'), deal: dealId, title, content }; d.notes.push(n); save(d); return { id: n.id };
    }),
    /* demo helpers */
    setOutage: v => S._set('mockOutage', !!v),
    outage,
    dealCount: () => db().deals.length,
    reset: () => save(JSON.parse(JSON.stringify(SEED)))
  };

  /* ---------- backend adapter ---------- */
  async function api(method, path, body) {
    const base = (window.SJK_CONFIG && window.SJK_CONFIG.apiBase) || '/api';
    const opt = { method, credentials: 'include', headers: {} };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(base + path, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || ('HTTP ' + res.status)); e.status = res.status; throw e; }
    return data;
  }
  const enc = encodeURIComponent;
  const ApiZoho = {
    mode: 'api',
    picklists: () => api('GET', '/zoho/picklists'),                                   // cached server-side
    searchAccounts: t => api('GET', '/zoho/accounts?search=' + enc(t)),               // Accounts/search?word=
    contacts: id => api('GET', '/zoho/accounts/' + enc(id) + '/contacts'),
    accountHistory: id => api('GET', '/zoho/accounts/' + enc(id) + '/history'),       // COQL on Deals
    createAccount: d => api('POST', '/zoho/accounts', d),
    createContact: d => api('POST', '/zoho/contacts', d),
    findDealByQuoteId: q => api('GET', '/zoho/deals?quote=' + enc(q)).then(r => r.deal || null),
    createDeal: f => api('POST', '/zoho/deals', { data: [f], trigger: ['workflow'] }),
    getDeal: id => api('GET', '/zoho/deals/' + enc(id)),
    updateDeal: (id, f) => api('PUT', '/zoho/deals/' + enc(id), { data: [f] }),
    uploadProposal: (id, doc) => api('POST', '/zoho/deals/' + enc(id) + '/proposal', doc),   // {fileName, html}
    addNote: (id, title, content) => api('POST', '/zoho/deals/' + enc(id) + '/notes', { title, content }),
    setOutage() {}, outage: () => false, dealCount: () => null, reset() {}
  };

  window.Zoho = (window.SJK_CONFIG && window.SJK_CONFIG.zohoMode === 'api') ? ApiZoho : MockZoho;
  window.ZOHO_PICKLIST_DEFAULTS = PICKLISTS;
})();
