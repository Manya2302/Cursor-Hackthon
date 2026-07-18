const express = require('express');
const { sendTextMessage, downloadMedia } = require('../services/whatsapp');
const { resolveOrCreateVendor } = require('../services/vendors');
const {
  extractIntent,
  transcribeAudio,
  ocrImageText,
  generateAiResponse,
} = require('../services/groq');
const { transcribeWithSarvam } = require('../services/sarvam');
const { extractDocumentText } = require('../services/documents');
const {
  stageRawExtraction,
  getLatestPendingExtraction,
  rejectPendingExtraction,
  markExtractionConfirmed,
  updatePendingParsed,
} = require('../services/extractions');
const { postTransaction } = require('../services/ledger');
const { postInventory } = require('../services/inventory');
const { detectLanguage } = require('../utils/language');
const { enrichParsedBill } = require('../utils/gujarati');
const { buildConfirmationSummary } = require('../utils/confirmation');
const { validateJournalEntry } = require('../utils/journalValidation');
const {
  parseConfirmationReply,
  parseIdentityCorrection,
  assessIdentityConfidence,
} = require('../utils/confirmReply');

const router = express.Router();

function getVerifyToken() {
  return (
    process.env.VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    ''
  ).trim();
}

/** Strip old slash-commands if someone still types them. */
function stripLegacyCommands(text) {
  if (!text) return '';
  return String(text)
    .replace(
      /^\s*\/?(ai-order|ai-stock-bulk|ai-stock|ai-payment|ai-report)\b[:\-\s,]*/i,
      ''
    )
    .trim();
}

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === getVerifyToken()) {
      console.log('WEBHOOK_VERIFIED');
      return res.status(200).send(String(challenge));
    }
    return res.status(403).send('Verification token mismatch');
  }

  return res.status(400).send('Missing parameters');
});

router.post('/webhook', (req, res) => {
  res.status(200).send('EVENT_RECEIVED');
  handleIncoming(req.body).catch((err) => {
    console.error('[webhook] unhandled error:', err.message);
  });
});

async function handleIncoming(body) {
  try {
    console.log('Incoming webhook:', JSON.stringify(body));
    if (body?.object !== 'whatsapp_business_account') return;

    const value = body?.entry?.[0]?.changes?.[0]?.value || {};
    if (!value.messages?.[0]) return;

    const message = value.messages[0];
    const phoneNumberId = value.metadata?.phone_number_id;
    const fromNumber = message.from;
    const msgType = message.type;
    const profileName = value.contacts?.[0]?.profile?.name;

    const vendor = await resolveOrCreateVendor(fromNumber, profileName);
    if (!vendor) {
      await sendTextMessage(
        fromNumber,
        'Sorry — could not register your account right now. Please try again.',
        phoneNumberId
      );
      return;
    }

    let reply = '';
    if (msgType === 'text') {
      reply = await handleText(vendor, message.text?.body || '');
    } else if (msgType === 'audio') {
      reply = await handleVoice(vendor, message);
    } else if (msgType === 'image') {
      reply = await handleImage(vendor, message);
    } else if (msgType === 'document') {
      reply = await handleDocument(vendor, message);
    } else {
      reply = `Unsupported message type: ${msgType}`;
    }

    if (reply) {
      await sendTextMessage(fromNumber, reply, phoneNumberId);
    }
  } catch (err) {
    console.error('[webhook] handleIncoming error:', err.message);
  }
}

/**
 * Single agent pipeline: analyze → stage → bill/stock confirmation.
 */
