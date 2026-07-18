/**
 * Detect YES / NO confirmation replies for a pending extraction.
 * @returns {'yes' | 'no' | 'save_as_is' | null}
 */
function parseConfirmationReply(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!.,]+$/g, '')
    .trim();

  if (
    /^(save\s*as\s*is|saveasis|keep\s*as\s*is|accept\s*ocr)$/i.test(t) ||
    t === 'save as is'
  ) {
    return 'save_as_is';
  }

  const yes = new Set([
    'yes',
    'y',
    'yeah',
    'yep',
    'confirm',
    'confirmed',
    'ok',
    'okay',
    'haan',
    'ha',
    'હા',
    'हां',
  ]);
  const no = new Set([
    'no',
    'n',
    'nope',
    'cancel',
    'cancelled',
    'canceled',
    'reject',
    'nah',
    'ના',
    'नहीं',
    'नही',
  ]);

  if (yes.has(t)) return 'yes';
  if (no.has(t)) return 'no';
  return null;
}

/**
 * Parse a user correction for misread name/phone, e.g.:
 * NAME: ઓમ ત્રિવેદી
 * NUMBER: 9974099063
 */
function parseIdentityCorrection(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  // Don't treat pure YES/NO as identity correction
  if (parseConfirmationReply(raw)) return null;

  const nameMatch = raw.match(
    /(?:name|નામ|naam)\s*[:\-]?\s*(.+?)(?:\n|$)/i
  );
  const numberMatch = raw.match(
    /(?:number|phone|નંબર|mobile|mob)\s*[:\-]?\s*([0-9૦-૯\s\-]{8,15})/i
  );

  // Also accept: "Om Trivedi 9974099063" on one line if 10-digit phone present
  const loosePhone = raw.match(/(?<!\d)([6-9][0-9]{9})(?!\d)/);
  const hasLabel = /name|number|નામ|નંબર|phone/i.test(raw);

  if (!nameMatch && !numberMatch && !(hasLabel && loosePhone)) {
    return null;
  }

  const { normalizeGujaratiDigits } = require('./gujarati');
  let name = nameMatch ? nameMatch[1].trim() : null;
  if (name) {
    name = name.replace(/\s+(number|phone|નંબર).*$/i, '').trim();
  }

  let phone = null;
  if (numberMatch) {
    phone = normalizeGujaratiDigits(numberMatch[1]).replace(/\D/g, '');
  } else if (loosePhone) {
    phone = loosePhone[1];
  }

  if (phone && phone.length !== 10) {
    // keep digits but mark invalid length — still return for user feedback
  }

  if (!name && !phone) return null;
  return { name, phone };
}

/**
 * Decide if OCR name/phone must be human-verified (handwriting often wrong).
 */
function assessIdentityConfidence(parsed, ocrText = '', opts = {}) {
  const fromImage = opts.fromImage === true;
  const party = parsed?.party || {};
  const name = (party.name || '').trim();
  const phone = String(party.phone || '').replace(/\D/g, '');
  const reasons = [];

  if (fromImage) {
    reasons.push('Gujarati handwritten name/phone is not auto-read (OCR invents wrong names)');
  }

  if (!name) reasons.push('name missing');
  if (!phone) reasons.push('phone missing');
  if (phone && !/^[6-9]\d{9}$/.test(phone)) {
    reasons.push('phone is not a valid 10-digit Indian mobile');
  }

  // If two OCR header drafts disagree, force verify
  if (opts.headerConflict) {
    reasons.push('two OCR reads disagreed on name/phone');
  }

  // Image bills: only ask for name/phone when OCR did not find them
  const needsVerify =
    parsed?.intent === 'transaction' &&
    fromImage === true &&
    (!name || !phone || (phone && !/^[6-9]\d{9}$/.test(phone)));

  return {
    needsVerify: Boolean(needsVerify),
    reasons,
    detectedName: name || null,
    detectedPhone: phone || null,
    detectedNameEn: parsed?.name_en || null,
  };
}

module.exports = {
  parseConfirmationReply,
  parseIdentityCorrection,
  assessIdentityConfidence,
};
