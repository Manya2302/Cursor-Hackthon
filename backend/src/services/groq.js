const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const EXTRACTION_MODEL = 'llama-3.3-70b-versatile';
const WHISPER_MODEL = 'whisper-large-v3';
const WHISPER_FALLBACK_MODEL = 'whisper-large-v3-turbo';

const GUJARATI_VOICE_PROMPT =
  'નામ, નંબર, ખાંડ, ઘી, બટર, ચીઝ, દૂધ, કિલો, ગ્રામ, ટોટલ, રકમ. ' +
  'Naam means name. Number means phone. Transcribe exact Gujarati words as spoken.';

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
- "product_query" — ask about stock/quantity/price/details of a product in the catalog, or list products / low stock. NOT a P&L statement. Examples: "quantity of milk", "stock of sugar", "price of ghee", "send me product details of maggi", "list products"
- "statement_query" — they want a financial report/statement (P&L, balance sheet, cashflow, ledger, party udhaar). Do NOT use for product stock/qty questions.
- "chat" — greeting, question, or help that is NOT a bookkeeping entry and NOT a product catalog lookup
- "unclear" — cannot tell without guessing

STRICT RULES:
- NEVER invent names, phones, products, amounts, or totals. Missing → null.
- NEVER guess missing grocery rows to "complete" a bill.
- NEVER duplicate an item unless the source text clearly repeats that row.
- NEVER convert/translate Gujarati item names before extraction is done; keep script as written, put English gloss in name_en only after.
- If OCR says NAME: UNREADABLE or NUMBER: UNREADABLE → party.name / party.phone must be null (do not guess).
- If HEADER_CONFLICT: true appears → treat name/phone as unreliable; use null unless both passes clearly agree in the text.
- NEVER calculate totals to fill gaps — copy TOTAL only if written. If TOTAL ≠ sum(line amounts), still copy TOTAL and note mismatch in notes.
- NEVER convert units (500GM stays quantity 500 + unit "GM"; keep weight_text as written).
- Extract EVERY product/item row — do not drop lines, do not merge adjacent rows.
- Customer name+phone+items+costs+TOTAL on a chit → transaction / sale / party.role customer.
- For Gujarati bills: keep party.name in Gujarati script; if NAME_EN is present and not UNREADABLE put it in name_en (and optionally notes like "name_en: Om Trivedi").
- Phone NUMBER may use Gujarati digits — treat as the same phone once normalized to 0-9.
- Item lines may look like: ITEM: ખાંડ | WEIGHT: 1 કિલો | AMOUNT: 200 — map to items[].name, weight_text, line_amount.
- Known Gujarati groceries: ખાંડ=Sugar, ઘી=Ghee, બટર=Butter, ચીઝ=Cheese, દૂધ=Milk (do not swap these).
- Supplier / stock / price-list / "add products" with item rows → inventory_bulk; party.role supplier when a supplier is named.
- PDF / CSV / Excel product or price lists with NO customer name → inventory_bulk (do not ask for customer name/phone).
- Questions about product quantity/stock/price/catalog → product_query (NOT statement_query, NOT chat). Put product name in product_query.name and ask type in product_query.action.
- Do NOT format a human reply — extraction only. Output JSON only.

JSON schema (always return all top-level keys):
{
  "intent": "transaction" | "inventory_bulk" | "product_query" | "statement_query" | "chat" | "unclear",
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
  "product_query": {
    "action": "stock" | "price" | "info" | "list" | "low_stock" | null,
    "name": string | null,
    "names": string[] | null
  },
  "statement": {
    "statementType": "pnl" | "balance_sheet" | "cashflow" | "owners_equity" | "party_ledger" | "ledger_account" | "accounting_equation" | null,
    "datePhrase": "today" | "this_week" | "this_month" | "last_month" | "last_3_months" | "this_year" | "previous_year" | "year_to_date" | "custom_range" | null,
    "accountName": string | null,
    "partyName": string | null,
    "startDate": string | null,
    "endDate": string | null,
    "type": string | null,
    "period": string | null
  },
  "notes": string | null,
  "unclear_reason": string | null
}

