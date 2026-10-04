'use strict';

const TIME_RANGES = Object.freeze(['7d', '1m', '3m', '6m', '1y', '3y', 'all']);
function normalizeTimeRange(value) { return TIME_RANGES.includes(value) ? value : '1m'; }

function normalizePublishedAt(value) {
  let millis;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    millis = numeric < 1e11 ? numeric * 1000 : numeric;
  } else if (typeof value === 'string') {
    const text = value.trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/);
    if (!match) return null;
    const clock = text.match(/[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (clock && (Number(clock[1]) > 23 || Number(clock[2]) > 59 || Number(clock[3] || 0) > 59)) return null;
    const [, y, m, d] = match.map(Number);
    if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
    const iso = text.length === 10 ? text + 'T00:00:00Z'
      : text.replace(' ', 'T') + (/(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? '' : 'Z');
    millis = Date.parse(iso);
  } else return null;
  if (!Number.isFinite(millis) || millis <= 0 || millis > 253402300799999) return null;
  return new Date(millis).toISOString();
}

function cutoffForRange(range, now) {
  if (range === 'all') return null;
  if (range === '7d') return now - 7 * 86400000;
  const months = { '1m': 1, '3m': 3, '6m': 6, '1y': 12, '3y': 36 }[range];
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const endOfMonth = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, endOfMonth));
  return cutoff.getTime();
}

module.exports = { TIME_RANGES, normalizeTimeRange, normalizePublishedAt, cutoffForRange };
