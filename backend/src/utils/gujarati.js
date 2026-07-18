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

/**
 * Common Indian grocery measures and local Gujarati names used in handwritten bills.
 * This is the canonical reference used by parseWeightText().
 */
const COMMON_MEASURE_REFERENCE = [
  {
    label: 'KILO',
    normalized_quantity: 1,
    normalized_unit: 'KG',
    approx_grams: 1000,
    aliases: ['kilo', 'kg', 'k.g', 'ki', 'કિલો', 'કિલો그램', 'किलो'],
  },
  {
    label: 'ARDHO_KILO',
    normalized_quantity: 0.5,
    normalized_unit: 'KG',
    approx_grams: 500,
    aliases: ['અડધો કિલો', 'અડધી કિલો', 'ardho kilo', 'half kilo'],
  },
  {
    label: 'PONO_KILO',
    normalized_quantity: 0.75,
    normalized_unit: 'KG',
    approx_grams: 750,
    aliases: ['પોણો કિલો', 'pono kilo', 'three quarter kilo'],
  },
  {
    label: 'SAVA_KILO',
    normalized_quantity: 1.25,
    normalized_unit: 'KG',
    approx_grams: 1250,
    aliases: ['સવા કિલો', 'sava kilo', 'one and quarter kilo'],
  },
  {
    label: 'DODH_KILO',
    normalized_quantity: 1.5,
    normalized_unit: 'KG',
    approx_grams: 1500,
    aliases: ['દોઢ કિલો', 'dodh kilo', 'one and half kilo'],
  },
  {
    label: 'PAV',
    normalized_quantity: 250,
    normalized_unit: 'GM',
    approx_grams: 250,
    aliases: ['પાવ', 'pav'],
  },
  {
    label: 'TOLA',
    normalized_quantity: 11.66,
    normalized_unit: 'GM',
    approx_grams: 11.66,
    aliases: ['તોલા', 'tola'],
  },
  {
    label: 'MANN',
    normalized_quantity: 1,
    normalized_unit: 'MANN',
    approx_grams: 20000,
    aliases: ['મણ', 'mann', 'man'],
    notes: 'Traditional regional unit, often around 20 kg in Gujarat.',
  },
  {
    label: 'LITER',
    normalized_quantity: 1,
    normalized_unit: 'L',
    aliases: ['liter', 'litre', 'ltr', 'લિટર', 'લીટર'],
  },
  {
    label: 'MILLILITER',
    normalized_quantity: 1,
    normalized_unit: 'ML',
    aliases: ['ml', 'મિલી', 'મિ.લી', 'मिली'],
  },
];

/** Common kirana item lexicon for OCR correction (Gujarati → canonical). */
const GUJARATI_ITEM_LEXICON = [
  { gu: 'ખાંડ', en: 'Sugar', aliases: ['ખાંડ', 'ખાડ', 'ખાંड'] },
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

function normalizeWeightText(weightText) {
  return normalizeGujaratiDigits(String(weightText || ''))
    .toLowerCase()
    .replace(/[.,|/:;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse WEIGHT like "500 ગ્રા" / "1 કિલો" / "500 મિ.લી" into quantity + unit.
 */
function parseWeightText(weightText) {
  if (!weightText) return { quantity: null, unit: null };
  const compact = normalizeWeightText(weightText);

  const fixedKiloMap = [
    { quantity: 0.5, regex: /(?:અડધ[ોી]?\s*કિલો|ardh[oa]?\s*kilo|half\s*kilo)/i },
    { quantity: 0.75, regex: /(?:પોણ[ોા]?\s*કિલો|pono\s*kilo|three\s*quarter\s*kilo)/i },
    { quantity: 1.25, regex: /(?:સવા\s*કિલો|sava\s*kilo|one\s*and\s*quarter\s*kilo)/i },
    { quantity: 1.5, regex: /(?:દોઢ\s*કિલો|dodh\s*kilo|one\s*and\s*half\s*kilo)/i },
  ];
  for (const item of fixedKiloMap) {
    if (item.regex.test(compact)) {
      return { quantity: item.quantity, unit: 'KG' };
    }
  }

  const pav = compact.match(/(?:(\d+(?:\.\d+)?)\s+)?(?:પાવ|pav)\b/i);
  if (pav) {
    const count = pav[1] ? Number(pav[1]) : 1;
    return { quantity: count * 250, unit: 'GM' };
  }

  const tola = compact.match(/(?:(\d+(?:\.\d+)?)\s+)?(?:તોલા|tola)\b/i);
  if (tola) {
    const count = tola[1] ? Number(tola[1]) : 1;
    return { quantity: Number((count * 11.66).toFixed(2)), unit: 'GM' };
  }

  const mann = compact.match(/(?:(\d+(?:\.\d+)?)\s+)?(?:મણ|mann|man)\b/i);
  if (mann) {
    const count = mann[1] ? Number(mann[1]) : 1;
    return { quantity: count, unit: 'MANN' };
  }

  const num = compact.match(/(\d+(?:\.\d+)?)/);
  const quantity = num ? Number(num[1]) : null;
  let unit = null;
  if (/(?:^|\s)(?:kg|k g|kilo|ki)(?:\s|$)|કિલો|किलो/i.test(compact)) unit = 'KG';
  else if (/(?:^|\s)(?:ml)(?:\s|$)|મિ લી|મિલી|मिली/i.test(compact)) unit = 'ML';
  else if (/(?:^|\s)(?:l|ltr|liter|litre)(?:\s|$)|લિટર|લીટર/i.test(compact)) unit = 'L';
  else if (/(?:^|\s)(?:gm|gram|g)(?:\s|$)|ગ્રા|ग्राम/i.test(compact)) unit = 'GM';

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
      const name = String(next.name || '');
      const hit = GUJARATI_ITEM_LEXICON.find(
        (x) =>
          x.gu === name ||
          x.aliases.some((a) => a.toLowerCase() === name.toLowerCase())
      );
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
  COMMON_MEASURE_REFERENCE,
  GUJARATI_ITEM_LEXICON,
  parseWeightText,
  enrichParsedBill,
};
