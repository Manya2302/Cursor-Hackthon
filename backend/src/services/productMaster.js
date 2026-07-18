const { Pool } = require('pg');
const { GUJARATI_ITEM_LEXICON } = require('../utils/gujarati');
const { normalizeUnit, roundMoney } = require('../utils/units');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString =
    process.env.DATABASE_URL || process.env.SUPABASE_API || '';
  if (!connectionString) return null;
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });
  return pool;
}

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Find product by alias / name / barcode for a vendor.
 */
async function findByAlias(vendorId, nameOrAlias) {
  const pg = getPool();
  if (!pg || !nameOrAlias) return null;

  const norm = normalizeName(nameOrAlias);
  if (!norm) return null;

  // Exact alias
  let r = await pg.query(
    `select m.*
       from product_aliases a
       join product_master m on m.id = a.product_id
      where a.vendor_id = $1 and a.alias_normalized = $2 and m.active = true
      limit 1`,
    [vendorId, norm]
  );
  if (r.rows[0]) return r.rows[0];

  // Normalized product name
  r = await pg.query(
    `select * from product_master
      where vendor_id = $1 and normalized_name = $2 and active = true
      limit 1`,
    [vendorId, norm]
  );
  if (r.rows[0]) return r.rows[0];

  // Lexicon bridge: ખાંડ ↔ Sugar
  const hit = GUJARATI_ITEM_LEXICON.find(
    (x) =>
      x.gu === nameOrAlias ||
      x.en.toLowerCase() === norm ||
      x.aliases.some((a) => a.toLowerCase() === norm || a === nameOrAlias)
  );
  if (hit) {
    for (const candidate of [hit.en, hit.gu, ...hit.aliases]) {
      const n = normalizeName(candidate);
      r = await pg.query(
        `select m.*
           from product_aliases a
           join product_master m on m.id = a.product_id
          where a.vendor_id = $1 and a.alias_normalized = $2 and m.active
          limit 1`,
        [vendorId, n]
      );
      if (r.rows[0]) return r.rows[0];
      r = await pg.query(
        `select * from product_master
          where vendor_id = $1 and normalized_name = $2 and active
          limit 1`,
        [vendorId, n]
      );
      if (r.rows[0]) return r.rows[0];
    }
  }

  // Fuzzy contains
  r = await pg.query(
    `select * from product_master
      where vendor_id = $1 and active
        and (normalized_name like '%' || $2 || '%' or product_name ilike '%' || $3 || '%')
      order by length(normalized_name) asc
      limit 1`,
    [vendorId, norm, String(nameOrAlias).trim()]
  );
  return r.rows[0] || null;
}

async function addAlias(vendorId, productId, alias) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');
  const a = String(alias || '').trim();
  if (!a) return null;
  const norm = normalizeName(a);
  await pg.query(
    `insert into product_aliases (vendor_id, product_id, alias, alias_normalized)
     values ($1, $2, $3, $4)
     on conflict (vendor_id, alias_normalized) do update
       set product_id = excluded.product_id, alias = excluded.alias`,
    [vendorId, productId, a, norm]
  );
  return { alias: a, alias_normalized: norm };
}

/**
 * Create or return existing product. Adds EN/GU lexicon aliases.
 */
