/**
 * Sarvam AI Saaras v3 — Speech-to-Text only.
 * Auth: api-subscription-key (NOT Bearer).
 */

const SARVAM_STT_URL = 'https://api.sarvam.ai/speech-to-text';
const SARVAM_MODEL = 'saaras:v3';

function getApiKey() {
  return (
    process.env.SARVAM_API_KEY ||
    process.env.SURVOM_API_KEY || // common typo
    ''
  )
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * Map vendor preferred_language / free-form language to Sarvam language_code.
 * Gujarat vendors default to gu-IN.
 */
function resolveLanguageCode(language) {
  const lang = String(language || 'gu')
    .trim()
    .toLowerCase()
    .replace('_', '-');

  if (lang === 'hi' || lang === 'hi-in' || lang.startsWith('hi')) return 'hi-IN';
  if (lang === 'en' || lang === 'en-in' || lang.startsWith('en')) return 'en-IN';
  if (lang === 'gu' || lang === 'gu-in' || lang.startsWith('gu')) return 'gu-IN';
  // Unknown / missing → Gujarati-first for MSME kirana default
  return 'gu-IN';
}

function extensionForMime(mimeType = '') {
  const m = String(mimeType).toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  // WhatsApp voice notes are typically ogg/opus
  return 'ogg';
}

function normalizeMime(mimeType = '') {
  const m = String(mimeType || '').toLowerCase().trim();
  if (!m) return 'audio/ogg';
  if (m.includes('ogg') || m.includes('opus')) return 'audio/ogg';
  if (m.includes('wav')) return 'audio/wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio/mpeg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'audio/mp4';
  if (m.includes('webm')) return 'audio/webm';
  return m.startsWith('audio/') ? m : 'audio/ogg';
}

/**
 * Transcribe audio with Sarvam Saaras v3.
 *
 * @param {Buffer|Uint8Array} audioBuffer
 * @param {string} mimeType - WhatsApp audio mime (ogg/opus, mp4/aac, mpeg/mp3, wav, …)
 * @param {{ language?: string, mode?: 'transcribe' | 'codemix' }} [options]
 * @returns {Promise<string>} plain transcript text
 */
async function transcribeWithSarvam(audioBuffer, mimeType = 'audio/ogg', options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error(
      'SARVAM_API_KEY is not set. Add it to backend/.env (see .env.example).'
    );
  }

  if (!audioBuffer || !audioBuffer.length) {
    throw new Error('Empty audio buffer');
  }

  const languageCode = resolveLanguageCode(options.language);
  const mode =
    options.mode === 'codemix' ? 'codemix' : 'transcribe';
  const mime = normalizeMime(mimeType);
  const ext = extensionForMime(mime);

  const form = new FormData();
  form.append(
    'file',
    new Blob([audioBuffer], { type: mime }),
    `audio.${ext}`
  );
  form.append('model', SARVAM_MODEL);
  form.append('language_code', languageCode);
  form.append('mode', mode);

  console.log(
    `[sarvam] STT start model=${SARVAM_MODEL} lang=${languageCode} mode=${mode} mime=${mime} bytes=${audioBuffer.length}`
  );

  let res;
  try {
    res = await fetch(SARVAM_STT_URL, {
      method: 'POST',
      headers: {
        'api-subscription-key': apiKey,
      },
      body: form,
    });
  } catch (err) {
    console.error('[sarvam] network error:', err.message);
    throw new Error(`Sarvam STT network error: ${err.message}`);
  }

  const raw = await res.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = { transcript: raw };
  }

  if (!res.ok) {
    const detail =
      body?.error?.message ||
      body?.message ||
      body?.detail ||
      raw ||
      `HTTP ${res.status}`;
    console.error(`[sarvam] STT failed (${res.status}):`, detail);
    throw new Error(`Sarvam STT failed (${res.status}): ${detail}`);
  }

  const text = String(body.transcript ?? body.text ?? '').trim();

  if (!text) {
    console.warn('[sarvam] empty transcript payload:', raw.slice(0, 300));
    return '';
  }

  console.log(`[sarvam] transcript (${text.length} chars): ${text.slice(0, 200)}`);
  return text;
}

module.exports = {
  transcribeWithSarvam,
  resolveLanguageCode,
  SARVAM_STT_URL,
  SARVAM_MODEL,
};
