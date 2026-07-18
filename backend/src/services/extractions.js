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
 * Stage a parsed WhatsApp message in raw_extractions (pending_confirmation).
 */
async function stageRawExtraction({
  vendorId,
  inputType,
  rawInput,
  command,
  llmParsed,
  detectedLanguage,
  mediaUrl = null,
}) {
  const row = {
    vendor_id: vendorId,
    channel: 'whatsapp',
    input_type: inputType,
    raw_input: rawInput,
    media_url: mediaUrl,
    command,
    llm_parsed: llmParsed,
    detected_language: detectedLanguage,
    status: 'pending_confirmation',
  };

  if (hasServiceRole()) {
    const { data, error } = await supabase
      .from('raw_extractions')
      .insert(row)
      .select('id, status, created_at')
      .single();

    if (error) {
      console.error('[extractions] supabase insert failed:', error.message);
    } else {
      console.log('[extractions] staged raw_extraction:', data.id);
      return data;
    }
  }

  const pg = getPool();
  if (!pg) {
    console.error(
      '[extractions] No SUPABASE_SERVICE_ROLE_KEY or DATABASE_URL/SUPABASE_API — cannot stage row'
    );
    return null;
  }

  try {
    // Only one pending confirmation per vendor at a time — expire older ones.
    await pg.query(
      `update raw_extractions
          set status = 'auto_expired'
        where vendor_id = $1 and status = 'pending_confirmation'`,
      [vendorId]
    );

    const result = await pg.query(
      `insert into raw_extractions
        (vendor_id, channel, input_type, raw_input, media_url, command,
         llm_parsed, detected_language, status)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       returning id, status, created_at`,
      [
        row.vendor_id,
        row.channel,
        row.input_type,
        row.raw_input,
        row.media_url,
        row.command,
        JSON.stringify(row.llm_parsed),
        row.detected_language,
        row.status,
      ]
    );
    const data = result.rows[0];
    console.log('[extractions] staged raw_extraction via pg:', data.id);
    return data;
  } catch (err) {
    console.error('[extractions] pg insert failed:', err.message);
    return null;
  }
}

async function getLatestPendingExtraction(vendorId) {
  const pg = getPool();
  if (!pg) return null;

  const result = await pg.query(
    `select id, vendor_id, command, raw_input, llm_parsed, status, created_at
       from raw_extractions
      where vendor_id = $1 and status = 'pending_confirmation'
      order by created_at desc
      limit 1`,
    [vendorId]
  );
  return result.rows[0] || null;
}

async function rejectPendingExtraction(extractionId) {
  const pg = getPool();
  if (!pg) return null;

  const result = await pg.query(
    `update raw_extractions
        set status = 'rejected'
      where id = $1 and status = 'pending_confirmation'
      returning id, status`,
    [extractionId]
  );
  return result.rows[0] || null;
}

module.exports = {
  stageRawExtraction,
  getLatestPendingExtraction,
  rejectPendingExtraction,
};
