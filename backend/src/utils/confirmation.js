/**
 * Build a plain-language WhatsApp confirmation from extracted JSON.
 * Deterministic — no second LLM call (formatting stays separate from extractIntent).
 */
function buildConfirmationSummary(parsed, command) {
  if (!parsed || typeof parsed !== 'object') {
    return 'I could not understand that. Please rephrase and try again.';
  }

  if (parsed.intent === 'unclear') {
    const reason = parsed.unclear_reason
      ? ` (${parsed.unclear_reason})`
      : '';
    return `I could not clearly understand that${reason}. Please rephrase using /ai-order, /ai-stock, /ai-payment, or /ai-report.`;
  }

  if (parsed.intent === 'statement_query') {
    const type = parsed.statement?.type || 'statement';
    const period = parsed.statement?.period || 'the requested period';
    return `Got it: ${type} for ${period}. Reply YES to confirm or NO to cancel.`;
  }

  if (parsed.intent === 'inventory_bulk') {
    const updates = Array.isArray(parsed.product_updates)
      ? parsed.product_updates.filter((p) => p?.name)
      : [];
    if (updates.length === 0) {
      return 'Got it: inventory update. Reply YES to confirm or NO to cancel.';
    }
    const lines = updates
      .slice(0, 8)
      .map((p) => {
        const bits = [p.name];
        if (p.stock != null) bits.push(`stock ${p.stock}`);
        if (p.price != null) bits.push(`₹${p.price}`);
        return bits.join(', ');
      })
      .join('; ');
    const more =
      updates.length > 8 ? ` (+${updates.length - 8} more)` : '';
    return `Got it: stock update — ${lines}${more}. Reply YES to confirm or NO to cancel.`;
  }

  // transaction (and /ai-order, /ai-payment defaults)
  const typeLabel = formatTxnType(parsed.transaction_type, command);
  const itemParts = (parsed.items || [])
    .filter((i) => i?.name)
    .map((i) => {
      const qty =
        i.quantity != null
          ? `${i.quantity}${i.unit ? i.unit : ''}`
          : null;
      return [qty, i.name].filter(Boolean).join(' ');
    });

  const paymentParts = (parsed.payments || [])
    .filter((p) => p && (p.amount != null || p.method))
    .map((p) => {
      const amt = p.amount != null ? `₹${p.amount}` : null;
      const method = p.method || 'payment';
      const party = p.party_name || parsed.party?.name;
      if (String(method).toLowerCase() === 'udhaar' && party) {
        return [amt, 'credit to', party].filter(Boolean).join(' ');
      }
      return [amt, method].filter(Boolean).join(' ');
    });

  const chunks = [];
  if (itemParts.length) {
    chunks.push(
      `${typeLabel} of ${itemParts.join(', ')}${
        parsed.total_amount != null ? `, ₹${parsed.total_amount} total` : ''
      }`
    );
  } else if (parsed.total_amount != null) {
    chunks.push(`${typeLabel} ₹${parsed.total_amount}`);
  } else {
    chunks.push(typeLabel);
  }

  if (paymentParts.length) {
    chunks.push(paymentParts.join(' + '));
  } else if (parsed.party?.name) {
    chunks.push(`party ${parsed.party.name}`);
  }

  return `Got it: ${chunks.join(', ')}. Reply YES to confirm or NO to cancel.`;
}

function formatTxnType(transactionType, command) {
  if (transactionType === 'sale') return 'Sale';
  if (transactionType === 'purchase') return 'Purchase';
  if (transactionType === 'payment') return 'Payment';
  if (transactionType === 'receipt') return 'Receipt';
  if (transactionType === 'expense') return 'Expense';
  if (command === '/ai-payment') return 'Payment';
  if (command === '/ai-order') return 'Sale';
  return 'Entry';
}

module.exports = { buildConfirmationSummary };
