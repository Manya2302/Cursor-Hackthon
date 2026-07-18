/**
 * WhatsApp welcome sender for auth (Graph API).
 * Token / phone number id come from env — never hardcode secrets.
 */

const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';

function getToken() {
  return (process.env.WHATSAPP_TOKEN || '').replace(/^["']|["']$/g, '').trim();
}

function getPhoneNumberId() {
  return (process.env.WHATSAPP_PHONE_NUMBER_ID || '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function toWhatsAppAddress(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  if (digits.startsWith('0') && digits.length === 11) {
    digits = `91${digits.slice(1)}`;
  }
  return digits;
}

/**
 * Send "Hi {name}" after successful OTP.
 * Prefers free-form text; falls back to the configured welcome template.
 */
async function sendHiMessage(phone, name) {
  const token = getToken();
  const phoneNumberId = getPhoneNumberId();
  const to = toWhatsAppAddress(phone);
  const firstName = String(name || 'there').trim().split(/\s+/)[0] || 'there';

  if (!token || !phoneNumberId) {
    const err = new Error(
      'WhatsApp is not configured. Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID.'
    );
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  const textBody = `Hi ${firstName}`;
  const textResult = await postMessage(phoneNumberId, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: textBody },
  });

  if (textResult.ok) {
    return { ok: true, mode: 'text', body: textResult.body };
  }

  // Outside the 24h session window Meta often requires a template.
  const templateName =
    process.env.WHATSAPP_WELCOME_TEMPLATE || 'jaspers_market_order_confirmation_v1';
  const language = process.env.WHATSAPP_WELCOME_LANG || 'en_US';
  const today = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const templateResult = await postMessage(phoneNumberId, token, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: firstName },
            { type: 'text', text: 'Welcome' },
            { type: 'text', text: today },
          ],
        },
      ],
    },
  });

  if (!templateResult.ok) {
    const err = new Error(
      templateResult.body?.error?.message ||
        textResult.body?.error?.message ||
        'Failed to send WhatsApp welcome message'
    );
    err.code = 'WHATSAPP_SEND_FAILED';
    err.details = {
      text: textResult.body,
      template: templateResult.body,
    };
    throw err;
  }

  return { ok: true, mode: 'template', body: templateResult.body };
}

async function postMessage(phoneNumberId, token, payload) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[auth/whatsapp] send failed:', res.status, body);
  } else {
    console.log(`[auth/whatsapp] sent ${payload.type} to ${payload.to}`);
  }
  return { ok: res.ok, status: res.status, body };
}

module.exports = {
  sendHiMessage,
  toWhatsAppAddress,
};
