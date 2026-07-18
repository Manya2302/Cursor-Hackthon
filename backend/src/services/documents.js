const { downloadMedia } = require('./whatsapp');
const { summarizeDocument } = require('./groq');

/**
 * Extract text from WhatsApp documents (PDF / Excel / CSV).
 * Returns { text, fileTypeLabel, errorMessage, inputType }.
 */
async function extractDocumentText(documentId, filename, mimeType) {
  const media = await downloadMedia(documentId);
  if (!media?.buffer) {
    return {
      text: null,
      fileTypeLabel: null,
      inputType: 'document',
      errorMessage: `❌ Could not download *${filename}*. Please try again.`,
      buffer: null,
    };
  }

  const fnameLower = (filename || '').toLowerCase();
  const fileBytes = media.buffer;
  let extractedText = '';
  let fileTypeLabel = '';
  let inputType = 'document';

  try {
    if (fnameLower.endsWith('.csv') || (mimeType || '').includes('csv')) {
      fileTypeLabel = 'CSV';
      inputType = 'csv';
      let textContent = null;
      for (const encoding of ['utf8', 'latin1']) {
        try {
          textContent = fileBytes.toString(encoding);
          break;
        } catch (_) {
          /* next */
        }
      }
      if (!textContent) {
        return {
          text: null,
          fileTypeLabel,
          inputType,
          errorMessage: `❌ Could not decode *${filename}*.`,
          buffer: fileBytes,
        };
      }
      const rows = textContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      extractedText = rows.join('\n');
    } else if (fnameLower.endsWith('.pdf') || (mimeType || '').includes('pdf')) {
      fileTypeLabel = 'PDF';
      inputType = 'pdf';
      try {
        const { PDFParse } = require('pdf-parse');
        const parser = new PDFParse({ data: fileBytes });
        const result = await parser.getText();
        extractedText = (result?.text || '').trim();
        if (typeof parser.destroy === 'function') await parser.destroy();
      } catch (err) {
        console.error('[documents] PDF parse error:', err.message);
        extractedText = '';
      }

      // Optional: table extraction if plain text is thin
      if (!extractedText || extractedText.length < 40) {
        try {
          const { PDFParse } = require('pdf-parse');
          const parser = new PDFParse({ data: fileBytes });
          if (typeof parser.getTable === 'function') {
            const tables = await parser.getTable();
            const bits = [];
            const pages = tables?.pages || tables?.tables || [];
            if (Array.isArray(pages)) {
              for (const page of pages) {
                const pageTables = page.tables || (page.rows ? [page] : []);
                for (const table of pageTables) {
                  const rows = table.rows || table;
                  if (!Array.isArray(rows)) continue;
                  for (const row of rows) {
                    if (Array.isArray(row)) bits.push(row.join(' | '));
                    else if (typeof row === 'string') bits.push(row);
                  }
                }
              }
            }
            if (bits.length) {
              extractedText = [extractedText, bits.join('\n')].filter(Boolean).join('\n\n');
            }
          }
          if (typeof parser.destroy === 'function') await parser.destroy();
        } catch (err) {
          console.error('[documents] PDF table extract error:', err.message);
        }
      }
    } else if (fnameLower.endsWith('.xlsx') || fnameLower.endsWith('.xls')) {
      fileTypeLabel = 'Excel';
      inputType = 'excel';
      try {
        const XLSX = require('xlsx');
        const workbook = XLSX.read(fileBytes, { type: 'buffer' });
        const sheetTexts = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (csv.trim()) {
            sheetTexts.push(`[Sheet: ${sheetName}]\n${csv.trim()}`);
          }
        }
        extractedText = sheetTexts.join('\n\n');
      } catch (err) {
        console.error('[documents] Excel parse error:', err.message);
        return {
          text: null,
          fileTypeLabel,
          inputType,
          errorMessage: `❌ Could not read *${filename}*: ${err.message}`,
          buffer: fileBytes,
        };
      }
    } else {
      return {
        text: null,
        fileTypeLabel: null,
        inputType: 'document',
        errorMessage:
          `⚠️ *${filename}* — file type not supported yet.\n` +
          'Supported: PDF, Excel (.xlsx/.xls), CSV',
        buffer: fileBytes,
      };
    }
  } catch (err) {
    return {
      text: null,
      fileTypeLabel,
      inputType,
      errorMessage: `❌ Could not read *${filename}*: ${err.message}`,
      buffer: fileBytes,
    };
  }

  if (!extractedText.trim()) {
    return {
      text: null,
      fileTypeLabel,
      inputType,
      errorMessage:
        `⚠️ *${filename}* appears to be empty or contains no readable text.\n` +
        'For scanned PDFs, send a clear *photo* of the page instead.',
      buffer: fileBytes,
    };
  }

  console.log(
    `[documents] Extracted ${extractedText.length} chars from ${filename} (${fileTypeLabel})`
  );

  return {
    text: extractedText,
    fileTypeLabel,
    inputType,
    errorMessage: null,
    buffer: fileBytes,
  };
}

/**
 * Human-readable document assistant reply (main.py style summary).
 */
async function extractDocumentContent(documentId, filename, mimeType) {
  const result = await extractDocumentText(documentId, filename, mimeType);
  if (result.errorMessage) return result.errorMessage;

  const CHAR_LIMIT = 6000;
  let displayText = result.text;
  let truncated = false;
  if (displayText.length > CHAR_LIMIT) {
    displayText = displayText.slice(0, CHAR_LIMIT);
    truncated = true;
  }

  const summary = await summarizeDocument(result.fileTypeLabel, displayText);
  const truncationNote = truncated
    ? `\n_(Showing first ${CHAR_LIMIT} of ${result.text.length} characters)_`
    : '';

  return (
    `📄 *${filename}* (${result.fileTypeLabel})${truncationNote}\n\n` +
    `📋 *Summary:*\n${summary}\n\n` +
    `📝 *Extracted Content:*\n${displayText}`
  );
}

module.exports = {
  extractDocumentText,
  extractDocumentContent,
};
