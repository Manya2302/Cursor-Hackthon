require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', '.env'),
  override: false,
});
for (const k of Object.keys(process.env)) {
  if (process.env[k]) {
    process.env[k] = String(process.env[k])
      .replace(/^["']|["']$/g, '')
      .trim();
  }
}

const { parseConfirmationReply } = require('../src/utils/confirmReply');
const { resolveOrCreateVendor } = require('../src/services/vendors');
const {
  stageRawExtraction,
  getLatestPendingExtraction,
} = require('../src/services/extractions');
const { postTransaction } = require('../src/services/ledger');

(async () => {
  console.log('Yes ->', parseConfirmationReply('Yes'));

  const v = await resolveOrCreateVendor('918866686473', 'Manya');
  await stageRawExtraction({
    vendorId: v.id,
    inputType: 'text',
    rawInput: '5kg sugar 400 cash Ramesh',
    command: '/ai-order',
    llmParsed: {
      intent: 'transaction',
      transaction_type: 'sale',
      items: [
        {
          name: 'sugar',
          quantity: 5,
          unit: 'kg',
          unit_price: null,
          line_amount: null,
        },
      ],
      party: { name: 'Ramesh', role: 'customer' },
      payments: [{ method: 'cash', amount: 400, party_name: null }],
      total_amount: null,
      product_updates: [],
      statement: {},
      notes: null,
      unclear_reason: null,
    },
    detectedLanguage: 'en',
  });

  const p = await getLatestPendingExtraction(v.id);
  console.log('pending', p.id);
  const r = await postTransaction(v.id, p);
  console.log('posted', r);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
