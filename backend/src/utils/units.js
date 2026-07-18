/**
 * Unit conversion for Product Master price verification.
 * All money math stays here / SQL — never in the LLM.
 */

const UNIT_TO_BASE = {
  KG: { base: 'GM', factor: 1000 },
  GM: { base: 'GM', factor: 1 },
  L: { base: 'ML', factor: 1000 },
  ML: { base: 'ML', factor: 1 },
  PCS: { base: 'PCS', factor: 1 },
  PKT: { base: 'PCS', factor: 1 },
  BOX: { base: 'PCS', factor: 1 },
  BOTTLE: { base: 'PCS', factor: 1 },
  DOZEN: { base: 'PCS', factor: 12 },
};

function normalizeUnit(unit) {
  if (!unit) return null;
  const u = String(unit)
    .trim()
    .toUpperCase()
    .replace(/\./g, '');
  if (/^(KG|KILO|KILOS|કિલો)$/i.test(u) || /કિ/.test(String(unit))) return 'KG';
  if (/^(GM|G|GRAM|GRAMS|ગ્રા)/i.test(u) || /ગ્રા/.test(String(unit))) return 'GM';
  if (/^(L|LTR|LITRE|LITER|લીટર)/i.test(u)) return 'L';
  if (/^(ML|મિ)/i.test(u) || /મિ\.?\s*લી|મિલી/.test(String(unit))) return 'ML';
  if (/^(PCS|PC|PIECE|NOS|NOs|નં)/i.test(u)) return 'PCS';
  if (/^(PKT|PACKET)/i.test(u)) return 'PKT';
  if (/^BOX/i.test(u)) return 'BOX';
  if (/^BOTTLE/i.test(u)) return 'BOTTLE';
  if (/^DOZEN/i.test(u)) return 'DOZEN';
  if (UNIT_TO_BASE[u]) return u;
  return u;
}

/**
 * Parse weight_text like "500gm", "1 કિલો", "500 મિલી" → { quantity, unit }
 */
function parseQtyUnit(quantity, unit, weightText) {
  if (weightText) {
    const t = String(weightText).trim();
    const num = t.match(/(\d+(?:\.\d+)?)/);
    const q = num ? Number(num[1]) : null;
    const u = normalizeUnit(t.replace(/[\d.\s]+/, '')) || normalizeUnit(unit);
    if (q != null && u) return { quantity: q, unit: u };
  }
  const q = quantity != null ? Number(quantity) : null;
  const u = normalizeUnit(unit) || 'PCS';
  return {
    quantity: Number.isFinite(q) ? q : null,
    unit: u,
  };
}

/**
 * Convert quantity into the master's unit for pricing.
 * Master price is always "per master.unit".
 * Returns qty expressed in master unit (e.g. 500 GM with master KG → 0.5).
 */
function qtyInMasterUnit(quantity, fromUnit, masterUnit) {
  const from = normalizeUnit(fromUnit) || masterUnit;
  const to = normalizeUnit(masterUnit) || 'KG';
  const q = Number(quantity);
  if (!Number.isFinite(q)) return null;

  const fromInfo = UNIT_TO_BASE[from];
  const toInfo = UNIT_TO_BASE[to];
  if (!fromInfo || !toInfo) {
    // Same opaque unit
    if (from === to) return q;
    return null;
  }
  if (fromInfo.base !== toInfo.base) return null;

  const inBase = q * fromInfo.factor;
  return inBase / toInfo.factor;
}

/**
 * Expected line amount = qty_in_master_unit × masterPricePerUnit
 */
function expectedLineAmount(quantity, fromUnit, masterUnit, masterPrice) {
  const qty = qtyInMasterUnit(quantity, fromUnit, masterUnit);
  const price = Number(masterPrice);
  if (qty == null || !Number.isFinite(price)) return null;
  return Math.round(qty * price * 100) / 100;
}

function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

module.exports = {
  UNIT_TO_BASE,
  normalizeUnit,
  parseQtyUnit,
  qtyInMasterUnit,
  expectedLineAmount,
  roundMoney,
};
