const {
  findByAlias,
  createProduct,
  getPool,
} = require('./productMaster');
const {
  parseQtyUnit,
  expectedLineAmount,
  qtyInMasterUnit,
  roundMoney,
  normalizeUnit,
} = require('../utils/units');

/**
 * Verify extracted bill lines against Product Master.
 * Preferred bill line: ProductPack-count-lineTotal (unit price = total/count).
 * All ₹ math here — never in the LLM.
 */
async function verifyBill(vendorId, lines, ocrTotal = null, kind = 'sale') {
  const reportLines = [];
  let expectedTotal = 0;
  let ocrLinesSum = 0;
  let unknownCount = 0;
  let mismatchCount = 0;
  const warnings = [];
  const reviewSuggestions = [];

  for (let i = 0; i < (lines || []).length; i++) {
    const line = lines[i] || {};
    const lineAmount =
      line.line_amount != null ? Number(line.line_amount) : null;
    const count =
      line.count != null
        ? Number(line.count)
        : line.quantity != null
          ? Number(line.quantity)
          : null;
    // Skip garbage OCR rows (e.g. "sugar 5" with ₹0)
    if (
      (lineAmount == null || lineAmount <= 0) &&
      (line.unit_price == null || Number(line.unit_price) <= 0)
    ) {
      continue;
    }

    const rawName = line.base_name || line.name_en || line.name || null;
    const displayName = line.name || line.display_name || rawName;
    const packText = line.pack_text || line.weight_text || null;

    const ocrUnitPrice =
      line.unit_price != null
        ? Number(line.unit_price)
        : lineAmount != null && count
          ? roundMoney(lineAmount / count)
          : null;

    if (lineAmount != null) ocrLinesSum = roundMoney(ocrLinesSum + lineAmount);

    // Try several alias keys: "Ghee 1kg", "Ghee", "Ghee1kg"
    let product = null;
    const tryNames = [
      displayName,
      rawName,
      packText && rawName ? `${rawName} ${packText}` : null,
      packText && rawName
        ? `${rawName}${String(packText).replace(/\s+/g, '')}`
        : null,
    ].filter(Boolean);
    for (const n of tryNames) {
      product = await findByAlias(vendorId, n);
      if (product) break;
    }

    if (!product) {
      unknownCount += 1;
      reportLines.push({
        line_no: i + 1,
        status: 'unknown_product',
        raw_name: displayName || rawName,
        base_name: rawName,
        pack_text: packText,
        quantity: count,
        unit: line.pack_unit || line.unit || null,
        ocr_unit_price: ocrUnitPrice != null ? roundMoney(ocrUnitPrice) : null,
        ocr_line_amount: lineAmount != null ? roundMoney(lineAmount) : null,
        product_id: null,
        master_price: null,
        expected_line: null,
        difference: null,
        message: `${displayName || rawName || 'item'} is not in Product Master`,
        ask_add: true,
      });
      continue;
    }

    const masterPrice =
      kind === 'purchase'
        ? Number(product.purchase_price) || Number(product.selling_price) || 0
        : Number(product.selling_price) || 0;

    // Expected = count × master pack/unit price (preferred new format)
    let expected = null;
    if (count != null && masterPrice > 0) {
      expected = roundMoney(count * masterPrice);
    } else {
      const { quantity, unit } = parseQtyUnit(
        line.quantity,
        line.unit,
        line.weight_text || line.quantity
      );
      expected = expectedLineAmount(
        quantity,
        unit || product.unit,
        product.unit,
        masterPrice
      );
    }

    if (expected != null) expectedTotal = roundMoney(expectedTotal + expected);

    const impliedPerUnit =
      ocrUnitPrice != null
        ? roundMoney(ocrUnitPrice)
        : lineAmount != null && count
          ? roundMoney(lineAmount / count)
          : null;

    let status = 'ok';
    let difference = null;
    let message = null;

    if (impliedPerUnit != null && masterPrice > 0) {
      difference = roundMoney(impliedPerUnit - masterPrice);
      if (Math.abs(difference) > 0.5) {
        status = 'price_mismatch';
        mismatchCount += 1;
        const packLabel =
          packText ||
          `${product.unit ? `1 ${product.unit}` : 'unit'}`;
        message =
          `Please review the price of *${packLabel} ${product.product_name}* — ` +
          `Product Master ₹${masterPrice}, bill ₹${impliedPerUnit} each` +
          (count != null && lineAmount != null
            ? ` (${count} × ₹${impliedPerUnit} = ₹${roundMoney(lineAmount)})`
            : '');
        reviewSuggestions.push(message);
      }
    } else if (expected != null && lineAmount != null) {
      difference = roundMoney(lineAmount - expected);
      if (Math.abs(difference) > 0.5) {
        status = 'price_mismatch';
        mismatchCount += 1;
        message =
          `Please review *${product.product_name}* — ` +
          `expected ₹${expected}, bill ₹${roundMoney(lineAmount)} (Δ ₹${difference})`;
        reviewSuggestions.push(message);
      }
    }

    if (
      kind === 'sale' &&
      impliedPerUnit != null &&
      Number(product.purchase_price) > 0 &&
      impliedPerUnit < Number(product.purchase_price)
    ) {
      warnings.push(`Selling below cost: ${product.product_name}`);
      if (status === 'ok') status = 'warning';
    }

    reportLines.push({
      line_no: i + 1,
      status,
      raw_name: displayName || rawName,
      base_name: rawName,
      pack_text: packText,
      product_id: product.id,
      product_name: product.product_name,
      quantity: count,
      unit: line.pack_unit || product.unit,
      master_unit: product.unit,
      master_price: masterPrice,
      purchase_price: Number(product.purchase_price) || 0,
      selling_price: Number(product.selling_price) || 0,
      ocr_unit_price: impliedPerUnit,
      ocr_line_amount: lineAmount != null ? roundMoney(lineAmount) : null,
      expected_line: expected,
      difference,
      message,
    });
  }

  const ocrTotalNum =
    ocrTotal != null && Number.isFinite(Number(ocrTotal))
      ? roundMoney(ocrTotal)
      : ocrLinesSum || null;

  const totalDiff =
    ocrTotalNum != null && expectedTotal > 0
      ? roundMoney(ocrTotalNum - expectedTotal)
      : null;

  if (totalDiff != null && Math.abs(totalDiff) > 0.5) {
    warnings.push(
      `Total mismatch: bill ₹${ocrTotalNum} vs master expected ₹${expectedTotal}`
    );
  }

  let overall = 'verified';
  if (unknownCount > 0) overall = 'needs_review';
  else if (mismatchCount > 0 || (totalDiff != null && Math.abs(totalDiff) > 0.5)) {
    overall = 'needs_review';
  } else if (warnings.length) overall = 'accepted_with_warning';

  return {
    kind,
    status: overall,
    lines: reportLines,
    expected_total: expectedTotal,
    ocr_total: ocrTotalNum,
    ocr_lines_sum: ocrLinesSum,
    difference: totalDiff,
    unknown_count: unknownCount,
    mismatch_count: mismatchCount,
    warnings,
    review_suggestions: reviewSuggestions,
  };
}

