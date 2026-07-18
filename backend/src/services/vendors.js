const { Pool } = require('pg');
const supabase = require('../config/supabase');

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

function hasServiceRole() {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return Boolean(key) && key !== 'placeholder-service-role-key';
}

/**
 * Look up a vendor by WhatsApp phone (wa_id), or create one on first contact.
 */
async function resolveOrCreateVendor(phone, profileName) {
  if (!phone) {
    console.error('[vendors] resolveOrCreateVendor: missing phone');
    return null;
  }

  const name = profileName || phone;

  if (hasServiceRole()) {
    try {
      const { data, error } = await supabase
        .from('vendors')
        .upsert({ phone, name }, { onConflict: 'phone' })
        .select('id, phone, name, preferred_language, created_at')
        .single();

      if (!error && data) {
        console.log('[vendors] resolved vendor:', data.id, data.phone);
        return data;
      }
      console.error('[vendors] upsert failed:', error?.message);
    } catch (err) {
      console.error('[vendors] supabase error:', err.message);
    }
  }

  const pg = getPool();
  if (!pg) {
    console.error(
      '[vendors] No SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL/SUPABASE_API'
    );
    return null;
  }

  try {
    const result = await pg.query(
      `insert into vendors (phone, name)
       values ($1, $2)
       on conflict (phone) do update set name = coalesce(excluded.name, vendors.name)
       returning id, phone, name, preferred_language, created_at`,
      [phone, name]
    );
    const data = result.rows[0];
    console.log('[vendors] resolved vendor via pg:', data.id, data.phone);
    return data;
  } catch (err) {
    console.error('[vendors] pg upsert failed:', err.message);
    return null;
  }
}

module.exports = {
  resolveOrCreateVendor,
};
