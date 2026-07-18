const express = require('express');

const router = express.Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: 'WhatsApp AI Webhook Backend is running.',
  });
});

module.exports = router;