For product_query:
- action=stock for quantity/qty/stock/how much left; price for selling/buy price; info for full product details; list for all products; low_stock for reorder alerts.
- name = the product they asked about (e.g. milk, sugar, દૂધ). null for list/low_stock.
- names = array when they ask about multiple products ("milk and sugar", "send me product of ghee and maggi"); otherwise null and use name.
- Never invent stock or prices — backend will SQL-query Product Master.
- "send me product of X" is product_query (info), NEVER statement_query / never a P&L report.

For statement_query:
- Map user ask to statementType (P&L / "statement" / નફો → pnl; balance sheet → balance_sheet; cash → cashflow; ledger of X → ledger_account with accountName; party udhaar → party_ledger with partyName; accounting equation → accounting_equation).
- datePhrase from fixed enum only; put ISO dates in startDate/endDate ONLY when datePhrase is custom_range.
- Never invent financial numbers — extraction only classifies the request.
- Do NOT classify product stock questions as statement_query.`;

const { getApiKey, getApiKeys, withGroqKey } = require('./groqKeys');

async function chatCompletion({
  messages,
  model,
  temperature = 0,
  max_tokens = 1024,
  retries = 2,
}) {
  return withGroqKey(async (apiKey, keyIndex) => {
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const res = await fetch(GROQ_CHAT_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages,
            temperature,
            max_tokens,
          }),
        });

        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const msg = body?.error?.message || `Groq chat failed (${res.status})`;
          const waitMatch = msg.match(/try again in ([\d.]+)\s*s/i);
          if (
            res.status === 429 ||
            /rate limit|tokens per minute|TPM/i.test(msg)
          ) {
            // Prefer switching to fallback key over waiting on same key
            if (keyIndex < getApiKeys().length - 1) {
              throw new Error(msg);
            }
            const waitSec = waitMatch
              ? Math.ceil(Number(waitMatch[1]) + 0.5)
              : 3 + attempt * 2;
            console.warn(
              `[groq] rate limit on key ${keyIndex + 1} — waiting ${waitSec}s`
            );
            await new Promise((r) => setTimeout(r, waitSec * 1000));
            lastErr = new Error(msg);
            continue;
          }
          throw new Error(msg);
        }

        return stripModelNoise(
          body.choices?.[0]?.message?.content?.trim() || ''
        );
      } catch (err) {
        lastErr = err;
        const msg = String(err.message || err);
        // Bubble rate-limit / auth up so withGroqKey can switch keys
        if (
          /rate limit|TPM|429|401|403|invalid.*api/i.test(msg) &&
          keyIndex < getApiKeys().length - 1
        ) {
          throw err;
        }
        if (/rate limit|TPM|429/i.test(msg) && attempt < retries - 1) {
          await new Promise((r) => setTimeout(r, (3 + attempt * 2) * 1000));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('Groq chat failed');
  });
}

/**
 * Pull structured bill lines out of noisy Qwen output (including inside <think>).
 */
function extractStructuredBill(text) {
  const full = normalizeGujaratiDigitsSafe(String(text || ''));
  const lines = [];

  const lang = full.match(/\bLANG\s*:\s*(en|gu)\b/i)?.[1]?.toLowerCase() || null;
  const name = full.match(/(?:^|\n)\s*NAME\s*:\s*(?!UNREADABLE)([^\n<]+)/i)?.[1]?.trim() || null;
  const nameEn =
    full.match(/(?:^|\n)\s*NAME_EN\s*:\s*(?!UNREADABLE)([^\n<]+)/i)?.[1]?.trim() || null;
  let number =
    full.match(/(?:^|\n)\s*NUMBER\s*:\s*([0-9૦-૯]{10})/i)?.[1] ||
    full.match(/\bNUMBER\s*[:\-]?\s*([0-9૦-૯]{10})\b/i)?.[1] ||
    null;
  if (number) number = normalizeGujaratiDigitsSafe(number).replace(/\D/g, '');

  const itemRe = /(?:^|\n)\s*ITEM\s*:\s*([^\n]+)/gi;
  let m;
  while ((m = itemRe.exec(full)) !== null) {
    const body = m[1].trim();
    if (body && !/^UNREADABLE$/i.test(body)) {
      lines.push(`ITEM: ${body}`);
    }
  }

  // Fallback: known grocery rows written without ITEM: prefix
  if (lines.length === 0) {
    const lex = [
      'ખાંડ',
      'ઘી',
      'બટર',
      'ચીઝ',
      'દૂધ',
      'Sugar',
      'Ghee',
      'Butter',
      'Cheese',
      'Milk',
      'Maggi',
      'Maggie',
      'Tea',
      'Oil',
      'Rice',
      'Atta',
      'Flour',
    ];
    for (const nameItem of lex) {
      const re = new RegExp(
        `${nameItem}\\s*[,|\\-:]?\\s*(\\d+(?:\\.\\d+)?\\s*(?:kg|gm|g|ml|l|pcs|nos)?)?\\s*[,|\\-:]?\\s*(\\d{2,5})(?:\\s*Rs|\\s*₹)?`,
        'i'
      );
      const hit = full.match(re);
      if (hit) {
        lines.push(
          `ITEM: ${nameItem} | WEIGHT: ${hit[1] || ''} | AMOUNT: ${hit[2]}`
        );
      }
    }
  }

  let total =
    full.match(/(?:^|\n)\s*TOTAL\s*:\s*([0-9૦-૯]+(?:\.\d+)?)/i)?.[1] ||
    full.match(/\b(?:TOTAL|ટોટલ)\s*[:\-]?\s*([0-9૦-૯]{2,6})/i)?.[1] ||
    null;
  if (total) total = normalizeGujaratiDigitsSafe(total).replace(/[^\d.]/g, '');

  if (!total && lines.length) {
    const sum = lines.reduce((s, line) => {
      const a = line.match(/AMOUNT\s*:\s*([0-9]+(?:\.\d+)?)/i);
      return s + (a ? Number(a[1]) : 0);
    }, 0);
    if (sum > 0) total = String(sum);
  }

  return {
    lang,
    name: name && !/^UNREADABLE$/i.test(name) ? name.replace(/[*"_`]/g, '').trim() : null,
    nameEn: nameEn && !/^UNREADABLE$/i.test(nameEn) ? nameEn.trim() : null,
    number: number && number.length === 10 ? number : null,
    items: lines,
    total,
  };
}

