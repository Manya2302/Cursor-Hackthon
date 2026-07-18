const express = require('express');
const { sendTextMessage, downloadMedia, sendDocumentMessage } = require('../services/whatsapp');
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
  parseCsv,
  extractInventoryFromImage,
  validateRows,
} = require('../services/inventoryImport');
const { previewBulkChanges } = require('../services/inventoryUpsert');
const {
  stageRawExtraction,
  getLatestPendingExtraction,
  rejectPendingExtraction,
  markExtractionConfirmed,
  updatePendingParsed,
} = require('../services/extractions');
const { postTransaction, undoLastPost } = require('../services/ledger');
const { postInventory } = require('../services/inventory');
const {
  parseProductSetupMessage,
  applyProductSetup,
  parseStockAdjustMessage,
  applyStockAdjust,
  createProduct,
  parseProductQueryMessage,
  runProductQuery,
} = require('../services/productMaster');
const {
  verifyBill,
  saveVerification,
  formatVerificationReport,
} = require('../services/priceVerify');
const {
  postVerifiedSale,
  addUnknownProductsFromReport,
  getProfitDigest,
} = require('../services/transactions');
const { normalizeUnit, roundMoney } = require('../utils/units');
const { resolveDatePhrase } = require('../services/dateResolver');
const { runStatement } = require('../services/statements');
const {
  formatStatementReply,
  pickFormatForStatement,
} = require('../services/responseFormatter');
const { generateStatementPdf } = require('../services/pdfGenerator');
const { extractInvoiceFromOcr } = require('../services/invoiceExtract');
const { normalizeOcrText } = require('../utils/ocrNormalize');
const {
  validateInvoice,
  invoiceToParsed,
} = require('../utils/invoiceValidation');
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

function isProfitQuery(text) {
  const t = String(text || '').toLowerCase();
  return (
    /\b(today'?s?\s+profit|profit\s+today|आज\s*का\s*नफा|આજનો\s*નફો|નફો\s*આજ)/i.test(
      t
    ) || /^(profit|નફો)$/i.test(t.trim())
  );
}

/**
 * Run Product Master price verification and stage for YES / UPDATE PRICE / ADD PRODUCTS.
 */
async function stagePriceVerification(vendor, parsed, opts = {}) {
  const kind =
    parsed.transaction_type === 'purchase' || parsed.party?.role === 'supplier'
      ? 'purchase'
      : 'sale';

  const lines = (parsed.items || [])
    .filter((i) => i && i.name)
    .map((i) => ({
      name: i.name,
      name_en: i.name_en,
      base_name: i.base_name || i.name_en || i.name,
      quantity: i.count != null ? i.count : i.quantity,
      count: i.count != null ? i.count : i.quantity,
      unit: i.unit,
      weight_text: i.pack_text || i.weight_text,
      pack_text: i.pack_text || i.weight_text,
      pack_qty: i.pack_qty,
      pack_unit: i.pack_unit,
      unit_price: i.unit_price,
      line_amount: i.line_amount,
    }));

  if (!lines.length) {
    return null; // nothing to verify
  }

  const report = await verifyBill(
    vendor.id,
    lines,
    parsed.total_amount,
    kind
  );

  // Temporary stage to get extraction id, then attach verification
  parsed.intent = 'price_verification';
  parsed.verification_report = report;
  parsed.identity_verify = { needsVerify: false, verified: true, reasons: [] };

  const staged = await stageRawExtraction({
    vendorId: vendor.id,
    inputType: opts.inputType || 'image',
    rawInput: opts.rawInput || JSON.stringify(report),
    command: 'price_verification',
    llmParsed: parsed,
    detectedLanguage: opts.language || 'en',
    mediaUrl: opts.mediaUrl || null,
  });

  if (!staged) {
    return (
      'Verification ready, but could not save pending confirmation (database error).'
    );
  }

  try {
    const vr = await saveVerification(vendor.id, staged.id, report, {
      mediaUrl: opts.mediaUrl,
      rawOcr: opts.rawInput,
      language: opts.language,
    });
    parsed.verification_id = vr.id;
    await updatePendingParsed(staged.id, parsed);
  } catch (err) {
    console.error('[verify] saveVerification failed:', err.message);
  }

  return formatVerificationReport(report, parsed.party || {});
}

function getVerifyToken() {
  return (
    process.env.VERIFY_TOKEN ||
    process.env.WHATSAPP_VERIFY_TOKEN ||
    ''
  ).trim();
}

