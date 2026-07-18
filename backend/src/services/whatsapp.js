const GRAPH_API_BASE = 'https://graph.facebook.com/v17.0';

function getToken() {
  return (process.env.WHATSAPP_TOKEN || '').replace(/^["']|["']$/g, '').trim();
}

function getPhoneNumberId(overrideId) {
  return (
    overrideId ||
    (process.env.WHATSAPP_PHONE_NUMBER_ID || '').replace(/^["']|["']$/g, '').trim()
  );
}

/**
 * Send a plain text WhatsApp message.
 * Matches Python send_whatsapp_message(phone_number_id, to_number, text).
 */
async function sendTextMessage(to, text, phoneNumberId) {
  const token = getToken();
  const id = getPhoneNumberId(phoneNumberId);

  if (!token || !id) {
    console.error(
      '[whatsapp] ❌ Missing WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID in .env'
    );
    return null;
  }

  const url = `${GRAPH_API_BASE}/${id}/messages`;
  const data = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[whatsapp] ❌ Failed to send message:', res.status, body);
      if (body?.error?.code === 190) {
        console.error(
          '[whatsapp] → Access token expired/invalid. Open Meta Developer → WhatsApp → API Setup, copy a NEW Temporary access token into backend/.env as WHATSAPP_TOKEN, then restart.'
        );
      }
      if (body?.error) {
        console.error('[whatsapp] Details:', JSON.stringify(body.error));
      }
      return null;
    }

    console.log(`[whatsapp] ✅ Message sent to ${to}`);
    return body;
  } catch (err) {
    console.error('[whatsapp] ❌ Failed to send message:', err.message);
    return null;
  }
}

/**
 * Download media bytes for a Meta media id.
 */
async function downloadMedia(mediaId) {
  const token = getToken();

  if (!token) {
    console.error('[whatsapp] downloadMedia: WHATSAPP_TOKEN missing');
    return null;
  }

  try {
    const metaRes = await fetch(`${GRAPH_API_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaRes.json().catch(() => ({}));

    if (!metaRes.ok || !meta.url) {
      console.error(
        '[whatsapp] Media download error (URL resolve):',
        metaRes.status,
        meta
      );
      return null;
    }

    const fileRes = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!fileRes.ok) {
      console.error(
        '[whatsapp] Media download error (bytes):',
        fileRes.status
      );
      return null;
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType:
        meta.mime_type ||
        fileRes.headers.get('content-type') ||
        'application/octet-stream',
    };
  } catch (err) {
    console.error('[whatsapp] Media download error:', err.message);
    return null;
  }
}

async function sendDocumentMessage(to, mediaBuffer, filename, phoneNumberId) {
  const token = getToken();
  const id = getPhoneNumberId(phoneNumberId);

  if (!token || !id) {
    console.error('[whatsapp] sendDocumentMessage: missing token or phone id');
    return null;
  }

  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'application/pdf');
    form.append(
      'file',
      new Blob([mediaBuffer], { type: 'application/pdf' }),
      filename
    );

    const uploadRes = await fetch(`${GRAPH_API_BASE}/${id}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });

    const uploadBody = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok || !uploadBody.id) {
      console.error(
        '[whatsapp] sendDocumentMessage upload failed:',
        uploadRes.status,
        uploadBody
      );
      return null;
    }

    const sendRes = await fetch(`${GRAPH_API_BASE}/${id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'document',
        document: { id: uploadBody.id, filename },
      }),
    });

    const sendBody = await sendRes.json().catch(() => ({}));
    if (!sendRes.ok) {
      console.error(
        '[whatsapp] sendDocumentMessage send failed:',
        sendRes.status,
        sendBody
      );
      return null;
    }

    return sendBody;
  } catch (err) {
    console.error('[whatsapp] sendDocumentMessage error:', err.message);
    return null;
  }
}

module.exports = {
  sendTextMessage,
  downloadMedia,
  sendDocumentMessage,
};
