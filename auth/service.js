const crypto = require('crypto');
const store = require('./store');
const { sendHiMessage } = require('./whatsapp');

const OTP_TTL_MS = 10 * 60 * 1000;

function randomOtp(length = 6) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += crypto.randomInt(0, 10);
  }
  return out;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, packed) {
  if (!packed || !String(packed).includes(':')) return false;
  const [salt, hash] = String(packed).split(':');
  const next = crypto.scryptSync(String(password), salt, 64).toString('hex');
  if (hash.length !== next.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(next, 'hex'));
  } catch {
    return false;
  }
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    vendorId: user.vendor_id || null,
    createdAt: user.created_at,
  };
}

/**
 * Step 1: name + email + phone → create OTP challenge
 */
async function requestOtp({ name, email, phone }) {
  if (!name || !String(name).trim()) {
    throw Object.assign(new Error('Please enter your name.'), { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())) {
    throw Object.assign(new Error('Please enter a valid email.'), { status: 400 });
  }
  const cleanPhone = store.normalizePhone(phone);
  if (cleanPhone.length < 12) {
    throw Object.assign(new Error('Enter a valid phone number (at least 10 digits).'), {
      status: 400,
    });
  }

  const existingPhone = await store.findUserByPhone(cleanPhone);
  if (existingPhone) {
    throw Object.assign(new Error('This phone number is already registered. Please log in.'), {
      status: 409,
    });
  }
  const existingEmail = await store.findUserByEmail(email);
  if (existingEmail) {
    throw Object.assign(new Error('This email is already registered. Please log in.'), {
      status: 409,
    });
  }

  const otp = randomOtp(6);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await store.saveOtp({
    name,
    email,
    phone: cleanPhone,
    otp,
    expiresAt,
  });

  const demoMode = process.env.AUTH_DEMO_OTP !== 'false';
  return {
    ok: true,
    message: 'OTP generated. Enter it to verify your account.',
    phone: cleanPhone,
    email: String(email).trim().toLowerCase(),
    expiresAt,
    // Shown in demo so registration works without an email provider.
    ...(demoMode ? { demoOtp: otp } : {}),
    storage: store.supabaseReady() ? 'supabase' : 'local',
  };
}

/**
 * Step 2: verify OTP → create user in DB → WhatsApp "Hi {name}"
 */
async function verifyOtp({ phone, email, otp }) {
  const row = await store.consumeOtp({ phone, email, otp });
  if (!row) {
    throw Object.assign(new Error('Incorrect or expired OTP. Please try again.'), {
      status: 400,
    });
  }

  let user = await store.findUserByPhone(row.phone);
  if (!user) {
    user = await store.createUser({
      name: row.name,
      email: row.email,
      phone: row.phone,
    });
  }

  // Always message the phone number entered at registration (never a fixed number).
  let whatsapp = { ok: false };
  try {
    const sent = await sendHiMessage(user.phone, user.name);
    await store.markWhatsappGreeted(user.id);
    whatsapp = {
      ok: true,
      mode: sent.mode,
      to: user.phone,
      text: sent.text || `Hi ${user.name}`,
    };
  } catch (err) {
    console.error('[auth] WhatsApp greeting failed:', err.message);
    whatsapp = {
      ok: false,
      error: err.message,
      code: err.code || 'WHATSAPP_SEND_FAILED',
      to: user.phone,
    };
  }

  return {
    ok: true,
    message: `Welcome, ${user.name}!`,
    user: publicUser(user),
    whatsapp,
  };
}

async function setUserPassword({ userId, password }) {
  if (!userId) {
    throw Object.assign(new Error('Account not found.'), { status: 404 });
  }
  if (!password || String(password).length < 6) {
    throw Object.assign(new Error('Password must be at least 6 characters.'), { status: 400 });
  }
  const user = await store.setPassword(userId, hashPassword(password));
  return { ok: true, user: publicUser(user) };
}

async function login({ phone, password }) {
  const user = await store.findUserByPhone(phone);
  if (!user) {
    throw Object.assign(new Error('No account found for this phone number.'), { status: 404 });
  }
  if (!user.password_hash) {
    throw Object.assign(
      new Error('No password set for this account. Complete registration first.'),
      { status: 400 }
    );
  }
  if (!verifyPassword(password, user.password_hash)) {
    throw Object.assign(new Error('Incorrect password.'), { status: 401 });
  }
  return { ok: true, user: publicUser(user) };
}

module.exports = {
  requestOtp,
  verifyOtp,
  setUserPassword,
  login,
  publicUser,
};
