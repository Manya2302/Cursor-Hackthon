/**
 * Local smoke test for Phase 3 extraction + staging (no WhatsApp send).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
require('dotenv').config({
  path: require('path').join(__dirname, '..', '..', '.env'),
  override: false,
});

for (const key of Object.keys(process.env)) {
  if (process.env[key]) {
    process.env[key] = String(process.env[key]).replace(/^["']|["']$/g, '').trim();
  }
}

const { extractIntent } = require('../src/services/groq');
const { detectLanguage } = require('../src/utils/language');
const { buildConfirmationSummary } = require('../src/utils/confirmation');
const { parseCommand } = require('../src/utils/commands');
const { resolveOrCreateVendor } = require('../src/services/vendors');
const { stageRawExtraction } = require('../src/services/extractions');

(async () => {
  const sample = '/ai-order 5kg sugar 400 cash 100 ramesh udhaar';
  const cmd = parseCommand(sample);
  console.log('command:', cmd);

  const lang = detectLanguage(cmd.rest);
  console.log('language:', lang);

  const parsed = await extractIntent(cmd.rest);
  console.log('parsed:', JSON.stringify(parsed, null, 2));

  const summary = buildConfirmationSummary(parsed, cmd.command);
  console.log('summary:', summary);

  const vendor = await resolveOrCreateVendor('918866686473', 'Manya');
  console.log('vendor:', vendor?.id);

  if (vendor && parsed?.intent !== 'unclear') {
    const staged = await stageRawExtraction({
      vendorId: vendor.id,
      inputType: 'text',
      rawInput: cmd.rest,
      command: cmd.command,
      llmParsed: parsed,
      detectedLanguage: lang,
    });
    console.log('staged:', staged);
  }

  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
