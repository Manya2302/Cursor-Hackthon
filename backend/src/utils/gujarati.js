/**
 * Convert Gujarati digits (૦-૯) to ASCII 0-9.
 */
function normalizeGujaratiDigits(text) {
  if (!text) return text;
  const map = {
    '૦': '0',
    '૧': '1',
    '૨': '2',
    '૩': '3',
    '૪': '4',
    '૫': '5',
    '૬': '6',
    '૭': '7',
    '૮': '8',
    '૯': '9',
  };
  return String(text).replace(/[૦-૯]/g, (d) => map[d] || d);
}

function containsGujarati(text) {
  return /[\u0A80-\u0AFF]/.test(text || '');
}

/** Common kirana item lexicon for OCR correction (Gujarati → canonical). */
const GUJARATI_ITEM_LEXICON = [
  { gu: 'ખાંડ', en: 'Sugar', aliases: ['ખાંડ', 'ખાડ', 'ખાંड', 'khaand', 'khand', 'sugar'] },
  { gu: 'ઘી', en: 'Ghee', aliases: ['ઘી', 'ધી', 'ઘિ'] },
  { gu: 'બટર', en: 'Butter', aliases: ['બટર', 'butter'] },
  { gu: 'ચીઝ', en: 'Cheese', aliases: ['ચીઝ', 'ચાગર', 'ચીજ', 'cheese', 'chzz'] },
  { gu: 'દૂધ', en: 'Milk', aliases: ['દૂધ', 'દુધ', 'milk'] },
  { gu: 'તેલ', en: 'Oil', aliases: ['તેલ'] },
  { gu: 'ચા', en: 'Tea', aliases: ['ચા'] },
  { gu: 'મીઠું', en: 'Salt', aliases: ['મીઠું', 'મીઠુ'] },
  { gu: 'આટો', en: 'Flour', aliases: ['આટો', 'આટા'] },
  { gu: 'ચોખા', en: 'Rice', aliases: ['ચોખા'] },
];

/**
 * Parse WEIGHT like "500 ગ્રા" / "1 કિલો" / "500 મિ.લી" into quantity + unit.
 */
function parseWeightText(weightText) {
  if (!weightText) return { quantity: null, unit: null };
  const { normalizeGujaratiDigits } = require('./gujarati');
  const t = normalizeGujaratiDigits(String(weightText)).trim();
  const num = t.match(/(\d+(?:\.\d+)?)/);
  const quantity = num ? Number(num[1]) : null;
  let unit = null;
  if (/કિ|किल|kg|k\.?g/i.test(t)) unit = 'KG';
  else if (/મિ\.?\s*લી|ml|मिली/i.test(t)) unit = 'ML';
  else if (/ગ્રા|gm|g\b|ग्राम/i.test(t)) unit = 'GM';
  return { quantity, unit };
}

/**
 * Enrich extracted JSON: English item labels, quantity from weight_text, phone digits.
 */
