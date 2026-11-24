/* SJK Parts Quoting Tool — customer PDF proposal (SPEC §8).
 * Builds a self-contained A4 HTML document. The browser's "Save as PDF" turns it into the PDF;
 * a backend can feed the same HTML to headless Chrome / Playwright for identical server-side output.
 * Rule (§8.4): never prints dealer cost, landed cost, margin, freight or duty.
 */
(function () {
  'use strict';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = v => (+v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const cssStr = t => String(t).replace(/[\\"<>]/g, '');
  const titleCase = s => String(s || '').toLowerCase().replace(/(^|[\s\-\/(,])([a-z])/g, (m, a, b) => a + b.toUpperCase());

  /* Matches proposal/Sample Proposal - SP-GC-07680-v1.pdf: Inter, the handoff template's spacing,
     footer "<brand> · <company>" left and "<proposal no> · page x of y" right. */
  const FONT = 'Inter,"Segoe UI",system-ui,-apple-system,Roboto,sans-serif';
  const CSS = `
@page{size:A4;margin:14mm 15mm 16mm;
  @bottom-left{content:"__FTLEFT__";font:6.5pt ${FONT};color:#56676f;vertical-align:middle}
  @bottom-right{content:"__FTRIGHT__ · page " counter(page) " of " counter(pages);font:6.5pt ${FONT};color:#56676f;vertical-align:middle}}
*{box-sizing:border-box}
body{font:9.5pt/1.45 ${FONT};color:#13242e;margin:0;background:#fff;-webkit-font-smoothing:antialiased}
.sheet{max-width:180mm;margin:0 auto;padding:0}
.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #13242e;padding-bottom:4mm}
.brand b{display:block;font-size:20pt;font-weight:800;line-height:1}.brand span{font-size:8.5pt;color:#56676f}
.doc{text-align:right}.doc h1{font-size:15pt;margin:0 0 1mm;font-weight:800;white-space:nowrap}.doc div{font-size:9pt}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:6mm;margin:4mm 0}
.box{background:#f2f5f2;border-radius:4px;padding:3mm 4mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.box h3{font-size:8pt;color:#56676f;margin:0 0 1mm;font-weight:600;letter-spacing:.02em}.box p{margin:0}
table{width:100%;border-collapse:collapse;margin-top:2mm}
thead{display:table-header-group}
th{background:#13242e;color:#fff;font-size:8.5pt;text-align:left;padding:2mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}
td{padding:2mm;border-bottom:1px solid #dcdfd2;vertical-align:top}tr{page-break-inside:avoid}
.c{text-align:center}.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.pn{font-weight:600;white-space:nowrap}.fit{font-size:7.5pt;color:#56676f}
.tot{width:80mm;margin:3mm 0 0 auto}.tot td{border:0;padding:1.2mm 2mm}.tot tr.g td{border-top:2px solid #13242e;font-weight:800;font-size:11pt}
h4{font-size:10pt;margin:5mm 0 1.5mm}ol{margin:0;padding-left:5mm;font-size:8.5pt}li{margin:.6mm 0}
.sig{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8mm;margin-top:9mm;font-size:8.5pt;page-break-inside:avoid}
.sig div{border-top:1px solid #13242e;padding-top:1.5mm}.sig b{display:block}.sig .muted{color:#9aa5aa}
.ft{display:none}
@media screen{body{background:#e9ece6;padding:8mm 0}.sheet{background:#fff;padding:14mm 15mm;box-shadow:0 2px 12px rgba(0,0,0,.12);max-width:210mm}
  .ft{display:flex;justify-content:space-between;font-size:7.5pt;color:#56676f;margin-top:8mm;border-top:1px solid #dcdfd2;padding-top:2mm}}
body.capture{background:#fff!important;padding:0!important}.capture .sheet{box-shadow:none!important;padding:14mm 15mm 6mm!important;max-width:none!important;width:210mm}.capture .ft{display:none!important}
@media screen and (max-width:700px){body{padding:0}.sheet{padding:6mm;box-shadow:none}.meta,.sig{grid-template-columns:1fr}.doc h1{font-size:12pt}.hd{flex-direction:column}.doc{text-align:left}}
`;

  /**
   * @param {object} q    quote record
   * @param {object} ver  issued version {no, date, validUntil, lines, totals, mode, approval}
   * @param {object} s    settings
   * @param {object} rep  user who prepared it
   */
  function render(q, ver, s, rep) {
    const co = s.company || {};
    const cust = q.customer || {};
    const acct = cust.account || {}, ct = cust.contact || null;
    const lead = ver.mode === 'air' ? s.leadAir : s.leadSea;
    const terms = String(s.terms || '').replace(/\{validity\}/g, s.validityDays).split('\n').map(t => t.trim()).filter(Boolean);
    const contactLine = ct ? `Attn: ${esc([ct.First_Name, ct.Last_Name].filter(Boolean).join(' '))}${ct.Title ? ', ' + esc(ct.Title) : ''}<br>` : '';
    const addr = [q.deal && q.deal.Street || acct.Billing_Street, q.deal && q.deal.City || acct.Billing_City].filter(Boolean).map(esc).join(', ');
    const reach = ct ? [ct.Email, ct.Mobile || acct.Phone].filter(Boolean).map(esc).join(' · ') : esc(acct.Phone || '');
    const coLine = [co.legal, co.address, co.phone, co.email, co.tin ? 'TIN ' + co.tin : ''].filter(Boolean).map(esc).join(' · ');

    const rows = ver.lines.map((l, i) => `<tr><td class="c">${i + 1}</td><td class="pn">${esc(l.pn)}</td>
      <td>${esc(titleCase(l.desc))}${l.fits ? `<div class="fit">Fits: ${esc(l.fits)}</div>` : ''}</td>
      <td class="c">${l.qty}</td><td class="n">${money(l.unitSell)}</td><td class="n">${money(l.unitSell * l.qty)}</td></tr>`).join('');

    const t = ver.totals;
    const approved = ver.approval
      ? `<b>Approved by</b>${esc(ver.approval.by)}<br>${esc(ver.approval.title || '')}${ver.approval.at ? ' · ' + esc(fmtDate(ver.approval.at.slice(0, 10))) : ''}`
      : `<b>Approved by</b>(required only when margin is below the minimum)`;

    const title = fileName(q, ver).replace(/\.pdf$/, '');
    const ft = footer(s, ver);
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<title>${esc(title)}</title><style>${CSS.replace('__FTLEFT__', cssStr(ft.left)).replace('__FTRIGHT__', cssStr(ft.right))}</style></head><body><div class="sheet">
<div class="hd"><div class="brand"><b>${esc(co.brand || 'Golf Carts PH')}</b><span>${coLine}</span></div>
<div class="doc"><h1>SPARE PARTS PROPOSAL</h1><div>No. <b>${esc(ver.no)}</b></div>
<div>Date: ${fmtDate(ver.date)} · Valid until: ${fmtDate(ver.validUntil)}</div>${q.zoho && q.zoho.dealNo ? `<div>Zoho Deal: ${esc(q.zoho.dealNo)}</div>` : ''}</div></div>
<div class="meta"><div class="box"><h3>PREPARED FOR</h3><p><b>${esc(acct.Account_Name || '')}</b><br>${contactLine}${addr}${addr ? '<br>' : ''}${reach}</p></div>
<div class="box"><h3>REFERENCE</h3><p><b>${esc(q.reference || '—')}</b><br>Cart model: ${esc(q.model ? 'Club Car ' + q.model : 'Various')}<br>
Shipment: <b>${ver.mode === 'air' ? 'Air freight' : 'Sea freight'}</b>${lead ? ', ' + esc(lead) : ''}<br>Prepared by: ${esc(rep ? rep.name : '')}${rep && rep.title ? ', ' + esc(rep.title) : ''}</p></div></div>
<table><thead><tr><th class="c" style="width:7%">#</th><th style="width:16%">Part no.</th><th>Description</th><th class="c" style="width:7%">Qty</th><th class="n" style="width:15%">Unit price (₱)</th><th class="n" style="width:16%">Amount (₱)</th></tr></thead>
<tbody>${rows}</tbody></table>
<table class="tot"><tr><td>Subtotal (VAT-exclusive)</td><td class="n">₱${money(t.sub)}</td></tr><tr><td>VAT 12%</td><td class="n">₱${money(t.vat)}</td></tr>
<tr class="g"><td>TOTAL (VAT-inclusive)</td><td class="n">₱${money(t.total)}</td></tr></table>
<h4>Terms &amp; conditions</h4><ol>${terms.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
<div class="sig"><div><b>Prepared by</b>${esc(rep ? rep.name : '')}<br>${esc([rep && rep.title, rep && rep.mobile, rep && rep.email].filter(Boolean).join(' · '))}</div>
<div>${approved}</div><div><b>Conforme</b>Customer signature over printed name / date</div></div>
<div class="ft"><span>${esc(ft.left)}</span><span>${esc(ft.right)} · page numbers appear in the PDF</span></div>
</div></body></html>`;
  }

  /* Footer text, shared by the HTML (@page boxes) and the in-browser PDF (pdf.js). */
  function footer(s, ver) {
    const co = (s && s.company) || {};
    return { left: co.footer || [co.brand, co.legal].filter(Boolean).join(' · '), right: ver.no };
  }

  function fileName(q, ver) {
    const acct = (q.customer && q.customer.account && q.customer.account.Account_Name) || 'Customer';
    return `${ver.no} - ${acct.replace(/[\\/:*?"<>|]/g, '')}.pdf`;
  }

  const api = { render, fileName, titleCase, footer };
  if (typeof module === 'object' && module.exports) module.exports = api;   // Node: scripts/render-proposal.js
  if (typeof window !== 'undefined') window.Proposal = api;
})();
