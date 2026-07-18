const { validateJournalEntry } = require('./journalValidation');

/**
 * Build a WhatsApp confirmation from extracted JSON (bill / stock style).
 */
function buildConfirmationSummary(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return 'I could not understand that. Please rephrase and try again.';
  }

  if (parsed.intent === 'chat') {
    return null;
  }

  if (parsed.intent === 'unclear') {
    return (
      'I could not understand that.\n' +
      'Send a *bill photo*, *stock file* (CSV/Excel/PDF), or a short text.'
    );
  }

  if (parsed.intent === 'statement_query') {
    const type = parsed.statement?.type || 'statement';
    const period = parsed.statement?.period || 'the requested period';
    return (
      `📊 Report: ${type} (${period})\n\nReply *YES* to confirm or *NO* to cancel.`
    );
  }

  if (parsed.intent === 'inventory_bulk') {
    return formatInventoryBill(parsed);
  }

  return formatTransactionBill(parsed);
}

function formatTransactionBill(parsed) {
  const party = parsed.party || {};
  const items = Array.isArray(parsed.items)
    ? parsed.items.filter((i) => i && (i.name || i.line_amount != null || i.quantity != null))
    : [];

  const hasName = Boolean(party.name && String(party.name).trim());
  const hasPhone = Boolean(party.phone && String(party.phone).trim());
  const missingIdentity = !hasName || !hasPhone;

  const lines = [];
  lines.push(`🧾 *${formatTxnType(parsed.transaction_type)}*`);

  if (hasName || hasPhone) {
    if (hasName) lines.push(`👤 ${party.name}`);
    if (hasPhone) lines.push(`📞 ${party.phone}`);
  }

  if (items.length) {
    items.slice(0, 8).forEach((item, idx) => {
      const name = item.name_en || item.name || 'item';
      const weight =
        item.weight_text || formatWeight(item.quantity, item.unit) || '';
      const cost =
        item.line_amount != null
          ? `₹${formatMoney(item.line_amount)}`
          : item.unit_price != null
            ? `₹${formatMoney(item.unit_price)}`
            : '';
      const bits = [`${idx + 1}. ${name}`];
      if (weight) bits.push(weight);
      if (cost) bits.push(cost);
      lines.push(bits.join(' · '));
    });
    if (items.length > 8) lines.push(`…+${items.length - 8} more`);
  }

  if (parsed.total_amount != null) {
    lines.push(`💰 Total *₹${formatMoney(parsed.total_amount)}*`);
  }

  lines.push('');
  if (missingIdentity) {
    lines.push(
      '⚠️ No name / phone on this bill read.\n' +
        'Reply *YES* to save without them, or send:\n' +
        'NAME:\n' +
        'NUMBER:\n' +
        'Then reply *YES* to save.\n' +
        '*NO* to cancel.'
    );
  } else if (parsed.identity_verify?.verified) {
    lines.push('✅ Name / phone added.\nReply *YES* to save, or *NO* to cancel.');
  } else {
    lines.push('Reply *YES* to save, or *NO* to cancel.');
  }

  return lines.join('\n');
}

function formatInventoryBill(parsed) {
  const party = parsed.party || {};
  const updates = Array.isArray(parsed.product_updates)
    ? parsed.product_updates.filter((p) => p?.name)
    : [];
  const fromItems =
    updates.length === 0 && Array.isArray(parsed.items)
      ? parsed.items.filter((i) => i?.name)
      : [];

  const rows =
    updates.length > 0
      ? updates
      : fromItems.map((i) => ({
          name: i.name,
          stock: i.quantity,
          price: i.line_amount != null ? i.line_amount : i.unit_price,
          category: i.weight_text || i.unit,
        }));

  const hasName = Boolean(party.name && String(party.name).trim());
  const hasPhone = Boolean(party.phone && String(party.phone).trim());
  const missingIdentity = !hasName || !hasPhone;

  const lines = [];
  lines.push('📦 *Stock / products*');

  if (hasName) lines.push(`🏭 ${party.name}`);
  if (hasPhone) lines.push(`📞 ${party.phone}`);

  rows.slice(0, 8).forEach((p, idx) => {
    const bits = [`${idx + 1}. ${String(p.name).toUpperCase()}`];
    if (p.stock != null) bits.push(`qty ${p.stock}`);
    if (p.price != null) bits.push(`₹${formatMoney(p.price)}`);
    lines.push(bits.join(' · '));
  });
  if (rows.length > 8) lines.push(`…+${rows.length - 8} more`);

  lines.push('');
  if (missingIdentity) {
    lines.push(
      '⚠️ No customer name / phone in this file.\n' +
        'Reply *YES* to save without them, or send:\n' +
        'NAME:\n' +
        'NUMBER:\n' +
        'Then reply *YES* to save.\n' +
        '*NO* to cancel.'
    );
  } else if (parsed.identity_verify?.verified) {
    lines.push('✅ Name / phone added.\nReply *YES* to save, or *NO* to cancel.');
  } else {
    lines.push('Reply *YES* to save, or *NO* to cancel.');
  }
  return lines.join('\n');
}

function formatWeight(quantity, unit) {
  if (quantity == null && !unit) return null;
  if (quantity == null) return String(unit);
  const q = Number(quantity);
  const qText = Number.isFinite(q)
    ? Number.isInteger(q)
      ? String(q)
      : String(q)
    : String(quantity);
  return unit ? `${qText}${unit}` : qText;
}

function formatMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}

function formatTxnType(transactionType) {
  if (transactionType === 'sale') return 'Sale';
  if (transactionType === 'purchase') return 'Purchase';
  if (transactionType === 'payment') return 'Payment';
  if (transactionType === 'receipt') return 'Receipt';
  if (transactionType === 'expense') return 'Expense';
  return 'Entry';
}

module.exports = { buildConfirmationSummary, validateJournalEntry };
