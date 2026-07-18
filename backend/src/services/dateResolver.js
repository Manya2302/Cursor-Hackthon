const dayjs = require('dayjs');

/**
 * Resolve relative date phrases to { startDate, endDate } (YYYY-MM-DD).
 * Pure code — no LLM. Uses dayjs to avoid month/year boundary bugs.
 *
 * @param {string} phrase
 * @param {Date|string|dayjs.Dayjs} [today]
 * @param {{ startDate?: string, endDate?: string }} [custom]
 */
function resolveDatePhrase(phrase, today = new Date(), custom = {}) {
  const now = dayjs(today).startOf('day');
  const key = String(phrase || 'this_month')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  let start;
  let end;

  switch (key) {
    case 'today':
      start = now;
      end = now;
      break;
    case 'this_week':
      start = now.startOf('week'); // Sunday in dayjs default
      end = now;
      break;
    case 'this_month':
      start = now.startOf('month');
      end = now.endOf('month');
      break;
    case 'last_month': {
      const lm = now.subtract(1, 'month');
      start = lm.startOf('month');
      end = lm.endOf('month');
      break;
    }
    case 'last_3_months':
      start = now.subtract(2, 'month').startOf('month');
      end = now.endOf('month');
      break;
    case 'this_year':
      start = now.startOf('year');
      end = now.endOf('year');
      break;
    case 'previous_year': {
      const py = now.subtract(1, 'year');
      start = py.startOf('year');
      end = py.endOf('year');
      break;
    }
    case 'year_to_date':
      start = now.startOf('year');
      end = now;
      break;
    case 'custom_range': {
      if (!custom.startDate || !custom.endDate) {
        throw new Error('custom_range requires startDate and endDate');
      }
      start = dayjs(custom.startDate).startOf('day');
      end = dayjs(custom.endDate).startOf('day');
      if (!start.isValid() || !end.isValid()) {
        throw new Error('Invalid custom_range dates');
      }
      if (end.isBefore(start)) {
        const tmp = start;
        start = end;
        end = tmp;
      }
      break;
    }
    default: {
      // Heuristic from free-text period strings the LLM may leave in
      if (/last\s*month|પાછલો\s*મહિનો/i.test(phrase)) {
        return resolveDatePhrase('last_month', today);
      }
      if (/this\s*week|આ\s*અઠવાડિયા/i.test(phrase)) {
        return resolveDatePhrase('this_week', today);
      }
      if (/today|આજે/i.test(phrase)) {
        return resolveDatePhrase('today', today);
      }
      if (/this\s*year|આ\s*વર્ષ/i.test(phrase)) {
        return resolveDatePhrase('this_year', today);
      }
      if (/ytd|year\s*to\s*date/i.test(phrase)) {
        return resolveDatePhrase('year_to_date', today);
      }
      // Default: this month
      start = now.startOf('month');
      end = now.endOf('month');
    }
  }

  return {
    phrase: key === 'custom_range' ? 'custom_range' : key,
    startDate: start.format('YYYY-MM-DD'),
    endDate: end.format('YYYY-MM-DD'),
  };
}

module.exports = { resolveDatePhrase };