/** Remove Qwen/thinking dumps — but keep any structured bill lines found inside. */
function stripModelNoise(text) {
  if (!text) return '';
  const structured = extractStructuredBill(text);
  if (structured.items.length || structured.name || structured.number || structured.total) {
    const out = [
      structured.lang ? `LANG: ${structured.lang}` : null,
      `NAME: ${structured.name || 'UNREADABLE'}`,
      `NAME_EN: ${structured.nameEn || structured.name || 'UNREADABLE'}`,
      `NUMBER: ${structured.number || 'UNREADABLE'}`,
      ...structured.items,
      `TOTAL: ${structured.total || 'UNREADABLE'}`,
    ]
      .filter(Boolean)
      .join('\n');
    return out;
  }

  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .trim();
  // Only strip unclosed think if something remains after removing the tag opener
  if (/<think>/i.test(cleaned) && /(?:NAME|ITEM|TOTAL)\s*:/i.test(cleaned)) {
    cleaned = cleaned.replace(/<\/?think>/gi, '\n');
  } else {
    cleaned = cleaned
      .replace(/<think>[\s\S]*$/gi, '')
      .replace(/<thinking>[\s\S]*$/gi, '');
  }

  const start = cleaned.search(/^(LANG|NAME|NAME_EN|NUMBER|ITEM|TOTAL)\s*:/im);
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
 * Whisper transcription — Gujarati-first (language=gu), with retries/fallback.
 * Returns plain transcript text (Gujarati/Hinglish as spoken).
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  const keys = getApiKeys();
  if (!keys.length) {
    throw new Error('GROQ_API_KEY is not set');
  }

  if (audioBuffer && !Buffer.isBuffer(audioBuffer) && !(audioBuffer instanceof Uint8Array)) {
    audioBuffer = Buffer.from(audioBuffer);
  }
  if (!audioBuffer || audioBuffer.length < 100) {
    throw new Error('Voice note was empty or too short');
  }

  const rawMime = String(mimeType || 'audio/ogg').split(';')[0].trim().toLowerCase();
  const mime =
    rawMime.includes('mpeg') || rawMime.includes('mp3')
      ? 'audio/mpeg'
      : rawMime.includes('mp4') || rawMime.includes('m4a')
        ? 'audio/mp4'
        : rawMime.includes('wav')
          ? 'audio/wav'
          : rawMime.includes('webm')
            ? 'audio/webm'
            : 'audio/ogg';
  const ext =
    mime === 'audio/mpeg'
      ? 'mp3'
      : mime === 'audio/mp4'
        ? 'mp4'
        : mime === 'audio/wav'
          ? 'wav'
          : mime === 'audio/webm'
            ? 'webm'
            : 'ogg';

  const attempts = [
    { model: WHISPER_MODEL, language: 'gu', prompt: GUJARATI_VOICE_PROMPT },
    { model: WHISPER_MODEL, language: 'gu', prompt: 'આ અવાજ નોંધ ગુજરાતીમાં છે. નામ અને નંબર સ્પષ્ટ લખો.' },
    { model: WHISPER_FALLBACK_MODEL, language: 'gu', prompt: GUJARATI_VOICE_PROMPT },
    { model: WHISPER_MODEL, language: undefined, prompt: GUJARATI_VOICE_PROMPT },
  ];

  let lastErr = null;
  for (const apiKey of keys) {
    for (let i = 0; i < attempts.length; i++) {
      const cfg = attempts[i];
      try {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 600 + i * 400));
        }
        const text = await whisperOnce({
          apiKey,
          audioBuffer,
          mime,
          ext,
          model: cfg.model,
          language: cfg.language,
          prompt: cfg.prompt,
        });
        if (text && text.trim()) {
          console.log(
            `[groq] whisper ok model=${cfg.model} lang=${cfg.language || 'auto'} chars=${text.trim().length}`
          );
          return normalizeVoiceTranscript(text.trim());
        }
      } catch (err) {
        lastErr = err;
        console.error(
          `[groq] whisper attempt failed:`,
          String(err.message || err).slice(0, 200)
        );
        if (/401|403|invalid.*api|rate limit|TPM/i.test(String(err.message))) {
          // Try next API key
          break;
        }
      }
    }
  }

  const msg = String(lastErr?.message || 'Whisper failed');
  if (/internal_server_error|Internal Server Error|502|503|500/i.test(msg)) {
    throw new Error(
      'Voice service is busy. Please wait a few seconds and send the voice note again.'
    );
  }
  throw new Error(msg.slice(0, 180));
}