/** True when user tagged stock/catalog bulk upload (legacy /ai-stock-bulk or plain words). */
function isStockBulkIntent(text) {
  const t = String(text || '').toLowerCase();
  return (
    /\/?ai-stock-bulk\b/.test(t) ||
    /\b(stock\s*bulk|bulk\s*stock|inventory\s*bulk|price\s*list|catalog)\b/.test(t)
  );
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

/**
 * Stage structured inventory rows (CSV / image table) for YES confirmation.
 */
async function stageBulkInventory(vendor, {
  validRows,
  invalidRows = [],
  rawInput,
  inputType,
  mediaUrl,
  detectedLanguage = 'en',
}) {
  const { newCount, updateCount } = await previewBulkChanges(
    vendor.id,
    validRows
  );

  const parsed = {
    intent: 'inventory_bulk',
    transaction_type: null,
    items: [],
    party: { name: null, phone: null, role: 'supplier' },
    name_en: null,
    payments: [],
    total_amount: null,
    date: null,
    currency: 'INR',
    product_updates: validRows.map((r) => ({
      productId: r.productId,
      name: r.name,
      stock: r.stock,
      price: r.price,
      category: r.category,
      supplier: r.supplier,
    })),
    bulk_rows: validRows,
    bulk_meta: {
      newCount,
      updateCount,
      invalidRows: invalidRows.map((r) => ({
        index: r.index,
        reasons: r.reasons,
        productId: r.row?.productId,
        name: r.row?.name,
      })),
    },
    statement: null,
    notes: null,
    unclear_reason: null,
    identity_verify: { needsVerify: false, verified: true, reasons: [] },
  };

  const staged = await stageRawExtraction({
    vendorId: vendor.id,
    inputType,
    rawInput,
    command: 'inventory_bulk',
    llmParsed: parsed,
    detectedLanguage,
    mediaUrl,
  });

  if (!staged) {
    return (
      'I parsed the inventory file, but could not save a pending confirmation (database error).\n' +
      'Please try again in a moment.'
    );
  }

  return buildConfirmationSummary(parsed);
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
    const msgCtx = { phoneNumberId, fromNumber };
    try {
      if (msgType === 'text') {
        reply = await handleText(vendor, message.text?.body || '', msgCtx);
      } else if (msgType === 'audio') {
        reply = await handleVoice(vendor, message, msgCtx);
      } else if (msgType === 'image') {
        reply = await handleImage(vendor, message, msgCtx);
      } else if (msgType === 'document') {
        reply = await handleDocument(vendor, message);
      } else {
        reply = `Unsupported message type: ${msgType}`;
      }
    } catch (handlerErr) {
      console.error(
        `[webhook] ${new Date().toISOString()} handler error:`,
        handlerErr.message
      );
      reply =
        'Something went wrong while processing your message. Please try again in a moment.';
    }

    if (reply) {
      console.log(
        `[webhook] ${new Date().toISOString()} replied → ${fromNumber}`
      );
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
  preParsed = null,
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
  if (preParsed && typeof preParsed === 'object') {
    parsed = preParsed;
    console.log('[agent] using preParsed invoice pipeline');
  } else {
    try {
      parsed = await extractIntent(agentInput);
    } catch (err) {
      console.error('[agent] extract failed:', err.message);
      return 'I could not parse that cleanly. Please try again with a clearer photo or message.';
    }
  }

  console.log('[agent] parsed:', JSON.stringify(parsed));

  // Improve Gujarati bill fields (digits, weights, item lexicon, name_en)
  // Invoice pipeline already has accurate counts/prices — do NOT enrich amounts
  if (!preParsed) {
    parsed = enrichParsedBill(parsed, cleaned);
  }

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

  // Product catalog lookup → answer from DB immediately (never a statement report)
  if (parsed.intent === 'product_query') {
    const pq = parsed.product_query || {};
    const names = Array.isArray(pq.names)
      ? pq.names.filter(Boolean)
      : pq.name
        ? [pq.name]
        : [];
    const query = {
      action: pq.action || (names.length ? 'info' : 'list'),
      name: names[0] || null,
      names: names.length > 1 ? names : undefined,
    };
    // Fallback: parse from raw text if LLM left fields blank
    if (
      !pq.action ||
      (pq.action !== 'list' &&
        pq.action !== 'low_stock' &&
        !names.length)
    ) {
      const fallback = parseProductQueryMessage(cleaned || captionClean);
      if (fallback) {
        query.action = fallback.action;
        query.name = fallback.name || null;
        query.names = fallback.names;
      }
    }
    try {
      return await runProductQuery(vendor.id, query);
    } catch (err) {
      return `Could not load product: ${err.message}`;
    }
  }

  // Misclassified stock questions as statement → redirect
  if (parsed.intent === 'statement_query') {
    const maybeProduct = parseProductQueryMessage(cleaned || captionClean);
    if (maybeProduct) {
      try {
        return await runProductQuery(vendor.id, maybeProduct);
      } catch (err) {
        return `Could not load product: ${err.message}`;
      }
    }
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

  // Normalize statement_query fields from LLM
  if (parsed.intent === 'statement_query') {
    if (!parsed.statement) parsed.statement = {};
    const st = parsed.statement;
    if (!st.statementType && st.type) st.statementType = st.type;
    if (!st.datePhrase && st.period) {
      const p = String(st.period).toLowerCase();
      if (/last.?month/.test(p)) st.datePhrase = 'last_month';
      else if (/this.?week/.test(p)) st.datePhrase = 'this_week';
      else if (/today/.test(p)) st.datePhrase = 'today';
      else if (/this.?year|ytd/.test(p)) st.datePhrase = /ytd/.test(p) ? 'year_to_date' : 'this_year';
      else if (/last.?3|quarter/.test(p)) st.datePhrase = 'last_3_months';
      else st.datePhrase = 'this_month';
    }
    if (!st.statementType) st.statementType = 'pnl';
    if (!st.datePhrase) st.datePhrase = 'this_month';
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
  // Product Master gate: sales/purchases with items → price verification first
  if (parsed.intent === 'transaction') {
    const hasItems = Array.isArray(parsed.items) && parsed.items.some((i) => i?.name);
    if (hasItems) {
      const verifyMsg = await stagePriceVerification(vendor, parsed, {
        inputType,
        rawInput: agentInput,
        mediaUrl,
        language: detectedLanguage,
      });
      if (verifyMsg) return verifyMsg;
    }

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

async function fulfillStatementQuery(vendor, parsed, msgCtx = {}) {
  const st = parsed.statement || {};
  const datePhrase =
    st.datePhrase ||
    st.period ||
    (st.startDate && st.endDate ? 'custom_range' : 'this_month');

  const range = resolveDatePhrase(datePhrase, new Date(), {
    startDate: st.startDate,
    endDate: st.endDate,
  });

  const { data, tally } = await runStatement(
    vendor.id,
    {
      statementType: st.statementType || st.type || 'pnl',
      type: st.statementType || st.type || 'pnl',
      accountId: st.accountId,
      accountName: st.accountName,
      partyName: st.partyName || parsed.party?.name,
    },
    range
  );

  const language =
    parsed.detected_language ||
    vendor.preferred_language ||
    detectLanguage(JSON.stringify(st)) ||
    'en';

  const text = await formatStatementReply({
    statementData: data,
    tally,
    language,
    format: pickFormatForStatement(data.statementType),
  });

  // Phase 7: also send PDF document on WhatsApp
  try {
    if (msgCtx.fromNumber) {
      const pdf = await generateStatementPdf(
        data,
        data.statementType,
        language
      );
      const fname = `LedgerBot_${data.statementType || 'statement'}_${range.endDate}.pdf`;
      await sendDocumentMessage(
        msgCtx.fromNumber,
        pdf,
        fname,
        msgCtx.phoneNumberId
      );
      console.log(
        `[webhook] ${new Date().toISOString()} PDF sent → ${msgCtx.fromNumber}`
      );
    }
  } catch (pdfErr) {
    console.error('[webhook] PDF send failed:', pdfErr.message);
  }

  return text;
}

async function handleText(vendor, userText, msgCtx = {}) {
  console.log(
    `[webhook] ${new Date().toISOString()} text from ${vendor.phone}: ${userText}`
  );

  const confirm = parseConfirmationReply(userText);
  if (confirm === 'undo') {
    try {
      await undoLastPost(vendor.id);
      return '↩️ Undone. The last journal entry was removed.';
    } catch (err) {
      return `Could not undo: ${err.message}`;
    }
  }
  if (confirm) return handleConfirmationReply(vendor, confirm, msgCtx);

  // Interactive Product Master add wizard (name → stock qty → unit price)
  const wizardReply = await handlePendingProductAdd(vendor, userText);
  if (wizardReply) return wizardReply;

  // Today's profit (Product Master cost vs sale)
  if (isProfitQuery(userText)) {
    try {
      const digest = await getProfitDigest(vendor.id, 'today');
      return digest.message;
    } catch (err) {
      return `Could not load profit: ${err.message}`;
    }
  }

  // Stock adjustment: "Add 20 to maggi stock", "Reduce maggi stock by 5",
  // "Set maggi stock to 20" — must run BEFORE the generic "Add <name>" setup so
  // we update the existing product instead of creating a bogus new one.
  const stockAdjust = parseStockAdjustMessage(userText);
  if (stockAdjust) {
    try {
      const res = await applyStockAdjust(vendor.id, stockAdjust);
      return res.message;
    } catch (err) {
      return `Could not update stock: ${err.message}`;
    }
  }

  // Product catalog questions → SQL on Product Master (not statements)
  const productQuery = parseProductQueryMessage(userText);
  if (productQuery) {
    try {
      return await runProductQuery(vendor.id, productQuery);
    } catch (err) {
      return `Could not load product: ${err.message}`;
    }
  }

  // Product Master NL setup: "Add Sugar", "Set Sugar price to 50"
  const setup = parseProductSetupMessage(userText);
  if (setup) {
    try {
      const result = await applyProductSetup(vendor.id, setup);
      const p = result.product;
      return (
        `✅ *Product Master*\n` +
        `${p.product_name}\n` +
        `Sell: ₹${p.selling_price}/${p.unit}\n` +
        `Buy: ₹${p.purchase_price}/${p.unit}\n` +
        (p.gst_pct ? `GST: ${p.gst_pct}%\n` : '') +
        (p.supplier ? `Supplier: ${p.supplier}\n` : '') +
        `Stock: ${p.current_stock}`
      );
    } catch (err) {
      return `Could not update product: ${err.message}`;
    }
  }

  // Correct misread name/phone on a pending image bill
  const identityFix = parseIdentityCorrection(userText);
  if (identityFix) {
    const fixed = await handleIdentityCorrection(vendor, identityFix);
    if (fixed) return fixed;
  }

  // Text sale lines → verify against master when items present
  const staged = await analyzeAndStage({
    vendor,
    rawText: userText,
    inputType: 'text',
    sourceHint: 'User sent a WhatsApp text message.',
  });

  return staged;
}

async function handleIdentityCorrection(vendor, fix) {
  const pending = await getLatestPendingExtraction(vendor.id);
  if (!pending) return null;

  const parsed =
    typeof pending.llm_parsed === 'string'
      ? JSON.parse(pending.llm_parsed)
      : { ...(pending.llm_parsed || {}) };

  if (parsed?.intent !== 'transaction' && parsed?.intent !== 'inventory_bulk' && parsed?.intent !== 'price_verification') {
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

/**
 * Wizard: pending_product_add steps = name → stock_qty → unit_price → next/reverify
 */
async function handlePendingProductAdd(vendor, userText) {
  const pending = await getLatestPendingExtraction(vendor.id);
  if (!pending) return null;

  const parsed =
    typeof pending.llm_parsed === 'string'
      ? JSON.parse(pending.llm_parsed)
      : { ...(pending.llm_parsed || {}) };

  const wiz = parsed.pending_product_add;
  if (!wiz || !wiz.step) return null;

  const text = String(userText || '').trim();
  if (!text) return null;
  if (/^(no|cancel|ના|नहीं)$/i.test(text)) {
    delete parsed.pending_product_add;
    await updatePendingParsed(pending.id, parsed);
    return 'Cancelled product add. Reply *YES* / *ADD PRODUCTS* / *NO* on the bill.';
  }

  const cur = wiz.queue?.[wiz.index];
  if (!cur) {
    delete parsed.pending_product_add;
    await updatePendingParsed(pending.id, parsed);
    return null;
  }

  if (wiz.step === 'name') {
    wiz.draft.name = text;
    wiz.step = 'stock_qty';
    parsed.pending_product_add = wiz;
    await updatePendingParsed(pending.id, parsed);
    return (
      `✅ Name: *${wiz.draft.name}*\n\n` +
      `Step 2/3 — Send *opening stock quantity* (number)\n` +
      `(or 0 if none)`
    );
  }

  if (wiz.step === 'stock_qty') {
    const qty = Number(String(text).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(qty) || qty < 0) {
      return 'Please send stock quantity as a number (e.g. 10 or 0).';
    }
    wiz.draft.stock = qty;
    wiz.step = 'unit_price';
    parsed.pending_product_add = wiz;
    await updatePendingParsed(pending.id, parsed);
    const suggest =
      cur.suggested_unit_price != null
        ? `\n(Bill suggests ₹${cur.suggested_unit_price} for one)`
        : '';
    return (
      `✅ Stock: *${qty}*\n\n` +
      `Step 3/3 — Send *price for one* ${wiz.draft.name}` +
      (cur.pack_text ? ` (${cur.pack_text})` : '') +
      suggest
    );
  }

  if (wiz.step === 'unit_price') {
    const price = Number(String(text).replace(/[^\d.]/g, ''));
    if (!Number.isFinite(price) || price < 0) {
      return 'Please send price for one as a number (e.g. 500).';
    }
    wiz.draft.selling_price = roundMoney(price);

    const unit =
      normalizeUnit(cur.pack_unit) ||
      normalizeUnit(cur.unit) ||
      'PCS';
    const nameToSave = cur.pack_text
      ? `${wiz.draft.name} ${cur.pack_text}`
      : wiz.draft.name;

    try {
      await createProduct(vendor.id, {
        name: nameToSave,
        selling_price: wiz.draft.selling_price,
        purchase_price: 0,
        unit,
        stock: wiz.draft.stock || 0,
      });
      // Also alias bare name
      if (wiz.draft.name && wiz.draft.name !== nameToSave) {
        const { addAlias, findByAlias } = require('../services/productMaster');
        const p = await findByAlias(vendor.id, nameToSave);
        if (p) await addAlias(vendor.id, p.id, wiz.draft.name);
      }
    } catch (err) {
      return `Could not save product: ${err.message}`;
    }

    wiz.index += 1;
    wiz.draft = {};
    if (wiz.index < (wiz.queue || []).length) {
      wiz.step = 'name';
      parsed.pending_product_add = wiz;
      await updatePendingParsed(pending.id, parsed);
      const next = wiz.queue[wiz.index];
      return (
        `✅ Saved *${nameToSave}* @ ₹${price}\n\n` +
        `Next unknown: *${next.raw_name}*\n` +
        `Step 1/3 — Send the *product name*`
      );
    }

    // Done — re-verify bill
    delete parsed.pending_product_add;
    const lines = (parsed.items || []).map((i) => ({
      name: i.name,
      name_en: i.name_en,
      base_name: i.base_name || i.name_en || i.name,
      quantity: i.count != null ? i.count : i.quantity,
      count: i.count != null ? i.count : i.quantity,
      unit: i.unit,
      weight_text: i.pack_text || i.weight_text,
      pack_text: i.pack_text || i.weight_text,
      pack_qty: i.pack_qty,
      pack_unit: i.pack_unit,
      unit_price: i.unit_price,
      line_amount: i.line_amount,
    }));
    const newReport = await verifyBill(
      vendor.id,
      lines,
      parsed.total_amount,
      parsed.verification_report?.kind || 'sale'
    );
    parsed.verification_report = newReport;
    await updatePendingParsed(pending.id, parsed);
    return (
      `✅ Product(s) added to master.\n\n` +
      formatVerificationReport(newReport, parsed.party || {})
    );
  }

  return null;
}

async function handleConfirmationReply(vendor, confirm, msgCtx = {}) {
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
    if (parsed?.verification_id) {
      try {
        const { resolveVerification } = require('../services/priceVerify');
        await resolveVerification(parsed.verification_id, 'rejected', {});
      } catch (_) {
        /* ignore */
      }
    }
    return 'Cancelled. Nothing was saved.';
  }

  // ADD PRODUCTS — start interactive wizard (name → stock qty → price for one)
  if (confirm === 'add_products' && parsed?.intent === 'price_verification') {
    const unknowns = (parsed.verification_report?.lines || []).filter(
      (l) => l.status === 'unknown_product'
    );
    if (!unknowns.length) {
      return 'No unknown products to add. Reply *YES* to save, or *NO* to cancel.';
    }
    const first = unknowns[0];
    parsed.pending_product_add = {
      step: 'name',
      queue: unknowns.map((u) => ({
        raw_name: u.raw_name,
        base_name: u.base_name || u.raw_name,
        pack_text: u.pack_text,
        unit: u.unit,
        suggested_unit_price: u.ocr_unit_price,
        suggested_count: u.quantity,
      })),
      index: 0,
      draft: {},
    };
    await updatePendingParsed(pending.id, parsed);
    const cur = parsed.pending_product_add.queue[0];
    return (
      `🆕 Add to Product Master (${unknowns.length} unknown)\n` +
      `Suggested: *${cur.raw_name}*\n\n` +
      `Step 1/3 — Send the *product name* to save\n` +
      `(or reply *${cur.base_name || cur.raw_name}* to keep suggestion)`
    );
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
    console.log(
      `[webhook] ${new Date().toISOString()} confirm=${confirm} intent=${intent}`
    );

    // Product Master verification gate
    if (intent === 'price_verification') {
      if (confirm !== 'yes' && confirm !== 'update_price') {
        return (
          'Reply *YES* to save, *UPDATE PRICE* to update master then save,\n' +
          '*ADD PRODUCTS* for unknowns, or *NO* to cancel.'
        );
      }
      const report = parsed.verification_report;
      if (!report) {
        return 'Verification data missing. Please resend the bill.';
      }
      if (report.unknown_count > 0 && confirm !== 'update_price') {
        // Allow YES only if user insists — still block if unknowns remain unless they added products
        const stillUnknown = (report.lines || []).some(
          (l) => l.status === 'unknown_product'
        );
        if (stillUnknown && confirm === 'yes') {
          return (
            'Still have unknown products.\n' +
            'Reply *ADD PRODUCTS* to create them in Product Master first,\n' +
            'or *NO* to cancel.'
          );
        }
      }

      const result = await postVerifiedSale(vendor.id, pending, report, {
        verificationId: parsed.verification_id,
        updateMasterPrices: confirm === 'update_price',
      });
      return (
        `✅ *Saved to books*\n` +
        `Gross ₹${result.gross} · Cost ₹${result.cost}\n` +
        `Profit *₹${result.profit}*` +
        (result.profit < 0 ? ' (loss)' : '') +
        `\n${result.itemCount} item(s)` +
        (result.party ? ` · ${result.party}` : '') +
        (confirm === 'update_price' ? '\n_Master selling prices updated._' : '') +
        `\n_Reply UNDO within 2 minutes to reverse journal._`
      );
    }

    if (confirm === 'update_price' || confirm === 'add_products') {
      return 'No price verification is pending. Send a bill photo first.';
    }

    if (intent === 'inventory_bulk') {
      const result = await postInventory(vendor.id, pending);
      const preview = result.products
        .slice(0, 8)
        .map((p) => `• ${p.name}${p.stock != null ? ` (stock ${p.stock})` : ''}`)
        .join('\n');
      const head =
        result.created != null && result.updated != null
          ? `✅ *Saved ${result.count} product(s)* — ${result.created} new, ${result.updated} updated.`
          : `✅ *Saved ${result.count} product(s)* to inventory.`;
      return (
        `${head}\n${preview}` +
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
        `${partyBit}\n` +
        `_Reply UNDO within 2 minutes to reverse._`
      );
    }

    if (intent === 'statement_query') {
      const text = await fulfillStatementQuery(vendor, {
        ...parsed,
        detected_language: pending.detected_language,
      }, msgCtx);
      await markExtractionConfirmed(pending.id);
      return text;
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
  const sarvamKey = (
    process.env.SARVAM_API_KEY ||
    process.env.SURVOM_API_KEY ||
    ''
  ).trim();

  // Explicit Groq, or Sarvam not configured → Whisper
  if (provider === 'groq' || !sarvamKey) {
    if (!sarvamKey && provider !== 'groq') {
      console.log('[voice] SARVAM_API_KEY missing → falling back to Groq Whisper');
    } else {
      console.log('[voice] STT_PROVIDER=groq → Whisper');
    }
    return transcribeAudio(audioBuffer, mimeType);
  }

  const language = vendor?.preferred_language || 'gu';
  console.log(`[voice] STT_PROVIDER=sarvam lang=${language}`);
  try {
    return await transcribeWithSarvam(audioBuffer, mimeType, { language });
  } catch (err) {
    console.error(
      '[voice] Sarvam failed, falling back to Groq Whisper:',
      err.message
    );
    return transcribeAudio(audioBuffer, mimeType);
  }
}

async function handleVoice(vendor, message, msgCtx = {}) {
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
  if (confirm === 'undo') {
    try {
      await undoLastPost(vendor.id);
      return '↩️ Undone. The last journal entry was removed.';
    } catch (err) {
      return `Could not undo: ${err.message}`;
    }
  }
  if (confirm) return handleConfirmationReply(vendor, confirm, msgCtx);

  // Voice identity correction (naam / નામ / number / નંબર)
  const identityFix = parseIdentityCorrection(transcript);
  if (identityFix) {
    const fixed = await handleIdentityCorrection(vendor, identityFix);
    if (fixed) return fixed;
  }

  if (isProfitQuery(transcript)) {
    try {
      const digest = await getProfitDigest(vendor.id, 'today');
      return digest.message;
    } catch (err) {
      return `Could not load profit: ${err.message}`;
    }
  }

  // Spoken stock adjustment: "add twenty to maggi stock" (transcribed as digits)
  const stockAdjust = parseStockAdjustMessage(transcript);
  if (stockAdjust) {
    try {
      const res = await applyStockAdjust(vendor.id, stockAdjust);
      return res.message;
    } catch (err) {
      return `Could not update stock: ${err.message}`;
    }
  }

  // Product stock/price questions → DB (never a statement PDF)
  const productQuery = parseProductQueryMessage(transcript);
  if (productQuery) {
    try {
      return await runProductQuery(vendor.id, productQuery);
    } catch (err) {
      return `Could not load product: ${err.message}`;
    }
  }

  const setup = parseProductSetupMessage(transcript);
  if (setup) {
    try {
      const result = await applyProductSetup(vendor.id, setup);
      const p = result.product;
      return (
        `✅ *Product Master*\n` +
        `${p.product_name}\n` +
        `Sell: ₹${p.selling_price}/${p.unit}\n` +
        `Buy: ₹${p.purchase_price}/${p.unit}\n` +
        (p.gst_pct ? `GST: ${p.gst_pct}%\n` : '') +
        (p.supplier ? `Supplier: ${p.supplier}\n` : '') +
        `Stock: ${p.current_stock}`
      );
    } catch (err) {
      return `Could not update product: ${err.message}`;
    }
  }

  return analyzeAndStage({
    vendor,
    rawText: transcript,
    inputType: 'voice',
    mediaUrl: audioId,
    sourceHint:
      'User sent a GUJARATI/Hinglish voice note (Whisper language=gu). ' +
      'Spoken "naam/નામ" means customer NAME; "number/નંબર" means phone NUMBER. ' +
      'Keep Gujarati words as spoken; map to party.name / party.phone.',
  });
}

async function handleImage(vendor, message, msgCtx = {}) {
  const imageId = message.image?.id;
  const caption = message.image?.caption || '';
  console.log(`Image from ${vendor.phone}, caption: ${caption}`);

  const media = await downloadMedia(imageId);
  if (!media?.buffer) {
    return '❌ Could not download your image. Please try again.';
  }

  // Phase 5: stock-sheet photo tagged for bulk inventory
  if (isStockBulkIntent(caption)) {
    try {
      const rows = await extractInventoryFromImage(
        media.buffer,
        media.mimeType
      );
      const { validRows, invalidRows } = validateRows(rows);
      if (!validRows.length) {
        return (
          '⚠️ Could not extract valid products from this stock photo.\n' +
          'Send a clearer table photo, or upload *sample_inventory.csv*.'
        );
      }
      return stageBulkInventory(vendor, {
        validRows,
        invalidRows,
        rawInput: JSON.stringify(rows, null, 0),
        inputType: 'image',
        mediaUrl: imageId,
      });
    } catch (err) {
      console.error('[image] stock-bulk extract failed:', err.message);
      return `❌ Could not read stock sheet: ${err.message}`;
    }
  }

  let ocrText;
  try {
    // Small pause helps stay under Groq 8k TPM after prior messages
    await new Promise((r) => setTimeout(r, 1500));
    ocrText = await ocrImageText(media.buffer, media.mimeType);
  } catch (err) {
    const msg = String(err.message || err);
    if (/rate limit|TPM|tokens per minute/i.test(msg)) {
      return (
        '⏳ Vision OCR is rate-limited (Groq free tier). Please wait *5–10 seconds* and send the bill photo again.'
      );
    }
    return `❌ OCR failed: ${msg.slice(0, 180)}`;
  }

  if (!ocrText || /no text found/i.test(ocrText)) {
    return '🖼️ No text detected in the image. Please send a clearer photo.';
  }

  console.log('[image] OCR raw:', ocrText.slice(0, 500));

  // Send the extracted text back first, then continue to verification.
  if (msgCtx.fromNumber) {
    try {
      await sendTextMessage(
        msgCtx.fromNumber,
        `📝 *Extracted from image:*\n${ocrText.trim().slice(0, 1200)}`,
        msgCtx.phoneNumberId
      );
    } catch (err) {
      console.error('[image] interim OCR send failed:', err.message);
    }
  }

  // Stock / catalog caption → existing inventory path (not invoice pipeline)
  if (/supplier|stock|inventory|price\s*list|catalog/i.test(caption)) {
    return analyzeAndStage({
      vendor,
      rawText: ocrText,
      caption,
      inputType: 'image',
      mediaUrl: imageId,
      sourceHint:
        'User sent an image with a supplier/stock caption — prefer inventory_bulk / product catalog.',
    });
  }

  // ── Invoice pipeline: OCR → normalize → JSON extract → validate → WhatsApp ──
  try {
    const normalized = normalizeOcrText(ocrText);
    console.log(
      `[image] normalized lang=${normalized.language} rows=${normalized.rowHints.length}`
    );

    const itemCount = (normalized.text.match(/^ITEM\s*:/gim) || []).length;
    if (itemCount === 0) {
      // Last chance: ask extractor on raw OCR (may still find rows)
      const invoiceJson = await extractInvoiceFromOcr(
        normalized.text || ocrText,
        normalized.language
      );
      const validated = validateInvoice(invoiceJson, {
        ocrText: normalized.text || ocrText,
      });
      if (!validated.items.length) {
        return (
          '⚠️ Could not read the bill items from this photo.\n' +
          'Tips: brighter light, flatter paper, full table in frame.\n' +
          'Or type: Sale Ghee 500gm 200 Sugar 1kg 500 Maggi 2 120 Milk 300gm 250 to Om Trivedi phone 9974099063'
        );
      }
      const preParsed = invoiceToParsed(validated, normalized.language);
      if (!preParsed.party) preParsed.party = { role: 'customer' };
      preParsed.intent = 'transaction';
      preParsed.transaction_type = 'sale';
      const verifyMsg = await stagePriceVerification(vendor, preParsed, {
        inputType: 'image',
        rawInput: normalized.text || ocrText,
        mediaUrl: imageId,
        language: normalized.language,
      });
      if (verifyMsg) return verifyMsg;
      return analyzeAndStage({
        vendor,
        rawText: ocrText,
        caption,
        inputType: 'image',
        mediaUrl: imageId,
        preParsed,
        sourceHint: 'User sent a customer bill photo (fallback extract).',
      });
    }

    const invoiceJson = await extractInvoiceFromOcr(
      normalized.text,
      normalized.language
    );
    const validated = validateInvoice(invoiceJson, { ocrText: normalized.text });
    console.log(
      `[image] invoice conf=${validated.confidence} items=${validated.items.length} warn=${validated.warning}`
    );

    if (!validated.items.length) {
      return (
        '⚠️ Could not extract any bill items without guessing.\n' +
        'Please resend a clearer photo, or type the items.'
      );
    }

    const preParsed = invoiceToParsed(validated, normalized.language);
    // Attach party from OCR header
    if (!preParsed.party) preParsed.party = {};
    const ocrName = normalized.text.match(/^NAME:\s*(.+)$/im)?.[1]?.trim();
    const ocrPhone = normalized.text.match(/^NUMBER:\s*([0-9]{10})/im)?.[1];
    if (ocrName && !/^UNREADABLE$/i.test(ocrName)) {
      preParsed.party.name = ocrName;
    }
    if (ocrPhone) preParsed.party.phone = ocrPhone;
    preParsed.party.role = 'customer';
    preParsed.transaction_type = 'sale';
    preParsed.intent = 'transaction';

    // Go straight to Product Master verification — do NOT re-parse via LLM
    const verifyMsg = await stagePriceVerification(vendor, preParsed, {
      inputType: 'image',
      rawInput: normalized.text,
      mediaUrl: imageId,
      language: normalized.language,
    });
    if (verifyMsg) return verifyMsg;

    return analyzeAndStage({
      vendor,
      rawText: normalized.text,
      caption,
      inputType: 'image',
      mediaUrl: imageId,
      sourceHint:
        'Invoice pipeline: structured OCR → JSON extract → validation (never guess).',
      preParsed,
    });
  } catch (err) {
    console.error('[image] invoice pipeline failed:', err.message);
    // Fallback: still try dash-line parse from raw OCR before LLM
    try {
      const {
        extractDashBillLines,
      } = require('../utils/billLineParse');
      const dash = extractDashBillLines(ocrText);
      if (dash.length) {
        const items = dash.map((p) => ({
          name: p.display_name,
          base_name: p.name,
          name_en: p.name,
          quantity: p.count,
          count: p.count,
          unit: p.pack_unit || p.unit,
          pack_text: p.pack_text,
          pack_qty: p.pack_qty,
          pack_unit: p.pack_unit,
          weight_text: p.pack_text,
          unit_price: p.unit_price,
          line_amount: p.line_amount,
        }));
        const name =
          ocrText.match(/^NAME:\s*(.+)$/im)?.[1]?.trim() ||
          ocrText.match(/^Name:\s*(.+)$/im)?.[1]?.trim() ||
          null;
        const phone =
          ocrText.match(/^NUMBER:\s*([0-9]{10})/im)?.[1] ||
          ocrText.match(/^Number:\s*([0-9]{10})/im)?.[1] ||
          null;
        const total = items.reduce((s, i) => s + (i.line_amount || 0), 0);
        const preParsed = {
          intent: 'transaction',
          transaction_type: 'sale',
          items,
          party: { name, phone, role: 'customer' },
          total_amount: total,
        };
        const verifyMsg = await stagePriceVerification(vendor, preParsed, {
          inputType: 'image',
          rawInput: ocrText,
          mediaUrl: imageId,
          language: 'en',
        });
        if (verifyMsg) return verifyMsg;
      }
    } catch (e2) {
      console.error('[image] dash fallback failed:', e2.message);
    }
    const langMatch = ocrText.match(/BILL_LANG:\s*(en|gu)/i);
    const billLang = langMatch ? langMatch[1].toLowerCase() : null;
    return analyzeAndStage({
      vendor,
      rawText: ocrText,
      caption,
      inputType: 'image',
      mediaUrl: imageId,
      sourceHint:
        billLang === 'gu'
          ? 'User sent a GUJARATI handwritten bill photo. Analyze as customer sale. NEVER invent items.'
          : 'User sent a bill photo. Analyze as customer sale. NEVER invent items.',
    });
  }
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

  const fnameLower = filename.toLowerCase();
  const isCsv =
    extracted.inputType === 'csv' ||
    fnameLower.endsWith('.csv') ||
    (mimeType || '').includes('csv');
  const isExcel =
    extracted.inputType === 'excel' ||
    fnameLower.endsWith('.xlsx') ||
    fnameLower.endsWith('.xls');
  const forceBulk =
    isStockBulkIntent(caption) ||
    isStockBulkIntent(filename) ||
    /sample_inventory|inventory|stock/i.test(filename);

  // Phase 5: structured CSV / Excel → validate → confirm (no LLM guesswork)
  if ((isCsv || isExcel) && extracted.buffer) {
    try {
      let rows = [];
      if (isCsv) {
        rows = parseCsv(extracted.buffer);
      } else {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(extracted.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const csvText = XLSX.utils.sheet_to_csv(sheet);
        rows = parseCsv(Buffer.from(csvText, 'utf8'));
      }

      const { validRows, invalidRows } = validateRows(rows);
      if (validRows.length > 0 && (forceBulk || isCsv || isExcel)) {
        return stageBulkInventory(vendor, {
          validRows,
          invalidRows,
          rawInput: extracted.text || JSON.stringify(validRows),
          inputType: isCsv ? 'csv' : 'excel',
          mediaUrl: documentId,
        });
      }

      if (forceBulk && !validRows.length) {
        return (
          `⚠️ Could not parse valid product rows from *${filename}*.\n` +
          'Expected columns: Product ID, Product Name, Category, Stock, Price, Supplier.'
        );
      }
    } catch (err) {
      console.error('[document] structured inventory parse failed:', err.message);
      if (forceBulk) {
        return `❌ Could not parse inventory file: ${err.message}`;
      }
      // fall through to LLM path
    }
  }

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
