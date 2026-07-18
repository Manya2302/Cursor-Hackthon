const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function emptyStore() {
  return { users: [], otps: [] };
}

function ensureFileStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(emptyStore(), null, 2));
  }
}

function readFileStore() {
  ensureFileStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return emptyStore();
  }
}

function writeFileStore(data) {
  ensureFileStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

function normalizePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.startsWith('0') && digits.length === 11) digits = `91${digits.slice(1)}`;
  return digits;
}

function supabaseReady() {
  return Boolean(
    process.env.SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY &&
      !String(process.env.SUPABASE_URL).includes('placeholder')
  );
}

function getSupabase() {
  // Lazy require so auth folder can boot even if backend config is incomplete
  return require('../backend/src/config/supabase');
}

async function findUserByPhone(phone) {
  const clean = normalizePhone(phone);
  if (supabaseReady()) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('auth_users')
      .select('*')
      .eq('phone', clean)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }
  const store = readFileStore();
  return store.users.find((u) => u.phone === clean) || null;
}

async function findUserByEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (supabaseReady()) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('auth_users')
      .select('*')
      .eq('email', clean)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }
  const store = readFileStore();
  return store.users.find((u) => u.email === clean) || null;
}

async function saveOtp({ name, email, phone, otp, expiresAt }) {
  const row = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: String(email).trim().toLowerCase(),
    phone: normalizePhone(phone),
    otp: String(otp),
    expires_at: expiresAt,
    consumed_at: null,
    created_at: new Date().toISOString(),
  };

  if (supabaseReady()) {
    const supabase = getSupabase();
    // Invalidate older OTPs for this phone
    await supabase
      .from('auth_otps')
      .update({ consumed_at: new Date().toISOString() })
      .eq('phone', row.phone)
      .is('consumed_at', null);

    const { data, error } = await supabase.from('auth_otps').insert(row).select('*').single();
    if (error) throw new Error(error.message);
    return data;
  }

  const store = readFileStore();
  store.otps = store.otps.map((o) =>
    o.phone === row.phone && !o.consumed_at
      ? { ...o, consumed_at: new Date().toISOString() }
      : o
  );
  store.otps.push(row);
  writeFileStore(store);
  return row;
}

async function consumeOtp({ phone, email, otp }) {
  const cleanPhone = normalizePhone(phone);
  const cleanEmail = email ? String(email).trim().toLowerCase() : null;
  const code = String(otp || '').trim();
  const now = Date.now();

  if (supabaseReady()) {
    const supabase = getSupabase();
    let query = supabase
      .from('auth_otps')
      .select('*')
      .eq('otp', code)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (cleanPhone) query = query.eq('phone', cleanPhone);
    if (cleanEmail) query = query.eq('email', cleanEmail);

    const { data: rows, error } = await query;
    if (error) throw new Error(error.message);
    const row = rows?.[0];
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < now) return null;

    const { error: upErr } = await supabase
      .from('auth_otps')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', row.id);
    if (upErr) throw new Error(upErr.message);
    return row;
  }

  const store = readFileStore();
  const idx = store.otps.findIndex(
    (o) =>
      !o.consumed_at &&
      o.otp === code &&
      (!cleanPhone || o.phone === cleanPhone) &&
      (!cleanEmail || o.email === cleanEmail)
  );
  if (idx === -1) return null;
  const row = store.otps[idx];
  if (new Date(row.expires_at).getTime() < now) return null;
  store.otps[idx] = { ...row, consumed_at: new Date().toISOString() };
  writeFileStore(store);
  return row;
}

async function createUser({ name, email, phone, passwordHash }) {
  const row = {
    id: crypto.randomUUID(),
    name: name.trim(),
    email: String(email).trim().toLowerCase(),
    phone: normalizePhone(phone),
    password_hash: passwordHash || null,
    vendor_id: null,
    whatsapp_greeted_at: null,
    created_at: new Date().toISOString(),
  };

  if (supabaseReady()) {
    const supabase = getSupabase();

    // Ensure vendor exists for WhatsApp bookkeeping
    const { data: vendor, error: vErr } = await supabase
      .from('vendors')
      .upsert({ phone: row.phone, name: row.name }, { onConflict: 'phone' })
      .select('id')
      .single();
    if (vErr) throw new Error(vErr.message);
    row.vendor_id = vendor.id;

    const { data, error } = await supabase.from('auth_users').insert(row).select('*').single();
    if (error) throw new Error(error.message);
    return data;
  }

  const store = readFileStore();
  store.users.push(row);
  writeFileStore(store);
  return row;
}

async function setPassword(userId, passwordHash) {
  if (supabaseReady()) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('auth_users')
      .update({ password_hash: passwordHash })
      .eq('id', userId)
      .select('*')
      .single();
    if (error) throw new Error(error.message);
    return data;
  }
  const store = readFileStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) throw new Error('Account not found.');
  store.users[idx] = { ...store.users[idx], password_hash: passwordHash };
  writeFileStore(store);
  return store.users[idx];
}

async function markWhatsappGreeted(userId) {
  const ts = new Date().toISOString();
  if (supabaseReady()) {
    const supabase = getSupabase();
    await supabase.from('auth_users').update({ whatsapp_greeted_at: ts }).eq('id', userId);
    return;
  }
  const store = readFileStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx !== -1) {
    store.users[idx].whatsapp_greeted_at = ts;
    writeFileStore(store);
  }
}

module.exports = {
  normalizePhone,
  supabaseReady,
  findUserByPhone,
  findUserByEmail,
  saveOtp,
  consumeOtp,
  createUser,
  setPassword,
  markWhatsappGreeted,
};