async function whisperOnce({
  apiKey,
  audioBuffer,
  mime,
  ext,
  model,
  language,
  prompt,
}) {
  const form = new FormData();
  const bytes = Buffer.isBuffer(audioBuffer)
    ? audioBuffer
    : Buffer.from(audioBuffer);
  // Prefer File when available (Node 20+) — more reliable than Blob for Groq
  if (typeof File !== 'undefined') {
    form.append('file', new File([bytes], `audio.${ext}`, { type: mime }));
  } else {
    form.append('file', new Blob([bytes], { type: mime }), `audio.${ext}`);
  }
  form.append('model', model);
  form.append('response_format', 'text');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const text = (await res.text()).trim();
  if (!res.ok) {
    throw new Error(text || `Whisper failed (${res.status})`);
  }
  // Sometimes API returns JSON even for text format on errors
  if (text.startsWith('{') && /"error"/i.test(text)) {
    throw new Error(text);
  }
  return text.replace(/^"|"$/g, '');
}

/**
 * Normalize spoken Gujarati/Hinglish voice notes into clear NAME:/NUMBER: cues
 * so extraction + identity correction understand "naam" / "નામ" / "number".
 */
function normalizeVoiceTranscript(text) {
  if (!text) return text;
  let t = String(text).trim();

  // Spoken labels → structured labels (keep Gujarati name words intact)
  t = t.replace(
    /(?:^|[\s,])(?:naam|name|નામ|नाम)\s*[:\-–]?\s*/gi,
    '\nNAME: '
  );
  t = t.replace(
    /(?:^|[\s,])(?:number|nambar|phone|mobile|મોબાઇલ|મોબાઈલ|નંબર|नंबर)\s*[:\-–]?\s*/gi,
    '\nNUMBER: '
  );

  // "my name is X" / "મારું નામ X"
  t = t.replace(
    /(?:my\s+name\s+is|મારું\s*નામ|મારુ\s*નામ)\s+/gi,
    '\nNAME: '
  );

  // Collapse spaces; keep newlines for NAME/NUMBER lines
  t = t
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

  return t.trim();
}

