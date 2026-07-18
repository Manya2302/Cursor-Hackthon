/**
 * Nirvha auth module
 * Mounted at /api/auth from the Express backend.
 *
 * Flow:
 * 1) POST /register { name, email, phone } → OTP
 * 2) POST /verify-otp { phone, email, otp } → create user + WhatsApp "Hi {name}"
 * 3) POST /set-password { userId, password }
 * 4) POST /login { phone, password }
 */
module.exports = require('./routes');