async function analyzeAndStage({
  vendor,
  rawText,
  caption = '',
  inputType,
  mediaUrl = null,
  sourceHint = '',
  filename = '',
}) {
  const cleaned = stripLegacyCommands(rawText);
  const captionClean = stripLegacyCommands(caption);
  const filenameHint = filename || '';
  const detectedLanguage = (() => {
    const billLang = String(rawText || '').match(/BILL_LANG:\s*(en|gu)/i)?.[1]?.toLowerCase();
    if (billLang === 'gu' || billLang === 'en') return billLang;
    return detectLanguage(`${captionClean}\n${cleaned}`);
  })();

  const agentInput = [
    sourceHint,
    filenameHint ? `Filename: ${filenameHint}` : '',
    captionClean ? `User caption/message: ${captionClean}` : '',
    cleaned ? `Content:\n${cleaned}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  console.log(
    `[agent] lang=${detectedLanguage} input=${agentInput.slice(0, 300)}…`
  );

  let parsed;
  try {
    parsed = await extractIntent(agentInput);
  } catch (err) {
    console.error('[agent] extract failed:', err.message);
    return 'I could not parse that cleanly. Please try again with a clearer photo or message.';
  }

  console.log('[agent] parsed:', JSON.stringify(parsed));

  // Improve Gujarati bill fields (digits, weights, item lexicon, name_en)
  parsed = enrichParsedBill(parsed, cleaned);

  // Prefer OCR template identity when the LLM left party blank
  if (inputType === 'image' && parsed?.intent === 'transaction') {
    if (!parsed.party) parsed.party = {};
    const ocrName = cleaned.match(/^NAME:\s*(.+)$/im)?.[1]?.trim();
    const ocrPhone = cleaned.match(/^NUMBER:\s*([0-9]{10})/im)?.[1];
    const ocrEn = cleaned.match(/^NAME_EN:\s*(.+)$/im)?.[1]?.trim();
    if ((!parsed.party.name || !String(parsed.party.name).trim()) && ocrName && !/^UNREADABLE$/i.test(ocrName)) {
      parsed.party.name = ocrName;
    }
    if ((!parsed.party.phone || String(parsed.party.phone).length < 10) && ocrPhone) {
      parsed.party.phone = ocrPhone;
    }
    if ((!parsed.name_en || !String(parsed.name_en).trim()) && ocrEn && !/^UNREADABLE$/i.test(ocrEn)) {
      parsed.name_en = ocrEn;
    }
  }

  if (!parsed || parsed.intent === 'unclear') {
    return (
      buildConfirmationSummary(parsed || { intent: 'unclear' }) ||
      (await generateAiResponse(cleaned || captionClean || 'hello'))
    );
  }

  if (parsed.intent === 'chat') {
    return generateAiResponse(cleaned || captionClean || 'hello');
  }

  const isDocument = ['pdf', 'csv', 'excel', 'document'].includes(inputType);
  const hint = `${captionClean} ${sourceHint} ${filenameHint || ''}`.toLowerCase();

  // PDF / CSV / Excel product lists usually have NO customer name — treat as stock, not a sale bill
  if (
    isDocument &&
    parsed.intent === 'transaction' &&
    !parsed.party?.name &&
    !parsed.party?.phone &&
    ((parsed.product_updates || []).length > 0 ||
      (parsed.items || []).length > 0 ||
      /(supplier|stock|inventory|price|catalog|product)/i.test(hint) ||
      !/(customer|sale|udhaar|invoice\s*to)/i.test(hint))
  ) {
    parsed.intent = 'inventory_bulk';
    if (!parsed.party) parsed.party = {};
    parsed.party.role = parsed.party.role || 'supplier';
    // Mirror items into product_updates when model only filled items
    if (
      (!parsed.product_updates || parsed.product_updates.length === 0) &&
      Array.isArray(parsed.items)
    ) {
      parsed.product_updates = parsed.items
        .filter((i) => i?.name)
        .map((i) => ({
          name: i.name,
          stock: i.quantity,
          price: i.line_amount != null ? i.line_amount : i.unit_price,
          category: i.weight_text || i.unit || null,
        }));
    }
  }

  // Heuristic: caption mentions supplier/stock → force inventory if model hedged
  if (
    parsed.intent === 'transaction' &&
    /(supplier|stock|inventory|price\s*list|catalog)/i.test(hint) &&
    !/(customer|sale|bill|udhaar|order)/i.test(hint)
  ) {
    parsed.intent = 'inventory_bulk';
    if (parsed.party) parsed.party.role = parsed.party.role || 'supplier';
  }

  // Customer bill without role → sale
  if (
    parsed.intent === 'transaction' &&
    (!parsed.transaction_type || parsed.transaction_type === 'purchase') &&
    parsed.party?.role !== 'supplier' &&
    (parsed.party?.phone || parsed.total_amount != null || (parsed.items || []).length)
  ) {
    parsed.transaction_type = 'sale';
    if (!parsed.party) parsed.party = {};
    if (!parsed.party.role) parsed.party.role = 'customer';
  }

  // Journal validation + identity verify ONLY for handwritten bill photos
  if (parsed.intent === 'transaction') {
    parsed.validation = validateJournalEntry(parsed);

    const assessment = assessIdentityConfidence(parsed, cleaned, {
      fromImage: inputType === 'image',
      headerConflict: inputType === 'image' && Boolean(parsed.header_conflict),
    });
    parsed.identity_verify = {
      needsVerify: assessment.needsVerify,
      verified: false,
      reasons: assessment.reasons,
      ocr_name: assessment.detectedName,
      ocr_phone: assessment.detectedPhone,
      ocr_name_en: assessment.detectedNameEn,
    };
  } else {
    // Stock/docs: never block on customer name verification
    parsed.identity_verify = { needsVerify: false, verified: true, reasons: [] };
  }

  const staged = await stageRawExtraction({
    vendorId: vendor.id,
    inputType,
    rawInput: agentInput,
    command: parsed.intent,
    llmParsed: parsed,
    detectedLanguage,
    mediaUrl,
  });

  if (!staged) {
    return (
      'I understood the file, but could not save a pending confirmation (database error).\n' +
      'Please try sending the file again in a moment.'
    );
  }

  return buildConfirmationSummary(parsed);
}

async function handleText(vendor, userText) {
  console.log(`Text from ${vendor.phone}: ${userText}`);

  const confirm = parseConfirmationReply(userText);
  if (confirm) return handleConfirmationReply(vendor, confirm);

  // Correct misread name/phone on a pending image bill
  const identityFix = parseIdentityCorrection(userText);
  if (identityFix) {
    const fixed = await handleIdentityCorrection(vendor, identityFix);
    if (fixed) return fixed;
  }

  return analyzeAndStage({
    vendor,
    rawText: userText,
    inputType: 'text',
    sourceHint: 'User sent a WhatsApp text message.',
  });
}

async function handleIdentityCorrection(vendor, fix) {
  const pending = await getLatestPendingExtraction(vendor.id);
  if (!pending) return null;

  const parsed =
    typeof pending.llm_parsed === 'string'
      ? JSON.parse(pending.llm_parsed)
      : { ...(pending.llm_parsed || {}) };

  if (parsed?.intent !== 'transaction' && parsed?.intent !== 'inventory_bulk') {
    return null;
  }

  if (!parsed.party) parsed.party = {};
  if (fix.name) {
    parsed.party.name = fix.name;
    if (parsed.name_en && /[\u0A80-\u0AFF]/.test(fix.name)) {
      parsed.name_en = null;
    } else if (!/[\u0A80-\u0AFF]/.test(fix.name)) {
      parsed.name_en = fix.name;
    }
  }
  if (fix.phone) {
    if (!/^[6-9]\d{9}$/.test(fix.phone)) {
      return (
        `Phone *${fix.phone}* is invalid.\nSend again:\nNUMBER: 9974099063`
      );
    }
    parsed.party.phone = fix.phone;
  }

  // Still missing one field — ask for the rest, don't mark fully verified yet
  const hasName = Boolean(parsed.party.name && String(parsed.party.name).trim());
  const hasPhone = Boolean(parsed.party.phone && String(parsed.party.phone).trim());

  parsed.identity_verify = {
    ...(parsed.identity_verify || {}),
    needsVerify: false,
    verified: hasName && hasPhone,
    verified_at: hasName && hasPhone ? new Date().toISOString() : null,
    reasons: ['added by user'],
  };
  if (parsed.intent === 'transaction') {
    parsed.validation = validateJournalEntry(parsed);
  }
  parsed.header_conflict = false;

  await updatePendingParsed(pending.id, parsed);

  if (!hasName || !hasPhone) {
    const need = [
      !hasName ? 'NAME:' : null,
      !hasPhone ? 'NUMBER:' : null,
    ]
      .filter(Boolean)
      .join('\n');
    return (
      `Got it${hasName ? ` · ${parsed.party.name}` : ''}${hasPhone ? ` · ${parsed.party.phone}` : ''}.\n` +
      `Still need:\n${need}\n\nThen reply *YES* to save.`
    );
  }

  return (
    '✅ Updated — please verify:\n\n' + buildConfirmationSummary(parsed)
  );
}

async function handleConfirmationReply(vendor, confirm) {
  const pending = await getLatestPendingExtraction(vendor.id);
  if (!pending) {
    return (
      'Nothing is waiting for confirmation.\n' +
      'Send a *customer bill photo* to record a sale, or a *supplier/stock list* to add products.'
    );
  }

  const parsed =
    typeof pending.llm_parsed === 'string'
      ? JSON.parse(pending.llm_parsed)
      : pending.llm_parsed;

  if (confirm === 'no') {
    await rejectPendingExtraction(pending.id);
    return 'Cancelled. Nothing was saved.';
  }

  // YES may proceed without name/phone (short confirm: "process anyway?")
  if (confirm === 'save_as_is') {
    if (parsed?.intent === 'transaction') {
      parsed.identity_verify = {
        ...(parsed.identity_verify || {}),
        needsVerify: false,
        verified: true,
        verified_at: new Date().toISOString(),
        reasons: ['user accepted OCR as-is'],
      };
      await updatePendingParsed(pending.id, parsed);
    } else {
      return 'Nothing to accept. Send a bill photo first.';
    }
  }

  if (
    confirm === 'yes' &&
    parsed?.intent === 'transaction' &&
    parsed?.identity_verify
  ) {
    parsed.identity_verify = {
      ...parsed.identity_verify,
      needsVerify: false,
      verified: true,
      verified_at: new Date().toISOString(),
      reasons: ['user chose to process'],
    };
    await updatePendingParsed(pending.id, parsed);
  }

  try {
    const intent = parsed?.intent;

    if (intent === 'inventory_bulk') {
      const result = await postInventory(vendor.id, pending);
      const preview = result.products
        .slice(0, 8)
        .map((p) => `• ${p.name}${p.stock != null ? ` (stock ${p.stock})` : ''}`)
        .join('\n');
      return (
        `✅ *Saved ${result.count} product(s)* to inventory.\n${preview}` +
        (result.count > 8 ? `\n…and ${result.count - 8} more` : '')
      );
    }

    if (intent === 'transaction') {
      // Reload pending after possible SAVE AS IS update
      const latest = await getLatestPendingExtraction(vendor.id);
      const result = await postTransaction(vendor.id, latest || pending);
      const incomplete = parsed?.validation?.incomplete;
      const partyBit = result.party ? ` · ${result.party}` : '';
      const amountBit =
        result.salesTotal > 0 ? `Amount ₹${result.salesTotal}` : 'Amount not on bill (saved as blank)';
      return (
        `✅ *Saved to journal${incomplete ? ' (with missing fields as blank)' : ''}.*\n` +
        `${amountBit}` +
        `${result.cashTotal ? ` · cash ₹${result.cashTotal}` : ''}` +
        `${result.udhaarTotal ? ` · udhaar ₹${result.udhaarTotal}` : ''}` +
        `${partyBit}`
      );
    }

    if (intent === 'statement_query') {
      await markExtractionConfirmed(pending.id);
      return (
        '✅ Report request noted. Statement generation is coming in the next phase — ' +
        'your request was saved.'
      );
    }

    await markExtractionConfirmed(pending.id);
    return '✅ Confirmed and saved.';
  } catch (err) {
    console.error('[confirm] failed:', err.message);
    return `Could not save: ${err.message}. Please send the details again.`;
  }
}

/**
 * STT provider switch: sarvam (default) | groq (Whisper fallback).
 * Groq extractIntent / OCR / chat are unchanged — Sarvam is voice→text only.
 */
async function transcribeVoiceNote(vendor, audioBuffer, mimeType) {
  const provider = String(process.env.STT_PROVIDER || 'sarvam')
    .trim()
    .toLowerCase();

  if (provider === 'groq') {
    console.log('[voice] STT_PROVIDER=groq → Whisper');
    return transcribeAudio(audioBuffer, mimeType);
  }

  const language = vendor?.preferred_language || 'gu';
  console.log(`[voice] STT_PROVIDER=sarvam lang=${language}`);
  return transcribeWithSarvam(audioBuffer, mimeType, { language });
}

async function handleVoice(vendor, message) {
  const audioId = message.audio?.id;
  const media = await downloadMedia(audioId);
  if (!media?.buffer) {
    return '❌ Could not download your voice message. Please try again.';
  }

  let transcript;
  try {
    transcript = await transcribeVoiceNote(vendor, media.buffer, media.mimeType);
  } catch (err) {
    console.error('[voice] transcription failed:', err.message);
    return `❌ Could not transcribe: ${err.message}`;
  }

  if (!transcript) {
    return '🎤 Could not detect speech. Please try again.';
  }

  console.log(`[voice] transcript: ${transcript}`);

  const confirm = parseConfirmationReply(transcript);
  if (confirm) return handleConfirmationReply(vendor, confirm);

  return analyzeAndStage({
    vendor,
    rawText: transcript,
    inputType: 'voice',
    mediaUrl: audioId,
    sourceHint: 'User sent a voice note (transcribed).',
  });
}

async function handleImage(vendor, message) {
  const imageId = message.image?.id;
  const caption = message.image?.caption || '';
  console.log(`Image from ${vendor.phone}, caption: ${caption}`);

  const media = await downloadMedia(imageId);
  if (!media?.buffer) {
    return '❌ Could not download your image. Please try again.';
  }

  let ocrText;
  try {
    ocrText = await ocrImageText(media.buffer, media.mimeType);
  } catch (err) {
    return `❌ OCR failed: ${err.message}`;
  }

  if (!ocrText || /no text found/i.test(ocrText)) {
    return '🖼️ No text detected in the image. Please send a clearer photo.';
  }

  console.log('[image] OCR:', ocrText.slice(0, 500));

  const langMatch = ocrText.match(/BILL_LANG:\s*(en|gu)/i);
  const billLang = langMatch ? langMatch[1].toLowerCase() : null;

  const hint = /supplier|stock|inventory|price\s*list|catalog/i.test(caption)
    ? 'User sent an image with a supplier/stock caption — prefer inventory_bulk / product catalog.'
    : billLang === 'gu'
      ? 'User sent a GUJARATI handwritten bill photo. Analyze as customer sale.'
      : billLang === 'en'
        ? 'User sent an ENGLISH handwritten bill photo. Analyze as customer sale.'
        : 'User sent an image (likely a customer bill or stock sheet). Analyze and classify.';

  return analyzeAndStage({
    vendor,
    rawText: ocrText,
    caption,
    inputType: 'image',
    mediaUrl: imageId,
    sourceHint: hint,
  });
}

async function handleDocument(vendor, message) {
  const doc = message.document || {};
  const documentId = doc.id;
  const filename = doc.filename || 'document';
  const mimeType = doc.mime_type || '';
  const caption = doc.caption || '';
  console.log(`Document '${filename}' from ${vendor.phone}`);

  const extracted = await extractDocumentText(documentId, filename, mimeType);
  if (extracted.errorMessage) return extracted.errorMessage;

  const hint = /supplier|stock|inventory|price\s*list|catalog|product/i.test(
    `${caption} ${filename}`
  )
    ? 'User sent a PDF/CSV/Excel file — treat as product/stock catalog (inventory_bulk). Customer name is NOT required.'
    : 'User sent a PDF/CSV/Excel document. If it is a product/price/stock list with no customer name, use inventory_bulk. Only use transaction/sale if a customer name+sale is clearly present.';

  return analyzeAndStage({
    vendor,
    rawText: extracted.text,
    caption,
    inputType: extracted.inputType || 'document',
    mediaUrl: documentId,
    sourceHint: hint,
    filename,
  });
}

module.exports = router;
