require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
for (const k of Object.keys(process.env)) {
  if (process.env[k]) {
    process.env[k] = String(process.env[k]).replace(/^["']|["']$/g, '').trim();
  }
}

const { extractIntent } = require('../src/services/groq');
const { buildConfirmationSummary } = require('../src/utils/confirmation');

(async () => {
  const bill = await extractIntent(`User sent an image (likely a customer bill).
Content:
NAME: OM TRIVEDI
NUMBER: 9974099063
1. SUGAR 1KG 100 Rs
2. GHEE 500GM 200 Rs
TOTAL 300 Rs`);
  console.log('BILL intent:', bill.intent, bill.transaction_type);
  console.log(buildConfirmationSummary(bill).slice(0, 400));

  const stock = await extractIntent(`User caption/message: supplier stock list
Content:
Supplier: ABC Traders
1. Rice 50 KG price 40
2. Oil 20 L price 120`);
  console.log('\nSTOCK intent:', stock.intent, stock.party);
  console.log(buildConfirmationSummary(stock).slice(0, 400));

  const hi = await extractIntent('User sent a WhatsApp text message.\nContent:\nhello');
  console.log('\nCHAT intent:', hi.intent);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