async function saveVerification(vendorId, extractionId, report, opts = {}) {
  const pg = getPool();
  if (!pg) throw new Error('Database not configured');

  const client = await pg.connect();
  try {
    await client.query('begin');

    const doc = await client.query(
      `insert into ocr_documents
         (vendor_id, extraction_id, media_url, raw_ocr, detected_language, document_kind)
       values ($1,$2,$3,$4,$5,$6)
       returning id`,
      [
        vendorId,
        extractionId || null,
        opts.mediaUrl || null,
        opts.rawOcr || null,
        opts.language || null,
        report.kind === 'purchase' ? 'purchase_invoice' : 'sale_bill',
      ]
    );
    const ocrDocId = doc.rows[0].id;

    for (const line of report.lines || []) {
      await client.query(
        `insert into ocr_items
           (ocr_document_id, line_no, raw_name, quantity, unit, unit_price, line_amount)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          ocrDocId,
          line.line_no,
          line.raw_name,
          line.quantity,
          line.unit,
          line.ocr_unit_price,
          line.ocr_line_amount,
        ]
      );
    }

    const vr = await client.query(
      `insert into verification_results
         (vendor_id, extraction_id, ocr_document_id, status, kind, report)
       values ($1,$2,$3,$4,$5,$6::jsonb)
       returning *`,
      [
        vendorId,
        extractionId || null,
        ocrDocId,
        report.status || 'pending',
        report.kind || 'sale',
        JSON.stringify(report),
      ]
    );

    await client.query(
      `insert into verification_logs (verification_id, action, detail)
       values ($1,'created',$2::jsonb)`,
      [vr.rows[0].id, JSON.stringify({ unknown: report.unknown_count })]
    );

    await client.query('commit');
    return vr.rows[0];
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

async function resolveVerification(verificationId, status, detail = {}) {
  const pg = getPool();
  if (!pg || !verificationId) return;
  await pg.query(
    `update verification_results set status = $2, resolved_at = now() where id = $1`,
    [verificationId, status]
  );
  await pg.query(
    `insert into verification_logs (verification_id, action, detail)
     values ($1,$2,$3::jsonb)`,
    [verificationId, status, JSON.stringify(detail)]
  );
}

/**
 * WhatsApp verification report for the new bill format.
 */
function formatVerificationReport(report, party = {}) {
  const lines = [];
  lines.push('🔎 *Bill verification*');
  if (party.name) lines.push(`👤 ${party.name}`);
  if (party.phone) lines.push(`📞 ${party.phone}`);
  lines.push('');

  for (const row of report.lines || []) {
    // Never show garbage zero rows
    if (
      (row.ocr_line_amount == null || Number(row.ocr_line_amount) <= 0) &&
      (row.ocr_unit_price == null || Number(row.ocr_unit_price) <= 0)
    ) {
      continue;
    }
    if (row.status === 'unknown_product') {
      lines.push(`❓ *${row.raw_name || 'item'}* — not in Product Master`);
      if (row.ocr_unit_price != null) {
        lines.push(
          `   Bill: ${row.quantity || '?'} × ₹${row.ocr_unit_price} = ₹${row.ocr_line_amount ?? '—'}`
        );
      }
      lines.push('   → Reply *ADD PRODUCTS* to add it (name → qty → price for one)');
      continue;
    }

    const label = row.product_name || row.raw_name;
    const pack = row.pack_text ? ` ${row.pack_text}` : '';
    lines.push(`• ${label}${pack}`);
    if (row.quantity != null && row.ocr_unit_price != null) {
      lines.push(
        `   Bill: ${row.quantity} × ₹${row.ocr_unit_price} = ₹${row.ocr_line_amount ?? '—'}`
      );
    }
    lines.push(`   Master: ₹${row.master_price} each → expected ₹${row.expected_line ?? '—'}`);
    if (row.status === 'price_mismatch' && row.message) {
      lines.push(`   ⚠️ ${row.message}`);
    }
  }

  if ((report.review_suggestions || []).length) {
    lines.push('');
    lines.push('*Price review*');
    for (const s of report.review_suggestions) {
      lines.push(`• ${s}`);
    }
  }

  lines.push('');
  lines.push(`Bill total: *₹${report.ocr_total ?? '—'}*`);
  lines.push(`Master expected: *₹${report.expected_total ?? '—'}*`);

  lines.push('');
  lines.push('Reply:');
  lines.push('• *YES* — accept & save to books');
  if (report.mismatch_count > 0) {
    lines.push('• *UPDATE PRICE* — update master to bill unit prices, then save');
  }
  if (report.unknown_count > 0) {
    lines.push('• *ADD PRODUCTS* — add unknowns (asks name → stock qty → price for one)');
  }
  lines.push('• *NO* — cancel');

  return lines.join('\n');
}

module.exports = {
  verifyBill,
  saveVerification,
  resolveVerification,
  formatVerificationReport,
  createProduct,
};
