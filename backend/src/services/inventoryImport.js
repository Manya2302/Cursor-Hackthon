const Papa = require('papaparse');
const { getApiKey, withGroqKey } = require('./groqKeys');

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';

/**
 * Map sample_inventory.csv (and similar) headers → normalized row shape.
 * Shape: { productId, name, category, stock, price, supplier }
 */
function mapHeader(h) {
  const key = String(h || '')
    .trim()
    .toLowerCase()
    .replace(/[_]+/g, ' ');
  if (/^product\s*id$|^id$|^sku$|^code$/.test(key)) return 'productId';
  if (/^product\s*name$|^name$|^item$/.test(key)) return 'name';
  if (/^categor/.test(key)) return 'category';
  if (/^stock$|^qty$|^quantity$/.test(key)) return 'stock';
  if (/^price$|^mrp$|^rate$/.test(key)) return 'price';
  if (/^supplier$|^vendor$/.test(key)) return 'supplier';
  return null;
}

function normalizeRow(raw) {
  const productId = raw.productId != null ? String(raw.productId).trim() : '';
  const name = raw.name != null ? String(raw.name).trim() : '';
  const category =
    raw.category != null && String(raw.category).trim()
      ? String(raw.category).trim()
      : null;
  const supplier =
    raw.supplier != null && String(raw.supplier).trim()
      ? String(raw.supplier).trim()
      : null;

  const stockRaw = raw.stock;
  const priceRaw = raw.price;
  const stock =
    stockRaw === '' || stockRaw == null ? NaN : Number(String(stockRaw).replace(/,/g, ''));
  const price =
    priceRaw === '' || priceRaw == null ? NaN : Number(String(priceRaw).replace(/,/g, ''));

  return { productId, name, category, stock, price, supplier };
}

/**
 * parseCsv(fileBuffer) → normalized row objects matching products schema fields.
 */
function parseCsv(fileBuffer) {
  const text = Buffer.isBuffer(fileBuffer)
    ? fileBuffer.toString('utf8')
    : String(fileBuffer || '');

  // Strip BOM
  const cleaned = text.replace(/^\uFEFF/, '');

  const parsed = Papa.parse(cleaned, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => mapHeader(h) || String(h || '').trim(),
  });

  if (parsed.errors?.length) {
    console.warn(
      '[inventoryImport] CSV parse warnings:',
      parsed.errors.slice(0, 3).map((e) => e.message)
    );
  }

  const rows = [];
  for (const row of parsed.data || []) {
    // Only keep rows that look like inventory (have id or name)
    if (!row || (typeof row !== 'object')) continue;
    const mapped = {};
    for (const [k, v] of Object.entries(row)) {
      const field = mapHeader(k) || k;
      if (
        field === 'productId' ||
        field === 'name' ||
        field === 'category' ||
        field === 'stock' ||
        field === 'price' ||
        field === 'supplier'
      ) {
        mapped[field] = v;
      }
    }
    const norm = normalizeRow(mapped);
    if (!norm.productId && !norm.name) continue;
    rows.push(norm);
  }

  return rows;
}

/**
 * Vision / OCR extraction of an inventory table image → same shape as parseCsv.
 */
async function extractInventoryFromImage(imageBuffer, mimeType = 'image/jpeg') {
  const mime = (mimeType || 'image/jpeg').split(';')[0].trim();
  const b64 = Buffer.from(imageBuffer).toString('base64');
  const dataUrl = `data:${mime};base64,${b64}`;

  const system = `You extract product inventory tables from photos.
Return ONLY a JSON array (no markdown). Each object:
{"productId":"string","name":"string","category":"string|null","stock":number,"price":number,"supplier":"string|null"}
Rules:
- productId: SKU / Product ID if visible; else invent a short CODE from the name (e.g. RICE-5KG).
- stock and price must be numbers (no currency symbols).
- Do not invent products that are not on the sheet.
- Empty table → [].`;

  const body = await withGroqKey(async (apiKey) => {
    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract every product row from this inventory / stock sheet photo.',
              },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Inventory image extract failed: ${text.slice(0, 200)}`);
    }
    return text;
  });

  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('Inventory image extract returned non-JSON');
  }

  let content = json?.choices?.[0]?.message?.content || '';
  // Strip think / fences
  content = String(content)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<think>[\s\S]*$/i, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = content.indexOf('[');
  const end = content.lastIndexOf(']');
  if (start < 0 || end < start) {
    console.warn('[inventoryImport] no array in vision response:', content.slice(0, 200));
    return [];
  }

  let arr;
  try {
    arr = JSON.parse(content.slice(start, end + 1));
  } catch (err) {
    throw new Error(`Could not parse inventory rows: ${err.message}`);
  }

  if (!Array.isArray(arr)) return [];
  return arr.map((r) =>
    normalizeRow({
      productId: r.productId ?? r.id ?? r.sku,
      name: r.name ?? r.product_name ?? r.productName,
      category: r.category,
      stock: r.stock,
      price: r.price,
      supplier: r.supplier,
    })
  );
}

/**
 * validateRows(rows) → { validRows, invalidRows }
 * Each valid row needs non-empty id, numeric stock, numeric price.
 */
function validateRows(rows) {
  const validRows = [];
  const invalidRows = [];

  (rows || []).forEach((row, index) => {
    const reasons = [];
    const productId = row?.productId != null ? String(row.productId).trim() : '';
    if (!productId) reasons.push('missing product id');

    const stock = Number(row?.stock);
    if (!Number.isFinite(stock)) reasons.push('stock must be numeric');

    const price = Number(row?.price);
    if (!Number.isFinite(price)) reasons.push('price must be numeric');

    const name = row?.name != null ? String(row.name).trim() : '';
    if (!name) reasons.push('missing product name');

    if (reasons.length) {
      invalidRows.push({ index, row, reasons });
    } else {
      validRows.push({
        productId,
        name,
        category: row.category || null,
        stock,
        price,
        supplier: row.supplier || null,
      });
    }
  });

  return { validRows, invalidRows };
}

module.exports = {
  parseCsv,
  extractInventoryFromImage,
  validateRows,
  normalizeRow,
  mapHeader,
};
