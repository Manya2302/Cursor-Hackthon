const { downloadMedia } = require('./whatsapp');
const { summarizeDocument, ocrImageText } = require('./groq');

/**
 * Extract text from WhatsApp documents (PDF / Excel / CSV).
 * Mirrors main.py extract_document_content for testing + /ai-stock-bulk.
 * Returns { text, fileTypeLabel, errorMessage }.
 */
async function extractDocumentText(documentId, filename, mimeType) {
  const media = await downloadMedia(documentId);
  if (!media?.buffer) {
    return {
      text: null,
      fileTypeLabel: null,
      errorMessage: `❌ Could not download *${filename}*. Please try again.`,
      buffer: null,
    };
  }

  const fnameLower = (filename || '').toLowerCase();
  const fileBytes = media.buffer;
  let extractedText = '';
  let fileTypeLabel = '';

  try {
    if (fnameLower.endsWith('.csv') || (mimeType || '').includes('csv')) {
      fileTypeLabel = 'CSV';
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
      try {
        const pdfParse = require('pdf-parse');
        const parsed = await pdfParse(fileBytes);
        extractedText = (parsed.text || '').trim();
      } catch (err) {
        console.error('[documents] PDF parse error:', err.message);
        extractedText = '';
      }

      // Scanned PDF fallback: vision OCR on raw bytes as image-like prompt via base64 note
      if (!extractedText) {
        console.log('[documents] Scanned/empty PDF — attempting vision OCR...');
        try {
          extractedText = await ocrImageText(fileBytes, 'application/pdf');
          if (/no text found/i.test(extractedText)) extractedText = '';
        } catch (err) {
          console.error('[documents] PDF OCR error:', err.message);
        }
      }
    } else if (fnameLower.endsWith('.xlsx') || fnameLower.endsWith('.xls')) {
      fileTypeLabel = 'Excel';
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
          errorMessage: `❌ Could not read *${filename}*: ${err.message}`,
          buffer: fileBytes,
        };
      }
    } else {
      return {
        text: null,
        fileTypeLabel: null,
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
      errorMessage: `❌ Could not read *${filename}*: ${err.message}`,
      buffer: fileBytes,
    };
  }

  if (!extractedText.trim()) {
    return {
      text: null,
      fileTypeLabel,
      errorMessage: `⚠️ *${filename}* appears to be empty or contains no readable text.`,
      buffer: fileBytes,
    };
  }

  console.log(
    `[documents] Extracted ${extractedText.length} chars from ${filename}`
  );

  return {
    text: extractedText,
    fileTypeLabel,
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
