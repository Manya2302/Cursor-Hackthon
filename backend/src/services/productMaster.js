const { Pool } = require('pg');
const { parseWeightText } = require('../utils/gujarati');

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

function isMissingTableError(err) {
  return err?.code === '42P01';
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function normalizeProductName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUnit(unit) {
  const raw = String(unit || '').trim().toUpperCase();
  if (!raw) return null;
  const map = {
    KILO: 'KG',
    KGS: 'KG',
    KG: 'KG',
    KI: 'KG',
    GRAM: 'GM',
    GRAMS: 'GM',
    GM: 'GM',
    G: 'GM',
    LITRE: 'L',
    LITER: 'L',
    LTR: 'L',
    L: 'L',
    ML: 'ML',
    MILLILITER: 'ML',
    MILLILITRE: 'ML',
    PCS: 'PIECE',
    PC: 'PIECE',
    PIECE: 'PIECE',
    PACKET: 'PACKET',
    PKT: 'PACKET',
    BOTTLE: 'BOTTLE',
    BOX: 'BOX',
    BAG: 'BAG',
    MANN: 'MANN',
  };
  return map[raw] || raw;
}

function createLegacyProductId(vendorId, normalizedName) {
  return `${vendorId}:${String(normalizedName).replace(/\s+/g, '_')}`;
}

function convertQuantity(quantity, fromUnit, toUnit) {
  const q = Number(quantity);
  if (!Number.isFinite(q)) return null;
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if (!from || !to) return null;
  if (from === to) return q;

  const toBase = (val, unit) => {
    if (unit === 'KG') return { value: val * 1000, base: 'GM' };
    if (unit === 'GM') return { value: val, base: 'GM' };
    if (unit === 'MANN') return { value: val * 20000, base: 'GM' };
    if (unit === 'L') return { value: val * 1000, base: 'ML' };
    if (unit === 'ML') return { value: val, base: 'ML' };
    if (['PIECE', 'PACKET', 'BOTTLE', 'BOX', 'BAG'].includes(unit)) {
      return { value: val, base: unit };
    }
    return null;
  };

  const b1 = toBase(q, from);
  const b2 = toBase(1, to);
  if (!b1 || !b2 || b1.base !== b2.base) return null;
  return b1.value / b2.value;
}

function deriveQuantityAndUnit(item) {
  const qtyCandidate = Number(item?.quantity);
  let quantity = Number.isFinite(qtyCandidate) ? qtyCandidate : null;
  let unit = normalizeUnit(item?.unit);

  if ((quantity == null || !unit) && item?.weight_text) {
    const parsed = parseWeightText(item.weight_text);
    if (quantity == null && Number.isFinite(Number(parsed.quantity))) {
      quantity = Number(parsed.quantity);
    }
    if (!unit && parsed.unit) unit = normalizeUnit(parsed.unit);
  }

  return { quantity, unit };
}

async function ensureSupplierParty(client, vendorId, supplierName) {
  const name = String(supplierName || '').trim();
  if (!name) return null;

  const existing = await client.query(
    `select id, party_type
       from parties
      where vendor_id = $1 and lower(name) = lower($2)
      limit 1`,
    [vendorId, name]
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.party_type === 'customer') {
      await client.query(
        `update parties set party_type = 'both' where id = $1`,
        [row.id]
      );
    }
    return row.id;
  }

  const inserted = await client.query(
    `insert into parties (vendor_id, name, party_type)
     values ($1, $2, 'supplier')
     returning id`,
    [vendorId, name]
  );
  return inserted.rows[0].id;
}

