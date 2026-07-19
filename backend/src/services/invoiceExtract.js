/**
 * Invoice extraction engine — JSON only, NEVER guess.
 * Pipeline step: normalized OCR → this → validation → WhatsApp format.
 */

const { chatCompletion, EXTRACTION_MODEL } = (() => {
  // Lazy require to avoid circular deps — re-export chat via local fetch
  return {
    EXTRACTION_MODEL: 'llama-3.3-70b-versatile',
    chatCompletion: null,
  };
})();

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL =
  process.env.GROQ_EXTRACTION_MODEL || EXTRACTION_MODEL || 'llama-3.3-70b-versatile';

const INVOICE_EXTRACTION_PROMPT = `You are an invoice extraction engine.

Your job is to extract information ONLY from the OCR text provided.

Rules:
1. Never guess missing values.
2. Never repeat items unless OCR repeats them.
3. Never invent customer names.
4. Never invent phone numbers.
5. Never invent quantities.
6. Never invent prices.
7. Preserve item order exactly as in OCR.
8. If a value is unreadable, return null.
9. Output ONLY valid JSON (no markdown, no commentary).
10. If OCR language is Gujarati, first understand Gujarati and then extract data. Do NOT translate item names until extraction is complete — keep Gujarati script in "name" (e.g. ઘી not Ghee).
11. If the OCR is noisy, prefer returning null rather than guessing.
12. If total does not equal the sum of item prices, set "warning":"Total mismatch".
13. Return confidence: "HIGH" | "MEDIUM" | "LOW" based on OCR quality.
14. Do not merge adjacent rows.
15. Do not duplicate rows.
16. Ignore handwriting that is crossed out / struck through.
17. If the same item appears multiple times in OCR, keep all occurrences only if clearly separate rows.
18. Each OCR ITEM line is one row: name from ITEM, quantity from WEIGHT, price from AMOUNT. UNREADABLE → null.
19. Do not complete a sale by inventing missing grocery items.

Output format (exact keys):
{
  "customer_name": string | null,
  "phone": string | null,
  "items": [
    {
      "name": string | null,
      "quantity": string | null,
      "price": number | null
    }
  ],
  "total": number | null,
  "warning": string | null,
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}`;

const { getApiKey, withGroqKey } = require('./groqKeys');

function stripJsonFences(text) {
  let t = String(text || '').trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return t.trim();
}

/**
 * Deterministic parse from structured OCR (ITEM: … | WEIGHT: … | AMOUNT: …)
 * when present — avoids LLM inventing rows.
 */
