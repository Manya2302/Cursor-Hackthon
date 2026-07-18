const crypto = require('crypto');
const {
  getPool,
  normalizeProductName,
  convertQuantity,
  deriveQuantityAndUnit,
  findProductMatch,
  getReferencePrice,
} = require('./productMaster');

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildVerificationRows(parsed) {
  const rows = [];
  if (!parsed || typeof parsed !== 'object') return rows;

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  for (const [idx, item] of items.entries()) {
    if (!item) continue;
    rows.push({
      line_no: idx + 1,
      name: item.name || item.name_en || null,
      quantity: item.quantity,
      unit: item.unit || null,
      weight_text: item.weight_text || null,
      unit_price: item.unit_price,
      line_amount: item.line_amount,
      gst_percent: item.gst_percent || null,
    });
  }

  if (rows.length === 0 && Array.isArray(parsed.product_updates)) {
    for (const [idx, item] of parsed.product_updates.entries()) {
      if (!item) continue;
      rows.push({
        line_no: idx + 1,
        name: item.name || null,
        quantity: item.stock,
        unit: item.unit || item.category || null,
        weight_text: null,
        unit_price: item.price,
        line_amount: null,
        gst_percent: item.gst_percent || null,
      });
    }
  }

  return rows.filter((r) => r.name);
}

function calculateDetectedLineAmount(row, quantity) {
  const lineAmount = toNumber(row.line_amount);
  if (lineAmount != null) return lineAmount;
  const unitPrice = toNumber(row.unit_price);
  if (unitPrice != null && quantity != null) return unitPrice * quantity;
  return null;
}

async function runPriceVerification(vendorId, parsed) {
  const rows = buildVerificationRows(parsed);
  if (!rows.length) return null;

  const transactionType =
    parsed?.transaction_type ||
    (parsed?.intent === 'inventory_bulk' ? 'purchase' : 'sale');
  const priceType = transactionType === 'purchase' ? 'purchase' : 'selling';

  const pg = getPool();
  let client = null;

  const resultItems = [];
  const warnings = [];
  const unknownProducts = [];
  const priceMismatches = [];
  const unitMismatches = [];
  let expectedTotal = 0;
  let expectedCount = 0;
  let detectedTotalFromLines = 0;

  try {
    if (pg) client = await pg.connect();

    for (const row of rows) {
      const { quantity, unit } = deriveQuantityAndUnit(row);
      const detectedLine = calculateDetectedLineAmount(row, quantity);
      if (detectedLine != null) detectedTotalFromLines += detectedLine;

      let product = null;
      let price = null;
      let expectedLine = null;
      let priceDiff = null;
      let unitIssue = null;
      if (client) {
        product = await findProductMatch(client, vendorId, row.name);
        if (product) {
          price = await getReferencePrice(client, vendorId, product.productId, {
            priceType,
            unit,
          });
          if (price?.amount != null && quantity != null) {
            let qtyForPrice = quantity;
            if (price.unit && unit) {
              const converted = convertQuantity(quantity, unit, price.unit);
              if (converted == null) {
                unitIssue = `${row.name}: ${unit} cannot convert to ${price.unit}`;
              } else {
                qtyForPrice = converted;
              }
            }
            if (!unitIssue) {
              expectedLine = Number((qtyForPrice * Number(price.amount)).toFixed(2));
              expectedTotal += expectedLine;
              expectedCount += 1;
            }
          }
        }
      }

      if (!product) {
        unknownProducts.push(row.name);
      }

      if (unitIssue) {
        unitMismatches.push(unitIssue);
      }

      if (expectedLine != null && detectedLine != null) {
        priceDiff = Number((detectedLine - expectedLine).toFixed(2));
        if (Math.abs(priceDiff) > 1) {
          priceMismatches.push({
            product: row.name,
            configured: expectedLine,
            detected: detectedLine,
            difference: priceDiff,
          });
        }
      }

      resultItems.push({
        ...row,
        quantity,
        unit,
        product_id: product?.productId || null,
        normalized_name: normalizeProductName(row.name),
        reference_unit: price?.unit || null,
        reference_price: price?.amount != null ? Number(price.amount) : null,
        expected_line_amount: expectedLine,
        detected_line_amount: detectedLine,
        price_difference: priceDiff,
        known_product: Boolean(product),
        unit_issue: unitIssue,
      });
    }
  } finally {
    if (client) client.release();
  }

  const detectedTotal =
    toNumber(parsed?.total_amount) != null
      ? Number(parsed.total_amount)
      : Number(detectedTotalFromLines.toFixed(2));

  const hasExpectedTotal = expectedCount > 0;
  const expected = hasExpectedTotal ? Number(expectedTotal.toFixed(2)) : null;
  const totalDifference =
    expected != null && detectedTotal != null
      ? Number((detectedTotal - expected).toFixed(2))
      : null;
  const totalMismatch =
    totalDifference != null ? Math.abs(totalDifference) > 1 : false;

  if (unknownProducts.length) {
    warnings.push(
      `Unknown products: ${Array.from(new Set(unknownProducts)).slice(0, 8).join(', ')}`
    );
  }
  if (priceMismatches.length) {
    warnings.push(`${priceMismatches.length} product price mismatch found`);
  }
  if (unitMismatches.length) {
    warnings.push(`${unitMismatches.length} product unit conversion issue found`);
  }
  if (totalMismatch) {
    warnings.push(
      `Expected total ₹${expected} vs detected total ₹${detectedTotal} (diff ₹${totalDifference})`
    );
  }

  let status = 'verified';
  if (unknownProducts.length || unitMismatches.length) {
    status = 'needs_review';
  } else if (priceMismatches.length || totalMismatch) {
    status = 'accepted_with_warning';
  }

  return {
    status,
    transaction_type: transactionType,
    expected_total: expected,
    detected_total: detectedTotal,
    difference_amount: totalDifference,
    requires_confirmation: status !== 'verified',
    warnings,
    unknown_products: Array.from(new Set(unknownProducts)),
    item_mismatches: priceMismatches,
    item_details: resultItems,
    checked_at: new Date().toISOString(),
  };
}

