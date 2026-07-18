/**
 * Invoice validation — NEVER invent; flag mismatches.
 * Runs AFTER JSON extraction, BEFORE WhatsApp formatting.
 */

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {object} invoice — { customer_name, phone, items[], total, warning, confidence }
 * @param {object} opts — { ocrText }
 */
function validateInvoice(invoice, opts = {}) {
  const ocrText = String(opts.ocrText || '');
  const out = {
    customer_name: invoice?.customer_name ?? null,
    phone: invoice?.phone ?? null,
    items: Array.isArray(invoice?.items) ? [...invoice.items] : [],
    total: invoice?.total ?? null,
    warning: invoice?.warning ?? null,
    confidence: String(invoice?.confidence || 'MEDIUM').toUpperCase(),
    warnings: [],
  };

  // Rule 5 — missing name → null (never fake)
  if (
    !out.customer_name ||
    !String(out.customer_name).trim() ||
    /^UNREADABLE$/i.test(String(out.customer_name)) ||
    /^null$/i.test(String(out.customer_name))
  ) {
    out.customer_name = null;
  }

  // Rule 6 — phone must be 10-digit Indian mobile AND appear in OCR (never invent)
  if (out.phone != null) {
    const digits = String(out.phone).replace(/\D/g, '');
    const ocrDigits = String(opts.ocrText || '').replace(/\D/g, '');
    if (!/^[6-9]\d{9}$/.test(digits)) {
      out.phone = null;
    } else if (ocrDigits && !ocrDigits.includes(digits)) {
      // Phone not present in OCR text → hallucinated
      out.warnings.push('phone_not_in_ocr');
      out.phone = null;
      if (out.confidence === 'HIGH') out.confidence = 'MEDIUM';
    } else {
      out.phone = digits;
    }
  }

  // Clean items — Rule 3/4 never invent; drop empty invented rows
  const cleanedItems = [];
  for (const item of out.items) {
    if (!item) continue;
    let name = item.name != null ? String(item.name).trim() : '';
    if (!name || /^UNREADABLE$/i.test(name) || /^null$/i.test(name)) {
      continue;
    }
    let quantity =
      item.quantity != null && String(item.quantity).trim()
        ? String(item.quantity).trim()
        : null;
    if (quantity && /^UNREADABLE$/i.test(quantity)) quantity = null;

    let price = num(item.price);
    if (item.price === 'UNREADABLE' || item.price === '') price = null;

    cleanedItems.push({
      name,
      quantity,
      price,
      name_en: item.name_en || null,
    });
  }

  // Rule 2 — drop consecutive exact duplicates (OCR/LLM echo)
  const finalItems = [];
  for (const item of cleanedItems) {
    const prev = finalItems[finalItems.length - 1];
    const same =
      prev &&
      prev.name === item.name &&
      prev.quantity === item.quantity &&
      prev.price === item.price;
    if (same) {
      out.warnings.push('duplicate_item_removed');
      continue;
    }
    finalItems.push(item);
  }
  out.items = finalItems;

  // Drop items whose name never appears in OCR (hallucinated)
  if (ocrText) {
    const before = out.items.length;
    out.items = out.items.filter((item) => {
      const n = String(item.name || '').trim();
      if (!n) return false;
      // Allow if Gujarati/English form appears loosely in OCR
      if (ocrText.includes(n)) return true;
      const { GUJARATI_ITEM_LEXICON } = require('./gujarati');
      const hit = GUJARATI_ITEM_LEXICON.find(
        (x) =>
          x.gu === n ||
          x.en.toLowerCase() === n.toLowerCase() ||
          x.aliases.some((a) => a.toLowerCase() === n.toLowerCase())
      );
      if (hit) {
        return (
          ocrText.includes(hit.gu) ||
          new RegExp(hit.en, 'i').test(ocrText) ||
          hit.aliases.some((a) => ocrText.includes(a))
        );
      }
      return false;
    });
    if (out.items.length < before) {
      out.warnings.push('hallucinated_items_removed');
      out.confidence = 'LOW';
    }
  }

  // Rule 1 — total vs sum(prices)
  const sumPrices = out.items.reduce(
    (s, i) => s + (i.price != null ? i.price : 0),
    0
  );
  const total = num(out.total);
  out.total = total;

  if (total != null && out.items.some((i) => i.price != null)) {
    if (Math.abs(total - sumPrices) > 0.5) {
      out.warning = 'Total mismatch';
      out.warnings.push('Total mismatch');
      if (out.confidence === 'HIGH') out.confidence = 'MEDIUM';
      if (Math.abs(total - sumPrices) > 50) out.confidence = 'LOW';
    }
  }

  if (!out.items.length) {
    out.confidence = 'LOW';
    out.warnings.push('no_items');
  } else if (out.items.some((i) => i.price == null || i.quantity == null)) {
    if (out.confidence === 'HIGH') out.confidence = 'MEDIUM';
  }
  if (!out.customer_name && !out.phone) {
    if (out.confidence === 'HIGH') out.confidence = 'MEDIUM';
  }
  if (/HEADER_CONFLICT:\s*true/i.test(ocrText)) {
    out.confidence = 'LOW';
    out.warnings.push('header_conflict');
  }

  out.sum_of_prices = Math.round(sumPrices * 100) / 100;
  return out;
}

