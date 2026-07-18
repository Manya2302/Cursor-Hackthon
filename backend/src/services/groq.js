const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const EXTRACTION_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3';

/**
 * Extraction Agent system prompt — classify + extract only.
 * Never calculate totals, invent parties/dates, or format replies.
 */
const EXTRACTION_SYSTEM_PROMPT = `You are the extraction engine for LedgerBot, a WhatsApp double-entry bookkeeping assistant for small Indian businesses (kirana stores, retailers, manufacturers).

Your ONLY job is to classify the user's intent and extract fields that are EXPLICITLY stated in the message. Output JSON only — no markdown fences, no commentary, no prose before or after the JSON.

STRICT RULES:
- NEVER calculate, sum, subtract, or invent totals — if a total is not written, set total_amount to null.
- NEVER invent party names, products, amounts, dates, quantities, or payment splits that were not stated.
- NEVER guess missing fields — use null.
- NEVER do arithmetic. If the user says "400 cash 100 ramesh udhaar" extract those payment lines as stated; do not derive a total unless they also stated one.
- Do NOT format a human confirmation message — extraction only.

Classify intent as exactly one of:
- "transaction" — a sale, purchase, payment, receipt, or expense involving money and/or credit (udhaar)
- "inventory_bulk" — bulk stock / product catalog update (multiple items or stock sheet)
- "statement_query" — request for a report/statement (P&L, balance sheet, ledger, cash, party udhaar, etc.)
- "unclear" — you cannot confidently extract without guessing

JSON schema (always return all top-level keys):
{
  "intent": "transaction" | "inventory_bulk" | "statement_query" | "unclear",
  "transaction_type": "sale" | "purchase" | "payment" | "receipt" | "expense" | null,
  "items": [
    {
      "name": string | null,
      "quantity": number | null,
      "unit": string | null,
      "unit_price": number | null,
      "line_amount": number | null
    }
  ],
  "party": {
    "name": string | null,
    "role": "customer" | "supplier" | null
  },
  "payments": [
    {
      "method": "cash" | "udhaar" | "bank" | "upi" | string | null,
      "amount": number | null,
      "party_name": string | null
    }
  ],
  "total_amount": number | null,
  "date": string | null,
  "currency": "INR",
  "product_updates": [
    {
      "name": string | null,
      "stock": number | null,
      "price": number | null,
      "category": string | null
    }
  ],
  "statement": {
    "type": string | null,
    "period": string | null
  },
  "notes": string | null,
  "unclear_reason": string | null
}

Hints for Indian bookkeeping slang (extract, do not invent):
- "udhaar" / "credit" → payment method udhaar with the named party
- "cash" → payment method cash
- "/ai-order" style sale lines often look like: qty + unit + product + cash/udhaar splits
- "/ai-payment" is usually settling udhaar (payment/receipt), not a new sale
- "/ai-report" / statement requests → intent statement_query
- "/ai-stock" / "/ai-stock-bulk" → inventory_bulk when about stock levels

If the message is ambiguous, set intent to "unclear" and explain in unclear_reason.`;

function getApiKey() {
  return (process.env.GROQ_API_KEY || '').trim();
}

async function chatCompletion({ messages, model, temperature = 0 }) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const res = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message || `Groq chat failed (${res.status})`);
  }

  return body.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Casual WhatsApp chat (main.py generate_ai_response) — NOT used for ledger extraction.
 */
async function generateAiResponse(userMessage) {
  if (!getApiKey()) {
    return `Echo: ${userMessage}`;
  }

  try {
    const content = await chatCompletion({
      model: 'llama-3.1-8b-instant',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'You are LedgerBot, a helpful and concise AI assistant on WhatsApp for small business owners. Keep responses short and clear. If the user seems to want to record a sale, payment, stock, or report, remind them to use /ai-order, /ai-stock, /ai-payment, or /ai-report.',
        },
        { role: 'user', content: userMessage },
      ],
    });
    return content || 'Sorry, I could not generate a reply.';
  } catch (err) {
    console.error('[groq] generateAiResponse error:', err.message);
    return 'Sorry, I encountered an error processing your message.';
  }
}

function stripJsonFences(text) {
  if (!text) return text;
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

/**
 * Extraction Agent — returns parsed JSON only.
 * Deliberately separate from any reply-formatting logic.
 */
async function extractIntent(rawText) {
  const content = await chatCompletion({
    model: EXTRACTION_MODEL,
    temperature: 0,
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content: rawText },
    ],
  });

  const cleaned = stripJsonFences(content);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const err2 = new Error(`Invalid JSON from Groq: ${err.message}`);
    err2.raw = content;
    throw err2;
  }
}

/**
 * Whisper transcription only — returns plain transcript text.
 * Deliberately separate from extractIntent / reply formatting.
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const ext = mimeType.includes('mp4')
    ? 'mp4'
    : mimeType.includes('mpeg')
      ? 'mp3'
      : mimeType.includes('wav')
        ? 'wav'
        : 'ogg';

  const form = new FormData();
  form.append(
    'file',
    new Blob([audioBuffer], { type: mimeType || 'audio/ogg' }),
    `audio.${ext}`
  );
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'text');
  // Gujarati-friendly hint (same idea as main.py); Whisper still auto-detects.
  form.append('prompt', 'આ ઑડિઓ ગુજરાતી અથવા હિન્દી અથવા અંગ્રેજીમાં હોઈ શકે.');

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const text = (await res.text()).trim();
  if (!res.ok) {
    throw new Error(text || `Whisper failed (${res.status})`);
  }

  return text;
}

/**
 * Vision OCR for images / scanned pages (from main.py gujarati_ocr_pipeline).
 * Returns extracted text only — caller may then pass it to extractIntent.
 */
async function ocrImageText(imageBuffer, mimeType = 'image/jpeg') {
  const imageB64 = Buffer.from(imageBuffer).toString('base64');
  const dataUrl = `data:${mimeType};base64,${imageB64}`;

  return chatCompletion({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          {
            type: 'text',
            text:
              'This image may contain Gujarati, Hindi, or English text (handwritten chits, invoices, stock sheets). ' +
              'Extract ALL text exactly as it appears, preserving Unicode. ' +
              'Output ONLY the extracted text. If no text is found, say exactly: No text found.',
          },
        ],
      },
    ],
  });
}

/** General image description helper (main.py analyze_image_general). */
async function analyzeImage(imageBuffer, caption = '', mimeType = 'image/jpeg') {
  const imageB64 = Buffer.from(imageBuffer).toString('base64');
  const dataUrl = `data:${mimeType};base64,${imageB64}`;
  const prompt = caption || 'Describe this image in detail.';

  const content = await chatCompletion({
    model: 'meta-llama/llama-4-scout-17b-16e-instruct',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  return `🖼️ ${content}`;
}

async function summarizeDocument(fileTypeLabel, displayText) {
  try {
    return await chatCompletion({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content:
            'You are a document analyst. Summarize the key information from this document in 3-5 bullet points.',
        },
        {
          role: 'user',
          content: `Summarize this ${fileTypeLabel} document:\n\n${displayText}`,
        },
      ],
    });
  } catch (_) {
    return '(Summary unavailable)';
  }
}

module.exports = {
  EXTRACTION_SYSTEM_PROMPT,
  extractIntent,
  transcribeAudio,
  generateAiResponse,
  ocrImageText,
  analyzeImage,
  summarizeDocument,
};
