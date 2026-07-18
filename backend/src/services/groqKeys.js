/**
 * Groq API key helpers — primary + fallback rotation.
 * Env: GROQ_API_KEY, GROQ_API_KEY_FALLBACK (or GROQ_API_KEY_2),
 *      or comma-separated GROQ_API_KEYS
 */

function getApiKeys() {
  const fromList = String(process.env.GROQ_API_KEYS || '')
    .split(/[,;\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);

  const keys = [
    ...fromList,
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_FALLBACK,
    process.env.GROQ_API_KEY_2,
  ]
    .map((k) => String(k || '').trim())
    .filter(Boolean);

  return [...new Set(keys)];
}

function getApiKey() {
  return getApiKeys()[0] || '';
}

/**
 * Run an async fn(apiKey) trying each key.
 * On rate-limit / TPM / 401 / 403, switch to the next key.
 */
async function withGroqKey(fn) {
  const keys = getApiKeys();
  if (!keys.length) {
    throw new Error('GROQ_API_KEY is not set');
  }

  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      return await fn(key, i);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const switchKey =
        /rate limit|tokens per minute|TPM|429|401|403|invalid.*api.?key|authentication/i.test(
          msg
        );
      if (switchKey && i < keys.length - 1) {
        console.warn(
          `[groq] key ${i + 1}/${keys.length} failed (${msg.slice(0, 80)}) — trying fallback key…`
        );
        // Brief pause so TPM window / org switch settles
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('All Groq API keys failed');
}

module.exports = {
  getApiKey,
  getApiKeys,
  withGroqKey,
};
