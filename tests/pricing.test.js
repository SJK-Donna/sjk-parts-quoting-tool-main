// Run: node tests/pricing.test.js — checks SPEC §5.3 test cases (defaults, effective fx 65.00).
const P = require('../js/pricing.js');
const s = P.normalize(null);
const cases = [
  ['102505401 sea', {dealerUsd:75.10, origin:'US', kg:6},    'sea', 585.78, 6519.36, 10030, 11233.60],
  ['102505401 air', {dealerUsd:75.10, origin:'US', kg:6},    'air', 3510.00, 10006.30, 15395, 17242.40],
  ['1012571 sea',   {dealerUsd:0.54,  origin:'US', kg:0.05}, 'sea', 4.21, 46.88, 75, 84.00],
  ['1012571 air',   {dealerUsd:0.54,  origin:'US', kg:0.05}, 'air', 29.25, 76.73, 120, 134.40],
];
let fail = 0;
for (const [name, part, mode, fr, landed, sell, inc] of cases) {
  const b = P.price(part, s, {mode});
  const got = [P.r2(b.freight), b.landed, b.sell, b.sellIncVat], want = [fr, landed, sell, inc];
  const ok = got.every((v,i)=>Math.abs(v-want[i])<0.005);
  if (!ok) fail++;
  console.log((ok?'PASS':'FAIL'), name, 'got', got.join(' / '), ok?'':'want '+want.join(' / '));
}
if (P.price({dealerUsd:null}, s, {mode:'sea'}) !== null) { fail++; console.log('FAIL unpriced'); } else console.log('PASS unpriced → null');
process.exit(fail ? 1 : 0);
