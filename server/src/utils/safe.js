export function maskSecret(value = '') {
  const text = String(value || '');
  if (!text) return { present: false, length: 0 };
  const compact = text.replace(/\s+/g, '');
  return {
    present: true,
    length: text.length,
    preview: compact.length <= 8 ? '***' : `${compact.slice(0, 3)}...${compact.slice(-3)}`
  };
}

export function boolEnv(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function round2(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  return Math.round(Number(n) * 100) / 100;
}

export function cleanText(value = '') {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function moneyToNumber(value = '') {
  const s = String(value || '').replace(/\u00a0/g, ' ');
  const m = s.match(/(?:A\$|AU\$|\$)?\s*(-?\d[\d,\s]*[.]\d{1,2}|-?\d[\d\s]*,\d{1,2}|-?\d+)/i);
  if (!m) return null;
  const raw = m[1].replace(/\s/g, '');
  if (raw.includes(',') && !raw.includes('.')) return Number(raw.replace(',', '.'));
  return Number(raw.replace(/,/g, ''));
}

export function makeId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