async function createProduct(vendorId, fields = {}) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const name = String(fields.name || fields.product_name || '').trim();
  if (!name) throw new Error('Product name required');

  const existing = await findByAlias(vendorId, name);
  if (existing) {
    return { product: existing, created: false };
  }

  const unit = normalizeUnit(fields.unit) || 'KG';
  const selling = roundMoney(fields.selling_price ?? fields.price ?? 0);
  const purchase = roundMoney(fields.purchase_price ?? 0);
  const norm = normalizeName(name);

  const client = await pg.connect();
  try {
    await client.query('begin');
    const ins = await client.query(
      `insert into product_master (
         vendor_id, product_name, normalized_name, category, brand, sku, barcode,
         hsn_code, gst_pct, purchase_price, selling_price, min_selling_price,
         max_selling_price, unit, current_stock, reorder_level, supplier, preferred_supplier
       ) values (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
       ) returning *`,
      [
        vendorId,
        name,
        norm,
        fields.category || null,
        fields.brand || null,
        fields.sku || null,
        fields.barcode || null,
        fields.hsn_code || null,
        fields.gst_pct != null ? Number(fields.gst_pct) : 0,
        purchase,
        selling,
        fields.min_selling_price != null ? Number(fields.min_selling_price) : null,
        fields.max_selling_price != null ? Number(fields.max_selling_price) : null,
        unit,
        fields.stock != null ? Number(fields.stock) : 0,
        fields.reorder_level != null ? Number(fields.reorder_level) : 5,
        fields.supplier || null,
        fields.preferred_supplier || null,
      ]
    );
    const product = ins.rows[0];

    await client.query(
      `insert into product_aliases (vendor_id, product_id, alias, alias_normalized)
       values ($1,$2,$3,$4)
       on conflict (vendor_id, alias_normalized) do nothing`,
      [vendorId, product.id, name, norm]
    );

    // Lexicon aliases
    const hit = GUJARATI_ITEM_LEXICON.find(
      (x) =>
        x.gu === name ||
        x.en.toLowerCase() === norm ||
        x.aliases.some((a) => a.toLowerCase() === norm)
    );
    if (hit) {
      for (const a of [hit.en, hit.gu, ...hit.aliases]) {
        await client.query(
          `insert into product_aliases (vendor_id, product_id, alias, alias_normalized)
           values ($1,$2,$3,$4)
           on conflict (vendor_id, alias_normalized) do nothing`,
          [vendorId, product.id, a, normalizeName(a)]
        );
      }
    }

    // Sync legacy products table
    const legacyId = `${vendorId}:${norm.replace(/\s+/g, '_')}`;
    await client.query(
      `insert into products (id, vendor_id, product_name, category, stock, price, supplier, low_stock_threshold, master_product_id, last_updated)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       on conflict (id) do update set
         product_name = excluded.product_name,
         price = excluded.price,
         stock = excluded.stock,
         master_product_id = excluded.master_product_id,
         last_updated = now()`,
      [
        legacyId,
        vendorId,
        name,
        fields.category || null,
        fields.stock != null ? Number(fields.stock) : 0,
        selling,
        fields.supplier || null,
        5,
        product.id,
      ]
    );

    await client.query('commit');
    return { product, created: true };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function updatePrices(vendorId, productId, updates = {}, meta = {}) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const cur = await pg.query(
    `select * from product_master where id = $1 and vendor_id = $2`,
    [productId, vendorId]
  );
  if (!cur.rows[0]) throw new Error('Product not found');
  const row = cur.rows[0];

  const client = await pg.connect();
  try {
    await client.query('begin');
    const sets = [];
    const vals = [productId, vendorId];
    let i = 3;

    async function track(field, newVal) {
      if (newVal == null || Number.isNaN(Number(newVal))) return;
      const nv = roundMoney(newVal);
      const ov = roundMoney(row[field]);
      if (ov === nv) return;
      sets.push(`${field} = $${i++}`);
      vals.push(nv);
      await client.query(
        `insert into product_price_history
           (vendor_id, product_id, field, old_price, new_price, reason, source_extraction_id, updated_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          vendorId,
          productId,
          field,
          ov,
          nv,
          meta.reason || 'manual_update',
          meta.sourceExtractionId || null,
          meta.updatedBy || 'whatsapp',
        ]
      );
    }

    if (updates.selling_price != null) await track('selling_price', updates.selling_price);
    if (updates.purchase_price != null) await track('purchase_price', updates.purchase_price);
    if (updates.gst_pct != null) await track('gst_pct', updates.gst_pct);

    if (updates.supplier != null) {
      sets.push(`supplier = $${i++}`);
      vals.push(updates.supplier);
    }
    if (updates.unit != null) {
      sets.push(`unit = $${i++}`);
      vals.push(normalizeUnit(updates.unit) || row.unit);
    }
    if (updates.barcode != null) {
      sets.push(`barcode = $${i++}`);
      vals.push(String(updates.barcode));
    }
    if (updates.stock != null) {
      sets.push(`current_stock = $${i++}`);
      vals.push(Number(updates.stock));
    }

    if (sets.length) {
      sets.push('updated_at = now()');
      await client.query(
        `update product_master set ${sets.join(', ')} where id = $1 and vendor_id = $2`,
        vals
      );
    }

    // Sync legacy price
    if (updates.selling_price != null) {
      await client.query(
        `update products set price = $3, last_updated = now()
          where vendor_id = $1 and master_product_id = $2`,
        [vendorId, productId, roundMoney(updates.selling_price)]
      );
    }

    await client.query('commit');
    const fresh = await pg.query(`select * from product_master where id = $1`, [
      productId,
    ]);
    return fresh.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function listProducts(vendorId) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');
  const r = await pg.query(
    `select m.*,
            (m.current_stock <= m.reorder_level) as low_stock,
            coalesce(
              (select json_agg(a.alias order by a.alias)
                 from product_aliases a where a.product_id = m.id),
              '[]'::json
            ) as aliases
       from product_master m
      where m.vendor_id = $1 and m.active
      order by m.product_name`,
    [vendorId]
  );
  return r.rows;
}

async function adjustStock(client, vendorId, productId, delta, reason, extractionId) {
  const r = await client.query(
    `update product_master
        set current_stock = greatest(0, current_stock + $3),
            updated_at = now()
      where id = $1 and vendor_id = $2
      returning current_stock`,
    [productId, vendorId, delta]
  );
  if (!r.rows[0]) return null;
  const newStock = Number(r.rows[0].current_stock);
  await client.query(
    `insert into inventory_movements
       (vendor_id, product_id, change, reason, source_extraction_id, new_stock_level)
     values ($1,$2,$3,$4,$5,$6)`,
    [vendorId, productId, delta, reason, extractionId || null, newStock]
  );
  // Legacy sync
  await client.query(
    `update products set stock = $3, last_updated = now()
      where vendor_id = $1 and master_product_id = $2`,
    [vendorId, productId, newStock]
  );
  return newStock;
}

/**
 * Parse natural-language product setup from WhatsApp text (no LLM required for common patterns).
 */
function parseProductSetupMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Add Sugar / Add product Sugar
  let m = raw.match(/^(?:add|create|new)\s+(?:product\s+)?(.+)$/i);
  if (m) {
    return { action: 'add', name: m[1].trim() };
  }

  // Set Sugar price to 50 / Sugar selling price 50 / Sugar price = 50 per kg
  m = raw.match(
    /^(?:set\s+)?(.+?)\s+(?:selling\s+)?price(?:\s+to|\s*=|:)?\s*₹?\s*(\d+(?:\.\d+)?)\s*(?:per\s+)?(kg|gm|g|liter|l|ml|pcs)?/i
  );
  if (m && !/purchase|cost|buy/i.test(m[0])) {
    return {
      action: 'set_selling',
      name: m[1].replace(/^(set|the)\s+/i, '').trim(),
      selling_price: Number(m[2]),
      unit: m[3] || null,
    };
  }

  // Sugar purchase price is 45
  m = raw.match(
    /^(.+?)\s+(?:purchase|cost|buy)\s+price(?:\s+is|\s+to|\s*=|:)?\s*₹?\s*(\d+(?:\.\d+)?)/i
  );
  if (m) {
    return {
      action: 'set_purchase',
      name: m[1].trim(),
      purchase_price: Number(m[2]),
    };
  }

  // GST is 5% for Sugar / Sugar GST 5
  m = raw.match(/^(?:(.+?)\s+)?gst(?:\s+is|\s*=|:)?\s*(\d+(?:\.\d+)?)\s*%?(?:\s+(?:for|on)\s+(.+))?$/i);
  if (m) {
    const name = (m[1] || m[3] || '').trim();
    if (name) {
      return { action: 'set_gst', name, gst_pct: Number(m[2]) };
    }
  }

  // Supplier is Raj Traders for Sugar / Sugar supplier Raj
  m = raw.match(
    /^(?:(.+?)\s+)?supplier(?:\s+is|\s*=|:)?\s+(.+?)(?:\s+for\s+(.+))?$/i
  );
  if (m) {
    const name = (m[1] || m[3] || '').trim();
    const supplier = (m[2] || '').trim();
    if (name && supplier && !/^is$/i.test(supplier)) {
      return { action: 'set_supplier', name, supplier };
    }
  }

  // Barcode 123456 for Sugar
  m = raw.match(/^barcode\s+(\S+)(?:\s+(?:for|on)\s+(.+))?$/i);
  if (m && m[2]) {
    return { action: 'set_barcode', name: m[2].trim(), barcode: m[1] };
  }

  return null;
}

/**
 * Detect stock adjustment commands like:
 *   "Add to maggi stock 20", "Add 20 to maggi", "Increase maggi stock by 20",
 *   "Reduce maggi stock by 5", "maggi stock +20", "Set maggi stock to 20".
 * These change stock of an EXISTING product — they must NOT create a new product.
 * @returns {{ name: string, delta?: number, setTo?: number } | null}
 */
function parseStockAdjustMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const UNIT =
    '(?:kgs?|gms?|grams?|litres?|liters?|ml|pcs|pc|pieces?|units?|nos?|packets?|boxes?|box|g|l)';
  const ADD = 'add|increase|increment|plus|top\\s*up|topup|restock|refill|received?|got';
  const SUB = 'reduce|decrease|remove|subtract|minus|deduct|less|sold|sell|used|use';
  const isSub = (v) => new RegExp(`^(?:${SUB})$`, 'i').test(v);

  // 1) "<verb> [to/from] <name> stock [by|to] <n>"  → "Add to maggi stock 20"
  let m = raw.match(
    new RegExp(
      `^(${ADD}|${SUB})\\s+(?:to\\s+|from\\s+|the\\s+|in\\s+|into\\s+)?(.+?)\\s+(?:stock|inventory|qty|quantity|units?)\\s+(?:by\\s+|to\\s+|=\\s*)?(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\.?$`,
      'i'
    )
  );
  if (m) {
    return { name: cleanAdjustName(m[2]), delta: (isSub(m[1]) ? -1 : 1) * Number(m[3]) };
  }

  // 2) "<verb> <n> [unit] to/from/in <name> [stock]"  → "Add 20 to maggi stock"
  m = raw.match(
    new RegExp(
      `^(${ADD}|${SUB})\\s+(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\s+(?:to|from|in|into|of|for)\\s+(.+?)(?:\\s+(?:stock|inventory))?\\.?$`,
      'i'
    )
  );
  if (m) {
    return { name: cleanAdjustName(m[3]), delta: (isSub(m[1]) ? -1 : 1) * Number(m[2]) };
  }

  // 3) "<name> [stock] +20" / "<name> stock -5"
  m = raw.match(
    new RegExp(
      `^(.+?)\\s+(?:stock|inventory\\s+)?\\s*([+\\-])\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\s*(?:stock|inventory)?\\.?$`,
      'i'
    )
  );
  if (m) {
    return { name: cleanAdjustName(m[1]), delta: (m[2] === '-' ? -1 : 1) * Number(m[3]) };
  }

  // 4) "set <name> stock to 20"
  m = raw.match(
    new RegExp(
      `^(?:set|make|update|change|adjust)\\s+(?:the\\s+)?(.+?)\\s+(?:stock|inventory|qty|quantity)\\s+(?:to|=|as)?\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\.?$`,
      'i'
    )
  );
  if (m) {
    return { name: cleanAdjustName(m[1]), setTo: Number(m[2]) };
  }

  // 5) "set stock of <name> to 20"
  m = raw.match(
    new RegExp(
      `^(?:set|make|update|change|adjust)\\s+(?:the\\s+)?(?:stock|inventory|qty|quantity)\\s+(?:of|for)\\s+(.+?)\\s+(?:to|=|as)?\\s*(\\d+(?:\\.\\d+)?)\\s*${UNIT}?\\.?$`,
      'i'
    )
  );
  if (m) {
    return { name: cleanAdjustName(m[1]), setTo: Number(m[2]) };
  }

  return null;
}

function cleanAdjustName(name) {
  return String(name || '')
    .replace(/^(?:to|from|the|in|into|of|for|a|an|my|our)\s+/i, '')
    .replace(/\s+(?:stock|inventory|qty|quantity)$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
}

/**
 * Apply a stock adjustment (delta or absolute setTo) to an existing product.
 * Never creates a new product — returns a not-found message instead.
 */
async function applyStockAdjust(vendorId, adj) {
  const name = cleanAdjustName(adj?.name);
  if (!name) return { ok: false, message: 'Which product? e.g. *Add 20 to maggi stock*' };

  const product = await findByAlias(vendorId, name);
  if (!product) {
    return {
      ok: false,
      message:
        `❓ No product matching *${name}* in Product Master.\n` +
        `Add it first: *Add ${name}* — then adjust its stock.`,
    };
  }

  let delta = adj.delta;
  if (adj.setTo != null) delta = Number(adj.setTo) - Number(product.current_stock);
  if (!Number.isFinite(delta) || delta === 0) {
    return {
      ok: true,
      message:
        `ℹ️ *${product.product_name}* stock unchanged — still *${product.current_stock}* ${product.unit}.`,
    };
  }

  const pg = getPool();
  if (!pg) return { ok: false, message: 'Database not configured.' };

  const client = await pg.connect();
  try {
    await client.query('begin');
    const newStock = await adjustStock(
      client,
      vendorId,
      product.id,
      delta,
      'whatsapp_manual_adjust',
      null
    );
    await client.query('commit');
    if (newStock == null) {
      return { ok: false, message: `Could not update stock for *${product.product_name}*.` };
    }
    const sign = delta > 0 ? '+' : '';
    return {
      ok: true,
      message:
        `✅ *${product.product_name}* stock updated\n` +
        `${product.current_stock} → *${newStock}* ${product.unit} (${sign}${delta})`,
    };
  } catch (err) {
    await client.query('rollback');
    return { ok: false, message: `Could not update stock: ${err.message}` };
  } finally {
    client.release();
  }
}

async function applyProductSetup(vendorId, setup) {
  if (!setup?.name && setup.action === 'add') {
    throw new Error('Product name required');
  }

  if (setup.action === 'add') {
    return createProduct(vendorId, { name: setup.name });
  }

  let product = await findByAlias(vendorId, setup.name);
  if (!product) {
    const created = await createProduct(vendorId, {
      name: setup.name,
      selling_price: setup.selling_price,
      purchase_price: setup.purchase_price,
      unit: setup.unit,
      gst_pct: setup.gst_pct,
      supplier: setup.supplier,
      barcode: setup.barcode,
    });
    product = created.product;
  }

  const updates = {};
  if (setup.action === 'set_selling') {
    updates.selling_price = setup.selling_price;
    if (setup.unit) updates.unit = setup.unit;
  }
  if (setup.action === 'set_purchase') updates.purchase_price = setup.purchase_price;
  if (setup.action === 'set_gst') updates.gst_pct = setup.gst_pct;
  if (setup.action === 'set_supplier') updates.supplier = setup.supplier;
  if (setup.action === 'set_barcode') updates.barcode = setup.barcode;

  if (Object.keys(updates).length) {
    product = await updatePrices(vendorId, product.id, updates, {
      reason: `whatsapp_${setup.action}`,
    });
  }

  return { product, created: false, action: setup.action };
}

/**
 * Detect NL product lookup questions (qty / price / list) — not setup, not statements.
 * @returns {{ action: 'stock'|'price'|'info'|'list'|'low_stock', name?: string } | null}
 */
function parseProductQueryMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  // Don't steal product-setup commands
  if (/^(?:add|create|new|set)\s+/i.test(raw)) return null;
  if (/\b(purchase|selling)\s+price\b/i.test(raw) && /(?:to|=|:)\s*₹?\s*\d/.test(raw)) {
    return null;
  }

  const t = raw.toLowerCase();

  if (
    /^(list|show)\s+(all\s+)?products?\b/i.test(raw) ||
    /^(all\s+)?products?\s*(list|catalog)?$/i.test(t) ||
    /show\s+(my\s+)?(stock|inventory|catalog)/i.test(t) ||
    /બધા\s*પ્રોડક્ટ|પ્રોડક્ટ\s*લિસ્ટ/i.test(raw)
  ) {
    return { action: 'list' };
  }

  if (/low\s*stock|reorder|out\s*of\s*stock|ઓછો\s*સ્ટોક/i.test(t)) {
    return { action: 'low_stock' };
  }

  // quantity / stock of X
  let m = raw.match(
    /(?:what(?:'s| is)?|tell me|send(?:\s+me)?|show(?:\s+me)?|get|check)?\s*(?:the\s+)?(?:product\s+)?(?:quantity|qty|stock|inventory)\s+(?:of|for)\s+(.+?)\s*[?.!]*$/i
  );
  if (m) {
    return stockOrInfoQuery('stock', m[1]);
  }

  // X quantity / stock / qty
  m = raw.match(
    /^(.+?)\s+(?:product\s+)?(?:quantity|qty|stock|inventory)\s*[?.!]*$/i
  );
  if (m && !/^(what|how|send|show|tell|the|a|an)$/i.test(m[1].trim())) {
    return stockOrInfoQuery('stock', m[1]);
  }

  // how much X (do I have / stock / left)
  m = raw.match(
    /how\s+much\s+(.+?)(?:\s+(?:stock|left|do\s+i\s+have|available))?\s*[?.!]*$/i
  );
  if (m) {
    return stockOrInfoQuery('stock', m[1]);
  }

  // price of X / X price (read-only, no "set/to 50")
  m = raw.match(
    /(?:what(?:'s| is)?|tell me|send(?:\s+me)?|show(?:\s+me)?)?\s*(?:the\s+)?(?:selling\s+)?price\s+(?:of|for)\s+(.+?)\s*[?.!]*$/i
  );
  if (m && !/\d/.test(m[1])) {
    return stockOrInfoQuery('price', m[1]);
  }

  // send me product / details of X (and Y…) — never a financial report
  m = raw.match(
    /(?:send|show|give|get)(?:\s+me)?\s+(?:the\s+)?(?:products?|details|info|information)\s+(?:of|for|about)\s+(.+?)\s*[?.!]*$/i
  );
  if (m) {
    return stockOrInfoQuery('info', m[1]);
  }

  // "product milk" / "products milk sugar"
  m = raw.match(
    /^(?:product|products)\s+(?:of\s+|for\s+|about\s+)?(.+?)\s*[?.!]*$/i
  );
  if (m && !/^(list|catalog|master)$/i.test(m[1].trim())) {
    return stockOrInfoQuery('info', m[1]);
  }

  // Gujarati: દૂધ નો સ્ટોક / દૂધની જથ્થો / દૂધ ભાવ
  m = raw.match(
    /(.+?)\s*(?:નો|ની|નું)?\s*(?:સ્ટોક|જથ્થો|qty|quantity|stock)\s*[?.!]*$/i
  );
  if (m && /[\u0A80-\u0AFF]/.test(raw)) {
    return { action: 'stock', name: cleanProductQueryName(m[1]) };
  }
  m = raw.match(
    /(.+?)\s*(?:નો|ની|નું)?\s*(?:ભાવ|કિંમત|price)\s*[?.!]*$/i
  );
  if (m && /[\u0A80-\u0AFF]/.test(raw) && !/\d/.test(m[1])) {
    return { action: 'price', name: cleanProductQueryName(m[1]) };
  }

  return null;
}

function cleanProductQueryName(name) {
  return String(name || '')
    .replace(/^(the|a|an|my|our)\s+/i, '')
    .replace(/\s+(please|product|item)$/i, '')
    .replace(/[?.!,]+$/g, '')
    .trim();
}

/** Split "milk and sugar" / "milk, ghee" into names; single name otherwise. */
function stockOrInfoQuery(action, rawNames) {
  const names = String(rawNames || '')
    .split(/\s*(?:,|&|\band\b|\bor\b)\s*/i)
    .map(cleanProductQueryName)
    .filter(Boolean);
  if (names.length > 1) {
    return { action, names };
  }
  return { action, name: names[0] || cleanProductQueryName(rawNames) };
}

/**
 * Answer product questions from Product Master (SQL only — never invent stock/price).
 */
async function runProductQuery(vendorId, query) {
  if (!query?.action) throw new Error('Invalid product query');

  if (query.action === 'list') {
    const rows = await listProducts(vendorId);
    if (!rows.length) {
      return '📦 No products in Product Master yet.\nReply *Add Milk* then *Set Milk price to 52* to add one.';
    }
    const lines = rows.slice(0, 25).map(
      (p) =>
        `• *${p.product_name}* — stock *${p.current_stock}* ${p.unit} · sell ₹${p.selling_price}`
    );
    return (
      `📦 *Products (${rows.length})*\n` +
      lines.join('\n') +
      (rows.length > 25 ? `\n…and ${rows.length - 25} more` : '')
    );
  }

  if (query.action === 'low_stock') {
    const rows = (await listProducts(vendorId)).filter((p) => p.low_stock);
    if (!rows.length) return '✅ No low-stock products right now.';
    return (
      `⚠️ *Low stock*\n` +
      rows
        .map(
          (p) =>
            `• *${p.product_name}* — ${p.current_stock} ${p.unit} (reorder ≤ ${p.reorder_level})`
        )
        .join('\n')
    );
  }

  const names =
    Array.isArray(query.names) && query.names.length
      ? query.names
      : query.name
        ? [query.name]
        : [];
  if (!names.length) return 'Which product? Example: *quantity of milk*';

  const blocks = [];
  const missing = [];
  for (const name of names) {
    const block = await formatOneProductAnswer(vendorId, name, query.action);
    if (block) blocks.push(block);
    else missing.push(name);
  }

  if (!blocks.length) {
    const label = names.join(', ');
    return (
      `❓ No product matching *${label}* in Product Master.\n` +
      `Add it: *Add ${names[0]}* then *Set ${names[0]} price to …*`
    );
  }

  let msg = blocks.join('\n\n');
  if (missing.length) {
    msg +=
      `\n\n❓ Not found: *${missing.join(', ')}*\n` +
      `Add with: *Add ${missing[0]}*`;
  }
  return msg;
}

async function formatOneProductAnswer(vendorId, name, action) {
  const product = await findByAlias(vendorId, name);
  if (!product) {
    // Also try legacy products table
    const pg = getPool();
    if (pg) {
      const legacy = await pg.query(
        `select product_name, stock, price, id
           from products
          where vendor_id = $1
            and (product_name ilike $2 or product_name ilike $3)
          order by length(product_name) asc
          limit 1`,
        [vendorId, name, `%${name}%`]
      );
      if (legacy.rows[0]) {
        const p = legacy.rows[0];
        if (action === 'price') {
          return `💰 *${p.product_name}*\nSell price: *₹${p.price}* (legacy catalog)`;
        }
        if (action === 'stock') {
          return `📦 *${p.product_name}*\nQuantity / stock: *${p.stock}*`;
        }
        return (
          `📦 *${p.product_name}*\n` +
          `Stock: *${p.stock}*\n` +
          `Price: *₹${p.price}*`
        );
      }
    }
    return null;
  }

  if (action === 'stock') {
    return (
      `📦 *${product.product_name}*\n` +
      `Quantity / stock: *${product.current_stock}* ${product.unit}`
    );
  }
  if (action === 'price') {
    return (
      `💰 *${product.product_name}*\n` +
      `Sell: *₹${product.selling_price}* / ${product.unit}\n` +
      `Buy: *₹${product.purchase_price}* / ${product.unit}`
    );
  }
  // info
  return (
    `📦 *${product.product_name}*\n` +
    `Stock: *${product.current_stock}* ${product.unit}\n` +
    `Sell: ₹${product.selling_price} / ${product.unit}\n` +
    `Buy: ₹${product.purchase_price} / ${product.unit}` +
    (product.supplier ? `\nSupplier: ${product.supplier}` : '') +
    (product.gst_pct ? `\nGST: ${product.gst_pct}%` : '')
  );
}

module.exports = {
  normalizeName,
  findByAlias,
  addAlias,
  createProduct,
  updatePrices,
  listProducts,
  adjustStock,
  parseProductSetupMessage,
  applyProductSetup,
  parseStockAdjustMessage,
  applyStockAdjust,
  parseProductQueryMessage,
  runProductQuery,
  getPool,
};
