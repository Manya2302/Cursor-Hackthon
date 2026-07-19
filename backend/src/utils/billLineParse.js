/**
 * Parse kirana bill lines.
 *
 * Table columns are: Item | Quantity | Rate (unit price).
 * Line total = quantity × rate (JS math only — never trust the LLM for this).
 *
 * Supported forms:
 *   Maggi | 5 | 50          → count 5, unit_price 50, line_amount 250
 *   ITEM: Maggi | WEIGHT: 5 | AMOUNT: 50
 *   Ghee1kg-6-3000          → pack + count + lineTotal (legacy dash form)
 *   Ghee-1kg-1-200
 */

const { normalizeUnit, roundMoney } = require('./units');

const PACK_UNIT =
  'kg|kgs|gm|gms|g|ml|ltr|l|liter|litre|pcs|pc|nos';

/**
 * @returns {object|null}
 */
function parseDashBillLine(rawLine) {
  const raw = String(rawLine || '').trim();
  if (!raw) return null;

  // Preferred structured OCR row (do this BEFORE stripping WEIGHT/AMOUNT):
  //   ITEM: Ghee | WEIGHT: 1 | AMOUNT: 200
  //   ITEM: Sugar - 500gm | WEIGHT: 2 | AMOUNT: 250 | COUNT: 2
  const structured = raw.match(
    /^ITEM\s*:\s*(.+?)\s*\|\s*WEIGHT\s*:\s*([^|]*)\|\s*AMOUNT\s*:\s*([^\|]+)/i
  );
  if (structured) {
    const namePart = structured[1].trim();
    const weightPart = String(structured[2] || '').trim();
    const amountRaw = Number(String(structured[3]).replace(/[^\d.]/g, ''));
    const countM = raw.match(/\|\s*COUNT\s*:\s*(\d+(?:\.\d+)?)/i);
    const unitPriceM = raw.match(/\|\s*UNIT_PRICE\s*:\s*([^\|]+)/i);
    const weightIsPack = new RegExp(
      `\\d+(?:\\.\\d+)?\\s*(?:${PACK_UNIT})`,
      'i'
    ).test(weightPart);
    const weightIsPlainQty =
      weightPart && /^\d+(?:\.\d+)?$/.test(weightPart) && !weightIsPack;

    let count = countM ? Number(countM[1]) : null;
    let packHint = null;
    if (count == null && weightIsPlainQty) count = Number(weightPart);
    if (count == null && weightIsPack) {
      packHint = weightPart;
      count = 1;
    }
    if (count == null) count = 1;
    if (weightIsPack) packHint = weightPart;

    if (!Number.isFinite(amountRaw) || amountRaw < 0 || !namePart) {
      // fall through to other parsers
    } else {
      // Kirana table: Item | Qty | Rate → AMOUNT is unit rate, line = qty × rate.
      // After normalize, lines include UNIT_PRICE and AMOUNT is already line total — don't multiply again.
      let lineAmount = amountRaw;
      let unitPriceOverride = null;
      if (unitPriceM) {
        const up = Number(String(unitPriceM[1]).replace(/[^\d.]/g, ''));
        if (Number.isFinite(up)) unitPriceOverride = up;
      } else if (!weightIsPack && count > 0) {
        unitPriceOverride = amountRaw;
        lineAmount = roundMoney(count * amountRaw);
      }

      const parsed = buildParsed(
        packHint && !/\d/.test(namePart) ? `${namePart} ${packHint}` : namePart,
        packHint,
        count,
        lineAmount,
        raw
      );
      if (parsed && unitPriceOverride != null) {
        parsed.unit_price = roundMoney(unitPriceOverride);
      }
      if (parsed) return parsed;
    }
  }

  let line = raw
    .replace(/^ITEM\s*:\s*/i, '')
    .replace(/^[-•*]\s*/, '')
    .replace(/\s*\|\s*WEIGHT\s*:.*$/i, '') // ignore leftover template tails
    .trim();

  // Skip headers
  if (
    /^(name|number|total|lang|item|quantity|price|qty|amount|product)\b/i.test(
      line
    ) &&
    !/[-–—]/.test(line)
  ) {
    return null;
  }

  // A) product-pack-count-amount: Ghee-1kg-1-200 / Sugar-500gm-2-250
  let m = line.match(
    new RegExp(
      `^(.+?)\\s*[-–—]\\s*(\\d+(?:\\.\\d+)?\\s*(?:${PACK_UNIT}))\\s*[-–—]\\s*(\\d+(?:\\.\\d+)?)\\s*[-–—]\\s*(\\d+(?:\\.\\d+)?)\\s*$`,
      'i'
    )
  );
  if (m) {
    return buildParsed(m[1], m[2], Number(m[3]), Number(m[4]), raw);
  }

  // B) glued pack then count-amount: Ghee1kg-6-3000
  m = line.match(
    new RegExp(
      `^(.+?\\d+(?:\\.\\d+)?\\s*(?:${PACK_UNIT}))\\s*[-–—]\\s*(\\d+(?:\\.\\d+)?)\\s*[-–—]\\s*(\\d+(?:\\.\\d+)?)\\s*$`,
      'i'
    )
  );
  if (m) {
    return buildParsed(m[1], null, Number(m[2]), Number(m[3]), raw);
  }

  // C) greedy end: left-count-amount  (left may include pack) e.g. Ghee-1kg-1-200 already handled;
  //    also "milk 250 gm -4-1000"
  m = line.match(
    /^(.+?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)\s*$/
  );
  if (m) {
    const left = m[1].trim();
    // If left ends with a pack unit, treat m[2]/m[3] as count/amount
    const hasPack = new RegExp(
      `\\d+(?:\\.\\d+)?\\s*(?:${PACK_UNIT})\\s*$`,
      'i'
    ).test(left);
    if (hasPack || /[a-zA-Z\u0A80-\u0AFF]/.test(left)) {
      return buildParsed(left, null, Number(m[2]), Number(m[3]), raw);
    }
  }

  // D) table row with pipes: Maggi | 5 | 50  (qty | unit rate)
  m = line.match(
    /^(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*$/
  );
  if (m) {
    const count = Number(m[2]);
    const rate = Number(m[3]);
    const parsed = buildParsed(m[1], null, count, roundMoney(count * rate), raw);
    if (parsed) {
      parsed.unit_price = roundMoney(rate);
      return parsed;
    }
  }

  // E) "Ghee - 1kg  1  200" (spaces)
  m = line.match(
    new RegExp(
      `^(.+?)\\s*[-–—]\\s*(\\d+(?:\\.\\d+)?\\s*(?:${PACK_UNIT}))\\s+(\\d+(?:\\.\\d+)?)\\s+(\\d+(?:\\.\\d+)?)\\s*$`,
      'i'
    )
  );
  if (m) {
    return buildParsed(m[1], m[2], Number(m[3]), Number(m[4]), raw);
  }

  return null;
}

function buildParsed(leftRaw, packHint, count, lineAmount, raw) {
  let left = String(leftRaw || '')
    .replace(/[\s|]+$/g, '')
    .trim();
  let packText = packHint ? String(packHint).replace(/\s+/g, '').trim() : null;
  let packQty = null;
  let packUnit = null;
  let name = left;

  const packRe = new RegExp(
    `^(.*?)[\\s_-]*(\\d+(?:\\.\\d+)?)\\s*(${PACK_UNIT})\\s*$`,
    'i'
  );
  const packed = left.match(packRe);
  if (packed && packed[1].trim()) {
    name = packed[1].replace(/[\s_-]+$/g, '').trim();
    packQty = Number(packed[2]);
    packUnit = normalizeUnit(packed[3]) || packed[3].toUpperCase();
    packText = `${packQty}${packUnit === 'GM' ? 'gm' : packUnit.toLowerCase()}`;
  } else if (packHint) {
    const ph = String(packHint).match(
      new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${PACK_UNIT})`, 'i')
    );
    if (ph) {
      packQty = Number(ph[1]);
      packUnit = normalizeUnit(ph[2]) || 'PCS';
      packText = `${packQty}${packUnit === 'GM' ? 'gm' : packUnit.toLowerCase()}`;
      name = left.replace(/[\s_-]+$/g, '').trim();
    }
  } else {
    const glued = left.match(
      new RegExp(`^(.*?)(\\d+(?:\\.\\d+)?)(${PACK_UNIT})$`, 'i')
    );
    if (glued && glued[1].trim()) {
      name = glued[1].trim();
      packQty = Number(glued[2]);
      packUnit = normalizeUnit(glued[3]);
      packText = `${packQty}${packUnit === 'GM' ? 'gm' : (packUnit || '').toLowerCase()}`;
    }
  }

  name = name.replace(/^[-–—\s]+|[-–—\s]+$/g, '').trim();
  if (!name) name = left;

  // Reject garbage like lone digits / empty amounts
  if (!name || name.length < 2) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  if (!Number.isFinite(lineAmount) || lineAmount < 0) return null;

  const unitPrice = roundMoney(lineAmount / count);
  const display_name = packText ? `${name} ${packText}` : name;

  return {
    name,
    pack_qty: packQty,
    pack_unit: packUnit,
    pack_text: packText,
    count,
    line_amount: roundMoney(lineAmount),
    unit_price: unitPrice,
    display_name,
    quantity: count,
    unit: packUnit || 'PCS',
    weight_text: packText,
    raw,
  };
}

function extractDashBillLines(ocrText) {
  const lines = String(ocrText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  const seen = new Set();
  for (const line of lines) {
    if (/^(name|number|total|lang|bill_lang)\s*:/i.test(line)) continue;
    if (/^(items?|quantity|price|qty|amount)\s*$/i.test(line)) continue;

    // Also accept structured template rows that embed dash body
    let parsed = parseDashBillLine(line);
    if (!parsed && /\|/.test(line) && /^ITEM\s*:/i.test(line)) {
      // ITEM: Ghee - 1kg | WEIGHT: 1 | AMOUNT: 200 | COUNT: 1
      const nameM = line.match(
        /^ITEM\s*:\s*(.+?)\s*\|\s*WEIGHT\s*:\s*(.+?)\s*\|\s*AMOUNT\s*:\s*([^\|]+)/i
      );
      if (nameM) {
        const countM = line.match(/\|\s*COUNT\s*:\s*(\d+)/i);
        const count = countM ? Number(countM[1]) : Number(nameM[2]);
        const amount = Number(String(nameM[3]).replace(/[^\d.]/g, ''));
        const countOk = Number.isFinite(count) && count > 0 ? count : 1;
        // If WEIGHT is a pack (1kg) and COUNT missing, WEIGHT is pack and we need qty from elsewhere
        const weightIsPack = new RegExp(
          `\\d+(?:\\.\\d+)?\\s*(?:${PACK_UNIT})`,
          'i'
        ).test(nameM[2]);
        if (weightIsPack && !countM) {
          parsed = buildParsed(
            `${nameM[1].trim()} ${nameM[2].trim()}`,
            nameM[2].trim(),
            1,
            amount,
            line
          );
          // Better: name has pack, count unknown → try amount only with count 1
        } else {
          parsed = buildParsed(
            nameM[1],
            weightIsPack ? nameM[2] : null,
            countOk,
            amount,
            line
          );
        }
      }
    }

    if (parsed && parsed.name && parsed.line_amount != null && parsed.unit_price != null) {
      const key = `${parsed.display_name}|${parsed.count}|${parsed.line_amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(parsed);
    }
  }
  return items;
}

function toStructuredItemLines(parsedItems) {
  return (parsedItems || []).map((p) => {
    const weight = p.pack_text || p.weight_text || '';
    // When there is no pack size, put the sold count in WEIGHT so re-parsers
    // never see a blank WEIGHT field (which used to drop rows).
    const weightOut =
      weight ||
      (p.count != null && Number.isFinite(Number(p.count))
        ? String(p.count)
        : '');
    return (
      `ITEM: ${p.display_name || p.name} | WEIGHT: ${weightOut} | AMOUNT: ${p.line_amount}` +
      ` | COUNT: ${p.count} | UNIT_PRICE: ${p.unit_price}`
    );
  });
}

module.exports = {
  parseDashBillLine,
  extractDashBillLines,
  toStructuredItemLines,
};
