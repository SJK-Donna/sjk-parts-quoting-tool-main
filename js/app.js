/* SJK Parts Quoting Tool — application (screens per SPEC §7). */
(async function () {
  'use strict';

  /* ================= helpers ================= */
  const CFG = window.SJK_CONFIG || {};
  const P = window.Pricing, Store = window.Store, Zoho = window.Zoho, Proposal = window.Proposal;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const php = (v, dp = 2) => '₱' + (+v || 0).toLocaleString('en-PH', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const usd = v => v == null ? '—' : '$' + (+v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clone = o => JSON.parse(JSON.stringify(o));
  const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (+n || 0)); return d.toISOString().slice(0, 10); };
  const fmtDate = iso => iso ? new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
  const fmtTime = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 3600);
    setTimeout(() => el.remove(), 4000);
  }
  function modal(title, html, opts = {}) {
    $('#modalTitle').textContent = title;
    // Fresh element each time so click handlers from earlier dialogs don't stack up.
    const old = $('#modalBody'), fresh = old.cloneNode(false); old.replaceWith(fresh);
    fresh.innerHTML = html;
    $('#modal .modal-card').classList.toggle('wide', !!opts.wide);
    $('#modal').hidden = false;
    document.body.classList.add('noscroll');
    return $('#modalBody');
  }
  function closeModal() { $('#modal').hidden = true; $('#modalBody').innerHTML = ''; document.body.classList.remove('noscroll'); }
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });

  /* ================= state ================= */
  const SHORT = ['Tempo', 'Tempo ND', 'Onward', 'Prec 2019', 'Prec 2015', 'Prec 2009', 'CA300', 'CA500', 'CA700', 'Transporter', 'Villager', 'Villager AC', 'Minibus'];
  const HAZMAT_PNS = ['47786538002', '47769678002'];
  const CAT_BATTERY = 'Batteries & Charging', CAT_TIRES = 'Wheels & Tires';

  let D = null, HAY = [], BYPN = {};
  let S = P.normalize((Store.liveSettings() || {}).values);
  let EDITS = Store.partEdits();
  let ME = null;
  let mode = Store.mode();
  let PICK = clone(window.ZOHO_PICKLIST_DEFAULTS);
  let F = { model: -1, cat: -1, q: '', unp: false }, shown = 150, openRow = null;

  const isAdmin = () => ME && ME.role === 'admin';
  const seeCosts = () => isAdmin() || !!S.salesSeeCosts;

  /* ================= data ================= */
  async function loadData() {
    const custom = Store.dataset();
    if (custom) return custom;
    const res = await fetch(CFG.dataUrl || 'data/parts_data.json');
    if (!res.ok) throw new Error('Could not load parts data (' + res.status + ')');
    return res.json();
  }
  function indexData() {
    HAY = []; BYPN = {};
    D.rows.forEach((r, i) => { BYPN[r[0]] = i; HAY[i] = (r[0] + ' ' + r[1] + ' ' + (r[7] || []).join(' ')).toUpperCase(); });
  }

  /* Merged view of one part: dataset row + admin edits. */
  function part(ref) {
    const i = typeof ref === 'number' ? ref : BYPN[ref];
    const r = D.rows[i]; if (!r) return null;
    const ed = EDITS[r[0]] || {};
    const catIdx = ed.cat != null && D.cats[ed.cat] != null ? +ed.cat : r[5];
    const cat = D.cats[catIdx];
    const catKg = +(S.kg[cat] != null ? S.kg[cat] : (P.CATEGORY_KG[cat] != null ? P.CATEGORY_KG[cat] : 1));
    return {
      i, pn: r[0], desc: r[1], dealer: r[2], msrp: r[3], origin: r[4] ? 'CN' : 'US', catIdx, cat,
      models: r[6] || [], alt: r[7] || [], kg: ed.kg != null ? +ed.kg : catKg, kgSource: ed.kg != null ? 'part' : 'category',
      hazmat: ed.hazmat != null ? !!ed.hazmat : (HAZMAT_PNS.includes(r[0]) || /LITHIUM/i.test(r[1])),
      notes: ed.notes || ''
    };
  }
  const priceOf = (p, o = {}) => p ? P.price({ dealerUsd: p.dealer, origin: p.origin, kg: o.kg != null ? o.kg : p.kg }, S, { mode: o.mode || mode, margin: o.margin }) : null;
  const fitsShort = k => k.length > 3 ? k.slice(0, 3).map(i => SHORT[i]).join(', ') + ` +${k.length - 3}` : k.map(i => SHORT[i]).join(', ');
  const fitsFull = k => k.map(i => D.models[i][0]).join(', ');

  /* ================= draft quote ================= */
  function blankDraft() {
    return { id: null, customer: null, reference: '', model: '', margin: S.margin, lines: [], deal: blankDeal(), approval: null };
  }
  function blankDeal() {
    return { Type: '', Business_Type: '', Industry: '', SJK_Office_Location: ME && ME.office ? [ME.office] : [],
      GO_Chance: '50%', GET_Chance: '50%', Street: '', City: '', Lead_Source: '', Pick_List_6: '', unitAuto: true };
  }
  let draft = Store.draft() || null;
  const saveDraft = () => { Store.saveDraft(draft); updateCount(); };
  function updateCount() { $('#lineCount').textContent = draft ? draft.lines.length : 0; }

  function addToQuote(pn, qty = 1) {
    if (!draft) draft = blankDraft();
    const p = part(pn);
    if (!p || p.dealer == null) return toast('This part has no price. It cannot be quoted.', 'warn');
    const ex = draft.lines.find(l => l.pn === pn);
    if (ex) ex.qty += qty; else draft.lines.push({ pn, qty, kg: null });
    saveDraft();
    if (p.hazmat && mode === 'air') toast(`${pn} is dangerous goods (lithium). It can't fly as standard cargo — quote it by sea.`, 'warn');
    else toast(`Added ${pn} to the quote`);
  }

  function pricedLines(d = draft) {
    return (d ? d.lines : []).map(l => {
      const p = part(l.pn); if (!p) return null;
      const b = priceOf(p, { kg: l.kg, margin: d.margin });
      return b && { pn: p.pn, desc: p.desc, cat: p.cat, fits: fitsFull(p.models), hazmat: p.hazmat, qty: l.qty, kg: l.kg != null ? l.kg : p.kg,
        kgOverride: l.kg != null, unitLanded: b.landed, unitSell: b.sell, b };
    }).filter(Boolean);
  }

  /* Unit Offered rule (SPEC §9.3): largest-value category decides. */
  function unitOffered(lines) {
    const byCat = {};
    lines.forEach(l => byCat[l.cat] = (byCat[l.cat] || 0) + l.unitSell * l.qty);
    const top = Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a])[0];
    return top === CAT_BATTERY ? 'Battery' : top === CAT_TIRES ? 'Tires' : 'GCPH Wear & Tear';
  }

  /* ================= header / auth ================= */
  function renderHeader() {
    $('#roleBadge').textContent = isAdmin() ? 'ADMIN' : 'SALES';
    $('#costLine').innerHTML = isAdmin()
      ? `Forex ${php(P.effectiveFx(S))}/USD · margin ${S.margin}% · min ${S.minMargin}%`
      : `Club Car spare parts · Golf Carts PH`;
    $('#userBtn').textContent = ME.name.split(' ')[0] + ' ▾';
    $$('.admin-only').forEach(el => el.hidden = !isAdmin());
    $$('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  }
  $$('[data-mode]').forEach(b => b.addEventListener('click', () => {
    mode = b.dataset.mode; Store.setMode(mode); renderHeader(); route();
  }));
  $('#userBtn').addEventListener('click', () => {
    const body = modal('Signed in', `<p><b>${esc(ME.name)}</b><br>${esc(ME.email)} · ${isAdmin() ? 'Admin' : 'Sales'}<br>${esc(ME.title || '')}</p>
      <div class="row-btns"><button class="btn" data-act="pw">Change password</button><button class="btn primary" data-act="out">Sign out</button></div>`);
    body.addEventListener('click', async e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'out') { a.disabled = true; await Store.logout(); location.hash = ''; location.reload(); }
      if (a.dataset.act === 'pw') changePassword(ME.id, true);
    });
  });

  function changePassword(userId, self) {
    const body = modal(self ? 'Change your password' : 'Set a new password', `<form class="form" id="pwf">
      <label>New password<input type="password" name="p1" minlength="8" required autocomplete="new-password"></label>
      <label>Repeat it<input type="password" name="p2" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary">Save password</button></form>`);
    $('#pwf', body).addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.target;
      if (f.p1.value !== f.p2.value) return toast('The passwords don\'t match.', 'warn');
      try { await Store.setPassword(userId, f.p1.value); closeModal(); toast('Password updated', 'ok'); }
      catch (err) { toast(err.message, 'err'); }
    });
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try { ME = await Store.login(f.email.value, f.password.value); $('#loginErr').textContent = ''; start(); }
    catch (err) { $('#loginErr').textContent = err.message; }
  });

  /* ================= router ================= */
  const VIEWS = { find: viewFind, quote: viewQuote, quotes: viewQuotes, q: viewQuoteDetail, costing: viewCosting, users: viewUsers, parts: viewParts, zoho: viewZoho };
  const ADMIN_VIEWS = ['costing', 'users', 'parts', 'zoho'];
  function route() {
    if (!ME) return;
    const h = location.hash.slice(1) || 'find';
    const [name, arg] = h.startsWith('q-') ? ['q', h.slice(2)] : [h, null];
    let v = VIEWS[name] ? name : 'find';
    if (ADMIN_VIEWS.includes(v) && !isAdmin()) v = 'find';
    $$('#tabs a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#' + (v === 'q' ? 'quotes' : v)));
    const main = $('#view');
    main.onclick = main.onchange = main.oninput = null;
    main.className = 'view-' + v;
    VIEWS[v](main, arg ? decodeURIComponent(arg) : null);
  }
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

  /* ================= FIND ================= */
  function filtered(ignoreCat) {
    const toks = F.q.toUpperCase().split(/\s+/).filter(Boolean), out = [];
    for (let i = 0; i < D.rows.length; i++) {
      const r = D.rows[i];
      const unpriced = r[2] == null;
      if (unpriced && !F.unp && !(toks.length === 1 && r[0].toUpperCase().startsWith(toks[0]))) continue;
      if (F.model >= 0 && !r[6].includes(F.model)) continue;
      if (!ignoreCat && F.cat >= 0 && part(i).catIdx !== F.cat) continue;
      if (toks.length && !toks.every(t => HAY[i].includes(t))) continue;
      out.push(i);
    }
    if (toks.length === 1) {
      const t = toks[0], pn = i => D.rows[i][0].toUpperCase();
      out.sort((a, b) => ((pn(b) === t) - (pn(a) === t)) || (pn(b).startsWith(t) - pn(a).startsWith(t)));
    }
    return out;
  }

  function viewFind(main) {
    const groups = {};
    D.models.forEach((m, i) => { const g = m[1].split(' /')[0]; (groups[g] = groups[g] || []).push(i); });
    main.innerHTML = `<div class="find">
      <aside class="filters card">
        <label class="lbl">Cart model<select id="fModel"><option value="-1">All models</option>
          ${Object.keys(groups).map(g => `<optgroup label="${esc(g)}">${groups[g].map(i => `<option value="${i}" ${F.model === i ? 'selected' : ''}>${esc(D.models[i][0])}</option>`).join('')}</optgroup>`).join('')}
        </select></label>
        <div class="lbl">Category</div>
        <div id="fCats" class="cats"></div>
        <label class="chk"><input type="checkbox" id="fUnp" ${F.unp ? 'checked' : ''}> Show parts not on the price list</label>
      </aside>
      <section class="results">
        <div class="searchbar"><input id="fq" type="search" placeholder="Part number or description — e.g. 102505401, brake shoe, headlight" value="${esc(F.q)}" autocomplete="off" enterkeyhint="search">
          <button class="btn" id="fClear" type="button">Clear</button></div>
        <p class="meta" id="fMeta"></p>
        <div id="fList"></div>
      </section></div>`;

    const q = $('#fq', main);
    q.addEventListener('input', debounce(() => { F.q = q.value; shown = 150; openRow = null; draw(); }, 120));
    $('#fClear', main).addEventListener('click', () => { F = { model: -1, cat: -1, q: '', unp: false }; shown = 150; viewFind(main); });
    $('#fModel', main).addEventListener('change', e => { F.model = +e.target.value; F.cat = -1; shown = 150; draw(); });
    $('#fUnp', main).addEventListener('change', e => { F.unp = e.target.checked; shown = 150; draw(); });
    $('#fCats', main).addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (!b) return; F.cat = +b.dataset.cat; shown = 150; draw(); });
    $('#fList', main).addEventListener('click', e => {
      const add = e.target.closest('[data-add]');
      if (add) { e.stopPropagation(); addToQuote(add.dataset.add); return; }
      if (e.target.closest('[data-more]')) { shown += 150; draw(); return; }
      if (e.target.closest('.pdetail')) return;
      const row = e.target.closest('[data-row]');
      if (row) { openRow = openRow === row.dataset.row ? null : row.dataset.row; draw(); }
    });
    draw();
    if (matchMedia('(min-width: 900px)').matches) q.focus();

    function draw() {
      const all = filtered(true);
      const counts = {}; all.forEach(i => { const c = part(i).catIdx; counts[c] = (counts[c] || 0) + 1; });
      $('#fCats', main).innerHTML = `<button data-cat="-1" class="${F.cat < 0 ? 'on' : ''}"><span>All categories</span><b>${all.length}</b></button>` +
        D.cats.map((c, i) => counts[i] ? `<button data-cat="${i}" class="${F.cat === i ? 'on' : ''}"><span>${esc(c)}</span><b>${counts[i]}</b></button>` : '').join('');
      const list = F.cat >= 0 ? all.filter(i => part(i).catIdx === F.cat) : all;
      $('#fMeta', main).textContent = `${list.length.toLocaleString()} parts · ${F.model >= 0 ? D.models[F.model][0] : 'all models'} · ${mode === 'air' ? 'Air' : 'Sea'} freight · prices ex-VAT at ${S.margin}% margin`;
      const cost = seeCosts();
      const rows = list.slice(0, shown).map(i => {
        const p = part(i), b = priceOf(p), open = openRow === p.pn;
        return `<div class="prow ${open ? 'open' : ''} ${b ? '' : 'unpriced'}" data-row="${esc(p.pn)}">
          <div class="pn">${esc(p.pn)}${p.hazmat ? ' <span class="tag haz" title="Dangerous goods">DG</span>' : ''}</div>
          <div class="desc">${esc(p.desc)}<small>${esc(p.cat)} · ${esc(fitsShort(p.models)) || '—'}</small></div>
          ${cost ? `<div class="num c-dealer"><small>Dealer</small>${usd(p.dealer)}</div><div class="num c-landed"><small>Landed</small>${b ? php(b.landed) : '—'}</div>` : ''}
          <div class="num sell"><small>Price</small>${b ? php(b.sell) : '<span class="por">Price on request</span>'}</div>
          <div class="act">${b ? `<button class="btn primary sm" data-add="${esc(p.pn)}" type="button" aria-label="Add ${esc(p.pn)}">Add</button>` : ''}</div>
          ${open ? detail(p, b) : ''}</div>`;
      }).join('');
      $('#fList', main).innerHTML = (list.length ? `<div class="phead ${cost ? '' : 'nocost'}"><span>Part no.</span><span>Description</span>${cost ? '<span class="num">Dealer cost</span><span class="num">Landed cost</span>' : ''}<span class="num">Selling price</span><span></span></div>` : '') +
        `<div class="plist ${cost ? '' : 'nocost'}">${rows}</div>` +
        (list.length > shown ? `<button class="btn block more" data-more type="button">Show ${Math.min(150, list.length - shown)} more of ${(list.length - shown).toLocaleString()}</button>` : '') +
        (!list.length ? `<div class="empty">No parts match. Try fewer words, another model, or turn on “parts not on the price list”.</div>` : '');
    }
  }

  const SEG = [['buy', 'Buy price', 'var(--c-buy)'], ['freight', 'Freight', 'var(--c-fr)'], ['insurance', 'Insurance', 'var(--c-ins)'], ['duty', 'Duty', 'var(--c-duty)'],
    ['brokerage', 'Brokerage & port', 'var(--c-brk)'], ['contingency', 'Contingency', 'var(--c-misc)'], ['importVat', 'Import VAT', 'var(--c-vat)'], ['gp', 'Margin', 'var(--c-gp)']];
  function stack(b) {
    const t = b.sell || 1, segs = SEG.filter(s => b[s[0]] > 0.004);
    return `<div class="stack">${segs.map(s => `<i style="width:${(b[s[0]] / t * 100).toFixed(2)}%;background:${s[2]}" title="${s[1]} ${php(b[s[0]])}"></i>`).join('')}</div>
      <div class="keys">${segs.map(s => `<span><i style="background:${s[2]}"></i>${s[1]} ${php(b[s[0]])}</span>`).join('')}</div>`;
  }
  function detail(p, b) {
    const cost = seeCosts();
    return `<div class="pdetail">
      ${b ? `<div class="big">${php(b.sell)} <small>ex-VAT · ${php(b.sellIncVat)} incl. 12% VAT</small></div>
        ${p.hazmat && mode === 'air' ? `<p class="alert warn">Dangerous goods: lithium batteries can't fly as standard cargo. Quote this part by sea.</p>` : ''}
        ${b.freightGuarded ? `<p class="alert">Air freight raised to the sea-freight amount (air is never priced below sea).</p>` : ''}
        ${cost ? stack(b) : ''}` : `<div class="big por">Price on request</div><p class="meta">Not on any current Club Car price list — usually superseded or no longer available.</p>`}
      <dl class="facts">
        <div><dt>Fits</dt><dd>${esc(fitsFull(p.models)) || '—'}</dd></div>
        <div><dt>Category</dt><dd>${esc(p.cat)}</dd></div>
        <div><dt>Origin</dt><dd>${p.origin === 'CN' ? 'China (FCA)' : 'USA'}</dd></div>
        ${cost ? `<div><dt>Dealer cost</dt><dd>${usd(p.dealer)}</dd></div><div><dt>MSRP (US)</dt><dd>${usd(p.msrp)}</dd></div>` : ''}
        ${cost && b ? `<div><dt>Freight basis</dt><dd>${b.basis === 'kg' ? `${p.kg} kg × $${S[mode][p.origin].kg}/kg (${p.kgSource} weight)` : `${S[mode][p.origin].pct}% of value`}</dd></div><div><dt>Landed cost</dt><dd>${php(b.landed)}</dd></div>` : ''}
        ${p.alt.length ? `<div><dt>Supplier codes</dt><dd>${esc(p.alt.join(', '))}</dd></div>` : ''}
        ${p.notes ? `<div><dt>Notes</dt><dd>${esc(p.notes)}</dd></div>` : ''}
      </dl></div>`;
  }

  /* ================= QUOTE (editor) ================= */
  function viewQuote(main) {
    if (!draft) { draft = blankDraft(); saveDraft(); }
    const lines = pricedLines();
    const t = P.totals(lines);
    const cost = seeCosts();
    const belowMin = +draft.margin < +S.minMargin;
    const approved = belowMin && draft.approval && +draft.approval.margin <= +draft.margin;
    const perKg = S[mode].basis === 'kg';
    const revising = draft.id && (Store.quote(draft.id) || {}).versions && Store.quote(draft.id).versions.length;
    const qrec = draft.id ? Store.quote(draft.id) : null;
    const nextV = qrec ? qrec.versions.length + 1 : 1;
    if (draft.deal.unitAuto && lines.length) draft.deal.Pick_List_6 = unitOffered(lines);
    const errs = validate(lines);

    main.innerHTML = `
    ${revising ? `<div class="banner">Revising <b>${esc(qrec.versions[qrec.versions.length - 1].no)}</b>. Generating creates <b>v${nextV}</b> and updates the same Zoho deal. <button class="link" data-act="cancelRev">Cancel revision</button></div>` : ''}
    ${qrec && qrec.status === 'pending_approval' ? `<div class="banner warn">Waiting for an admin to approve the ${esc(qrec.approvalRequest && qrec.approvalRequest.margin)}% margin.</div>` : ''}
    <div class="qgrid">
      <section class="card">
        <h2>Customer</h2>
        <div id="custBox">${customerBox()}</div>
      </section>
      <section class="card">
        <h2>Quote</h2>
        <div class="form grid3">
          <label class="span2">Reference<input data-f="reference" value="${esc(draft.reference)}" placeholder="e.g. Tempo fleet brake service" maxlength="80"></label>
          <label>Margin %<input data-f="margin" type="number" step="0.5" min="0" max="90" value="${esc(draft.margin)}" inputmode="decimal"></label>
          <label class="span2">Cart model<select data-f="model"><option value="">Various / not specified</option>${D.models.map(m => `<option ${draft.model === m[0] ? 'selected' : ''}>${esc(m[0])}</option>`).join('')}</select></label>
          <label>Freight<input value="${mode === 'air' ? 'Air' : 'Sea'} (top bar)" disabled></label>
        </div>
        ${belowMin ? `<div class="alert ${approved ? 'ok' : 'warn'}">Margin ${esc(draft.margin)}% is below the ${S.minMargin}% minimum.
          ${approved ? `Approved by ${esc(draft.approval.by)} on ${fmtTime(draft.approval.at)}.` :
            isAdmin() ? ` <button class="btn sm" data-act="approve">Approve ${esc(draft.margin)}% margin</button>` :
            ` An admin must approve it before you can generate. <button class="btn sm" data-act="reqApproval">Request approval</button>`}</div>` : ''}
      </section>
    </div>

    <section class="card">
      <div class="card-hd"><h2>Parts <span class="meta">${lines.length} line${lines.length === 1 ? '' : 's'} · ${mode === 'air' ? 'air' : 'sea'} freight</span></h2>
        <a class="btn sm" href="#find">+ Add parts</a></div>
      ${lines.length ? `<div class="qlines ${cost ? '' : 'nocost'} ${perKg ? 'kg' : ''}">
        <div class="qh"><span>Part</span><span class="num">Qty</span>${perKg ? '<span class="num">kg / unit</span>' : ''}${cost ? '<span class="num">Landed / unit</span>' : ''}<span class="num">Price / unit</span><span class="num">Line total</span><span></span></div>
        ${lines.map((l, i) => `<div class="ql">
          <div class="qp"><b>${esc(l.pn)}</b>${l.hazmat ? ' <span class="tag haz">DG</span>' : ''}<span>${esc(l.desc)}</span><small>${esc(l.cat)}</small></div>
          <label class="num"><span class="mlbl">Qty</span><input type="number" min="1" step="1" value="${l.qty}" data-qty="${i}" inputmode="numeric" aria-label="Quantity for ${esc(l.pn)}"></label>
          ${perKg ? `<label class="num"><span class="mlbl">kg/unit</span><input type="number" min="0" step="0.01" value="${l.kg}" data-kg="${i}" class="${l.kgOverride ? 'ovr' : ''}" inputmode="decimal" aria-label="Weight for ${esc(l.pn)}"></label>` : ''}
          ${cost ? `<div class="num"><span class="mlbl">Landed</span>${php(l.unitLanded)}</div>` : ''}
          <div class="num"><span class="mlbl">Price</span>${php(l.unitSell)}</div>
          <div class="num strong"><span class="mlbl">Total</span>${php(l.unitSell * l.qty)}</div>
          <button class="x" data-rm="${i}" aria-label="Remove ${esc(l.pn)}" type="button">×</button></div>`).join('')}
      </div>
      <div class="totals">
        ${cost ? `<div><small>Landed cost</small><b>${php(t.landed)}</b></div>` : ''}
        <div><small>Selling price ex-VAT</small><b>${php(t.sub)}</b></div>
        <div><small>VAT 12%</small><b>${php(t.vat)}</b></div>
        <div class="hl"><small>Total VAT-inclusive</small><b>${php(t.total)}</b></div>
        ${cost ? `<div><small>Gross profit (${t.gpPct.toFixed(1)}%)</small><b>${php(t.gp)}</b></div>` : ''}
      </div>` : `<div class="empty">No parts yet. <a href="#find">Find parts</a> and press <b>Add</b>.</div>`}
    </section>

    <section class="card">
      <div class="card-hd"><h2>Zoho deal details</h2><span class="meta">Required by the “Service Layout New” layout</span></div>
      ${dealForm()}
    </section>

    <section class="card actions">
      ${errs.length ? `<ul class="todo">${errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : `<p class="ready">Ready. This creates proposal v${nextV}${revising ? ' and updates the Zoho deal' : ', the Zoho deal, and uploads the PDF'}.</p>`}
      <div class="row-btns">
        <button class="btn primary lg" data-act="generate" ${errs.length ? 'disabled' : ''}>Generate proposal</button>
        <button class="btn" data-act="preview" ${lines.length && draft.customer ? '' : `disabled title="${!draft.customer ? 'Pick a customer' : 'Add parts'} to preview the PDF"`}>Preview PDF</button>
        ${lines.length && draft.customer ? '' : `<span class="meta">Preview needs ${[!draft.customer && 'a customer', !lines.length && 'at least one part'].filter(Boolean).join(' and ')}.</span>`}
        <button class="btn" data-act="saveDraft" ${lines.length || draft.customer ? '' : 'disabled'}>Save draft</button>
        ${isAdmin() && lines.length ? `<button class="btn" data-act="csv">Internal CSV</button>` : ''}
        <button class="btn ghost" data-act="clear">Clear quote</button>
      </div>
    </section>`;

    bindQuote(main, lines);
  }

  function customerBox() {
    const c = draft.customer;
    if (!c) return `<div class="typeahead"><input id="acctQ" type="search" placeholder="Search Zoho accounts (2+ letters)" autocomplete="off">
      <div id="acctRes" class="ta-res"></div></div>
      <button class="link" data-act="newCust" type="button">+ New customer</button>
      ${Zoho.mode === 'mock' ? '<p class="hint">Demo CRM: try “golf”, “resort” or “university”.</p>' : ''}`;
    const a = c.account;
    return `<div class="cust"><b>${esc(a.Account_Name)}</b><span>${esc([a.Billing_Street, a.Billing_City].filter(Boolean).join(', '))}</span>
      <label class="lbl">Contact<select id="contactSel"><option value="">— No contact —</option>${(c.contacts || []).map(x => `<option value="${esc(x.id)}" ${c.contact && c.contact.id === x.id ? 'selected' : ''}>${esc([x.First_Name, x.Last_Name].filter(Boolean).join(' '))}${x.Title ? ' · ' + esc(x.Title) : ''}</option>`).join('')}</select></label>
      <div class="row-btns"><button class="link" data-act="newContact" type="button">+ New contact</button>
      ${draft.id && Store.quote(draft.id) && Store.quote(draft.id).zoho.dealId ? '' : '<button class="link" data-act="changeCust" type="button">Change customer</button>'}</div></div>`;
  }

  function sel(name, opts, val, extra = '') {
    return `<select data-d="${name}" ${extra}><option value="">Choose…</option>${opts.map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  function dealForm() {
    const d = draft.deal, req = '<i class="req" title="Required">*</i>';
    const ind = d.Business_Type === 'Business-to-Consumer' ? PICK.Industry_B2C : PICK.Industry_B2B;
    return `<div class="form grid3">
      <label><span>Type of client ${req}</span>${sel('Type', PICK.Type, d.Type)}</label>
      <label><span>Business type ${req}</span>${sel('Business_Type', PICK.Business_Type, d.Business_Type)}</label>
      <label><span>Industry ${req}</span>${sel('Industry', ind, d.Industry, d.Business_Type ? '' : 'disabled')}</label>
      <fieldset class="span2"><legend>SJK office location ${req}</legend><div class="checks">${PICK.SJK_Office_Location.map(o => `<label class="chk"><input type="checkbox" data-office value="${esc(o)}" ${d.SJK_Office_Location.includes(o) ? 'checked' : ''}> ${esc(o)}</label>`).join('')}</div></fieldset>
      <label><span>Unit offered ${req}</span><select data-d="Pick_List_6">${PICK.Pick_List_6.map(o => `<option ${o === d.Pick_List_6 ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
        <small class="meta">${d.unitAuto ? 'Set automatically from the parts' : 'Set by you · <button class="link" data-act="unitAuto" type="button">auto</button>'}</small></label>
      <label><span>GO chance ${req}</span>${sel('GO_Chance', PICK.GO_Chance, d.GO_Chance)}</label>
      <label><span>GET chance ${req}</span>${sel('GET_Chance', PICK.GET_Chance, d.GET_Chance)}</label>
      <label>Lead source${sel('Lead_Source', PICK.Lead_Source, d.Lead_Source)}</label>
      <label class="span2"><span>Street ${req}</span><input data-d="Street" value="${esc(d.Street)}"></label>
      <label><span>City ${req}</span><input data-d="City" value="${esc(d.City)}"></label>
    </div>
    <p class="meta">Pipeline <b>Spare Parts</b> · stage <b>Proposal/Price Quote</b> · owner <b>${esc(ME.name)}</b> · amount = VAT-inclusive total · closing date = valid-until (${S.validityDays} days).</p>`;
  }

  function validate(lines) {
    const e = [], d = draft.deal;
    if (!draft.customer) e.push('Choose the customer.');
    if (!lines.length) e.push('Add at least one part.');
    if (lines.some(l => !(l.qty >= 1))) e.push('Every quantity must be 1 or more.');
    if (mode === 'air' && lines.some(l => l.hazmat)) e.push('Lithium batteries can’t go by air. Switch to sea freight or remove them.');
    if (+draft.margin < +S.minMargin && !(draft.approval && +draft.approval.margin <= +draft.margin)) e.push(`Margin below ${S.minMargin}% needs admin approval.`);
    const miss = [];
    if (!d.Type) miss.push('type of client'); if (!d.Business_Type) miss.push('business type'); if (!d.Industry) miss.push('industry');
    if (!d.SJK_Office_Location.length) miss.push('office location'); if (!d.GO_Chance) miss.push('GO chance'); if (!d.GET_Chance) miss.push('GET chance');
    if (!String(d.Street).trim()) miss.push('street'); if (!String(d.City).trim()) miss.push('city');
    if (miss.length) e.push('Fill the deal details: ' + miss.join(', ') + '.');
    return e;
  }

  function bindQuote(main, lines) {
    const rerender = () => { saveDraft(); viewQuote(main); };
    main.onchange = e => {
      const t = e.target;
      if (t.dataset.f) { draft[t.dataset.f] = t.dataset.f === 'margin' ? +t.value : t.value; return rerender(); }
      if (t.dataset.qty != null) { draft.lines[+t.dataset.qty].qty = Math.max(1, Math.round(+t.value || 1)); return rerender(); }
      if (t.dataset.kg != null) { const v = t.value === '' ? null : Math.max(0, +t.value); draft.lines[+t.dataset.kg].kg = v; return rerender(); }
      if (t.dataset.d) {
        const k = t.dataset.d; draft.deal[k] = t.value;
        if (k === 'Business_Type') draft.deal.Industry = '';
        if (k === 'Pick_List_6') draft.deal.unitAuto = false;
        return rerender();
      }
      if (t.matches('[data-office]')) { draft.deal.SJK_Office_Location = $$('[data-office]:checked', main).map(x => x.value); return rerender(); }
      if (t.id === 'contactSel') { draft.customer.contact = (draft.customer.contacts || []).find(c => c.id === t.value) || null; return rerender(); }
    };
    // keep typing in text fields without re-render on each key
    $$('[data-d="Street"],[data-d="City"],[data-f="reference"]', main).forEach(inp => inp.addEventListener('input', () => {
      if (inp.dataset.d) draft.deal[inp.dataset.d] = inp.value; else draft.reference = inp.value; Store.saveDraft(draft);
    }));

    main.onclick = async e => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { draft.lines.splice(+rm.dataset.rm, 1); return rerender(); }
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act;
      if (act === 'clear') { if (await ask('Clear this quote? Lines and customer will be removed.', 'Clear quote')) { draft = blankDraft(); rerender(); } }
      if (act === 'cancelRev') { draft = blankDraft(); rerender(); }
      if (act === 'changeCust') { draft.customer = null; rerender(); }
      if (act === 'newCust') newCustomer(main);
      if (act === 'newContact') newContact(main);
      if (act === 'unitAuto') { draft.deal.unitAuto = true; rerender(); }
      if (act === 'approve') { draft.approval = { margin: +draft.margin, by: ME.name, title: ME.title, at: Store.now() }; toast('Margin approved', 'ok'); rerender(); }
      if (act === 'reqApproval') { const q = persistDraft('pending_approval'); q.approvalRequest = { margin: +draft.margin, by: ME.name, at: Store.now() }; Store.saveQuote(q); toast('Saved and sent for approval. Admins see it in My quotes.', 'ok'); rerender(); }
      if (act === 'saveDraft') { persistDraft(); toast('Draft saved to My quotes', 'ok'); rerender(); }
      if (act === 'preview') previewDraft(lines);
      if (act === 'csv') exportCsv(draft, lines);
      if (act === 'generate') { a.disabled = true; a.textContent = 'Generating…'; await generate(); }
    };

    const qi = $('#acctQ', main);
    if (qi) {
      const res = $('#acctRes', main);
      qi.addEventListener('input', debounce(async () => {
        const t = qi.value.trim();
        if (t.length < 2) { res.innerHTML = ''; return; }
        res.innerHTML = '<div class="meta pad">Searching Zoho…</div>';
        try {
          const list = await Zoho.searchAccounts(t);
          res.innerHTML = list.length ? list.map(a => `<button type="button" data-acct="${esc(a.id)}"><b>${esc(a.Account_Name)}</b><small>${esc([a.Billing_Street, a.Billing_City].filter(Boolean).join(', '))}</small></button>`).join('')
            : '<div class="meta pad">No accounts found. Use “New customer”.</div>';
          res._list = list;
        } catch (err) { res.innerHTML = `<div class="err pad">${esc(err.message)}</div>`; }
      }, 250));
      res.addEventListener('click', async e => {
        const b = e.target.closest('[data-acct]'); if (!b) return;
        await pickAccount(res._list.find(a => a.id === b.dataset.acct));
        viewQuote(main);
      });
    }
  }

  async function pickAccount(acct) {
    let contacts = [], hist = { hasClosedWon: false, lastDeal: null };
    try { [contacts, hist] = await Promise.all([Zoho.contacts(acct.id), Zoho.accountHistory(acct.id)]); }
    catch (err) { toast('Zoho: ' + err.message, 'err'); }
    draft.customer = { account: acct, contacts, contact: contacts[0] || null };
    // Prefill deal fields from the account's last deal (SPEC §9.3)
    const d = draft.deal, last = hist.lastDeal || {};
    d.Type = hist.hasClosedWon ? 'Existing Business' : 'New Business';
    d.Business_Type = last.Business_Type || d.Business_Type || 'Business-to-Business';
    d.Industry = last.Business_Type === 'Business-to-Consumer' ? (last.Industry_B2C || '') : (last.Industry_B2B || '');
    if (last.SJK_Office_Location && last.SJK_Office_Location.length && !d.SJK_Office_Location.length) d.SJK_Office_Location = last.SJK_Office_Location.slice();
    d.Lead_Source = hist.hasClosedWon ? 'Repeat Client' : (last.Lead_Source || d.Lead_Source);
    d.Street = acct.Billing_Street || ''; d.City = acct.Billing_City || '';
    saveDraft();
  }

  function newCustomer(main) {
    const body = modal('New customer', `<form class="form" id="ncf">
      <fieldset><legend>Account</legend>
      <label>Company / account name *<input name="Account_Name" required maxlength="120"></label>
      <label>Street<input name="Billing_Street"></label><label>City<input name="Billing_City"></label><label>Phone<input name="Phone" inputmode="tel"></label></fieldset>
      <fieldset><legend>Contact person</legend>
      <label>First name<input name="First_Name"></label><label>Last name *<input name="Last_Name" required></label>
      <label>Title<input name="Title"></label><label>Email<input name="Email" type="email"></label><label>Mobile<input name="Mobile" inputmode="tel"></label></fieldset>
      <p class="err" id="ncErr"></p><button class="btn primary">Create in Zoho</button></form>`);
    $('#ncf', body).addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const btn = e.target.querySelector('button'); btn.disabled = true; btn.textContent = 'Creating…';
      try {
        let a = await Zoho.createAccount({ Account_Name: f.Account_Name.trim(), Billing_Street: f.Billing_Street, Billing_City: f.Billing_City, Phone: f.Phone });
        if (a.duplicate) { toast(`“${a.record.Account_Name}” already exists in Zoho. Using the existing account.`, 'warn'); a = a.record; }
        let c = await Zoho.createContact({ First_Name: f.First_Name, Last_Name: f.Last_Name, Title: f.Title, Email: f.Email, Mobile: f.Mobile, account: a.id, Account_Name: { id: a.id } });
        if (c.duplicate) { toast('A contact with that email exists. Using it.', 'warn'); c = c.record; }
        await pickAccount(a);
        if (!draft.customer.contacts.find(x => x.id === c.id)) draft.customer.contacts.push(c);
        draft.customer.contact = c; saveDraft(); closeModal(); viewQuote(main);
      } catch (err) { $('#ncErr', body).textContent = err.message; btn.disabled = false; btn.textContent = 'Create in Zoho'; }
    });
  }
  function newContact(main) {
    const body = modal('New contact', `<form class="form" id="nctf">
      <label>First name<input name="First_Name"></label><label>Last name *<input name="Last_Name" required></label>
      <label>Title<input name="Title"></label><label>Email<input name="Email" type="email"></label><label>Mobile<input name="Mobile" inputmode="tel"></label>
      <p class="err" id="nctErr"></p><button class="btn primary">Create in Zoho</button></form>`);
    $('#nctf', body).addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target)), a = draft.customer.account;
      try {
        let c = await Zoho.createContact(Object.assign(f, { account: a.id, Account_Name: { id: a.id } }));
        if (c.duplicate) { toast('A contact with that email exists. Using it.', 'warn'); c = c.record; }
        if (!draft.customer.contacts.find(x => x.id === c.id)) draft.customer.contacts.push(c);
        draft.customer.contact = c; saveDraft(); closeModal(); viewQuote(main);
      } catch (err) { $('#nctErr', body).textContent = err.message; }
    });
  }

  /* In-app confirm (native confirm() can be blocked in embedded pages). */
  function ask(msg, okLabel = 'OK') {
    return new Promise(res => {
      const body = modal('Please confirm', `<p>${esc(msg)}</p><div class="row-btns"><button class="btn primary" data-yes>${esc(okLabel)}</button><button class="btn" data-no>Cancel</button></div>`);
      let done = false;
      const fin = v => { if (done) return; done = true; obs.disconnect(); if (!$('#modal').hidden) closeModal(); res(v); };
      body.addEventListener('click', e => { if (e.target.closest('[data-yes]')) fin(true); if (e.target.closest('[data-no]')) fin(false); });
      const obs = new MutationObserver(() => { if ($('#modal').hidden) fin(false); });
      obs.observe($('#modal'), { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  /* Save the working draft into the quotes list. */
  function persistDraft(status) {
    let q = draft.id ? Store.quote(draft.id) : null;
    if (!q) {
      q = { id: Store.uid('Q'), status: 'draft', createdBy: ME.id, createdByName: ME.name, created_at: Store.now(), versions: [],
        zoho: { dealId: null, dealNo: null, status: 'none', error: null } };
      draft.id = q.id;
    }
    Object.assign(q, { customer: clone(draft.customer), reference: draft.reference, model: draft.model, margin: +draft.margin,
      lines: clone(draft.lines), deal: clone(draft.deal), approval: draft.approval ? clone(draft.approval) : null, mode });
    if (status) q.status = status;
    else if (!q.versions.length) q.status = 'draft';
    Store.saveQuote(q); saveDraft();
    return q;
  }

  function makeVersion(q, lines, v) {
    const date = today();
    const snap = lines.map(l => ({ pn: l.pn, desc: l.desc, cat: l.cat, fits: l.fits, qty: l.qty, kg: l.kg, unitLanded: l.unitLanded, unitSell: l.unitSell }));
    const approval = +q.margin < +S.minMargin ? q.approval : null;
    return { v, no: q.zoho.dealNo ? `SP-${q.zoho.dealNo}-v${v}` : `SP-TMP-${q.id}-v${v}`, date, validUntil: addDays(date, S.validityDays),
      lines: snap, totals: P.totals(snap), mode, margin: +q.margin, settingsId: (Store.liveSettings() || {}).id || 'defaults',
      approval, by: ME.id, byName: ME.name, synced: false, created_at: Store.now() };
  }

  async function generate() {
    const lines = pricedLines();
    if (validate(lines).length) return viewQuote($('#view'));
    const q = persistDraft();
    const ver = makeVersion(q, lines, q.versions.length + 1);
    q.versions.push(ver);
    q.status = 'issued'; q.approvalRequest = null; q.zoho.status = 'pending'; q.zoho.error = null;
    Store.saveQuote(q);                                   // SPEC §9.5: save first, then push to Zoho
    draft = null; Store.saveDraft(null); updateCount();
    location.hash = 'q-' + q.id;
    await syncZoho(q.id);
  }

  /* ================= Zoho sync (SPEC §9.4–9.5) ================= */
  const syncing = {};
  function dealFields(q, ver, create) {
    const d = q.deal, acct = q.customer.account, n = ver.lines.length;
    const f = {
      Deal_Name: `Spare Parts Proposal – ${acct.Account_Name}${q.reference ? ' – ' + q.reference : ''}`.slice(0, 120),
      Amount: ver.totals.total, Closing_Date: ver.validUntil,
      Description: `Proposal ${ver.no}, ${n} line${n === 1 ? '' : 's'}, ${ver.mode === 'air' ? 'Air' : 'Sea'} freight. Created by SJK Parts Quoting Tool. [${q.id}]`
    };
    if (!create) return f;
    const owner = (Store.users().find(u => u.id === q.createdBy) || ME);
    return Object.assign(f, {
      Layout: { id: '4983915000040429371' }, Pipeline: 'Spare Parts', Stage: 'Proposal/Price Quote', Lead_Creation: 'Service',
      Account_Name: { id: acct.id }, Contact_Name: q.customer.contact ? { id: q.customer.contact.id } : undefined,
      Owner: owner.zohoUserId ? { id: owner.zohoUserId } : { email: owner.email },
      Type: d.Type, Business_Type: d.Business_Type,
      Industry_B2B: d.Business_Type === 'Business-to-Business' ? d.Industry : undefined,
      Industry_B2C: d.Business_Type === 'Business-to-Consumer' ? d.Industry : undefined,
      SJK_Office_Location: d.SJK_Office_Location, Pick_List_6: d.Pick_List_6 || 'GCPH Wear & Tear',
      GO_Chance: d.GO_Chance, GET_Chance: d.GET_Chance, Street: d.Street, City: d.City, Lead_Source: d.Lead_Source || undefined
    });
  }
  function noteText(ver) {
    return ver.lines.map((l, i) => `${i + 1}. ${l.pn} ${Proposal.titleCase(l.desc)} × ${l.qty} @ ${php(l.unitSell)} = ${php(l.unitSell * l.qty)}`).join('\n') +
      `\n\nSubtotal ex-VAT ${php(ver.totals.sub)} · VAT 12% ${php(ver.totals.vat)} · Total ${php(ver.totals.total)}\nValid until ${ver.validUntil} · ${ver.mode === 'air' ? 'Air' : 'Sea'} freight`;
  }
  async function withRetry(fn) {
    let delay = 800;
    for (let a = 0; ; a++) {
      try { return await fn(); }
      catch (e) {
        const transient = !e.status || e.status >= 500 || e.status === 429;
        if (!transient || a >= 2) throw e;
        await new Promise(r => setTimeout(r, delay)); delay *= 2;
      }
    }
  }

  async function syncZoho(id) {
    if (syncing[id]) return; syncing[id] = true;
    let q = Store.quote(id);
    const refresh = () => { if (location.hash === '#q-' + id) viewQuoteDetail($('#view'), id); };
    q.zoho.status = 'pending'; q.zoho.lastAttempt = Store.now(); Store.saveQuote(q); refresh();
    try {
      await withRetry(async () => {
        q = Store.quote(id);
        const pending = q.versions.filter(v => !v.synced);
        if (!pending.length) return;
        if (!q.zoho.dealId) {
          const existing = await Zoho.findDealByQuoteId(q.id);       // duplicate guard before a create
          if (existing) q.zoho.dealId = existing.id;
          else { const r = await Zoho.createDeal(dealFields(q, pending[0], true)); q.zoho.dealId = r.id; }
          Store.saveQuote(q);
        }
        if (!q.zoho.dealNo) { const deal = await Zoho.getDeal(q.zoho.dealId); q.zoho.dealNo = deal.Deal_No; Store.saveQuote(q); }
        for (const ver of pending) {
          ver.no = `SP-${q.zoho.dealNo}-v${ver.v}`;                // final number replaces SP-TMP-…
          await Zoho.updateDeal(q.zoho.dealId, dealFields(q, ver, false));
          const rep = Store.users().find(u => u.id === ver.by) || ME;
          await Zoho.uploadProposal(q.zoho.dealId, { fileName: Proposal.fileName(q, ver), html: Proposal.render(q, ver, S, rep) });
          await Zoho.addNote(q.zoho.dealId, `Proposal ${ver.no} issued`, noteText(ver));
          ver.synced = true; Store.saveQuote(q);
        }
      });
      q = Store.quote(id); q.zoho.status = 'synced'; q.zoho.error = null; Store.saveQuote(q);
      toast(`Synced to Zoho · ${q.versions[q.versions.length - 1].no}`, 'ok');
    } catch (err) {
      q = Store.quote(id); q.zoho.status = 'failed'; q.zoho.error = err.message; Store.saveQuote(q);
      toast('Zoho sync failed — the quote is saved. You can retry.', 'err');
    } finally { syncing[id] = false; refresh(); }
  }

  /* ================= PDF preview ================= */
  function showPdf(q, ver) {
    const rep = Store.users().find(u => u.id === ver.by) || ME;
    const html = Proposal.render(q, ver, S, rep);
    const name = Proposal.fileName(q, ver);
    const body = modal(ver.no, `<div class="pdfbar"><span class="meta">${esc(name)}</span>
        <div class="row-btns"><button class="btn primary" data-act="dl">Download PDF</button>${IN_ARTIFACT ? '' : '<button class="btn" data-act="print">Print</button>'}</div></div>
      ${ver.no.startsWith('SP-TMP') ? '<p class="alert warn">Temporary number — Zoho hasn\'t synced yet. Retry the sync before sending this to the customer.</p>' : ''}
      <iframe class="pdfframe" title="Proposal preview"></iframe>
      <p class="hint">The PDF is made in your browser. With the backend in place, proposals are rendered on the server with selectable text.</p>`, { wide: true });
    const fr = $('.pdfframe', body); fr.srcdoc = html;
    // onclick (not addEventListener): #modalBody is reused, so listeners would stack up and download once per past preview.
    body.onclick = async e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'print') { fr.contentWindow.focus(); fr.contentWindow.print(); }
      if (a.dataset.act === 'dl') {
        const label = a.textContent; a.disabled = true; a.textContent = 'Making PDF…';
        try {
          const blob = await window.ProposalPdf.make(html, Proposal.footer(S, ver));
          if (await saveFile(name, blob)) toast('PDF ready: ' + name, 'ok');
        } catch (err) { toast(err.message || 'Could not make the PDF', 'err'); }
        finally { a.disabled = false; a.textContent = label; }
      }
    };
    if (window.ProposalPdf) window.ProposalPdf.loadLibs().catch(() => {});
  }
  function previewDraft(lines) {
    const q = { id: draft.id || 'DRAFT', customer: draft.customer, reference: draft.reference, model: draft.model, margin: +draft.margin, deal: draft.deal,
      approval: draft.approval, zoho: (draft.id && Store.quote(draft.id) || {}).zoho || {} };
    const ver = makeVersion(q, lines, ((draft.id && Store.quote(draft.id) || {}).versions || []).length + 1);
    ver.no = 'DRAFT-PREVIEW';
    showPdf(q, ver);
  }

  /* Save a file: the artifact 'downloads' capability when hosted on claude.ai, else a normal browser download. */
  const IN_ARTIFACT = !!(window.claude && window.claude.use);
  async function saveFile(filename, data) {
    if (IN_ARTIFACT) {
      const dl = await window.claude.use('downloads');
      if (!dl) throw new Error('Downloads are not available in this view.');
      try { await dl.save({ filename, data }); return true; }
      catch (e) { if (e && e.code === 'declined') return false; throw new Error((e && e.message) || 'Download failed'); }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
    a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return true;
  }

  /* Internal copy with costing — Admin only (SPEC §7.2). */
  function exportCsv(src, lines, label) {
    const rows = [['Part no', 'Description', 'Category', 'Qty', 'kg/unit', 'Landed/unit PHP', 'Price/unit PHP', 'Line total PHP', 'Line landed PHP', 'Line GP PHP']];
    lines.forEach(l => rows.push([l.pn, l.desc, l.cat, l.qty, l.kg, l.unitLanded.toFixed(2), l.unitSell.toFixed(2), (l.unitSell * l.qty).toFixed(2), (l.unitLanded * l.qty).toFixed(2), ((l.unitSell - l.unitLanded) * l.qty).toFixed(2)]));
    const t = P.totals(lines);
    rows.push([], ['Subtotal ex-VAT', t.sub.toFixed(2)], ['VAT 12%', t.vat.toFixed(2)], ['Total inc-VAT', t.total.toFixed(2)], ['Landed', t.landed.toFixed(2)], ['Gross profit', t.gp.toFixed(2), t.gpPct.toFixed(1) + '%'],
      ['Forex (effective)', P.effectiveFx(S)], ['Margin %', src.margin]);
    const csv = '﻿' + rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c).join(',')).join('\r\n');
    saveFile(`INTERNAL ${label || 'quote'} - costing.csv`, csv).catch(e => toast(e.message, 'err'));
  }

  /* ================= MY QUOTES ================= */
  let QF = { q: '', st: 'all' };
  const STATUS = { draft: 'Draft', pending_approval: 'Needs approval', issued: 'Issued', won: 'Won', lost: 'Lost', expired: 'Expired' };
  function effectiveStatus(q) {
    if (q.status === 'issued') { const v = q.versions[q.versions.length - 1]; if (v && v.validUntil < today()) return 'expired'; }
    return q.status;
  }
  function viewQuotes(main) {
    const mine = Store.quotes().filter(q => isAdmin() || q.createdBy === ME.id);
    const draw = () => {
      const t = QF.q.toLowerCase();
      const list = mine.filter(q => (QF.st === 'all' || effectiveStatus(q) === QF.st) &&
        (!t || [q.customer && q.customer.account.Account_Name, q.reference, q.zoho.dealNo, q.createdByName, ...(q.versions || []).map(v => v.no)].join(' ').toLowerCase().includes(t)));
      $('#qlist', main).innerHTML = list.length ? list.map(q => {
        const v = q.versions[q.versions.length - 1], st = effectiveStatus(q);
        const total = v ? v.totals.total : P.totals(pricedLines(q)).total;
        return `<a class="qcard" href="#q-${esc(q.id)}">
          <div><b>${esc(v ? v.no : 'Draft')}</b><span class="st st-${st}">${STATUS[st]}</span>${v ? zohoBadge(q) : ''}</div>
          <div class="qc-m"><span>${esc(q.customer ? q.customer.account.Account_Name : 'No customer yet')}</span><small>${esc(q.reference || '')}</small></div>
          <div class="qc-r"><b>${php(total)}</b><small>${esc(fmtDate((v || q).created_at || q.created_at))}${isAdmin() ? ' · ' + esc(q.createdByName) : ''}</small></div></a>`;
      }).join('') : '<div class="empty">No quotes here yet.</div>';
    };
    const counts = {}; mine.forEach(q => { const s = effectiveStatus(q); counts[s] = (counts[s] || 0) + 1; });
    main.innerHTML = `<div class="card-hd"><h2>${isAdmin() ? 'All quotes' : 'My quotes'}</h2><button class="btn primary sm" data-new type="button">New quote</button></div>
      <div class="searchbar"><input type="search" id="qq" placeholder="Search customer, reference, proposal or deal no." value="${esc(QF.q)}"></div>
      <div class="chips">${['all', 'pending_approval', 'draft', 'issued', 'won', 'lost', 'expired'].map(s => `<button data-st="${s}" class="${QF.st === s ? 'on' : ''}">${s === 'all' ? 'All' : STATUS[s]} <small>${s === 'all' ? mine.length : counts[s] || 0}</small></button>`).join('')}</div>
      <div id="qlist" class="qlist"></div>`;
    $('#qq', main).addEventListener('input', debounce(e => { QF.q = e.target.value; draw(); }, 150));
    $('.chips', main).addEventListener('click', e => { const b = e.target.closest('[data-st]'); if (!b) return; QF.st = b.dataset.st; viewQuotes(main); });
    $('[data-new]', main).addEventListener('click', async () => {
      if (draft && (draft.lines.length || draft.customer) && !(await ask('Start a new quote? The quote you are working on will be cleared.', 'Start new'))) return;
      draft = blankDraft(); saveDraft(); location.hash = 'quote';
    });
    draw();
  }
  function zohoBadge(q) {
    const s = q.zoho.status;
    return s === 'synced' ? '<span class="zs ok">Zoho ✓</span>' : s === 'failed' ? '<span class="zs err">Zoho failed</span>' : s === 'pending' ? '<span class="zs">Zoho…</span>' : '';
  }

  function viewQuoteDetail(main, id) {
    const q = Store.quote(id);
    if (!q || (!isAdmin() && q.createdBy !== ME.id)) { main.innerHTML = '<div class="empty">Quote not found. <a href="#quotes">Back to quotes</a></div>'; return; }
    const v = q.versions[q.versions.length - 1], st = effectiveStatus(q);
    const z = q.zoho;
    const zLink = z.dealId ? (Zoho.mode === 'mock' ? `<span class="meta">Demo CRM — deal ${esc(z.dealNo || z.dealId)}</span>` : `<a class="btn sm" target="_blank" rel="noopener" href="${esc(CFG.zohoDealUrl + z.dealId)}">Open in Zoho ↗</a>`) : '';
    const linesNow = v ? v.lines : pricedLines(q);
    main.innerHTML = `<p><a href="#quotes" class="link">← All quotes</a></p>
      <section class="card">
        <div class="card-hd"><div><h2>${esc(v ? v.no : 'Draft quote')} <span class="st st-${st}">${STATUS[st]}</span></h2>
          <p class="meta">${esc(q.customer ? q.customer.account.Account_Name : 'No customer')}${q.reference ? ' · ' + esc(q.reference) : ''} · by ${esc(q.createdByName)}</p></div>
          ${v ? `<div class="big-total"><small>Total incl. VAT</small><b>${php(v.totals.total)}</b></div>` : ''}</div>
        ${v ? `<div class="zbox zb-${z.status}"><div><b>Zoho CRM:</b> ${z.status === 'synced' ? `Synced · Deal ${esc(z.dealNo)}` : z.status === 'pending' ? 'Sending…' : z.status === 'failed' ? 'Failed' : 'Not sent'}
            ${z.error ? `<div class="err">${esc(z.error)}</div>` : ''}${z.lastAttempt ? `<small class="meta">Last attempt ${fmtTime(z.lastAttempt)}</small>` : ''}</div>
            <div class="row-btns">${zLink}${z.status === 'failed' ? '<button class="btn primary sm" data-act="retry">Retry</button>' : ''}</div></div>` : ''}
        <div class="row-btns">
          ${v ? `<button class="btn primary" data-act="pdf" data-v="${v.v}">Download PDF</button>` : ''}
          <button class="btn" data-act="revise">${v ? 'Revise (new version)' : 'Open in editor'}</button>
          ${isAdmin() && q.status === 'pending_approval' ? `<button class="btn primary" data-act="approveQ">Approve ${esc(q.margin)}% margin</button>` : ''}
          ${v && st !== 'won' ? '<button class="btn" data-act="won">Mark won</button>' : ''}${v && st !== 'lost' ? '<button class="btn" data-act="lost">Mark lost</button>' : ''}
          ${isAdmin() && v ? '<button class="btn" data-act="csv">Internal CSV</button>' : ''}
        </div>
      </section>
      ${v ? `<section class="card"><h2>Versions</h2><div class="vers">${q.versions.slice().reverse().map(x => `<div class="ver">
          <div><b>${esc(x.no)}</b><small>${fmtDate(x.date)} · valid until ${fmtDate(x.validUntil)} · ${x.mode === 'air' ? 'Air' : 'Sea'} · ${x.lines.length} lines · ${esc(x.byName || '')}${x.synced ? '' : ' · <span class="err">not in Zoho yet</span>'}</small></div>
          <b class="num">${php(x.totals.total)}</b><button class="btn sm" data-act="pdf" data-v="${x.v}">PDF</button></div>`).join('')}</div>
          <p class="hint">Issued versions are read-only, so you can always see exactly what the customer received.</p></section>` : ''}
      <section class="card"><h2>${v ? 'Lines in ' + esc(v.no) : 'Lines'}</h2>
        <div class="simple">${linesNow.map((l, i) => `<div><span>${i + 1}. <b>${esc(l.pn)}</b> ${esc(l.desc)}</span><span class="num">${l.qty} × ${php(l.unitSell)} = <b>${php(l.unitSell * l.qty)}</b></span></div>`).join('') || '<div class="meta">No lines.</div>'}</div></section>`;

    main.onclick = async e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const act = a.dataset.act, qq = Store.quote(id);
      if (act === 'pdf') showPdf(qq, qq.versions.find(x => x.v === +a.dataset.v));
      if (act === 'retry') syncZoho(id);
      if (act === 'won' || act === 'lost') { qq.status = act; Store.saveQuote(qq); viewQuoteDetail(main, id); toast(`Marked ${act}. Update the Stage in Zoho too.`); }
      if (act === 'csv') exportCsv(qq, v.lines, v.no);
      if (act === 'approveQ') {
        qq.approval = { margin: +qq.margin, by: ME.name, title: ME.title, at: Store.now() };
        qq.status = qq.versions.length ? 'issued' : 'draft'; qq.approvalRequest = null; Store.saveQuote(qq);
        toast('Approved. The rep can now generate the proposal.', 'ok'); viewQuoteDetail(main, id);
      }
      if (act === 'revise') {
        if (draft && (draft.lines.length || draft.customer) && draft.id !== id && !(await ask('Open this quote in the editor? The quote you are working on will be cleared.', 'Open'))) return;
        draft = { id: qq.id, customer: clone(qq.customer), reference: qq.reference, model: qq.model, margin: qq.margin, lines: clone(qq.lines), deal: clone(qq.deal), approval: qq.approval ? clone(qq.approval) : null };
        saveDraft(); location.hash = 'quote';
      }
    };
  }

  /* ================= ADMIN: COSTING ================= */
  function viewCosting(main, W0) {
    const W = W0 || clone(S);
    const n = (path, label, opts = {}) => {
      const v = path.split('.').reduce((o, k) => o[k], W);
      return `<label>${label}<span class="inp ${opts.suf ? 'suf' : ''}"><input type="number" step="${opts.step || 'any'}" data-s="${path}" value="${esc(v)}" inputmode="decimal">${opts.suf ? `<em>${opts.suf}</em>` : ''}</span></label>`;
    };
    const basis = m => `<label>Basis<select data-s="${m}.basis"><option value="pct" ${W[m].basis === 'pct' ? 'selected' : ''}>% of value</option><option value="kg" ${W[m].basis === 'kg' ? 'selected' : ''}>USD per kg</option></select></label>`;
    const hist = Store.settingsHistory().slice().reverse().slice(0, 8);
    main.innerHTML = `<div class="card-hd"><h2>Costing setup</h2><span class="meta">Every price in the tool comes from these settings. Saving applies to all users.</span></div>
    <div class="cgrid">
      <section class="card"><h3>Forex</h3><div class="form grid2">${n('fx', 'Rate (PHP per USD)', { step: '0.01' })}${n('fxBuf', 'Buffer (PHP per USD)', { step: '0.01' })}</div>
        <p class="meta" id="fxEff"></p></section>
      <section class="card"><h3>Sea freight</h3><div class="form grid3">${basis('sea')}${n('sea.US.pct', 'US', { suf: '%' })}${n('sea.CN.pct', 'China', { suf: '%' })}<span></span>${n('sea.US.kg', 'US', { suf: '$/kg' })}${n('sea.CN.kg', 'China', { suf: '$/kg' })}</div></section>
      <section class="card"><h3>Air freight</h3><div class="form grid3">${basis('air')}${n('air.US.pct', 'US', { suf: '%' })}${n('air.CN.pct', 'China', { suf: '%' })}<span></span>${n('air.US.kg', 'US', { suf: '$/kg' })}${n('air.CN.kg', 'China', { suf: '$/kg' })}</div>
        <label class="chk"><input type="checkbox" data-s="airNotBelowSea" ${W.airNotBelowSea ? 'checked' : ''}> Never price air freight below sea freight</label></section>
      <section class="card"><h3>Duties &amp; charges</h3><div class="form grid3">${n('ins', 'Insurance (of buy + freight)', { suf: '%' })}${n('duty', 'Duty (of CIF)', { suf: '%' })}${n('broker', 'Brokerage, arrastre & port', { suf: '%' })}
        ${n('cnFee', 'China origin fee', { suf: '%' })}${n('misc', 'Contingency', { suf: '%' })}</div>
        <label class="chk"><input type="checkbox" data-s="vatCost" ${W.vatCost ? 'checked' : ''}> Count 12% import VAT as cost (off = creditable input VAT)</label></section>
      <section class="card"><h3>Pricing</h3><div class="form grid3">${n('margin', 'Standard margin', { suf: '%' })}${n('minMargin', 'Minimum margin', { suf: '%' })}${n('round', 'Round up to (PHP)', { step: '1' })}</div>
        <label class="chk"><input type="checkbox" data-s="salesSeeCosts" ${W.salesSeeCosts ? 'checked' : ''}> Sales can see dealer cost, landed cost and gross profit</label></section>
      <section class="card preview"><h3>Live preview</h3><p class="meta">Sample part: USD 100 dealer cost, 2 kg, US origin, standard margin.</p><div id="pv"></div></section>
      <section class="card span-all"><h3>Default weight by category (kg)</h3><p class="meta">Used for per-kg freight when a part has no weight of its own. Set per-part weights in Parts data.</p>
        <div class="form grid4">${Object.keys(W.kg).filter(c => c !== 'Not on price list').map(c => `<label>${esc(c)}<input type="number" step="any" min="0" data-kg="${esc(c)}" value="${W.kg[c]}" inputmode="decimal"></label>`).join('')}</div></section>
      <section class="card span-all"><h3>Proposal</h3><div class="form grid3">
        ${n('validityDays', 'Validity (days)', { step: '1' })}<label>Sea lead time<input data-t="leadSea" value="${esc(W.leadSea)}"></label><label>Air lead time<input data-t="leadAir" value="${esc(W.leadAir)}"></label>
        <label>Brand name<input data-t="company.brand" value="${esc(W.company.brand)}"></label><label>Legal name<input data-t="company.legal" value="${esc(W.company.legal)}"></label><label>TIN<input data-t="company.tin" value="${esc(W.company.tin)}"></label>
        <label class="span2">Address<input data-t="company.address" value="${esc(W.company.address)}"></label><label>Phone<input data-t="company.phone" value="${esc(W.company.phone)}"></label>
        <label>Email<input data-t="company.email" value="${esc(W.company.email)}"></label>
        <label class="span-all">Terms &amp; conditions <small class="meta">One per line. {validity} becomes the validity days.</small><textarea data-t="terms" rows="7">${esc(W.terms)}</textarea></label></div></section>
    </div>
    <div class="savebar"><button class="btn primary lg" id="saveS">Save costing</button><button class="btn ghost" id="resetS">Reset to defaults</button><span class="meta" id="dirty"></span></div>
    <section class="card"><h3>Change history</h3>${hist.length ? `<div class="simple">${hist.map((h, i) => {
      const prev = Store.settingsHistory()[Store.settingsHistory().length - 2 - i];
      return `<div><span>${fmtTime(h.created_at)} · <b>${esc(h.created_by || '—')}</b></span><span class="meta">${esc(diff(prev ? prev.values : P.DEFAULT_SETTINGS, h.values) || 'no changes')}</span></div>`;
    }).join('')}</div>` : '<p class="meta">Using the built-in defaults. Nothing saved yet.</p>'}</section>`;

    const setPath = (path, val) => { const ks = path.split('.'); let o = W; ks.slice(0, -1).forEach(k => o = o[k]); o[ks[ks.length - 1]] = val; };
    const preview = () => {
      $('#fxEff', main).textContent = `Effective rate ${php(P.effectiveFx(W))} per USD`;
      $('#pv', main).innerHTML = ['sea', 'air'].map(m => {
        const b = P.price({ dealerUsd: 100, origin: 'US', kg: 2 }, W, { mode: m });
        return `<div class="pvrow"><b>${m === 'sea' ? 'Sea' : 'Air'}</b><span>Landed ${php(b.landed)}</span><span class="sell">${php(b.sell)}</span><small>${php(b.sellIncVat)} inc-VAT</small>${stack(b)}</div>`;
      }).join('');
      $('#dirty', main).textContent = JSON.stringify(W) !== JSON.stringify(S) ? 'Unsaved changes' : '';
    };
    main.oninput = e => {
      const t = e.target;
      if (t.dataset.s) setPath(t.dataset.s, t.type === 'checkbox' ? t.checked : t.tagName === 'SELECT' ? t.value : (t.value === '' ? 0 : +t.value));
      else if (t.dataset.kg) W.kg[t.dataset.kg] = +t.value || 0;
      else if (t.dataset.t) setPath(t.dataset.t, t.value);
      else return;
      preview();
    };
    main.onchange = e => { if (e.target.matches('select[data-s],input[type=checkbox][data-s]')) { setPath(e.target.dataset.s, e.target.type === 'checkbox' ? e.target.checked : e.target.value); preview(); } };
    $('#saveS', main).addEventListener('click', () => {
      if (+W.margin >= 90 || +W.minMargin >= 90) return toast('Margins must be below 90%.', 'warn');
      if (+W.fx <= 0) return toast('Forex rate must be above zero.', 'warn');
      Store.saveSettings(W, ME); S = P.normalize(W); renderHeader(); toast('Costing saved. All prices updated.', 'ok'); viewCosting(main);
    });
    $('#resetS', main).addEventListener('click', async () => { if (await ask('Reset every costing setting to the defaults? Nothing changes until you press Save.', 'Reset')) viewCosting(main, P.normalize(null)); });
    preview();
  }
  function diff(a, b, pre = '') {
    const out = [];
    Object.keys(b || {}).forEach(k => {
      if (k === 'terms') { if (a && a.terms !== b.terms) out.push('terms text'); return; }
      const va = a ? a[k] : undefined, vb = b[k];
      if (vb && typeof vb === 'object' && !Array.isArray(vb)) { const d = diff(va || {}, vb, pre + k + '.'); if (d) out.push(d); }
      else if (JSON.stringify(va) !== JSON.stringify(vb)) out.push(`${pre}${k} ${va} → ${vb}`);
    });
    return out.join(', ');
  }

  /* ================= ADMIN: USERS ================= */
  function viewUsers(main) {
    const users = Store.users();
    main.innerHTML = `<div class="card-hd"><h2>Users &amp; access</h2><button class="btn primary sm" data-act="add">Add user</button></div>
      <p class="meta">Sales: find parts, build quotes, generate proposals. Admin: everything, plus costing, users, parts data and approvals.</p>
      <div class="ulist">${users.map(u => `<div class="urow ${u.active ? '' : 'off'}">
        <div><b>${esc(u.name)}</b> <span class="role ${u.role}">${u.role === 'admin' ? 'Admin' : 'Sales'}</span>${u.active ? '' : ' <span class="st st-lost">Deactivated</span>'}
          <small>${esc(u.email)} · ${esc(u.title || '')}${u.office ? ' · ' + esc(u.office) : ''}${u.zohoUserId ? ' · Zoho ' + esc(u.zohoUserId) : ''}</small></div>
        <div class="row-btns"><button class="btn sm" data-edit="${u.id}">Edit</button><button class="btn sm" data-pw="${u.id}">Password</button>
          ${u.id !== ME.id ? `<button class="btn sm ghost" data-toggle="${u.id}">${u.active ? 'Deactivate' : 'Reactivate'}</button>` : ''}</div></div>`).join('')}</div>`;
    main.onclick = async e => {
      const t = e.target;
      if (t.closest('[data-act="add"]')) editUser(null, main);
      if (t.dataset.edit) editUser(t.dataset.edit, main);
      if (t.dataset.pw) changePassword(t.dataset.pw, t.dataset.pw === ME.id);
      if (t.dataset.toggle) {
        const us = Store.users(), u = us.find(x => x.id === t.dataset.toggle);
        if (u.active && u.role === 'admin' && us.filter(x => x.role === 'admin' && x.active).length < 2) return toast('Keep at least one active admin.', 'warn');
        t.disabled = true;
        try { await Store.setActive(u.id, !u.active); viewUsers(main); }
        catch (err) { t.disabled = false; toast(err.message, 'err'); }
      }
    };
  }
  function editUser(id, main) {
    const u = id ? Store.users().find(x => x.id === id) : { name: '', email: '', role: 'sales', title: 'Service Executive', mobile: '', office: 'SJK Manila', zohoUserId: '' };
    const body = modal(id ? 'Edit user' : 'Add user', `<form class="form" id="uf">
      <label>Full name *<input name="name" required value="${esc(u.name)}"></label>
      <label>Email *<input name="email" type="email" required value="${esc(u.email)}"><small class="meta">Matches the rep to their Zoho user (Deal Owner).</small></label>
      <label>Role<select name="role"><option value="sales" ${u.role === 'sales' ? 'selected' : ''}>Sales</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></label>
      <label>Title<input name="title" value="${esc(u.title || '')}"></label><label>Mobile<input name="mobile" value="${esc(u.mobile || '')}" inputmode="tel"></label>
      <label>Default office<select name="office">${PICK.SJK_Office_Location.map(o => `<option ${u.office === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
      <label>Zoho user ID <small class="meta">optional</small><input name="zohoUserId" value="${esc(u.zohoUserId || '')}"></label>
      ${id ? '' : '<label>Temporary password *<input name="pw" type="text" minlength="8" required></label>'}
      <p class="err" id="ufErr"></p><button class="btn primary">${id ? 'Save' : 'Add user'}</button></form>`);
    $('#uf', body).addEventListener('submit', async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target)), us = Store.users();
      if (us.some(x => x.email.toLowerCase() === f.email.toLowerCase() && x.id !== id)) return $('#ufErr', body).textContent = 'That email is already used.';
      if (id && u.role === 'admin' && f.role !== 'admin' && us.filter(x => x.role === 'admin' && x.active).length < 2) return $('#ufErr', body).textContent = 'Keep at least one admin.';
      const fields = { name: f.name, email: f.email.trim(), role: f.role, title: f.title, mobile: f.mobile, office: f.office, zohoUserId: f.zohoUserId };
      const btn = $('button.primary', body); btn.disabled = true;
      try { if (id) await Store.updateUser(id, fields); else await Store.createUser(fields, f.pw); }
      catch (err) { btn.disabled = false; return $('#ufErr', body).textContent = err.message; }
      if (id === ME.id) { ME = Store.users().find(x => x.id === id) || ME; renderHeader(); }
      closeModal(); viewUsers(main); toast('User saved', 'ok');
    });
  }

  /* ================= ADMIN: PARTS DATA ================= */
  function viewParts(main) {
    const cov = D.models.map((m, i) => { let p = 0, u = 0; D.rows.forEach(r => { if (r[6].includes(i)) r[2] == null ? u++ : p++; }); return { m: m[0], p, u }; });
    const priced = D.rows.filter(r => r[2] != null).length;
    const edited = Object.keys(EDITS);
    main.innerHTML = `<div class="card-hd"><h2>Parts data</h2><span class="meta">Dataset ${esc(D.v)} · ${D.rows.length.toLocaleString()} parts · ${priced.toLocaleString()} priced${Store.dataset() ? ' · <b>custom import</b>' : ''}</span></div>
    <div class="cgrid">
      <section class="card"><h3>Edit a part</h3><p class="meta">Weight, category, dangerous-goods flag and notes. Changes apply to new quotes straight away.</p>
        <div class="searchbar"><input id="pe" placeholder="Part number, e.g. 47786510001" autocomplete="off"><button class="btn" id="peGo">Open</button></div><div id="peBox"></div>
        ${edited.length ? `<h4>Edited parts (${edited.length})</h4><div class="chips">${edited.map(pn => `<button data-open="${esc(pn)}">${esc(pn)}</button>`).join('')}</div>` : ''}</section>
      <section class="card"><h3>Load a new price list</h3>
        <p class="meta">Run <code>scripts/ingest.py</code> on Club Car's new price PDFs, then load the <code>parts_data.json</code> it makes. You'll see what changed before publishing.</p>
        <label class="lbl">Flag price changes over<span class="inp suf"><input type="number" id="thr" value="10" min="0"><em>%</em></span></label>
        <input type="file" id="imp" accept=".json,application/json">
        <div id="impBox"></div>
        ${Store.dataset() ? '<button class="btn ghost sm" id="revert">Go back to the bundled dataset</button>' : ''}</section>
      <section class="card span-all"><h3>Coverage by model</h3><div class="cov">${cov.map(c => `<div><span>${esc(c.m)}</span><div class="bar"><i style="width:${(c.p / Math.max(1, c.p + c.u) * 100).toFixed(1)}%"></i></div><small>${c.p} priced · ${c.u} not priced</small></div>`).join('')}</div></section>
    </div>`;
    const open = pn => {
      const p = part(pn.trim());
      const box = $('#peBox', main);
      if (!p) { box.innerHTML = '<p class="err">Part not found.</p>'; return; }
      const ed = EDITS[p.pn] || {};
      box.innerHTML = `<form class="form grid2" id="pef"><p class="span-all"><b>${esc(p.pn)}</b> ${esc(p.desc)}<br><small class="meta">${usd(p.dealer)} · ${p.origin} · fits ${esc(fitsShort(p.models))}</small></p>
        <label>Weight kg <small class="meta">blank = category default ${S.kg[D.cats[p.catIdx]] ?? 1}</small><input name="kg" type="number" step="any" min="0" value="${ed.kg ?? ''}"></label>
        <label>Category<select name="cat"><option value="">Auto: ${esc(D.cats[D.rows[p.i][5]])}</option>${D.cats.map((c, i) => `<option value="${i}" ${ed.cat != null && +ed.cat === i ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="chk span-all"><input type="checkbox" name="hazmat" ${p.hazmat ? 'checked' : ''}> Dangerous goods (blocks air freight)</label>
        <label class="span-all">Notes<input name="notes" value="${esc(ed.notes || '')}"></label>
        <div class="row-btns span-all"><button class="btn primary">Save part</button>${EDITS[p.pn] ? '<button class="btn ghost" type="button" id="peClr">Clear edits</button>' : ''}</div></form>`;
      $('#pef', box).addEventListener('submit', e => {
        e.preventDefault(); const f = e.target;
        const autoHaz = HAZMAT_PNS.includes(p.pn) || /LITHIUM/i.test(p.desc);
        Store.savePartEdit(p.pn, { kg: f.kg.value === '' ? null : +f.kg.value, cat: f.cat.value === '' ? null : +f.cat.value,
          hazmat: f.hazmat.checked === autoHaz ? null : f.hazmat.checked, notes: f.notes.value.trim() });
        EDITS = Store.partEdits(); toast('Part saved', 'ok'); viewParts(main); open(p.pn);
      });
      const clr = $('#peClr', box); if (clr) clr.addEventListener('click', () => { Store.savePartEdit(p.pn, {}); EDITS = Store.partEdits(); viewParts(main); open(p.pn); });
    };
    $('#peGo', main).addEventListener('click', () => open($('#pe', main).value));
    $('#pe', main).addEventListener('keydown', e => { if (e.key === 'Enter') open(e.target.value); });
    main.onclick = e => { const b = e.target.closest('[data-open]'); if (b) { $('#pe', main).value = b.dataset.open; open(b.dataset.open); } };
    const rv = $('#revert', main); if (rv) rv.addEventListener('click', async () => {
      if (!await ask(`Go back to the bundled dataset? The imported price list will be switched off${Store.backend === 'supabase' ? ' for everyone' : ' in this browser'}.`, 'Go back')) return;
      try { await Store.clearDataset(); location.reload(); } catch (err) { toast(err.message, 'err'); }
    });

    $('#imp', main).addEventListener('change', async e => {
      const file = e.target.files[0]; if (!file) return;
      const box = $('#impBox', main);
      try {
        const N = JSON.parse(await file.text());
        if (!N.rows || !N.models || !N.cats) throw new Error('This is not a parts_data.json file.');
        const thr = +$('#thr', main).value || 10;
        const oldBy = {}; D.rows.forEach(r => oldBy[r[0]] = r);
        const newBy = {}; N.rows.forEach(r => newBy[r[0]] = r);
        const added = N.rows.filter(r => !oldBy[r[0]]), removed = D.rows.filter(r => !newBy[r[0]]);
        const changed = N.rows.filter(r => { const o = oldBy[r[0]]; return o && o[2] != null && r[2] != null && Math.abs(r[2] - o[2]) / o[2] * 100 > thr; });
        const newlyPriced = N.rows.filter(r => oldBy[r[0]] && oldBy[r[0]][2] == null && r[2] != null).length;
        const lostPrice = N.rows.filter(r => oldBy[r[0]] && oldBy[r[0]][2] != null && r[2] == null).length;
        box.innerHTML = `<div class="diff"><p><b>${esc(file.name)}</b> · dataset ${esc(N.v || '?')} · ${N.rows.length.toLocaleString()} parts</p>
          <ul><li><b>${added.length}</b> new parts</li><li><b>${removed.length}</b> removed parts</li><li><b>${changed.length}</b> price changes over ±${thr}%</li>
          <li><b>${newlyPriced}</b> newly priced · <b>${lostPrice}</b> lost their price</li></ul>
          ${changed.length ? `<details><summary>Show price changes</summary><div class="simple">${changed.slice(0, 200).map(r => `<div><span>${esc(r[0])} ${esc(r[1])}</span><span class="num">${usd(oldBy[r[0]][2])} → ${usd(r[2])}</span></div>`).join('')}</div></details>` : ''}
          <button class="btn primary" id="pub">Publish this price list</button>
          <p class="hint">${Store.backend === 'supabase' ? 'Publishing makes this the live price list for everyone. Earlier lists are kept in the database. Issued quotes keep the prices they were issued with.' : 'Published in this browser only (demo mode).'}</p></div>`;
        $('#pub', box).addEventListener('click', async e => {
          e.target.disabled = true;
          try { await Store.publishDataset(N); toast('Price list published', 'ok'); setTimeout(() => location.reload(), 600); }
          catch (err) { e.target.disabled = false; toast(err.message, 'err'); }
        });
      } catch (err) { box.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    });
  }

  /* ================= ADMIN: ZOHO ================= */
  function viewZoho(main) {
    const log = Store.zohoLog().slice(0, 40);
    main.innerHTML = `<div class="card-hd"><h2>Zoho CRM</h2></div>
    <div class="cgrid">
      <section class="card"><h3>Connection</h3>
        <p>Mode: <b>${Zoho.mode === 'mock' ? 'Demo CRM (in this browser)' : 'Backend API'}</b></p>
        ${Zoho.mode === 'mock' ? `<p class="meta">Nothing is sent to the real Zoho. Deals get demo numbers (GC-07700 onward). Switch <code>zohoMode</code> to <code>'api'</code> in <code>js/config.js</code> once the backend is ready.</p>
          <label class="chk"><input type="checkbox" id="outage" ${Zoho.outage() ? 'checked' : ''}> Simulate Zoho outage (acceptance test 5)</label>
          <p class="meta">Demo deals: ${Zoho.dealCount()}</p><button class="btn ghost sm" id="resetCrm">Reset demo CRM</button>`
        : `<p class="meta">API base: <code>${esc(CFG.apiBase)}</code></p>`}</section>
      <section class="card"><h3>Deal settings</h3><dl class="facts">
        <div><dt>Pipeline</dt><dd>Spare Parts</dd></div><div><dt>Layout</dt><dd>Service Layout New (4983915000040429371)</dd></div>
        <div><dt>Stage on create</dt><dd>Proposal/Price Quote</dd></div><div><dt>Amount</dt><dd>VAT-inclusive total</dd></div>
        <div><dt>Closing date</dt><dd>Valid-until (${S.validityDays} days)</dd></div><div><dt>Revisions</dt><dd>Update the same deal; add PDF + note</dd></div></dl></section>
      <section class="card span-all"><h3>Recent requests</h3>${log.length ? `<div class="simple">${log.map(l => `<div><span>${fmtTime(l.at)} · <b>${esc(l.op)}</b></span><span class="${l.ok ? 'okc' : 'err'}">${l.ok ? 'OK' : esc(l.error)}</span></div>`).join('')}</div>` : '<p class="meta">No requests yet.</p>'}</section>
    </div>`;
    const o = $('#outage', main); if (o) o.addEventListener('change', () => { Zoho.setOutage(o.checked); toast(o.checked ? 'Zoho outage simulated' : 'Zoho back online'); });
    const r = $('#resetCrm', main); if (r) r.addEventListener('click', async () => { if (await ask('Reset the demo CRM? Demo deals created so far will be removed.', 'Reset')) { Zoho.reset(); viewZoho(main); } });
  }

  /* ================= boot ================= */
  async function start() {
    $('#login').hidden = true; $('#app').hidden = false;
    // Shared data is only readable after sign-in (database mode), so pick it up now.
    S = P.normalize((Store.liveSettings() || {}).values);
    EDITS = Store.partEdits();
    const ds = Store.dataset(); if (ds && ds !== D) { D = ds; indexData(); }
    if (draft && !draft.deal) draft.deal = blankDeal();
    renderHeader(); updateCount();
    try { PICK = Object.assign(PICK, await Zoho.picklists()); } catch (e) { /* keep defaults */ }
    if (!location.hash) location.hash = 'find'; else route();
  }

  /* Database mode: saves that fail, and changes other people make while this screen is open. */
  window.addEventListener('store:error', e => toast(`Not saved to the database (${e.detail.what}): ${e.detail.message}`, 'err'));
  window.addEventListener('store:change', e => {
    if (!ME) return;
    const what = e.detail.what, view = location.hash.slice(1) || 'find';
    if (what === 'deactivated') { toast('Your account was deactivated.', 'err'); setTimeout(async () => { await Store.logout(); location.reload(); }, 1500); return; }
    if (what === 'settings') {
      S = P.normalize((Store.liveSettings() || {}).values); renderHeader();
      toast(`Costing updated${e.detail.by ? ' by ' + e.detail.by : ''}. Prices refreshed.`);
      if (view === 'find' || view === 'quote') route();   // the costing screen keeps any unsaved edits
    }
    if (what === 'edits') { EDITS = Store.partEdits(); if (view === 'find') route(); }
    if (what === 'dataset') toast('A new price list was published. Reload the page to use it.', 'warn');
    if (what === 'quotes' && (view === 'quotes' || view.startsWith('q-'))) route();
    if (what === 'users' && view === 'users') route();
  });
  if (Store.backend === 'supabase') { const h = $('#login .hint'); if (h) h.remove(); }

  try { D = await loadData(); indexData(); }
  catch (err) { $('#loading').innerHTML = `<p class="err">${esc(err.message)}</p><p class="meta">Open this folder through a web server (e.g. <code>python3 -m http.server</code>), not as a file.</p>`; return; }
  $('#loading').remove();
  ME = await Store.currentUser();
  if (ME) start(); else $('#login').hidden = false;
})();
