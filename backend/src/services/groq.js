const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const EXTRACTION_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3';
const CHAT_MODEL = 'llama-3.1-8b-instant';
// Groq vision: llama-4-scout is no longer available on many accounts.
// Use current multimodal model (same pipeline as main.py, updated model id).
const VISION_MODEL =
  process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';

/**
 * Extraction Agent — single NIRVHA brain.
 * Classifies what the user wants from plain text / OCR / captions (no slash commands).
 */
const EXTRACTION_SYSTEM_PROMPT = `You are NIRVHA's single AI agent for small Indian businesses (kirana stores, retailers).

The user may send plain WhatsApp text, a voice transcript, OCR from a photo/PDF, and/or a short caption like "supplier", "stock", "customer bill", or "udhaar".

Your ONLY job: understand what they want and extract explicitly stated fields into JSON.
Output JSON only — no markdown fences, no commentary.

INTENTS (pick exactly one):
- "transaction" — record a sale, purchase, payment, receipt, or expense in the books (customer bill/order chit with items + costs + TOTAL → sale; supplier invoice paid → purchase; settling udhaar → payment/receipt)
- "inventory_bulk" — add/update products in the catalog/stock from a supplier list, stock sheet, price list, or PDF/image of products (caption may say supplier/stock). Put products in product_updates (and mirror key rows in items if helpful).
- "statement_query" — they want a report/statement (P&L, balance, ledger, party balance)
- "chat" — greeting, question, or help that is NOT a bookkeeping entry
- "unclear" — cannot tell without guessing

STRICT RULES:
- NEVER invent names, phones, products, amounts, or totals. Missing → null.
- If OCR says NAME: UNREADABLE or NUMBER: UNREADABLE → party.name / party.phone must be null (do not guess).
- If HEADER_CONFLICT: true appears → treat name/phone as unreliable; use null unless both passes clearly agree in the text.
- NEVER calculate totals — copy TOTAL only if written.
- NEVER convert units (500GM stays quantity 500 + unit "GM"; keep weight_text as written).
- Extract EVERY product/item row — do not drop lines.
- Customer name+phone+items+costs+TOTAL on a chit → transaction / sale / party.role customer.
- For Gujarati bills: keep party.name in Gujarati script; if NAME_EN is present and not UNREADABLE put it in name_en (and optionally notes like "name_en: Om Trivedi").
- Phone NUMBER may use Gujarati digits — treat as the same phone once normalized to 0-9.
- Item lines may look like: ITEM: ખાંડ | WEIGHT: 1 કિલો | AMOUNT: 200 — map to items[].name, weight_text, line_amount.
- Known Gujarati groceries: ખાંડ=Sugar, ઘી=Ghee, બટર=Butter, ચીઝ=Cheese, દૂધ=Milk (do not swap these).
- Supplier / stock / price-list / "add products" with item rows → inventory_bulk; party.role supplier when a supplier is named.
- PDF / CSV / Excel product or price lists with NO customer name → inventory_bulk (do not ask for customer name/phone).
- Do NOT format a human reply — extraction only.

JSON schema (always return all top-level keys):
{
  "intent": "transaction" | "inventory_bulk" | "statement_query" | "chat" | "unclear",
  "transaction_type": "sale" | "purchase" | "payment" | "receipt" | "expense" | null,
  "items": [
    {
      "name": string | null,
      "quantity": number | null,
      "unit": string | null,
      "weight_text": string | null,
      "unit_price": number | null,
      "line_amount": number | null
    }
  ],
  "party": {
    "name": string | null,
    "phone": string | null,
    "role": "customer" | "supplier" | null
  },
  "name_en": string | null,
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
  "statement": { "type": string | null, "period": string | null },
  "notes": string | null,
  "unclear_reason": string | null
}`;

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

  return stripModelNoise(body.choices?.[0]?.message?.content?.trim() || '');
}

/** Remove Qwen/thinking dumps and cap runaway model output. */
function stripModelNoise(text) {
  if (!text) return '';
  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    // Unclosed think blocks (common with qwen)
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<thinking>[\s\S]*$/gi, '')
    .trim();

  // If noise remains but template lines exist, keep from first template key
  const start = cleaned.search(/^(NAME|NAME_EN|NUMBER|ITEM|TOTAL)\s*:/im);
  if (start > 0) cleaned = cleaned.slice(start);

  if (cleaned.length > 6000) {
    cleaned = cleaned.slice(0, 6000) + '\n…(truncated)';
  }
  return cleaned.trim();
}

