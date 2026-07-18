const COMMANDS = [
  '/ai-order',
  '/ai-stock-bulk',
  '/ai-stock',
  '/ai-payment',
  '/ai-report',
];

/**
 * Normalize WhatsApp text so commands still match with odd slashes / zero-width chars.
 */
function normalizeCommandText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[／⁄∕]/g, '/')
    .replace(/\u00A0/g, ' ')
    .trim();
}

/**
 * Detect a LedgerBot command prefix (case-insensitive).
 * Accepts: "/ai-order …", "ai-order …", "/ ai-order …"
 * @returns {{ command: string, rest: string } | null}
 */
function parseCommand(text) {
  const trimmed = normalizeCommandText(text);
  if (!trimmed) return null;

  // Allow optional leading slash and spaces: "ai-order", "/ai-order", "/ ai-order"
  let working = trimmed.replace(/^\/\s*/, '/');
  if (!working.startsWith('/')) {
    working = `/${working}`;
  }

  const lower = working.toLowerCase();

  for (const cmd of COMMANDS) {
    if (lower === cmd) {
      return { command: cmd, rest: '' };
    }
    // "/ai-order …" or "/ai-order:…" or "/ai-order,…"
    const prefixRe = new RegExp(
      `^${cmd.replace('/', '\\/')}(?:\\s+|[:\\-,]|$)`,
      'i'
    );
    if (prefixRe.test(lower)) {
      const rest = working.slice(cmd.length).replace(/^[\s:\-,]+/, '').trim();
      return { command: cmd, rest };
    }
  }

  return null;
}

const UNRECOGNIZED_COMMAND_REPLY =
  'Command not recognized. Use /ai-order, /ai-stock, /ai-payment, or /ai-report.';

const COMMAND_TIP =
  '\n\n_For bookkeeping, start with /ai-order, /ai-stock, /ai-payment, or /ai-report._';

module.exports = {
  COMMANDS,
  parseCommand,
  normalizeCommandText,
  UNRECOGNIZED_COMMAND_REPLY,
  COMMAND_TIP,
};
