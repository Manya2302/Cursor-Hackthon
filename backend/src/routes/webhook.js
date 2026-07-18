const express = require('express');
const { sendTextMessage, downloadMedia } = require('../services/whatsapp');
const { resolveOrCreateVendor } = require('../services/vendors');
const { extractIntent, transcribeAudio, ocrImageText, analyzeImage, generateAiResponse } = require('../services/groq');
const {
  extractDocumentText,
  extractDocumentContent,
} = require('../services/documents');
const { stageRawExtraction } = require('../services/extractions');
const { detectLanguage } = require('../utils/language');
const { buildConfirmationSummary } = require('../utils/confirmation');
const {
  parseCommand,
  COMMAND_TIP,
} = require('../utils/commands');

const router = express.Router();

function getVerifyToken() {
  return (
    process.env.VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    ''
  ).trim();
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

/**
 * Always ACK Meta quickly, then process (extraction can take a few seconds).
 */
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
      reply = await handleTextCommand(vendor, message.text?.body || '');
    } else if (msgType === 'audio') {
      reply = await handleVoiceCommand(vendor, message);
    } else if (msgType === 'image') {
      reply = await handleImageCommand(vendor, message);
    } else if (msgType === 'document') {
      reply = await handleDocumentCommand(vendor, message);
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
 * Core staging pipeline: language detect → extractIntent → raw_extractions → confirm summary.
 */
async function stageExtractionAndConfirm({
  vendor,
  rawText,
  command,
  inputType,
  mediaUrl = null,
}) {
  const detectedLanguage = detectLanguage(rawText);
  console.log(
    `[extract] command=${command} lang=${detectedLanguage} input=${rawText}`
  );

  let parsed;
  try {
    parsed = await extractIntent(rawText);
  } catch (err) {
    console.error('[extract] Groq JSON/parse error:', err.message, err.raw || '');
    return 'I could not parse that cleanly. Please rephrase your message and try again.';
  }

  console.log('[extract] parsed:', JSON.stringify(parsed));

  if (!parsed || parsed.intent === 'unclear') {
    return buildConfirmationSummary(parsed || { intent: 'unclear' }, command);
  }

  await stageRawExtraction({
    vendorId: vendor.id,
    inputType,
    rawInput: rawText,
    command,
    llmParsed: parsed,
    detectedLanguage,
    mediaUrl,
  });

  return buildConfirmationSummary(parsed, command);
}

async function handleTextCommand(vendor, userText) {
  console.log(`Text from ${vendor.phone}: ${userText}`);
  const parsedCmd = parseCommand(userText);
  if (!parsedCmd) {
    // Casual chat (main.py) + tip — don't hard-fail on "hi"
    const ai = await generateAiResponse(userText);
    return `${ai}${COMMAND_TIP}`;
  }

  const rawText = parsedCmd.rest || userText;
  return stageExtractionAndConfirm({
    vendor,
    rawText,
    command: parsedCmd.command,
    inputType: 'text',
  });
}

async function handleVoiceCommand(vendor, message) {
  const audioId = message.audio?.id;
  console.log(`Audio from ${vendor.phone}, ID: ${audioId}`);

  const media = await downloadMedia(audioId);
  if (!media?.buffer) {
    return '❌ Could not download your voice message. Please try again.';
  }

  let transcript;
  try {
    transcript = await transcribeAudio(media.buffer, media.mimeType);
  } catch (err) {
    console.error('[webhook] transcription failed:', err.message);
    return `❌ Could not transcribe your voice message: ${err.message}`;
  }

  console.log(`[webhook] transcript: ${transcript}`);
  if (!transcript) {
    return '🎤 Could not detect any speech. Please speak clearly and try again.';
  }

  const parsedCmd = parseCommand(transcript);
  if (!parsedCmd) {
    const ai = await generateAiResponse(transcript);
    return `🎤 ${transcript}\n\n${ai}${COMMAND_TIP}`;
  }

  return stageExtractionAndConfirm({
    vendor,
    rawText: parsedCmd.rest || transcript,
    command: parsedCmd.command,
    inputType: 'voice',
    mediaUrl: audioId,
  });
}

async function handleImageCommand(vendor, message) {
  const imageId = message.image?.id;
  const caption = message.image?.caption || '';
  console.log(
    `Image from ${vendor.phone}, ID: ${imageId}, caption: ${caption}`
  );

  const parsedCmd = parseCommand(caption);
  const media = await downloadMedia(imageId);
  if (!media?.buffer) {
    return '❌ Could not download your image. Please try again.';
  }

  // With a LedgerBot command in the caption → OCR → extractIntent → stage
  if (parsedCmd) {
    let ocrText;
    try {
      ocrText = await ocrImageText(media.buffer, media.mimeType);
    } catch (err) {
      console.error('[webhook] image OCR failed:', err.message);
      return `❌ OCR failed: ${err.message}`;
    }

    if (!ocrText || /no text found/i.test(ocrText)) {
      return '🖼️ No text was detected in your image. Please send a clearer photo or type the entry.';
    }

    const rawText = [parsedCmd.rest, ocrText].filter(Boolean).join('\n').trim();
    return stageExtractionAndConfirm({
      vendor,
      rawText,
      command: parsedCmd.command,
      inputType: 'image',
      mediaUrl: imageId,
    });
  }

  // No command — keep main.py-style assistant for plain images
  try {
    return await analyzeImage(media.buffer, caption, media.mimeType);
  } catch (err) {
    return `❌ Image analysis failed: ${err.message}`;
  }
}

async function handleDocumentCommand(vendor, message) {
  const docInfo = message.document || {};
  const documentId = docInfo.id;
  const filename = docInfo.filename || 'document';
  const mimeType = docInfo.mime_type || '';
  const caption = docInfo.caption || '';
  console.log(`Document '${filename}' (${mimeType}) from ${vendor.phone}`);

  const parsedCmd = parseCommand(caption);

  if (parsedCmd) {
    const extracted = await extractDocumentText(documentId, filename, mimeType);
    if (extracted.errorMessage) return extracted.errorMessage;

    const rawText = [parsedCmd.rest, extracted.text]
      .filter(Boolean)
      .join('\n')
      .trim();

    return stageExtractionAndConfirm({
      vendor,
      rawText,
      command: parsedCmd.command,
      inputType:
        mimeType.includes('csv') || /\.csv$/i.test(filename) ? 'csv' : 'text',
      mediaUrl: documentId,
    });
  }

  // No command — main.py document assistant summary
  return extractDocumentContent(documentId, filename, mimeType);
}

module.exports = router;