function clip(text, max = 1500) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…(truncated)`;
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
            'You are NIRVHA, a helpful WhatsApp AI accountant for small Indian businesses. ' +
            'Keep replies short. Users do NOT need slash commands — they can send text, photos of bills, or supplier/stock sheets and you will understand. ' +
            'If they want to save something to the books, tell them to send the bill/photo or details and reply YES when asked to confirm.',
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
 * Vision OCR router: detect bill language (en | gu), then run the matching OCR pipeline.
 */
async function ocrImageText(imageBuffer, mimeType = 'image/jpeg') {
  const { dataUrl, headerDataUrl } = await prepareBillImages(imageBuffer, mimeType);
  const lang = await detectBillLanguage(headerDataUrl || dataUrl);
  console.log(`[groq] bill language detected: ${lang}`);

  const text =
    lang === 'gu'
      ? await ocrGujaratiBill(dataUrl, headerDataUrl)
      : await ocrEnglishBill(dataUrl, headerDataUrl);

  return `${require('../utils/gujarati').normalizeGujaratiDigits(text)}\nBILL_LANG: ${lang}`;
}

async function prepareBillImages(imageBuffer, mimeType = 'image/jpeg') {
  const safeMime = mimeType?.startsWith('image/') ? mimeType : 'image/jpeg';
  try {
    const sharp = require('sharp');
    const jpeg = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

    const meta = await sharp(imageBuffer).rotate().metadata();
    const w = meta.width || 1280;
    const h = meta.height || 1280;
    const headerBuf = await sharp(imageBuffer)
      .rotate()
      .extract({
        left: 0,
        top: 0,
        width: w,
        height: Math.max(80, Math.round(h * 0.32)),
      })
      .normalize()
      .resize({ width: Math.min(1200, w * 2), withoutEnlargement: false })
      .jpeg({ quality: 88 })
      .toBuffer();
    const headerDataUrl = `data:image/jpeg;base64,${headerBuf.toString('base64')}`;
    return { dataUrl, headerDataUrl };
  } catch {
    const imageB64 = Buffer.from(imageBuffer).toString('base64');
    const dataUrl = `data:${safeMime};base64,${imageB64}`;
    return { dataUrl, headerDataUrl: dataUrl };
  }
}

/**
 * Tiny language classifier — English (Latin) vs Gujarati script.
 * @returns {'en' | 'gu'}
 */
async function detectBillLanguage(dataUrl) {
  try {
    // Smaller image for cheap TPM usage
    let tinyUrl = dataUrl;
    try {
      const sharp = require('sharp');
      const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const tiny = await sharp(Buffer.from(b64, 'base64'))
        .resize({ width: 640, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      tinyUrl = `data:image/jpeg;base64,${tiny.toString('base64')}`;
    } catch (_) {
      /* use original */
    }

    const out = await chatCompletion({
      model: VISION_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: tinyUrl } },
            {
              type: 'text',
              text:
                'Classify the LANGUAGE of this handwritten shop bill.\n' +
                '- If most text is Latin/English letters (NAME, SUGAR, TOTAL, OM TRIVEDI) → en\n' +
                '- If most text is Gujarati script (નામ, ખાંડ, ટોટલ, ઓમ) → gu\n' +
                '- Mixed: pick the script used for NAME and item names.\n' +
                'Reply with EXACTLY one line and nothing else:\n' +
                'LANG: en\n' +
                'or\n' +
                'LANG: gu',
            },
          ],
        },
      ],
    });
    const cleaned = stripModelNoise(out);
    if (/\bLANG\s*:\s*gu\b/i.test(cleaned) || /[\u0A80-\u0AFF]/.test(cleaned)) {
      // Only trust gu from LANG tag, not from accidental Gujarati in thinking
      if (/\bLANG\s*:\s*gu\b/i.test(cleaned)) return 'gu';
    }
    if (/\bLANG\s*:\s*en\b/i.test(cleaned)) return 'en';
    // Fallback heuristics from model free text
    if (/gujarati|ગુજરાતી/i.test(cleaned)) return 'gu';
    return 'en';
  } catch (err) {
    console.error('[groq] detectBillLanguage failed:', err.message);
    return 'en';
  }
}

async function ocrEnglishBill(dataUrl, headerDataUrl) {
  const raw = await chatCompletion({
    model: VISION_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          {
            type: 'text',
            text:
              'Read this HANDWRITTEN ENGLISH shop bill (red/blue ink).\n' +
              'Labels are like NAME, NUMBER, ITEMS, WEIGHT, COST, TOTAL.\n' +
              'Copy NAME and NUMBER exactly (e.g. OM TRIVEDI, 9974099063).\n' +
              'Ignore crossed-out / struck text above the main bill.\n' +
              'Do not invent. If unreadable: UNREADABLE.\n\n' +
              'Output EXACTLY (plain text):\n' +
              'NAME: <English name>\n' +
              'NAME_EN: <same>\n' +
              'NUMBER: <10 digits>\n' +
              'ITEM: <name> | WEIGHT: <as written> | AMOUNT: <digits>\n' +
              'TOTAL: <digits>',
          },
        ],
      },
    ],
  });

  const passRaw = extractOcrHeader(raw);
  const text = stripModelNoise(raw);
  const pass1 = mergeIdentityPasses(extractOcrHeader(text), passRaw);
  const pass2 = headerDataUrl
    ? await ocrHeaderCropWithRetry(headerDataUrl, 'en')
    : { name: null, nameEn: null, number: null };
  const merged = mergeIdentityPasses(pass1, pass2);
  let out = rebuildCleanBillOcr(text, merged, raw);
  if (merged.conflict) out += '\nHEADER_CONFLICT: true';
  console.log(`[groq] EN identity merged=${JSON.stringify(merged)}`);
  console.log('[groq] EN OCR:', out.slice(0, 400));
  return out;
}

async function ocrGujaratiBill(dataUrl, headerDataUrl) {
  const raw = await chatCompletion({
    model: VISION_MODEL,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          {
            type: 'text',
            text:
              'Read this HANDWRITTEN GUJARATI shop bill (red/blue ink).\n' +
              'Labels: નામ/NAME, નંબર/NUMBER, વજન, રકમ, ટોટલ.\n' +
              'Keep person names in Gujarati script. Digits may be ૦-૯ — convert phone/amounts to ASCII 0-9.\n' +
              'Copy carefully. Do not invent common Indian names. If unsure: UNREADABLE.\n\n' +
              'Output EXACTLY (plain text):\n' +
              'NAME: <Gujarati name>\n' +
              'NAME_EN: <English transliteration or UNREADABLE>\n' +
              'NUMBER: <10 ASCII digits>\n' +
              'ITEM: <Gujarati item> | WEIGHT: <as written> | AMOUNT: <ASCII digits>\n' +
              'TOTAL: <ASCII digits>\n\n' +
              'Lexicon: ખાંડ=Sugar, ઘી=Ghee, બટર=Butter, ચીઝ=Cheese, દૂધ=Milk.',
          },
        ],
      },
    ],
  });

  const passRaw = extractOcrHeader(raw);
  let text = await refineGujaratiBillOcr(raw);
  const pass1 = mergeIdentityPasses(extractOcrHeader(text), passRaw);
  const pass2 = headerDataUrl
    ? await ocrHeaderCropWithRetry(headerDataUrl, 'gu')
    : { name: null, nameEn: null, number: null };
  const merged = mergeIdentityPasses(pass1, pass2);
  let out = rebuildCleanBillOcr(text, merged, raw);
  if (merged.conflict) out += '\nHEADER_CONFLICT: true';
  console.log(`[groq] GU identity merged=${JSON.stringify(merged)}`);
  console.log('[groq] GU OCR:', out.slice(0, 400));
  return out;
}

async function ocrHeaderCropWithRetry(headerDataUrl, lang = 'en', attempts = 2) {
  const prompt =
    lang === 'gu'
      ? 'This is the TOP of a handwritten GUJARATI bill. Read ONLY નામ/NAME and નંબર/NUMBER.\n' +
        'Keep name in Gujarati if written that way. Phone: 10 ASCII digits (convert ૦-૯).\n' +
        'Do not invent. Output ONLY:\nNAME: ...\nNAME_EN: ...\nNUMBER: <10 digits or UNREADABLE>'
      : 'This is the TOP of a handwritten ENGLISH bill. Read ONLY NAME and NUMBER.\n' +
        'Example: NAME: OM TRIVEDI  NUMBER: 9974099063\n' +
        'Copy exactly. Output ONLY:\nNAME: ...\nNAME_EN: ...\nNUMBER: <10 digits or UNREADABLE>';

  for (let i = 0; i < attempts; i++) {
    try {
      const headerRaw = await chatCompletion({
        model: VISION_MODEL,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: headerDataUrl } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      });
      return extractOcrHeader(headerRaw);
    } catch (err) {
      const msg = err.message || '';
      const waitMatch = msg.match(/try again in ([\d.]+)s/i);
      const waitMs = waitMatch
        ? Math.ceil(Number(waitMatch[1]) * 1000) + 500
        : 8000;
      console.error(`[groq] header crop OCR failed (try ${i + 1}):`, msg.slice(0, 180));
      if (i < attempts - 1 && /rate limit|tpm|tokens per minute/i.test(msg)) {
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      return { name: null, nameEn: null, number: null };
    }
  }
  return { name: null, nameEn: null, number: null };
}

/** Keep only structured bill lines so thinking dumps never reach the agent. */
function rebuildCleanBillOcr(billText, header, rawFallback = '') {
  const sources = [
    stripModelNoise(billText || ''),
    stripModelNoise(rawFallback || ''),
    normalizeGujaratiDigitsSafe(String(rawFallback || '')),
  ];

  let items = [];
  let total = null;
  for (const src of sources) {
    const found = src
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^ITEM\s*:/i.test(l));
    if (found.length && items.length === 0) items = found;
    const t = src.match(/(?:^|\n)\s*TOTAL\s*:\s*([0-9]+(?:\.\d+)?)/im)?.[1]?.trim();
    if (t && !total) total = t;
  }

  // Fallback: sum line amounts if TOTAL missing
  if (!total && items.length) {
    const sum = items.reduce((s, line) => {
      const m = line.match(/AMOUNT\s*:\s*([0-9]+(?:\.\d+)?)/i);
      return s + (m ? Number(m[1]) : 0);
    }, 0);
    if (sum > 0) total = String(sum);
  }

  const lines = [
    `NAME: ${header.name || 'UNREADABLE'}`,
    `NAME_EN: ${header.nameEn || header.name || 'UNREADABLE'}`,
    `NUMBER: ${header.number || 'UNREADABLE'}`,
    ...items,
    `TOTAL: ${total || 'UNREADABLE'}`,
  ];
  return lines.join('\n');
}

function normalizeGujaratiDigitsSafe(text) {
  try {
    return require('../utils/gujarati').normalizeGujaratiDigits(text);
  } catch {
    return text;
  }
}

/**
 * Prefer English/Latin identity when available; require phone agreement when both passes have phones.
 */
function mergeIdentityPasses(pass1, pass2) {
  const latin = (s) => /^[A-Za-z][A-Za-z\s.'()-]*$/.test(String(s || '').trim());
  const pickName = () => {
    if (pass2.name && latin(pass2.name)) return pass2.name;
    if (pass1.name && latin(pass1.name)) return pass1.name;
    if (pass2.name && pass1.name && normalizePersonName(pass1.name) === normalizePersonName(pass2.name)) {
      return pass2.name;
    }
    // Prefer longer/clearer English-looking header read
    if (pass2.name) return pass2.name;
    if (pass1.name) return pass1.name;
    return null;
  };
  const pickEn = () => pass2.nameEn || pass1.nameEn || (latin(pickName()) ? pickName() : null);
  const phonesAgree =
    pass1.number && pass2.number ? pass1.number === pass2.number : true;
  const pickPhone = () => {
    if (pass2.number && pass1.number && pass2.number !== pass1.number) {
      // Prefer header-crop phone for English bills
      return pass2.number;
    }
    return pass2.number || pass1.number || null;
  };

  const name = pickName();
  const number = pickPhone();
  const conflict = Boolean(pass1.number && pass2.number && !phonesAgree);

  return {
    name,
    nameEn: pickEn(),
    number,
    conflict,
  };
}

function normalizePersonName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[()（）]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractOcrHeader(text) {
  const { normalizeGujaratiDigits } = require('../utils/gujarati');
  const full = normalizeGujaratiDigits(String(text || ''));
  const t = normalizeGujaratiDigits(stripModelNoise(text || ''));
  const searchIn = `${t}\n${full}`;

  let name =
    searchIn.match(/(?:^|\n)\s*NAME:\s*(?!UNREADABLE)(.+?)\s*(?:\n|$)/im)?.[1]?.trim() ||
    searchIn.match(
      /\bNAME\s*[:\-]\s*((?:OM|Om|om)\s+[A-Za-z]+|[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3}|[\u0A80-\u0AFF][\u0A80-\u0AFF\s]{1,40})/
    )?.[1]?.trim() ||
    null;
  let nameEn =
    searchIn.match(/(?:^|\n)\s*NAME_EN:\s*(?!UNREADABLE)(.+?)\s*(?:\n|$)/im)?.[1]?.trim() ||
    null;
  let number =
    searchIn.match(/(?:^|\n)\s*NUMBER:\s*([0-9૦-૯]{10}|UNREADABLE)\s*(?:\n|$)/im)?.[1]?.trim() ||
    searchIn.match(/\bNUMBER\s*[:\-]?\s*([0-9૦-૯]{10})\b/i)?.[1] ||
    searchIn.match(/(?<!\d)([6-9][0-9]{9})(?!\d)/)?.[1] ||
    null;

  if (name) {
    name = name.replace(/[*"_`]/g, '').trim();
    if (/^UNREADABLE$/i.test(name)) name = null;
  }
  if (nameEn && /^UNREADABLE$/i.test(nameEn)) nameEn = null;
  if (number && !/^UNREADABLE$/i.test(number)) {
    number = normalizeGujaratiDigits(number).replace(/\D/g, '');
    if (number.length !== 10 || !/^[6-9]/.test(number)) number = null;
  } else if (number && /^UNREADABLE$/i.test(number)) {
    number = null;
  }

  // If English name found but nameEn empty, mirror it
  if (name && !nameEn && /^[A-Za-z]/.test(name)) nameEn = name;

  return { name, nameEn, number };
}

