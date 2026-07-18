/**
 * Smoke test Sarvam Saaras v3 STT.
 *
 * Usage:
 *   node scripts/smoke-sarvam.js [path/to/audio.ogg|wav|mp3|mp4]
 *
 * Skips (exit 0) when SARVAM_API_KEY is missing.
 * With a key but no file: prints usage and exits 0 (documents how to test).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
for (const k of Object.keys(process.env)) {
  if (process.env[k]) {
    process.env[k] = String(process.env[k]).replace(/^["']|["']$/g, '').trim();
  }
}

const fs = require('fs');
const path = require('path');
const {
  transcribeWithSarvam,
  resolveLanguageCode,
  SARVAM_MODEL,
} = require('../src/services/sarvam');

const apiKey = (process.env.SARVAM_API_KEY || '').trim();
if (!apiKey) {
  console.log('[smoke-sarvam] SKIP — SARVAM_API_KEY not set');
  process.exit(0);
}

const audioPath = process.argv[2];
if (!audioPath) {
  console.log('[smoke-sarvam] SARVAM_API_KEY is set.');
  console.log(`[smoke-sarvam] model=${SARVAM_MODEL} default lang=${resolveLanguageCode('gu')}`);
  console.log('');
  console.log('Pass an audio file to transcribe:');
  console.log('  npm run test:sarvam -- ./sample.ogg');
  console.log('');
  console.log('curl example:');
  console.log(
    '  curl -X POST https://api.sarvam.ai/speech-to-text \\'
  );
  console.log('    -H "api-subscription-key: $SARVAM_API_KEY" \\');
  console.log('    -F "model=saaras:v3" \\');
  console.log('    -F "language_code=gu-IN" \\');
  console.log('    -F "mode=transcribe" \\');
  console.log('    -F "file=@./sample.ogg"');
  process.exit(0);
}

const abs = path.resolve(audioPath);
if (!fs.existsSync(abs)) {
  console.error(`[smoke-sarvam] file not found: ${abs}`);
  process.exit(1);
}

const ext = path.extname(abs).toLowerCase();
const mime =
  ext === '.wav'
    ? 'audio/wav'
    : ext === '.mp3'
      ? 'audio/mpeg'
      : ext === '.mp4' || ext === '.m4a'
        ? 'audio/mp4'
        : 'audio/ogg';

(async () => {
  const buf = fs.readFileSync(abs);
  console.log(`[smoke-sarvam] file=${abs} mime=${mime} bytes=${buf.length}`);
  const text = await transcribeWithSarvam(buf, mime, { language: 'gu' });
  console.log('[smoke-sarvam] transcript:');
  console.log(text || '(empty)');
  if (!text) process.exit(1);
})().catch((err) => {
  console.error('[smoke-sarvam] FAILED:', err.message);
  process.exit(1);
});
