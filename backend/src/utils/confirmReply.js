/**
 * Detect YES / NO confirmation replies for a pending extraction.
 * @returns {'yes' | 'no' | null}
 */
function parseConfirmationReply(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text
    .trim()
    .toLowerCase()
    .replace(/[!.,]+$/g, '')
    .trim();

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

module.exports = { parseConfirmationReply };