function applyHeaderToBillOcr(billText, header) {
  let out = String(billText || '');
  const nameLine = header.name || 'UNREADABLE';
  const nameEnLine = header.nameEn || 'UNREADABLE';
  const numberLine = header.number || 'UNREADABLE';

  if (/^NAME:/im.test(out)) out = out.replace(/^NAME:.*$/im, `NAME: ${nameLine}`);
  else out = `NAME: ${nameLine}\n${out}`;

  if (/^NAME_EN:/im.test(out)) out = out.replace(/^NAME_EN:.*$/im, `NAME_EN: ${nameEnLine}`);
  else out = out.replace(/^(NAME:.*)$/im, `$1\nNAME_EN: ${nameEnLine}`);

  if (/^NUMBER:/im.test(out)) out = out.replace(/^NUMBER:.*$/im, `NUMBER: ${numberLine}`);
  else out = out.replace(/^(NAME_EN:.*)$/im, `$1\nNUMBER: ${numberLine}`);

  return out;
}

/**
 * Second-pass cleanup: fix common Gujarati OCR misreads + normalize digits.
 */
async function refineGujaratiBillOcr(rawOcr) {
  const { normalizeGujaratiDigits, containsGujarati } = require('../utils/gujarati');
  let text = normalizeGujaratiDigits(stripModelNoise(rawOcr || ''));
  if (!text || /no text found/i.test(text)) return text;

  // Fast path: already structured and has digits
  if (!containsGujarati(text) && /NAME:|ITEM:/i.test(text)) {
    return text;
  }

  try {
    const cleaned = await chatCompletion({
      model: EXTRACTION_MODEL,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You clean OCR from Gujarati handwritten kirana bills. ' +
            'Fix obvious item-name misreads using: ખાંડ=Sugar, ઘી=Ghee, બટર=Butter, ચીઝ=Cheese, દૂધ=Milk. ' +
            'Convert Gujarati digits to ASCII 0-9. ' +
            'CRITICAL: Do NOT change AMOUNT or TOTAL numbers except digit-script conversion — copy amounts exactly as OCR read them. ' +
            'Do NOT recalculate the total. ' +
            'CRITICAL: Preserve NAME / NAME_EN / NUMBER from the input — do not invent or blank them unless they say UNREADABLE. ' +
            'Output the SAME template only:\n' +
            'NAME: ...\nNAME_EN: ...\nNUMBER: ...\nITEM: ... | WEIGHT: ... | AMOUNT: ...\nTOTAL: ...\n' +
            'No markdown, no commentary.',
        },
        {
          role: 'user',
          content: `Clean this OCR bill text:\n\n${text}`,
        },
      ],
    });
    return normalizeGujaratiDigits(stripModelNoise(cleaned));
  } catch (err) {
    console.error('[groq] refineGujaratiBillOcr failed:', err.message);
    return text;
  }
}

