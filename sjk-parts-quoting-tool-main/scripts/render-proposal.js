#!/usr/bin/env node
/* Server-side proposal PDF (SPEC §8.4): same HTML as the app (js/proposal.js) printed by headless
 * Chrome/Edge, which is how proposal/Sample Proposal - SP-GC-07680-v1.pdf was made. Text is real,
 * selectable text, with "<company>" and "<no> · page x of y" in the footer of every page.
 *
 *   node scripts/render-proposal.js <input.json> [output.pdf]
 *
 * input.json = { quote, version, rep, settings? }  (see tests/fixtures/sample-proposal.json)
 * Browser: set CHROME_PATH, otherwise Chrome or Edge is looked up in the usual places.
 * The backend's POST /api/zoho/deals/:id/proposal can call render() below with the posted HTML.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Pricing = require('../js/pricing.js');
const Proposal = require('../js/proposal.js');

function findBrowser() {
  const c = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
  ].filter(Boolean);
  const hit = c.find(p => fs.existsSync(p));
  if (!hit) throw new Error('Chrome/Edge not found. Set CHROME_PATH.');
  return hit;
}

/** Render proposal HTML to a PDF file. */
function render(html, outPdf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sjk-proposal-'));
  const src = path.join(dir, 'proposal.html');
  fs.writeFileSync(src, html, 'utf8');
  try {
    execFileSync(findBrowser(), [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + path.join(dir, 'profile'),
      '--no-pdf-header-footer', '--virtual-time-budget=8000',   // give Google Fonts (Inter) time to load
      '--print-to-pdf=' + path.resolve(outPdf),
      'file:///' + src.replace(/\\/g, '/')
    ], { stdio: 'pipe', timeout: 60000 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!fs.existsSync(outPdf)) throw new Error('The browser did not write the PDF.');
  return outPdf;
}

if (require.main === module) {
  const [input, out] = process.argv.slice(2);
  if (!input) { console.error('Usage: node scripts/render-proposal.js <input.json> [output.pdf]'); process.exit(2); }
  const j = JSON.parse(fs.readFileSync(input, 'utf8'));
  const s = Pricing.normalize(j.settings || null);
  const html = Proposal.render(j.quote, j.version, s, j.rep);
  const file = out || Proposal.fileName(j.quote, j.version);
  render(html, file);
  console.log('Wrote', file);
}

module.exports = { render };
