/**
 * Validate journal-entry (non-supplier) extractions.
 * Expected: name, phone/number, items (name + qty/weight + value), total.
 * Missing fields are listed so the user can still YES to save with nulls.
 */
function validateJournalEntry(parsed) {
  const missing = [];
  const party = parsed?.party || {};
  const items = Array.isArray(parsed?.items)
    ? parsed.items.filter((i) => i && (i.name || i.quantity != null || i.line_amount != null))
    : [];

  if (!party.name || !String(party.name).trim()) {
    missing.push('customer name');
  }
  if (!party.phone || !String(party.phone).trim()) {
    missing.push('phone number');
  }

  if (!items.length) {
    missing.push('items list');
  } else {
    const incompleteItems = [];
    items.forEach((item, idx) => {
      const n = idx + 1;
      if (!item.name || !String(item.name).trim()) {
        incompleteItems.push(`item ${n} name`);
      }
      const hasQty =
        item.quantity != null ||
        (item.weight_text && String(item.weight_text).trim());
      if (!hasQty) incompleteItems.push(`item ${n} quantity/weight`);
      const hasValue = item.line_amount != null || item.unit_price != null;
      if (!hasValue) incompleteItems.push(`item ${n} value/cost`);
    });
    missing.push(...incompleteItems);
  }

  if (parsed?.total_amount == null || parsed.total_amount === '') {
    missing.push('total amount');
  }

  return {
    ok: missing.length === 0,
    missing,
    incomplete: missing.length > 0,
  };
}

module.exports = { validateJournalEntry };