async function persistVerificationArtifacts({
  vendorId,
  extractionId,
  inputType,
  mediaUrl,
  rawInput,
  parsed,
}) {
  const verification = parsed?.verification;
  if (!verification || !extractionId) return null;

  const pg = getPool();
  if (!pg) return null;
  const client = await pg.connect();

  try {
    await client.query('begin');

    const ocrHash = crypto
      .createHash('sha256')
      .update(String(rawInput || ''))
      .digest('hex');

    const doc = await client.query(
      `insert into ocr_documents
         (vendor_id, raw_extraction_id, input_type, media_url, ocr_text, ocr_text_hash, detected_language)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        vendorId,
        extractionId,
        inputType || null,
        mediaUrl || null,
        rawInput || null,
        ocrHash,
        parsed?.detected_language || null,
      ]
    );
    const documentId = doc.rows[0].id;

    const details = Array.isArray(verification.item_details)
      ? verification.item_details
      : [];

    for (const row of details) {
      await client.query(
        `insert into ocr_items
           (vendor_id, document_id, line_no, raw_name, normalized_name, quantity, unit, unit_price, line_amount, gst_percent, mapped_product_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          vendorId,
          documentId,
          row.line_no || null,
          row.name || null,
          row.normalized_name || null,
          toNumber(row.quantity),
          row.unit || null,
          toNumber(row.unit_price),
          toNumber(row.detected_line_amount),
          toNumber(row.gst_percent),
          row.product_id || null,
        ]
      );
    }

    const verificationRow = await client.query(
      `insert into verification_results
         (vendor_id, raw_extraction_id, document_id, transaction_type, status, expected_total, detected_total, difference_amount, summary, warnings, requires_confirmation)
       values ($1, $2, $3, $4, $5::verification_status_enum, $6, $7, $8, $9, $10::jsonb, $11)
       returning id`,
      [
        vendorId,
        extractionId,
        documentId,
        verification.transaction_type || 'unknown',
        verification.status || 'pending',
        toNumber(verification.expected_total),
        toNumber(verification.detected_total),
        toNumber(verification.difference_amount),
        verification.warnings?.join(' | ') || null,
        JSON.stringify(verification),
        Boolean(verification.requires_confirmation),
      ]
    );

    await client.query(
      `insert into verification_logs (verification_result_id, event_type, payload)
       values ($1, 'generated', $2::jsonb)`,
      [verificationRow.rows[0].id, JSON.stringify(verification)]
    );

    await client.query(
      `update raw_extractions
          set verification_status = $2::verification_status_enum,
              verification_summary = $3::jsonb
        where id = $1`,
      [extractionId, verification.status || 'pending', JSON.stringify(verification)]
    );

    await client.query('commit');
    return { documentId, verificationResultId: verificationRow.rows[0].id };
  } catch (err) {
    await client.query('rollback');
    if (err?.code === '42P01' || err?.code === '42704' || err?.code === '42703') {
      return null;
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runPriceVerification,
  persistVerificationArtifacts,
};
