/**
 * Deterministic language detection via Unicode script blocks.
 * Gujarati U+0A80–U+0AFF → 'gu'
 * Devanagari U+0900–U+097F → 'hi'
 * Otherwise → 'en' (Hinglish LLM detection comes later)
 */
function detectLanguage(text) {
  if (!text) return 'en';

  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x0a80 && code <= 0x0aff) return 'gu';
    if (code >= 0x0900 && code <= 0x097f) return 'hi';
  }

  return 'en';
}

module.exports = { detectLanguage };