function parseInvoiceFromStructuredOcr(ocrText) {
  const text = String(ocrText || '');

  // Preferred format first: Ghee1kg-6-3000
  const {
    extractDashBillLines,
  } = require('../utils/billLineParse');
  const dashItems = extractDashBillLines(text);
  if (dashItems.length) {
    const customer_name = (() => {
      const m = text.match(/^NAME\s*:\s*(.+)$/im);
      if (!m || /^UNREADABLE$/i.test(m[1].trim())) return null;
      return m[1].trim();
    })();
    const phone = (() => {
      const m = text.match(/^NUMBER\s*:\s*([0-9૦-૯]{10}|UNREADABLE)/im);
      if (!m || /^UNREADABLE$/i.test(m[1])) return null;
      return m[1].replace(/\D/g, '');
    })();
    const items = dashItems.map((p) => ({
      name: p.display_name || p.name,
      quantity: p.count != null ? String(p.count) : null,
      price: p.line_amount,
      unit_price: p.unit_price,
      pack_text: p.pack_text,
      pack_qty: p.pack_qty,
      pack_unit: p.pack_unit,
      weight_text: p.pack_text,
      count: p.count,
      base_name: p.name,
    }));
    const sum = items.reduce((s, i) => s + (i.price || 0), 0);
    return {
      customer_name,
      phone,
      items,
      total: sum || null,
      warning: null,
      confidence: items.length >= 2 ? 'HIGH' : 'MEDIUM',
      _source: 'dash_bill_format',
    };
  }

  const customer_name = (() => {
    const m = text.match(/^NAME:\s*(.+)$/im);
    if (!m || /^UNREADABLE$/i.test(m[1].trim())) return null;
    return m[1].trim();
  })();
  const phone = (() => {
    const m = text.match(/^NUMBER:\s*([0-9૦-૯]{10}|UNREADABLE)/im);
    if (!m || /^UNREADABLE$/i.test(m[1])) return null;
    return m[1].replace(/\D/g, '');
  })();

  const items = [];
  const itemRe =
    /^ITEM\s*:\s*(.+?)\s*\|\s*WEIGHT\s*:\s*(.+?)\s*\|\s*AMOUNT\s*:\s*([^\|]+)(?:\s*\|\s*COUNT\s*:\s*([^\|]+))?(?:\s*\|\s*UNIT_PRICE\s*:\s*(.+))?\s*$/gim;
  let m;
  while ((m = itemRe.exec(text))) {
    const name = m[1].trim();
    const quantity = /^UNREADABLE$/i.test(m[2].trim()) ? null : m[2].trim();
    const priceRaw = m[3].trim();
    const priceNum = /^UNREADABLE$/i.test(priceRaw)
      ? null
      : Number(String(priceRaw).replace(/[^\d.]/g, ''));
    const count =
      m[4] != null && !/^UNREADABLE$/i.test(String(m[4]).trim())
        ? Number(String(m[4]).replace(/[^\d.]/g, ''))
        : null;
    const unitPriceExplicit =
      m[5] != null && !/^UNREADABLE$/i.test(String(m[5]).trim())
        ? Number(String(m[5]).replace(/[^\d.]/g, ''))
        : null;
    if (!name || /^UNREADABLE$/i.test(name)) continue;

    // Plain qty + AMOUNT without UNIT_PRICE → AMOUNT is unit rate
    const qtyNum =
      count != null && Number.isFinite(count)
        ? count
        : quantity && /^\d+(?:\.\d+)?$/.test(quantity)
          ? Number(quantity)
          : null;
    let unit_price = Number.isFinite(unitPriceExplicit) ? unitPriceExplicit : null;
    let price = Number.isFinite(priceNum) ? priceNum : null;
    if (unit_price == null && qtyNum != null && qtyNum > 0 && price != null) {
      unit_price = price;
      price = Math.round(qtyNum * unit_price * 100) / 100;
    }

    items.push({
      name,
      quantity: qtyNum != null ? String(qtyNum) : quantity,
      price,
      unit_price,
      weight_text: quantity,
      count: qtyNum,
    });
  }

  const totalM = text.match(/^TOTAL\s*:\s*([0-9]+(?:\.[0-9]+)?|UNREADABLE)/im);
  const total =
    totalM && !/^UNREADABLE$/i.test(totalM[1])
      ? Number(totalM[1])
      : null;

  if (!items.length && !customer_name && !phone && total == null) {
    return null;
  }

  const sum = items.reduce((s, i) => s + (i.price || 0), 0);
  let warning = null;
  let confidence = items.length >= 3 ? 'HIGH' : items.length ? 'MEDIUM' : 'LOW';
  if (total != null && items.some((i) => i.price != null) && Math.abs(total - sum) > 0.5) {
    warning = 'Total mismatch';
    confidence = 'LOW';
  }

  return {
    customer_name,
    phone,
    items,
    total: Number.isFinite(total) ? total : null,
    warning,
    confidence,
    _source: 'structured_ocr',
  };
}

async function extractInvoiceFromOcr(ocrText, language = 'en') {
  // Prefer deterministic parse when OCR already has ITEM template
  const structured = parseInvoiceFromStructuredOcr(ocrText);
  if (structured && structured.items.length > 0) {
    console.log(
      `[invoice] structured OCR parse: ${structured.items.length} items, conf=${structured.confidence}`
    );
    return structured;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return (
      structured || {
        customer_name: null,
        phone: null,
        items: [],
        total: null,
        warning: 'No API key',
        confidence: 'LOW',
      }
    );
  }

  // LLM path uses withGroqKey below (primary + fallback)
  const userMsg =
    `OCR language hint: ${language}\n` +
    `Extract invoice JSON ONLY from this OCR text. Never guess.\n\n` +
    `--- OCR START ---\n${ocrText}\n--- OCR END ---`;

  const content = await withGroqKey(async (apiKey) => {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_tokens: 2048,
        messages: [
          { role: 'system', content: INVOICE_EXTRACTION_PROMPT },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        body?.error?.message || `Invoice extract failed (${res.status})`
      );
    }
    return body?.choices?.[0]?.message?.content || '';
  });

  const cleaned = stripJsonFences(content);
  let json;
  try {
    json = JSON.parse(cleaned);
  } catch (err) {
    console.error('[invoice] bad JSON:', content.slice(0, 300));
    if (structured) return structured;
    throw new Error(`Invalid invoice JSON: ${err.message}`);
  }

  // Merge structured identity if LLM blanked them
  if (structured) {
    if (!json.customer_name && structured.customer_name) {
      json.customer_name = structured.customer_name;
    }
    if (!json.phone && structured.phone) json.phone = structured.phone;
    if (
      (!Array.isArray(json.items) || !json.items.length) &&
      structured.items.length
    ) {
      json.items = structured.items;
    }
    if (json.total == null && structured.total != null) json.total = structured.total;
  }

  json._source = 'llm';
  return json;
}

module.exports = {
  INVOICE_EXTRACTION_PROMPT,
  extractInvoiceFromOcr,
  parseInvoiceFromStructuredOcr,
};