/**
 * Vision OCR — ONE vision call when possible (8000 TPM).
 * No refine / no header crop unless identity is missing after first pass.
 */
async function ocrImageText(imageBuffer, mimeType = 'image/jpeg') {
  const { dataUrl, headerDataUrl } = await prepareBillImages(imageBuffer, mimeType);

  let raw = await runBillVision(dataUrl);
  let structured = extractStructuredBill(raw);
  let lang =
    structured.lang ||
    (/\bLANG\s*:\s*gu\b/i.test(raw) ? 'gu' : null) ||
    (require('../utils/gujarati').containsGujarati(raw) ? 'gu' : 'en');

  // Only retry if zero items — wait for TPM window, use stricter prompt
  if (!structured.items.length) {
    console.log('[groq] no ITEM lines — waiting 3s then one retry…');
    await new Promise((r) => setTimeout(r, 3000));
    try {
      raw = await runBillVision(dataUrl, true);
      structured = extractStructuredBill(raw);
      lang =
        structured.lang ||
        (/\bLANG\s*:\s*gu\b/i.test(raw) ? 'gu' : lang || 'en');
    } catch (err) {
      console.error('[groq] OCR retry failed:', err.message.slice(0, 160));
    }
  }

  lang = lang || 'en';
  console.log(`[groq] bill language detected: ${lang}`);

  // NEVER call refineGujaratiBillOcr here — burns TPM and invents rows.
  let text = stripModelNoise(raw);
  if (structured.items.length) {
    text = [
      `NAME: ${structured.name || 'UNREADABLE'}`,
      `NAME_EN: ${structured.nameEn || 'UNREADABLE'}`,
      `NUMBER: ${structured.number || 'UNREADABLE'}`,
      ...structured.items,
      `TOTAL: ${structured.total || 'UNREADABLE'}`,
    ].join('\n');
  }

  const passRaw = extractOcrHeader(raw);
  let pass1 = mergeIdentityPasses(extractOcrHeader(text), passRaw);
  if (structured.name || structured.number) {
    pass1 = mergeIdentityPasses(pass1, {
      name: structured.name,
      nameEn: structured.nameEn,
      number: structured.number,
    });
  }

  // Header crop ONLY if we have items but still missing BOTH name and phone
  // (saves ~3k TPM on the common path)
  let pass2 = { name: null, nameEn: null, number: null };
  if (
    headerDataUrl &&
    structured.items.length > 0 &&
    !pass1.name &&
    !pass1.number
  ) {
    console.log('[groq] identity blank — header crop (1 call)…');
    await new Promise((r) => setTimeout(r, 2500));
    try {
      pass2 = await ocrHeaderCropWithRetry(headerDataUrl, lang, 1);
    } catch (err) {
      console.error('[groq] header crop skipped:', err.message.slice(0, 120));
    }
  }

  const merged = mergeIdentityPasses(pass1, pass2);
  let out = rebuildCleanBillOcr(text, merged, raw);
  if (merged.conflict) out += '\nHEADER_CONFLICT: true';
  console.log(`[groq] identity merged=${JSON.stringify(merged)}`);
  console.log('[groq] OCR:', out.slice(0, 500));
  return `${require('../utils/gujarati').normalizeGujaratiDigits(out)}\nBILL_LANG: ${lang}`;
}

