/* SJK Parts Quoting Tool — costing formula (SPEC §5).
 * Pure functions, no DOM. Loaded in the browser as window.Pricing and in Node via require() for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pricing = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CATEGORY_KG = {
    'Accessories': 2, 'Batteries & Charging': 25, 'Body & Trim': 4, 'Brakes & Pedals': 1.5,
    'Canopy, Roof & Windshield': 8, 'Cargo Bed & Utility': 10, 'Decals & Labels': 0.05,
    'Drivetrain & Clutch': 4, 'Electrical & Controls': 0.8, 'Engine & Fuel': 1.5,
    'Frame & Chassis': 6, 'Hardware & Fasteners': 0.05, 'Lighting': 0.8, 'Not on price list': 1,
    'Other': 1, 'Seats & Restraints': 5, 'Shop Tools & Service': 2, 'Steering & Suspension': 3,
    'Wheels & Tires': 10
  };

  const DEFAULT_TERMS = [
    'Prices are in Philippine Pesos. Unit prices exclude VAT; the total includes 12% VAT.',
    'This proposal is valid for {validity} days. Prices are based on the exchange rate on the proposal date and may change after the validity date.',
    'Delivery: sea freight about 8–12 weeks, air freight about 2–3 weeks, from receipt of confirmed PO and payment. Subject to Club Car stock availability.',
    'Payment: full payment upon order confirmation unless otherwise agreed in writing.',
    'Parts are covered by the Club Car parts warranty. Wear-and-tear items and damage from improper installation are excluded.',
    'Installation and labour are not included unless listed above.'
  ].join('\n');

  /* Defaults from SPEC §5.2 (placeholders until James confirms). */
  const DEFAULT_SETTINGS = {
    fx: 64, fxBuf: 1,
    sea: { basis: 'pct', US: { pct: 12, kg: 2.5 }, CN: { pct: 10, kg: 1.2 } },
    air: { basis: 'kg', US: { pct: 30, kg: 9 }, CN: { pct: 22, kg: 5 } },
    ins: 0.5, duty: 10, broker: 3, cnFee: 3, misc: 5, vatCost: false,
    margin: 35, minMargin: 20, round: 5,
    airNotBelowSea: true,       // §5.4 guard: air freight never cheaper than sea for the same part
    kg: Object.assign({}, CATEGORY_KG),
    validityDays: 15,
    leadSea: 'est. 8–12 weeks', leadAir: 'est. 2–3 weeks',
    terms: DEFAULT_TERMS,
    salesSeeCosts: false,       // §12 Q1 — open decision; admin can switch on
    company: {
      brand: 'Golf Carts PH', legal: 'SJK GUAHAN INC.',
      address: '1877 Paz M. Guazon cor. Pres. Quirino Ave, Paco, Manila 1007',
      phone: '', email: '', tin: '',
      footer: 'Golf Carts PH · SJK Guahan Inc.'   // PDF footer, as on the sample proposal
    }
  };

  const clone = o => JSON.parse(JSON.stringify(o));
  const num = v => (v === '' || v == null || isNaN(+v)) ? 0 : +v;
  const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;

  /* Merge saved settings over defaults so new keys always exist. */
  function normalize(s) {
    const d = clone(DEFAULT_SETTINGS);
    if (!s) return d;
    const out = Object.assign(d, clone(s));
    ['sea', 'air'].forEach(m => {
      out[m] = Object.assign(clone(DEFAULT_SETTINGS[m]), s[m] || {});
      ['US', 'CN'].forEach(o => out[m][o] = Object.assign(clone(DEFAULT_SETTINGS[m][o]), (s[m] || {})[o] || {}));
    });
    out.kg = Object.assign(clone(CATEGORY_KG), s.kg || {});
    out.company = Object.assign(clone(DEFAULT_SETTINGS.company), s.company || {});
    return out;
  }

  function effectiveFx(s) { return num(s.fx) + num(s.fxBuf); }

  function freightUsd(s, mode, origin, buyUsd, kg) {
    const m = s[mode], o = m[origin];
    return m.basis === 'pct' ? buyUsd * num(o.pct) / 100 : kg * num(o.kg);
  }

  /**
   * Price one unit of a part.
   * @param {object} p   { dealerUsd, origin: 'US'|'CN', kg }
   * @param {object} s   settings (normalized)
   * @param {object} opt { mode: 'sea'|'air', margin: % }
   * @returns null when the part has no dealer cost ("Price on request").
   */
  function price(p, s, opt) {
    if (!p || p.dealerUsd == null) return null;
    const mode = opt && opt.mode === 'air' ? 'air' : 'sea';
    const margin = Math.min(Math.max(num(opt && opt.margin != null ? opt.margin : s.margin), 0), 90);
    const origin = p.origin === 'CN' ? 'CN' : 'US';
    const kg = num(p.kg);

    const buy = p.dealerUsd * (origin === 'CN' ? 1 + num(s.cnFee) / 100 : 1);
    let freight = freightUsd(s, mode, origin, buy, kg);
    let freightGuarded = false;
    if (mode === 'air' && s.airNotBelowSea) {
      const sea = freightUsd(s, 'sea', origin, buy, kg);
      if (sea > freight) { freight = sea; freightGuarded = true; }
    }
    const insurance = (buy + freight) * num(s.ins) / 100;
    const cif = buy + freight + insurance;
    const duty = cif * num(s.duty) / 100;
    const brokerage = cif * num(s.broker) / 100;
    const subtotal = cif + duty + brokerage;
    const contingency = subtotal * num(s.misc) / 100;
    const importVat = s.vatCost ? subtotal * 0.12 : 0;
    const landedUsd = subtotal + contingency + importVat;
    const fx = effectiveFx(s);
    const landed = landedUsd * fx;
    const raw = landed / (1 - margin / 100);
    const rd = num(s.round);
    // Round UP to the step; the small epsilon stops float noise pushing an exact multiple up a step.
    const sell = rd > 0 ? Math.ceil(r2(raw) / rd - 1e-9) * rd : r2(raw);

    return {
      mode, origin, kg, basis: s[mode].basis, freightGuarded, fx, margin,
      buy: buy * fx, freight: freight * fx, insurance: insurance * fx, duty: duty * fx,
      brokerage: brokerage * fx, contingency: contingency * fx, importVat: importVat * fx,
      landed: r2(landed), sell, sellIncVat: r2(sell * 1.12), gp: r2(sell - landed)
    };
  }

  /* Quote totals from already-priced lines: amount = unit × qty, no re-rounding (SPEC §8.4). */
  function totals(lines) {
    let landed = 0, sub = 0;
    lines.forEach(l => { landed += l.unitLanded * l.qty; sub += l.unitSell * l.qty; });
    sub = r2(sub); landed = r2(landed);
    const vat = r2(sub * 0.12);
    return { landed, sub, vat, total: r2(sub + vat), gp: r2(sub - landed), gpPct: sub ? (sub - landed) / sub * 100 : 0 };
  }

  return { CATEGORY_KG, DEFAULT_SETTINGS, DEFAULT_TERMS, normalize, price, totals, effectiveFx, r2 };
});
