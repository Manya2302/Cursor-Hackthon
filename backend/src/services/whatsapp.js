const GRAPH_API_BASE = 'https://graph.facebook.com/v17.0';
const WHATSAPP_TEXT_LIMIT = 4000; // Meta hard limit is 4096; leave headroom

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
 * Split long replies so each WhatsApp text.body stays under 4096 chars.
 */
function chunkWhatsAppText(text, maxLen = WHATSAPP_TEXT_LIMIT) {
  const raw = String(text || '');
  if (raw.length <= maxLen) return [raw];

  const chunks = [];
  let remaining = raw;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < Math.floor(maxLen * 0.5)) {
      cut = remaining.lastIndexOf(' ', maxLen);
    }
    if (cut < Math.floor(maxLen * 0.5)) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  return chunks.filter((c) => c.length > 0);
}

async function sendOneTextMessage(to, text, phoneNumberId, token, id) {
  const url = `${GRAPH_API_BASE}/${id}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text },
    }),
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

  console.log(`[whatsapp] ✅ Message sent to ${to} (${text.length} chars)`);
  return body;
}

/**
 * Send a plain text WhatsApp message (auto-chunks if over 4096 chars).
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

  const chunks = chunkWhatsAppText(text);
  let last = null;

  try {
    for (let i = 0; i < chunks.length; i++) {
      const part =
        chunks.length > 1
          ? `(${i + 1}/${chunks.length})\n${chunks[i]}`
          : chunks[i];
      // Re-chunk if the prefix pushed us over the limit
      const safeParts = chunkWhatsAppText(part);
      for (const safe of safeParts) {
        last = await sendOneTextMessage(to, safe, phoneNumberId, token, id);
        if (!last) return null;
      }
    }
    return last;
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