async function runBillVision(dataUrl, strictRetry = false) {
  const prompt = strictRetry
    ? 'STRICT OCR. Keep image language (en/gu).\n' +
      'Table columns Item | Quantity | Price OR lines like Ghee-1kg-1-200.\n' +
      'Output one line per product as: ITEM: Product-pack-count-lineTotal\n' +
      'Example: ITEM: Ghee-1kg-1-200\nITEM: Sugar-500gm-2-250\nITEM: Milk-1kg-1-52\n' +
      'Also: LANG / NAME / NUMBER / TOTAL. Never invent.'
    : 'OCR handwritten kirana bill. Detect LANG en|gu.\n' +
      'Header: Name + Number.\n' +
      'Table often: Item | Quantity | Price\n' +
      '  Ghee - 1kg | 1 | 200\n' +
      '  Sugar - 500gm | 2 | 250\n' +
      '  Milk - 1kg | 1 | 52\n' +
      'Rewrite EACH row as: ITEM: <Product>-<pack>-<count>-<lineTotal>\n' +
      'Examples:\n' +
      'ITEM: Ghee-1kg-1-200\n' +
      'ITEM: Sugar-500gm-2-250\n' +
      'ITEM: Milk-1kg-1-52\n' +
      'Also support compact: Ghee1kg-6-3000\n' +
      'Rules: every row; never invent; never duplicate; Price column = line total.\n' +
      'Output ONLY:\n' +
      'LANG: en|gu\nNAME: ...\nNAME_EN: ...\nNUMBER: ...\n' +
      'ITEM: Product-pack-count-total\nTOTAL: digits';

  return chatCompletion({
    model: VISION_MODEL,
    temperature: 0,
    max_tokens: 900,
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
}

async function prepareBillImages(imageBuffer, mimeType = 'image/jpeg') {
  const safeMime = mimeType?.startsWith('image/') ? mimeType : 'image/jpeg';
  try {
    const sharp = require('sharp');
    // Mild downscale — handwriting needs more pixels than before
    const jpeg = await sharp(imageBuffer)
      .rotate()
      .resize({ width: 1280, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;

    const meta = await sharp(imageBuffer).rotate().metadata();
    const w = meta.width || 960;
    const h = meta.height || 960;
    const headerBuf = await sharp(imageBuffer)
      .rotate()
      .extract({
        left: 0,
        top: 0,
        width: w,
        height: Math.max(80, Math.round(h * 0.28)),
      })
      .normalize()
      .resize({ width: 960, withoutEnlargement: true })
      .jpeg({ quality: 80 })
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
 * Prefer ocrImageText single-pass LANG line; this is a fallback helper.
 * @returns {'en' | 'gu'}
 */
async function detectBillLanguage(dataUrl) {
  try {
    let tinyUrl = dataUrl;
    try {
      const sharp = require('sharp');
      const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const tiny = await sharp(Buffer.from(b64, 'base64'))
        .resize({ width: 480, withoutEnlargement: true })
        .jpeg({ quality: 60 })
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
              text: 'LANG: en or LANG: gu only. English letters→en, Gujarati script→gu.',
            },
          ],
        },
      ],
    });
    const cleaned = stripModelNoise(out);
    if (/\bLANG\s*:\s*gu\b/i.test(cleaned)) return 'gu';
    return 'en';
  } catch (err) {
    console.error('[groq] detectBillLanguage failed:', err.message);
    return 'en';
  }
}

async function ocrEnglishBill(dataUrl, headerDataUrl) {
  // Kept for direct calls; prefer ocrImageText single-pass.
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
              'Read ENGLISH handwritten bill. Output:\n' +
              'NAME:\nNAME_EN:\nNUMBER:\nITEM: … | WEIGHT: … | AMOUNT: …\nTOTAL:',
          },
        ],
      },
    ],
  });
  const pass1 = extractOcrHeader(raw);
  const pass2 =
    headerDataUrl && (!pass1.name || !pass1.number)
      ? await ocrHeaderCropWithRetry(headerDataUrl, 'en', 1)
      : { name: null, nameEn: null, number: null };
  const merged = mergeIdentityPasses(pass1, pass2);
  return rebuildCleanBillOcr(stripModelNoise(raw), merged, raw);
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
              'Read GUJARATI handwritten bill. Digits ૦-૯→ASCII. Output:\n' +
              'NAME:\nNAME_EN:\nNUMBER:\nITEM: … | WEIGHT: … | AMOUNT: …\nTOTAL:',
          },
        ],
      },
    ],
  });
  const text = await refineGujaratiBillOcr(raw);
  const pass1 = mergeIdentityPasses(extractOcrHeader(text), extractOcrHeader(raw));
  const pass2 =
    headerDataUrl && (!pass1.name || !pass1.number)
      ? await ocrHeaderCropWithRetry(headerDataUrl, 'gu', 1)
      : { name: null, nameEn: null, number: null };
  const merged = mergeIdentityPasses(pass1, pass2);
  return rebuildCleanBillOcr(text, merged, raw);
}