/**
 * main.py gujarati_ocr_pipeline:
 * Image → Vision OCR → Gujarati text → translate → summary
 */
async function gujaratiOcrPipeline(imageBuffer, mimeType = 'image/jpeg') {
  if (!getApiKey()) return 'AI not configured.';

  let gujaratiText;
  try {
    gujaratiText = (await ocrImageText(imageBuffer, mimeType)).trim();
    console.log('[groq] OCR result:', gujaratiText);
  } catch (err) {
    console.error('[groq] OCR error:', err.message);
    return `❌ OCR failed: ${err.message}`;
  }

  if (!gujaratiText || gujaratiText.toLowerCase() === 'no text found') {
    return '🖼️ No text was detected in your image.';
  }

  let englishText = '(Translation failed)';
  try {
    englishText = await chatCompletion({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert Gujarati-to-English translator. ' +
            'Translate the provided Gujarati text to clear, accurate English. ' +
            'Output only the English translation, nothing else.',
        },
        {
          role: 'user',
          content: `Translate this Gujarati text to English:\n\n${gujaratiText}`,
        },
      ],
    });
    console.log('[groq] Translation:', englishText);
  } catch (err) {
    console.error('[groq] Translation error:', err.message);
  }

  let summary = '(Summary unavailable)';
  try {
    summary = await chatCompletion({
      model: CHAT_MODEL,
      messages: [
        {
          role: 'system',
          content: 'Provide a concise summary of the text in 2-3 sentences.',
        },
        { role: 'user', content: `Summarize:\n\n${englishText}` },
      ],
    });
  } catch (_) {
    /* ignore */
  }

  return (
    `🔍 *Text (OCR):*\n${clip(gujaratiText, 1200)}\n\n` +
    `🌐 *English:*\n${clip(englishText, 1200)}\n\n` +
    `📋 *Summary:*\n${clip(summary, 800)}`
  );
}

/**
 * main.py analyze_image_general — describe image with optional caption prompt.
 */
async function analyzeImage(imageBuffer, caption = '', mimeType = 'image/jpeg') {
  if (!getApiKey()) return 'AI not configured.';

  const safeMime = mimeType?.startsWith('image/') ? mimeType : 'image/jpeg';
  const imageB64 = Buffer.from(imageBuffer).toString('base64');
  const dataUrl = `data:${safeMime};base64,${imageB64}`;
  const prompt = caption || 'Describe this image in detail.';

  try {
    const content = await chatCompletion({
      model: VISION_MODEL,
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
    return `🖼️ ${clip(content, 3500)}`;
  } catch (err) {
    console.error('[groq] analyzeImage error:', err.message);
    return `❌ Image analysis failed: ${err.message}`;
  }
}

async function summarizeDocument(fileTypeLabel, displayText) {
  try {
    return await chatCompletion({
      model: CHAT_MODEL,
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
  VISION_MODEL,
  extractIntent,
  transcribeAudio,
  generateAiResponse,
  ocrImageText,
  detectBillLanguage,
  refineGujaratiBillOcr,
  gujaratiOcrPipeline,
  analyzeImage,
  summarizeDocument,
};
