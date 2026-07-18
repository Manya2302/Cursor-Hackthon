require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
for (const k of Object.keys(process.env)) {
  if (process.env[k]) {
    process.env[k] = String(process.env[k]).replace(/^["']|["']$/g, '').trim();
  }
}

const { extractIntent } = require('../src/services/groq');
const { buildConfirmationSummary } = require('../src/utils/confirmation');

const sample = `
Command: /ai-order (customer SALE / order bill — extract every item, weights, costs, NAME, phone, TOTAL).
NAME :- OM TRIVEDI
NUMBER :- 9974099063
ITEMS WEIGHT COST
1. SUGAR 1KG 100 Rs.
2. GHEE 500GM 200 Rs.
3. BUTTER 250GM 50 Rs.
4. CHEESE 1KG 250 Rs.
5. MILK 500ML 35 Rs.
TOTAL 635 Rs.
`;

(async () => {
  const parsed = await extractIntent(sample);
  console.log(JSON.stringify(parsed, null, 2));
  console.log('\n--- BILL ---\n');
  console.log(buildConfirmationSummary(parsed, '/ai-order'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
