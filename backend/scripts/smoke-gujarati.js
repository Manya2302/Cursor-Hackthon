/**
 * Offline Gujarati lexicon + confirmation smoke (no API keys required).
 * Ensures khaand / ખાંડ → Sugar (ખાંડ) still works after Sarvam STT wiring.
 */

const assert = require('assert');
const { enrichParsedBill, GUJARATI_ITEM_LEXICON } = require('../src/utils/gujarati');
const { buildConfirmationSummary } = require('../src/utils/confirmation');

const sugar = GUJARATI_ITEM_LEXICON.find((x) => x.en === 'Sugar');
assert(sugar, 'Sugar lexicon entry missing');
assert(
  sugar.aliases.some((a) => String(a).toLowerCase() === 'khaand'),
  'Sugar aliases should include khaand (Gujlish / Sarvam romanization)'
);

const cases = ['khaand', 'khand', 'Khaand', sugar.gu];
for (const name of cases) {
  const parsed = enrichParsedBill({
    intent: 'transaction',
    transaction_type: 'sale',
    items: [{ name, quantity: 2, unit: 'KG' }],
    party: { name: 'Raju', phone: '9876543210' },
  });
  const item = parsed.items[0];
  assert.strictEqual(item.name_en, 'Sugar', `name_en for ${name}`);
  assert.strictEqual(item.name, sugar.gu, `canonical gu for ${name}`);

  const summary = buildConfirmationSummary(parsed);
  assert(
    summary.includes('Sugar') && summary.includes(sugar.gu),
    `confirmation should show Sugar (${sugar.gu}) for input ${name}\n---\n${summary}`
  );
  assert(summary.includes('2KG') || summary.includes('2'), 'qty in confirmation');
}

console.log('[smoke-gujarati] OK — lexicon + confirmation for khaand/ખાંડ → Sugar');
