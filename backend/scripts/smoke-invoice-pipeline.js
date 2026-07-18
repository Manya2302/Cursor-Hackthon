const { parseInvoiceFromStructuredOcr } = require('../src/services/invoiceExtract');
const { validateInvoice, invoiceToParsed } = require('../src/utils/invoiceValidation');
const { normalizeOcrText } = require('../src/utils/ocrNormalize');

const en = `NAME: OM TRIVEDI
NAME_EN: OM TRIVEDI
NUMBER: 9974099063
ITEM: Sugar | WEIGHT: 1kg | AMOUNT: 100
ITEM: Ghee | WEIGHT: 500gm | AMOUNT: 200
ITEM: Butter | WEIGHT: 250gm | AMOUNT: 50
ITEM: Cheese | WEIGHT: 1kg | AMOUNT: 250
ITEM: Milk | WEIGHT: 500ml | AMOUNT: 35
TOTAL: 635
BILL_LANG: en`;

const n = normalizeOcrText(en);
const inv = parseInvoiceFromStructuredOcr(n.text);
const v = validateInvoice(inv, { ocrText: n.text });
const p = invoiceToParsed(v, 'en');
console.log('EN', JSON.stringify({
  items: v.items,
  total: v.total,
  conf: v.confidence,
  warn: v.warning,
  party: p.party,
}, null, 2));

const gu = `NAME: UNREADABLE
NUMBER: UNREADABLE
ITEM: ખાંડ | WEIGHT: 1 કિલો | AMOUNT: 100
ITEM: ઘી | WEIGHT: 500 ગ્રા | AMOUNT: 200
ITEM: બટર | WEIGHT: 250 ગ્રા | AMOUNT: 50
ITEM: ચીઝ | WEIGHT: 1 કિલો | AMOUNT: 250
ITEM: દૂધ | WEIGHT: 500 મિ.લી | AMOUNT: 34
TOTAL: 634
BILL_LANG: gu`;
const ng = normalizeOcrText(gu);
const iv = validateInvoice(parseInvoiceFromStructuredOcr(ng.text), { ocrText: ng.text });
console.log('GU', JSON.stringify({
  names: iv.items.map((i) => i.name),
  total: iv.total,
  warn: iv.warning,
  conf: iv.confidence,
}, null, 2));

// Duplicate echo should be removed
const dup = `ITEM: Sugar | WEIGHT: 2kg | AMOUNT: 100
ITEM: Sugar | WEIGHT: 2kg | AMOUNT: 100
TOTAL: 100`;
const dv = validateInvoice(parseInvoiceFromStructuredOcr(dup), { ocrText: dup });
console.log('DUP count', dv.items.length, dv.warnings);
