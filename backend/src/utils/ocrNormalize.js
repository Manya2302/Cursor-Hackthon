/**
 * Normalize noisy OCR into clearer line structure BEFORE LLM extraction.
 * Does not invent values — only reshapes existing text.
 */
const { normalizeGujaratiDigits, containsGujarati } = require('./gujarati');

function detectBillLanguage(ocrText) {
  const m = String(ocrText || '').match(/BILL_LANG:\s*(en|gu)/i);
  if (m) return m[1].toLowerCase();
  const lang = String(ocrText || '').match(/^LANG:\s*(en|gu)\b/im);
  if (lang) return lang[1].toLowerCase();
  return containsGujarati(ocrText) ? 'gu' : 'en';
}

/**
 * Collapse OCR so table rows are explicit.
 * Handles both:
 *   ITEM: Sugar | WEIGHT: 1kg | AMOUNT: 100
 * and fragmented:
 *   SUGAR
 *   1KG
 *   100
 */
function normalizeOcrText(ocrText) {
  let text = normalizeGujaratiDigits(String(ocrText || '')).trim();
  if (!text) return { text: '', language: 'en', rowHints: [] };

  const language = detectBillLanguage(text);

  // Preferred dash format: Ghee1kg-6-3000 — promote to ITEM lines early
  try {
    const {
      extractDashBillLines,
      toStructuredItemLines,
    } = require('./billLineParse');
    const dashItems = extractDashBillLines(text);
    if (dashItems.length >= 1) {
      const header = [];
      const nameM = text.match(/^NAME\s*:\s*(.+)$/im);
      const numM = text.match(/^NUMBER\s*:\s*(.+)$/im);
      if (nameM) header.push(`NAME: ${nameM[1].trim()}`);
      if (numM) header.push(`NUMBER: ${numM[1].trim()}`);
      // Loose header if not labeled
      if (!nameM) {
        const looseName = text.match(/^Name\s*[:\-]?\s*(.+)$/im);
        if (looseName) header.push(`NAME: ${looseName[1].trim()}`);
      }
      if (!numM) {
        const looseNum = text.match(/^Number\s*[:\-]?\s*([0-9૦-૯]{10})/im);
        if (looseNum) header.push(`NUMBER: ${looseNum[1]}`);
      }
      const itemLines = toStructuredItemLines(dashItems);
      const sum = dashItems.reduce((s, p) => s + (p.line_amount || 0), 0);
      const normalized = [
        ...header,
        ...itemLines,
        `TOTAL: ${sum}`,
        `BILL_LANG: ${language}`,
      ].join('\n');
      return {
        text: normalized,
        language,
        rowHints: itemLines,
        rawLineCount: text.split(/\n/).length,
      };
    }
  } catch (_) {
    /* fall through */
  }

  // Drop think dumps / markdown noise if any leaked through
  text = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim();

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const header = [];
  const itemLines = [];
  const footer = [];
  const rowHints = [];

  // Already structured ITEM lines — keep as-is
  const hasItemTemplate = lines.some((l) => /^ITEM\s*:/i.test(l));

  if (hasItemTemplate) {
    for (const line of lines) {
      if (/^(NAME|NAME_EN|NUMBER|LANG|BILL_LANG|HEADER_CONFLICT)\s*:/i.test(line)) {
        header.push(line);
      } else if (/^ITEM\s*:/i.test(line)) {
        itemLines.push(line);
        rowHints.push(line);
      } else if (/^TOTAL\s*:/i.test(line)) {
        footer.push(line);
      } else if (/^BILL_LANG\s*:/i.test(line)) {
        footer.push(line);
      }
    }
  } else {
    // Fragmented OCR — try to group name / weight / price triplets after ITEMS header
    let mode = 'header';
    const buf = [];
    const weightRe = /^\d+(\.\d+)?\s*(kg|gm|g|ml|ltr|લી|કિલો|ગ્રા|મિ\.?\s*લી)?$/i;
    const priceRe = /^\d+(\.\d+)?$/;
    const skipRe = /^(items?|item|qty|weight|cost|price|amount|particulars|sr\.?|no\.?)$/i;

    for (const line of lines) {
      if (/^(NAME|NAME_EN|NUMBER|LANG)\s*:/i.test(line)) {
        header.push(line);
        continue;
      }
      if (/^TOTAL\s*:/i.test(line) || /^total\b/i.test(line)) {
        mode = 'footer';
        const digits = line.match(/(\d+(?:\.\d+)?)/);
        footer.push(digits ? `TOTAL: ${digits[1]}` : line);
        continue;
      }
      if (/^items?\b/i.test(line) || skipRe.test(line)) {
        mode = 'items';
        continue;
      }
      if (mode === 'header') {
        // Loose name/phone before items
        if (/^[6-9]\d{9}$/.test(line.replace(/\D/g, '')) && line.replace(/\D/g, '').length === 10) {
          header.push(`NUMBER: ${line.replace(/\D/g, '')}`);
        } else if (!/^\d/.test(line) && line.length > 1) {
          if (!header.some((h) => /^NAME\s*:/i.test(h))) {
            header.push(`NAME: ${line}`);
          }
        }
        continue;
      }
      if (mode === 'footer') continue;

      // items mode
      if (skipRe.test(line)) continue;
      buf.push(line);

      // Flush when we have name + weight + price, or name + price
      if (buf.length >= 3) {
        const [a, b, c] = buf.splice(0, 3);
        const name = a;
        let weight = null;
        let price = null;
        if (weightRe.test(b) && priceRe.test(c.replace(/[₹rs.\s]/gi, ''))) {
          weight = b;
          price = c.replace(/[₹rs.\s]/gi, '');
        } else if (priceRe.test(b.replace(/[₹rs.\s]/gi, '')) && weightRe.test(c)) {
          price = b.replace(/[₹rs.\s]/gi, '');
          weight = c;
        } else if (priceRe.test(c.replace(/[₹rs.\s]/gi, ''))) {
          weight = weightRe.test(b) ? b : null;
          price = c.replace(/[₹rs.\s]/gi, '');
        }
        if (name && (weight || price)) {
          const row = `ITEM: ${name} | WEIGHT: ${weight || 'UNREADABLE'} | AMOUNT: ${price || 'UNREADABLE'}`;
          itemLines.push(row);
          rowHints.push(row);
        }
      }
    }
    // leftover incomplete row → leave as null hints (do not invent)
    if (buf.length === 2 && !priceRe.test(buf[1].replace(/[₹rs.\s]/gi, ''))) {
      // name + weight only
      itemLines.push(
        `ITEM: ${buf[0]} | WEIGHT: ${buf[1]} | AMOUNT: UNREADABLE`
      );
    } else if (buf.length === 1) {
      itemLines.push(`ITEM: ${buf[0]} | WEIGHT: UNREADABLE | AMOUNT: UNREADABLE`);
    }
  }

  // Deduplicate exact consecutive duplicate ITEM lines (OCR echo) — keep one
  const deduped = [];
  for (const line of itemLines) {
    if (deduped.length && deduped[deduped.length - 1] === line) continue;
    deduped.push(line);
  }

  const billLang = `BILL_LANG: ${language}`;
  const normalized = [...header, ...deduped, ...footer, billLang]
    .filter(Boolean)
    .join('\n');

  return {
    text: normalized || text,
    language,
    rowHints: deduped,
    rawLineCount: lines.length,
  };
}

module.exports = {
  normalizeOcrText,
  detectBillLanguage,
};
