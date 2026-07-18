const PDFDocument = require('pdfkit');

/**
 * Generate a clean letterhead-style PDF for Indian accounting statements.
 */
function generateStatementPdf(statementData, statementType, language = 'en') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 50, bottom: 50, left: 50, right: 50 },
      });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const d = statementData || {};
      const type = statementType || d.statementType || 'statement';
      const isGu = String(language || '').toLowerCase().startsWith('gu');

      // Letterhead
      doc
        .fontSize(18)
        .fillColor('#1a1a1a')
        .text('LedgerBot', { align: 'left' });
      doc
        .fontSize(9)
        .fillColor('#555')
        .text(
          isGu
            ? 'આંતરિક હિસાબી વિગત — CA સમીક્ષા પહેલાં ફાઇલ ન કરો'
            : 'Internal bookkeeping statement — review with a CA before filing',
          { align: 'left' }
        );
      doc.moveDown(0.5);
      doc
        .moveTo(50, doc.y)
        .lineTo(545, doc.y)
        .strokeColor('#ccc')
        .stroke();
      doc.moveDown(1);

      doc.fontSize(14).fillColor('#111').text(titleFor(type, isGu));
      doc
        .fontSize(10)
        .fillColor('#444')
        .text(
          `Period: ${d.startDate || ''} → ${d.endDate || d.asOfDate || ''}`
        );
      doc.moveDown(1);

      if (type === 'ledger_account' || type === 'party_ledger') {
        renderLedgerTable(doc, d);
      } else if (type === 'pnl') {
        renderKeyValues(doc, [
          ['Income', d.income],
          ['Expense', d.expense],
          ['Gross profit', d.gross_profit],
          ['Net profit', d.net_profit],
        ]);
      } else if (type === 'balance_sheet') {
        renderKeyValues(doc, [
          ['Assets', d.assets],
          ['Liabilities', d.liabilities],
          ['Equity', d.equity],
          ['Balanced', d.balanced ? 'Yes' : 'No'],
        ]);
      } else if (type === 'cashflow') {
        renderKeyValues(doc, [
          ['Inflows', d.inflows],
          ['Outflows', d.outflows],
          ['Net cash', d.net_cash],
        ]);
      } else if (type === 'owners_equity') {
        renderKeyValues(doc, [
          ['Capital contributions', d.capital_contributions],
          ['Drawings', d.drawings],
          ['Retained profit', d.retained_profit],
          ['Closing equity', d.closing_equity],
        ]);
      } else if (type === 'accounting_equation') {
        renderKeyValues(doc, [
          ['Assets', d.assets],
          ['Liabilities', d.liabilities],
          ['Equity', d.equity],
          ['Equation', d.equation],
          ['Balanced', d.balanced ? 'Yes' : 'No'],
        ]);
      } else {
        doc.fontSize(10).text(JSON.stringify(d, null, 2));
      }

      doc.moveDown(2);
      doc
        .fontSize(8)
        .fillColor('#888')
        .text(`Generated ${new Date().toISOString()} · LedgerBot`, {
          align: 'center',
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function titleFor(type, isGu) {
  const map = {
    pnl: isGu ? 'Profit & Loss / નફો-નુકસાન' : 'Profit & Loss Statement',
    balance_sheet: isGu ? 'Balance Sheet / બેલેન્સ શીટ' : 'Balance Sheet',
    cashflow: isGu ? 'Cash Flow / કેશ ફ્લો' : 'Cash Flow Statement',
    owners_equity: "Owner's Equity Statement",
    ledger_account: 'Account Ledger (Dr. / Cr.)',
    party_ledger: 'Party Ledger (Dr. / Cr.)',
    accounting_equation: 'Accounting Equation',
  };
  return map[type] || 'Financial Statement';
}

function renderKeyValues(doc, pairs) {
  doc.fontSize(11).fillColor('#111');
  for (const [label, value] of pairs) {
    const display =
      typeof value === 'number'
        ? `₹${Number(value).toLocaleString('en-IN')}`
        : String(value ?? '');
    doc.text(`${label}:  ${display}`);
    doc.moveDown(0.4);
  }
}

function renderLedgerTable(doc, d) {
  doc.fontSize(10).text(`Account: ${d.account?.name || d.account?.id || ''}`);
  doc.moveDown(0.5);

  const col = { date: 50, part: 120, debit: 380, credit: 470 };
  doc.fontSize(9).fillColor('#333');
  doc.text('Date', col.date, doc.y, { continued: false });
  const y = doc.y - 11;
  doc.text('Particulars', col.part, y);
  doc.text('Debit', col.debit, y);
  doc.text('Credit', col.credit, y);
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#999').stroke();
  doc.moveDown(0.4);

  for (const r of d.rows || []) {
    if (doc.y > 750) doc.addPage();
    const rowY = doc.y;
    const dateStr =
      typeof r.entry_date === 'string'
        ? r.entry_date.slice(0, 10)
        : r.entry_date
          ? new Date(r.entry_date).toISOString().slice(0, 10)
          : '';
    doc.fontSize(8).fillColor('#111');
    doc.text(dateStr, col.date, rowY, { width: 65 });
    doc.text(String(r.narration || '-').slice(0, 40), col.part, rowY, {
      width: 240,
    });
    doc.text(String(r.debit ?? 0), col.debit, rowY, { width: 70 });
    doc.text(String(r.credit ?? 0), col.credit, rowY, { width: 70 });
    doc.moveDown(0.8);
  }

  doc.moveDown(0.5);
  doc
    .fontSize(10)
    .text(
      `Total Debit: ₹${d.total_debit ?? 0}    Total Credit: ₹${d.total_credit ?? 0}`
    );
}

module.exports = { generateStatementPdf };
