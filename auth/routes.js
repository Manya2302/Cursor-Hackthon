const path = require('path');
// Resolve express from backend/node_modules (auth is a top-level folder)
const express = require(
  require.resolve('express', { paths: [path.join(__dirname, '../backend')] })
);
const service = require('./service');

const router = express.Router();

function asyncHandler(fn) {
  return (req, res) => {
    Promise.resolve(fn(req, res)).catch((err) => {
      const status = err.status || 500;
      res.status(status).json({
        ok: false,
        error: err.message || 'Unexpected auth error',
      });
    });
  };
}

/** POST /api/auth/register — name, email, phone → OTP */
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { name, email, phone } = req.body || {};
    const result = await service.requestOtp({ name, email, phone });
    res.status(201).json(result);
  })
);

/** Alias used by the UI */
router.post(
  '/request-otp',
  asyncHandler(async (req, res) => {
    const { name, email, phone } = req.body || {};
    const result = await service.requestOtp({ name, email, phone });
    res.status(201).json(result);
  })
);

/** POST /api/auth/verify-otp — on success sends WhatsApp "Hi {name}" */
router.post(
  '/verify-otp',
  asyncHandler(async (req, res) => {
    const { phone, email, otp } = req.body || {};
    const result = await service.verifyOtp({ phone, email, otp });
    res.json(result);
  })
);

/** POST /api/auth/set-password */
router.post(
  '/set-password',
  asyncHandler(async (req, res) => {
    const { userId, password } = req.body || {};
    const result = await service.setUserPassword({ userId, password });
    res.json(result);
  })
);

/** POST /api/auth/login — phone + password */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { phone, password } = req.body || {};
    const result = await service.login({ phone, password });
    res.json(result);
  })
);

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'auth',
    whatsappConfigured: Boolean(
      process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID
    ),
  });
});

module.exports = router;