async function findProductMatch(client, vendorId, productName) {
  const normalized = normalizeProductName(productName);
  if (!normalized) return null;

  try {
    const modern = await client.query(
      `select pm.id,
              pm.product_name,
              pm.normalized_name,
              pm.base_unit,
              pm.purchase_price,
              pm.selling_price
         from product_master pm
         left join product_aliases pa
           on pa.product_id = pm.id
          and pa.vendor_id = pm.vendor_id
        where pm.vendor_id = $1
          and pm.is_active = true
          and (
            pm.normalized_name = $2
            or pa.normalized_alias = $2
          )
        order by
          case when pm.normalized_name = $2 then 0 else 1 end,
          pa.created_at asc nulls last
        limit 1`,
      [vendorId, normalized]
    );
    if (modern.rows[0]) {
      return {
        productId: modern.rows[0].id,
        productName: modern.rows[0].product_name,
        normalizedName: modern.rows[0].normalized_name,
        baseUnit: modern.rows[0].base_unit,
        purchasePrice: modern.rows[0].purchase_price,
        sellingPrice: modern.rows[0].selling_price,
        legacy: false,
      };
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  const legacy = await client.query(
    `select id, product_name, price
       from products
      where vendor_id = $1 and lower(product_name) = lower($2)
      limit 1`,
    [vendorId, productName]
  );
  if (!legacy.rows[0]) return null;
  return {
    productId: legacy.rows[0].id,
    productName: legacy.rows[0].product_name,
    normalizedName: normalized,
    baseUnit: null,
    purchasePrice: null,
    sellingPrice: legacy.rows[0].price,
    legacy: true,
  };
}

async function ensureProductMaster(
  client,
  vendorId,
  {
    productName,
    unit = null,
    supplierPartyId = null,
    categoryName = null,
    price = null,
    priceType = 'purchase',
    createIfMissing = true,
  } = {}
) {
  const name = String(productName || '').trim();
  if (!name) return null;
  const normalized = normalizeProductName(name);
  const existing = await findProductMatch(client, vendorId, name);
  if (existing) {
    if (!existing.legacy) {
      try {
        await client.query(
          `insert into product_aliases
             (vendor_id, product_id, alias_name, normalized_alias, source)
           values ($1, $2, $3, $4, 'extraction')
           on conflict (vendor_id, normalized_alias) do nothing`,
          [vendorId, existing.productId, name, normalized]
        );
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }
    }
    return { ...existing, created: false };
  }

  if (!createIfMissing) return null;

  const normalizedUnit = normalizeUnit(unit) || 'PIECE';
  const numericPrice = Number(price);
  const purchasePrice =
    priceType === 'purchase' && Number.isFinite(numericPrice) ? numericPrice : null;
  const sellingPrice =
    priceType === 'selling' && Number.isFinite(numericPrice) ? numericPrice : null;

  try {
    const inserted = await client.query(
      `insert into product_master
         (vendor_id, product_name, normalized_name, base_unit, purchase_price, selling_price, supplier_party_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id, product_name, normalized_name, base_unit, purchase_price, selling_price`,
      [
        vendorId,
        name,
        normalized,
        normalizedUnit,
        purchasePrice,
        sellingPrice,
        supplierPartyId,
      ]
    );
    const row = inserted.rows[0];

    await client.query(
      `insert into product_aliases
         (vendor_id, product_id, alias_name, normalized_alias, source)
       values ($1, $2, $3, $4, 'extraction')
       on conflict (vendor_id, normalized_alias) do nothing`,
      [vendorId, row.id, name, normalized]
    );

    const legacyId = createLegacyProductId(vendorId, normalized);
    await client.query(
      `insert into products
         (id, vendor_id, product_name, category, stock, price, supplier, last_updated)
       values ($1, $2, $3, $4, 0, $5, null, now())
       on conflict (id) do update
         set product_name = excluded.product_name,
             price = greatest(products.price, excluded.price),
             last_updated = now()`,
      [legacyId, vendorId, name, categoryName, Number.isFinite(numericPrice) ? numericPrice : 0]
    );

    return {
      productId: row.id,
      productName: row.product_name,
      normalizedName: row.normalized_name,
      baseUnit: row.base_unit,
      purchasePrice: row.purchase_price,
      sellingPrice: row.selling_price,
      legacy: false,
      created: true,
    };
  } catch (err) {
    if (!isMissingTableError(err)) throw err;
  }

  const legacyId = createLegacyProductId(vendorId, normalized);
  const legacyPrice = Number.isFinite(numericPrice) ? numericPrice : 0;
  await client.query(
    `insert into products
       (id, vendor_id, product_name, category, stock, price, supplier, last_updated)
     values ($1, $2, $3, $4, 0, $5, null, now())
     on conflict (id) do update
       set product_name = excluded.product_name,
           price = case when $5 > 0 then $5 else products.price end,
           last_updated = now()`,
    [legacyId, vendorId, name, categoryName, legacyPrice]
  );

  return {
    productId: legacyId,
    productName: name,
    normalizedName: normalized,
    baseUnit: normalizeUnit(unit),
    purchasePrice: null,
    sellingPrice: legacyPrice,
    legacy: true,
    created: true,
  };
}

async function getReferencePrice(
  client,
  vendorId,
  productId,
  {
    supplierPartyId = null,
    priceType = 'selling',
    unit = null,
  } = {}
) {
  if (!productId) return null;
  const wantedUnit = normalizeUnit(unit);

  if (isUuid(productId)) {
    try {
      const byPrice = await client.query(
        `select amount, unit, price_type
           from product_prices
          where vendor_id = $1
            and product_id = $2
            and price_type = $3
            and is_active = true
            and ($4::uuid is null or supplier_party_id = $4)
            and ($5::text is null or unit = $5)
          order by effective_from desc
          limit 1`,
        [vendorId, productId, priceType, supplierPartyId, wantedUnit]
      );
      if (byPrice.rows[0]) {
        return {
          amount: Number(byPrice.rows[0].amount),
          unit: normalizeUnit(byPrice.rows[0].unit),
          priceType: byPrice.rows[0].price_type,
          source: 'product_prices',
        };
      }

      const fallbackAny = await client.query(
        `select amount, unit, price_type
           from product_prices
          where vendor_id = $1
            and product_id = $2
            and price_type = $3
            and is_active = true
          order by
            case when supplier_party_id = $4::uuid then 0 else 1 end,
            effective_from desc
          limit 1`,
        [vendorId, productId, priceType, supplierPartyId]
      );
      if (fallbackAny.rows[0]) {
        return {
          amount: Number(fallbackAny.rows[0].amount),
          unit: normalizeUnit(fallbackAny.rows[0].unit),
          priceType: fallbackAny.rows[0].price_type,
          source: 'product_prices',
        };
      }

      const fromMaster = await client.query(
        `select purchase_price, selling_price, base_unit
           from product_master
          where vendor_id = $1 and id = $2
          limit 1`,
        [vendorId, productId]
      );
      const master = fromMaster.rows[0];
      if (master) {
        const amount =
          priceType === 'purchase'
            ? Number(master.purchase_price)
            : Number(master.selling_price);
        if (Number.isFinite(amount) && amount > 0) {
          return {
            amount,
            unit: normalizeUnit(master.base_unit) || null,
            priceType,
            source: 'product_master',
          };
        }
      }
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }
  }

  const legacy = await client.query(
    `select price
       from products
      where id = $1 and vendor_id = $2
      limit 1`,
    [String(productId), vendorId]
  );
  if (!legacy.rows[0]) return null;

  return {
    amount: Number(legacy.rows[0].price),
    unit: wantedUnit || null,
    priceType,
    source: 'products',
  };
}

async function upsertProductPrice(
  client,
  vendorId,
  productId,
  {
    supplierPartyId = null,
    priceType = 'purchase',
    unit = null,
    amount,
    reason = 'manual_update',
    updatedBy = 'system',
  } = {}
) {
  const nextAmount = Number(amount);
  if (!Number.isFinite(nextAmount) || nextAmount < 0 || !productId) return null;
  const normalizedUnit = normalizeUnit(unit) || 'PIECE';

  if (isUuid(productId)) {
    try {
      const existing = await client.query(
        `select id, amount
           from product_prices
          where vendor_id = $1
            and product_id = $2
            and price_type = $3
            and unit = $4
            and is_active = true
            and (
              ($5::uuid is null and supplier_party_id is null)
              or supplier_party_id = $5::uuid
            )
          order by effective_from desc
          limit 1`,
        [vendorId, productId, priceType, normalizedUnit, supplierPartyId]
      );

      const oldPrice = existing.rows[0] ? Number(existing.rows[0].amount) : null;
      if (oldPrice != null && Math.abs(oldPrice - nextAmount) < 0.0001) {
        return { changed: false, oldPrice, newPrice: nextAmount };
      }

      if (existing.rows[0]) {
        await client.query(
          `update product_prices
              set is_active = false, effective_to = now(), updated_at = now()
            where id = $1`,
          [existing.rows[0].id]
        );
      }

      await client.query(
        `insert into product_prices
           (vendor_id, product_id, supplier_party_id, price_type, unit, amount, created_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [
          vendorId,
          productId,
          supplierPartyId,
          priceType,
          normalizedUnit,
          nextAmount,
          updatedBy,
        ]
      );

      await client.query(
        `insert into product_price_history
           (vendor_id, product_id, supplier_party_id, price_type, unit, old_price, new_price, reason, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          vendorId,
          productId,
          supplierPartyId,
          priceType,
          normalizedUnit,
          oldPrice,
          nextAmount,
          reason,
          updatedBy,
        ]
      );

      if (priceType === 'purchase') {
        await client.query(
          `update product_master
              set purchase_price = $2,
                  last_purchase_price = $2,
                  last_purchase_date = current_date,
                  average_purchase_price = case
                    when average_purchase_price is null then $2
                    else round((average_purchase_price + $2) / 2.0, 2)
                  end,
                  updated_at = now()
            where id = $1`,
          [productId, nextAmount]
        );
      } else {
        await client.query(
          `update product_master
              set selling_price = $2,
                  average_selling_price = case
                    when average_selling_price is null then $2
                    else round((average_selling_price + $2) / 2.0, 2)
                  end,
                  updated_at = now()
            where id = $1`,
          [productId, nextAmount]
        );
      }
      return { changed: true, oldPrice, newPrice: nextAmount };
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }
  }

  await client.query(
    `update products
        set price = $2, last_updated = now()
      where id = $1`,
    [String(productId), nextAmount]
  );
  return { changed: true, oldPrice: null, newPrice: nextAmount };
}

module.exports = {
  getPool,
  normalizeProductName,
  normalizeUnit,
  createLegacyProductId,
  convertQuantity,
  deriveQuantityAndUnit,
  ensureSupplierParty,
  findProductMatch,
  ensureProductMaster,
  getReferencePrice,
  upsertProductPrice,
};