/**
 * Map validated invoice JSON → LedgerBot transaction parsed shape.
 * Keeps Gujarati names; attaches name_en only as translation of known lexicon.
 */
function invoiceToParsed(invoice, language = 'en') {
  const { GUJARATI_ITEM_LEXICON, parseWeightText } = require('./gujarati');

  const items = (invoice.items || []).map((item) => {
    const name = item.base_name || item.name;
    const hit = GUJARATI_ITEM_LEXICON.find(
      (x) =>
        x.gu === name ||
        x.en.toLowerCase() === String(name).toLowerCase() ||
        x.aliases.some((a) => a.toLowerCase() === String(name).toLowerCase()) ||
        (item.name &&
          x.en.toLowerCase() ===
            String(item.name).toLowerCase().replace(/\d.*/, '').trim())
    );
    let canonical = name;
    let nameEn = item.name_en || null;
    if (hit) {
      if (language === 'gu' || /[\u0A80-\u0AFF]/.test(String(name))) {
        canonical = hit.gu;
        nameEn = hit.en;
      } else {
        canonical = hit.en;
        nameEn = hit.en;
      }
    }

    // New format: quantity = pack count; pack_text = "1kg" / "250gm"
    let count =
      item.count != null && Number.isFinite(Number(item.count))
        ? Number(item.count)
        : null;
    if (
      count == null &&
      item.quantity != null &&
      /^\d+(\.\d+)?$/.test(String(item.quantity).trim())
    ) {
      count = Number(item.quantity);
    }

    const packText =
      item.pack_text ||
      (item.weight_text &&
      /\d+\s*(kg|gm|g|ml|l)/i.test(String(item.weight_text))
        ? String(item.weight_text).replace(/\s+/g, '')
        : null) ||
      (item.name &&
      /\d+\s*(kg|gm|g|ml|l)/i.test(String(item.name))
        ? String(item.name).match(/(\d+\s*(?:kg|gm|g|ml|l))/i)?.[1]?.replace(
            /\s+/g,
            ''
          )
        : null) ||
      null;

    const w = packText
      ? parseWeightText(packText)
      : { quantity: null, unit: null };

    // If quantity field was a pack size (500gm) and count missing → count defaults 1
    if (count == null) count = 1;

    const unitPrice =
      item.unit_price != null && Number(item.unit_price) > 0
        ? Number(item.unit_price)
        : item.price != null && count
          ? Math.round((Number(item.price) / count) * 100) / 100
          : null;

    return {
      name: item.name || canonical,
      name_en: nameEn || canonical,
      base_name: item.base_name || canonical,
      quantity: count,
      unit: item.pack_unit || w.unit || 'PCS',
      weight_text: packText,
      pack_text: packText,
      pack_qty: item.pack_qty != null ? item.pack_qty : w.quantity,
      pack_unit: item.pack_unit || w.unit,
      count,
      unit_price: unitPrice,
      line_amount: item.price,
    };
  });

  return {
    intent: 'transaction',
    transaction_type: 'sale',
    items,
    party: {
      name: invoice.customer_name,
      phone: invoice.phone,
      role: 'customer',
    },
    name_en: null,
    payments: [],
    total_amount: invoice.total,
    date: null,
    currency: 'INR',
    product_updates: [],
    statement: null,
    notes: invoice.warning || null,
    unclear_reason: null,
    invoice_confidence: invoice.confidence,
    invoice_warning: invoice.warning,
    invoice_sum_of_prices: invoice.sum_of_prices,
    validation_warnings: invoice.warnings || [],
  };
}

module.exports = {
  validateInvoice,
  invoiceToParsed,
};