function enrichParsedBill(parsed, ocrText = '') {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const { normalizeGujaratiDigits, GUJARATI_ITEM_LEXICON } = require('./gujarati');

  if (parsed.party?.phone) {
    parsed.party.phone = normalizeGujaratiDigits(String(parsed.party.phone)).replace(
      /\D/g,
      ''
    );
  }

  // Pull NAME_EN from OCR template if model omitted name_en
  if (!parsed.name_en && ocrText) {
    const m = ocrText.match(/^NAME_EN:\s*(.+)$/im);
    if (m && !/^UNREADABLE$/i.test(m[1].trim())) parsed.name_en = m[1].trim();
  }
  if ((!parsed.party?.name || /^UNREADABLE$/i.test(String(parsed.party.name))) && ocrText) {
    const m = ocrText.match(/^NAME:\s*(.+)$/im);
    if (m && !/^UNREADABLE$/i.test(m[1].trim())) {
      if (!parsed.party) parsed.party = {};
      parsed.party.name = m[1].trim();
    }
  }
  if (parsed.party?.name && /^UNREADABLE$/i.test(String(parsed.party.name))) {
    parsed.party.name = null;
  }
  if (parsed.name_en && /^UNREADABLE$/i.test(String(parsed.name_en))) {
    parsed.name_en = null;
  }
  if ((!parsed.party?.phone || parsed.party.phone.length < 10) && ocrText) {
    const m = ocrText.match(/^NUMBER:\s*([0-9]{10}|UNREADABLE)/im);
    if (m && !/^UNREADABLE$/i.test(m[1])) {
      if (!parsed.party) parsed.party = {};
      parsed.party.phone = m[1];
    }
  }
  if (parsed.party?.phone && !/^[6-9]\d{9}$/.test(String(parsed.party.phone))) {
    // Invalid OCR phone — clear so we don't save garbage
    if (/UNREADABLE/i.test(String(parsed.party.phone)) || String(parsed.party.phone).length !== 10) {
      parsed.party.phone = null;
    }
  }

  parsed.header_conflict = /HEADER_CONFLICT:\s*true/i.test(String(ocrText || ''));

  if (Array.isArray(parsed.items)) {
    parsed.items = parsed.items.map((item) => {
      if (!item) return item;
      const next = { ...item };
      if (next.weight_text && (next.quantity == null || !next.unit)) {
        const w = parseWeightText(next.weight_text);
        if (next.quantity == null) next.quantity = w.quantity;
        if (!next.unit) next.unit = w.unit;
      }
      const name = String(next.name || '').trim();
      const nameLower = name.toLowerCase();
      const hit = GUJARATI_ITEM_LEXICON.find((x) => {
        if (x.gu === name || x.en.toLowerCase() === nameLower) return true;
        return x.aliases.some((a) => {
          const al = String(a).toLowerCase();
          return al === nameLower || nameLower.includes(al);
        });
      });
      if (hit) {
        next.name_en = hit.en;
        next.name = hit.gu;
      }
      return next;
    });
  }

  // Prefer TOTAL from OCR template; if model total disagrees with sum of line amounts, use line sum.
  const lineSum = (parsed.items || []).reduce((s, i) => {
    const v = Number(i.line_amount);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
  const ocrTotalMatch = String(ocrText || '').match(/^TOTAL:\s*(\d+(?:\.\d+)?)\s*$/im);
  const ocrTotal = ocrTotalMatch ? Number(ocrTotalMatch[1]) : null;

  if (ocrTotal != null && Number.isFinite(ocrTotal)) {
    if (lineSum > 0 && Math.abs(ocrTotal - lineSum) <= 1) {
      parsed.total_amount = ocrTotal;
    } else if (
      lineSum > 0 &&
      parsed.total_amount != null &&
      Math.abs(Number(parsed.total_amount) - lineSum) > 1 &&
      Math.abs(ocrTotal - lineSum) > 1
    ) {
      // Both disagree with lines — trust explicit line amounts (stated on bill)
      parsed.total_amount = lineSum;
      parsed.notes = [parsed.notes, 'total_reconciled_from_line_amounts']
        .filter(Boolean)
        .join(' | ');
    } else if (parsed.total_amount == null) {
      parsed.total_amount = ocrTotal;
    } else if (lineSum > 0 && Math.abs(Number(parsed.total_amount) - lineSum) > 1) {
      parsed.total_amount = lineSum;
      parsed.notes = [parsed.notes, 'total_reconciled_from_line_amounts']
        .filter(Boolean)
        .join(' | ');
    }
  } else if (
    lineSum > 0 &&
    (parsed.total_amount == null ||
      Math.abs(Number(parsed.total_amount) - lineSum) > 1)
  ) {
    parsed.total_amount = lineSum;
  }

  return parsed;
}

module.exports = {
  normalizeGujaratiDigits,
  containsGujarati,
  GUJARATI_ITEM_LEXICON,
  parseWeightText,
  enrichParsedBill,
};
