/**
 * Legacy slash-commands removed — NIRVHA uses a single intent agent.
 * Kept as a no-op module so old imports do not crash if referenced.
 */
module.exports = {
  COMMANDS: [],
  parseCommand: () => null,
  normalizeCommandText: (t) => (t || '').trim(),
  UNRECOGNIZED_COMMAND_REPLY: '',
  COMMAND_TIP: '',
};
