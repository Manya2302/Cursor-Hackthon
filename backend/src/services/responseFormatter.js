/**
 * Formatter Agent — second Groq call.
 * Receives ONLY already-computed JSON numbers + language + format.
 * Must NEVER recalculate, add, or omit any given figure.
 */

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const FORMATTER_MODEL =
  process.env.GROQ_FORMATTER_MODEL || 'llama-3.1-8b-instant';

const FORMATTER_SYSTEM_PROMPT = `You are LedgerBot's Formatter Agent for Indian small-business bookkeeping.

You receive ALREADY-COMPUTED statement JSON (numbers are final), a target language, and a layout format.
Your ONLY job: present those exact numbers as clear WhatsApp-ready text (or a compact table).

STRICT RULES:
- NEVER recalculate, round differently, add, subtract, invent, or omit any figure from the JSON.
- Copy every rupee amount exactly as given (you may add ₹ and thousand separators for readability, but digits must match).
- If language is Gujarati (gu), write labels/headings in Gujarati script; keep ALL numbers identical to the English digits in the JSON (use Western 0-9 digits).
- If language is English (en) or other, use English labels.
- Do not add advice, GST opinions, or extra totals not in the JSON.
- End with the tally.message line exactly if provided (✅ Verified balanced or ⚠️ Discrepancy found).
- Keep the reply concise for WhatsApp (under ~1500 characters when possible).

Formats:
- chat_summary: short sectioned summary with emoji headers allowed.
- ledger_table: classic Date | Particulars | Debit | Credit style lines.
- equation: one clear Assets = Liabilities + Equity line plus the balanced flag.

Output plain text only — no markdown fences, no JSON.`;

const { getApiKey, withGroqKey } = require('./groqKeys');

function fallbackFormat(statementData, tally, language, format) {
  const lang = String(language || 'en').toLowerCase();
  const isGu = lang === 'gu' || lang.startsWith('gu');
  const lines = [];
  const d = statementData || {};
  const type = d.statementType || 'statement';

  if (type === 'pnl') {
    lines.push(isGu ? '📊 *નફો-નુકસાન*' : '📊 *Profit & Loss*');
    lines.push(`${isGu ? 'આવક' : 'Income'}: ₹${d.income}`);
    lines.push(`${isGu ? 'ખર્ચ' : 'Expense'}: ₹${d.expense}`);
    lines.push(`${isGu ? 'ચોખ્ખો નફો' : 'Net profit'}: ₹${d.net_profit}`);
  } else if (type === 'balance_sheet') {
    lines.push(isGu ? '📒 *બેલેન્સ શીટ*' : '📒 *Balance Sheet*');
    lines.push(`${isGu ? 'અસ્કયામતો' : 'Assets'}: ₹${d.assets}`);
    lines.push(`${isGu ? 'જવાબદારીઓ' : 'Liabilities'}: ₹${d.liabilities}`);
    lines.push(`${isGu ? 'મૂડી' : 'Equity'}: ₹${d.equity}`);
    lines.push(d.balanced ? 'Balanced: yes' : 'Balanced: no');
  } else if (type === 'cashflow') {
    lines.push(isGu ? '💵 *કેશ ફ્લો*' : '💵 *Cash flow*');
    lines.push(`${isGu ? 'આવક' : 'Inflows'}: ₹${d.inflows}`);
    lines.push(`${isGu ? 'જાવક' : 'Outflows'}: ₹${d.outflows}`);
    lines.push(`${isGu ? 'ચોખ્ખું' : 'Net'}: ₹${d.net_cash}`);
  } else if (type === 'owners_equity') {
    lines.push(isGu ? '🏠 *માલિકની મૂડી*' : '🏠 *Owner\'s equity*');
    lines.push(`Capital: ₹${d.capital_contributions}`);
    lines.push(`Drawings: ₹${d.drawings}`);
    lines.push(`Retained: ₹${d.retained_profit}`);
    lines.push(`Closing: ₹${d.closing_equity}`);
  } else if (type === 'ledger_account' || type === 'party_ledger') {
    lines.push(
      isGu
        ? `📖 *ખાતું: ${d.account?.name || ''}*`
        : `📖 *Ledger: ${d.account?.name || ''}*`
    );
    (d.rows || []).slice(0, 12).forEach((r) => {
      lines.push(
        `${r.entry_date} | ${r.narration || '-'} | Dr ${r.debit} | Cr ${r.credit}`
      );
    });
    lines.push(`Total Dr ₹${d.total_debit} | Total Cr ₹${d.total_credit}`);
  } else if (type === 'accounting_equation') {
    lines.push(isGu ? '⚖️ *હિસાબી સમીકરણ*' : '⚖️ *Accounting equation*');
    lines.push(d.equation || `${d.assets} = ${d.liabilities} + ${d.equity}`);
    lines.push(d.balanced ? 'Balanced: yes' : 'Balanced: no');
  } else {
    lines.push(JSON.stringify(d));
  }

  if (d.startDate || d.endDate || d.asOfDate) {
    lines.push(
      `Period: ${d.startDate || ''} → ${d.endDate || d.asOfDate || ''}`
    );
  }
  if (tally?.message) lines.push(tally.message);
  return lines.join('\n');
}

/**
 * formatStatementReply({ statementData, tally, language, format })
 */
async function formatStatementReply({
  statementData,
  tally,
  language = 'en',
  format = 'chat_summary',
}) {
  const apiKey = getApiKey();
  const payload = {
    statement: statementData,
    tally: tally
      ? {
          totalDebit: tally.totalDebit,
          totalCredit: tally.totalCredit,
          balanced: tally.balanced,
          message: tally.message,
        }
      : null,
    language,
    format,
  };

  if (!apiKey) {
    return fallbackFormat(statementData, tally, language, format);
  }

  try {
    const body = await withGroqKey(async (key) => {
      const res = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: FORMATTER_MODEL,
          temperature: 0,
          max_tokens: 1200,
          messages: [
            { role: 'system', content: FORMATTER_SYSTEM_PROMPT },
            {
              role: 'user',
              content:
                `Language: ${language}\nFormat: ${format}\n\n` +
                `Computed JSON (do not change numbers):\n` +
                JSON.stringify(payload),
            },
          ],
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json?.error?.message || `Formatter failed (${res.status})`);
      }
      return json;
    });

    let text = body?.choices?.[0]?.message?.content?.trim() || '';
    text = text.replace(/```[\s\S]*?```/g, '').trim();
    if (!text) {
      return fallbackFormat(statementData, tally, language, format);
    }

    // Ensure tally line is present
    if (tally?.message && !text.includes('Verified') && !text.includes('Discrepancy')) {
      text = `${text}\n${tally.message}`;
    }
    return text;
  } catch (err) {
    console.error('[formatter] failed:', err.message);
    return fallbackFormat(statementData, tally, language, format);
  }
}

function pickFormatForStatement(statementType) {
  const t = String(statementType || '');
  if (t === 'ledger_account' || t === 'party_ledger') return 'ledger_table';
  if (t === 'accounting_equation') return 'equation';
  return 'chat_summary';
}

module.exports = {
  formatStatementReply,
  pickFormatForStatement,
  FORMATTER_SYSTEM_PROMPT,
  fallbackFormat,
};