async function ocrHeaderCropWithRetry(headerDataUrl, lang = 'en', attempts = 1) {
  const prompt =
    lang === 'gu'
      ? 'TOP of GUJARATI bill only. Output:\nNAME: ...\nNAME_EN: ...\nNUMBER: <10 digits or UNREADABLE>'
      : 'TOP of ENGLISH bill only. Output:\nNAME: ...\nNAME_EN: ...\nNUMBER: <10 digits or UNREADABLE>';

  for (let i = 0; i < attempts; i++) {
    try {
      const headerRaw = await chatCompletion({
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 200,
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
        ? Math.min(25000, Math.ceil(Number(waitMatch[1]) * 1000) + 800)
        : 12000;
      console.error(`[groq] header crop OCR failed (try ${i + 1}):`, msg.slice(0, 160));
      if (i < attempts - 1 && /rate limit|tpm|tokens per minute/i.test(msg)) {
        console.log(`[groq] waiting ${Math.round(waitMs / 1000)}s for TPM…`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      // Don't burn more TPM — continue with main OCR identity only
      return { name: null, nameEn: null, number: null };
    }
  }
  return { name: null, nameEn: null, number: null };
}

/** Keep only structured bill lines so thinking dumps never reach the agent. */
function rebuildCleanBillOcr(billText, header, rawFallback = '') {
  const fromRaw = extractStructuredBill(rawFallback);
  const fromBill = extractStructuredBill(billText);
  const items =
    fromBill.items.length > 0
      ? fromBill.items
      : fromRaw.items.length > 0
        ? fromRaw.items
        : [];
  const total = fromBill.total || fromRaw.total || null;

  const lines = [
    `NAME: ${header.name || fromBill.name || fromRaw.name || 'UNREADABLE'}`,
    `NAME_EN: ${header.nameEn || header.name || fromBill.nameEn || fromRaw.nameEn || fromBill.name || fromRaw.name || 'UNREADABLE'}`,
    `NUMBER: ${header.number || fromBill.number || fromRaw.number || 'UNREADABLE'}`,
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
