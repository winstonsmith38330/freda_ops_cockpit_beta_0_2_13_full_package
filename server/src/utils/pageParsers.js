import * as cheerio from 'cheerio';
import { cleanText, moneyToNumber, numberOrNull, round2 } from './safe.js';
import { extractPeriodFromText, extractDatesFromText, hourFromTimestamp, parseDisplayDate } from './dateUtils.js';

const SALES_LABELS = ['sales', 'ventes', 'revenue', 'turnover', 'total sales', 'net sales', 'total encaissé', 'ventes nettes'];
const ORDER_LABELS = ['orders', 'commandes', 'tickets', 'transactions', 'receipts', 'transactions finalisées'];
const AOV_LABELS = ['aov', 'average order', 'coût moyen', 'average spend', 'panier moyen'];

export function htmlToTextAndTables(html = '') {
  const $ = cheerio.load(String(html || ''));
  $('script,style,noscript,svg').remove();
  const title = cleanText($('title').first().text());
  const bodyText = cleanText($('body').text() || $.root().text());
  const tables = [];
  $('table').each((_i, table) => {
    const rows = [];
    $(table).find('tr').each((_j, tr) => {
      const cells = [];
      $(tr).find('th,td').each((_k, td) => cells.push(cleanText($(td).text())));
      if (cells.some(Boolean)) rows.push(cells);
    });
    if (rows.length) tables.push(rows);
  });
  const inputs = [];
  $('input,select').each((_i, el) => {
    inputs.push({ name: $(el).attr('name') || '', id: $(el).attr('id') || '', type: $(el).attr('type') || '', value: $(el).attr('value') || '' });
  });
  return { title, text: bodyText, tables, inputs };
}

export function parseKpisFromText(text = '') {
  const source = cleanText(text);
  const lower = source.toLowerCase();
  const out = { sales: null, totalSales: null, netSales: null, orders: null, transactions: null, aov: null };
  out.sales = findMoneyNearLabels(source, SALES_LABELS);
  out.totalSales = out.sales;
  out.netSales = out.sales;
  out.orders = findIntegerNearLabels(source, ORDER_LABELS);
  out.transactions = out.orders;
  out.aov = findMoneyNearLabels(source, AOV_LABELS);

  if (out.aov == null && out.sales != null && out.orders) out.aov = round2(out.sales / out.orders);

  // Fallback for card-style dashboards where labels and values are adjacent but reversed.
  const moneyValues = [...source.matchAll(/(?:A\$|AU\$|\$)\s*\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*\.\d{2}\s*(?:A\$|AU\$|\$)/gi)].map(m => moneyToNumber(m[0])).filter(Number.isFinite);
  if (out.sales == null && moneyValues.length && hasAny(lower, SALES_LABELS)) {
    out.sales = moneyValues[0]; out.totalSales = out.sales; out.netSales = out.sales;
  }
  return out;
}

export function parseDashboardPage(html = '', context = {}) {
  const { title, text, tables, inputs } = htmlToTextAndTables(html);
  const metrics = parseKpisFromText(text);
  const period = extractPeriodFromText(text);
  const inputPeriod = extractPeriodFromInputs(inputs);
  const finalPeriod = period.start ? period : inputPeriod;
  const tableRows = parseGenericTables(tables);
  const hourlyRows = [...parseHourlyFromTables(tables), ...parseHourlyFromText(text)];
  const productRows = parseProductsFromTables(tables);
  return {
    ok: Boolean(metrics.sales != null || metrics.orders != null || hourlyRows.length || productRows.length || tableRows.length),
    title,
    period: finalPeriod,
    textPeriod: period,
    inputPeriod,
    metrics,
    hourlyRows: mergeHourly(hourlyRows),
    productRows,
    tableRows,
    inputs,
    warnings: finalPeriod.start ? [] : ['No exact period/date text found in page text or date inputs. Values will not be accepted for Today unless another page confirms the date.'],
    sourcePage: context.sourcePage || ''
  };
}

export function parseSquareUiText(text = '') {
  const source = cleanText(text);
  const period = extractPeriodFromText(source);
  const metrics = parseKpisFromText(source);
  return { period, metrics };
}

export function parseUberUiText(text = '') {
  const source = cleanText(text);
  const period = extractPeriodFromText(source);
  const metrics = parseKpisFromText(source);
  const hourlyRows = parseHourlyFromText(source);
  return { period, metrics, hourlyRows };
}


function extractPeriodFromInputs(inputs = []) {
  const values = [];
  for (const input of inputs || []) {
    const name = `${input.name || ''} ${input.id || ''} ${input.type || ''}`.toLowerCase();
    const value = String(input.value || '').trim();
    if (!value) continue;
    if (/date|from|to|start|end|range|day|report/.test(name) || parseDisplayDate(value)) {
      values.push(value);
    }
  }
  const dates = [];
  for (const value of values) {
    const direct = parseDisplayDate(value);
    if (direct) dates.push(direct);
    for (const d of extractDatesFromText(value)) dates.push(d);
  }
  const uniq = [...new Set(dates)].filter(Boolean);
  if (uniq.length === 1) return { start: uniq[0], end: uniq[0], label: values.join(' | ') };
  if (uniq.length >= 2) return { start: uniq[0], end: uniq[uniq.length - 1], label: values.join(' | ') };
  return { start: '', end: '', label: '' };
}

function parseGenericTables(tables = []) {
  return tables.flatMap(rows => rows.slice(0, 80).map(row => row.map(cleanText))).filter(r => r.length > 1);
}

function parseHourlyFromTables(tables = []) {
  const out = [];
  for (const rows of tables) {
    const headers = (rows[0] || []).map(h => h.toLowerCase());
    const hourIdx = headers.findIndex(h => /hour|time|heure/.test(h));
    const salesIdx = headers.findIndex(h => /sales|vente|revenue|amount|total/.test(h));
    const ordersIdx = headers.findIndex(h => /order|commande|ticket|transaction/.test(h));
    for (const row of rows.slice(1)) {
      const hour = hourFromTimestamp(row[hourIdx] || row[0]);
      if (!hour) continue;
      const sales = moneyToNumber(row[salesIdx] || row.find(c => moneyToNumber(c) != null) || '');
      const orders = numberOrNull(row[ordersIdx] || '');
      out.push({ hour, sales: sales || 0, orders: orders || 0 });
    }
  }
  return out;
}

function parseHourlyFromText(text = '') {
  const out = [];
  const source = String(text || '').replace(/\r/g, '\n');
  const lines = source.split(/\n+/).map(cleanText).filter(Boolean);
  const lineRe = /\b(\d{1,2})(?::|h\s?)(\d{2})\b.{0,80}?(?:A\$|AU\$|\$)?\s*(-?\d[\d,]*(?:\.\d{1,2})?)/i;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (!m) continue;
    const hour = `${String(m[1]).padStart(2, '0')}:00`;
    const sales = moneyToNumber(m[3]);
    if (sales != null) out.push({ hour, sales, orders: 0 });
  }
  return out;
}

function parseProductsFromTables(tables = []) {
  const out = [];
  for (const rows of tables) {
    if (!rows.length) continue;
    const headers = rows[0].map(h => h.toLowerCase());
    const productIdx = headers.findIndex(h => /product|item|article|produit|name/.test(h));
    const qtyIdx = headers.findIndex(h => /qty|quantity|unit|quant|vendu/.test(h));
    const salesIdx = headers.findIndex(h => /sales|vente|amount|total|revenue/.test(h));
    if (productIdx < 0 && rows.length < 3) continue;
    for (const row of rows.slice(1, 120)) {
      const product = cleanText(row[productIdx >= 0 ? productIdx : 0]);
      if (!product || product.length > 80 || /total|grand total/i.test(product)) continue;
      const qty = numberOrNull(row[qtyIdx] || '');
      const sales = moneyToNumber(row[salesIdx] || row.find(c => moneyToNumber(c) != null) || '');
      if (qty == null && sales == null) continue;
      out.push({ product, qty: qty || 0, sales: sales || 0, category: inferCategory(product) });
    }
  }
  return out.sort((a, b) => (b.sales || b.qty || 0) - (a.sales || a.qty || 0)).slice(0, 50);
}

export function inferCategory(product = '') {
  const p = String(product).toLowerCase();
  if (/pie|beef|cheese|steak|sausage|mushroom|naan/.test(p)) return 'Pies';
  if (/coffee|latte|cappuccino|mocha|shake|drink|coke|water/.test(p)) return 'Beverage';
  if (/box|pack|6|12/.test(p)) return 'Boxes';
  if (/special|nutella|biscoff|oreo|brulee|cream|boston|raspberry|banana/.test(p)) return 'Filled / Specials';
  if (/glaze|homer|choc|cinnamon|fairy|caramel|passion|pineapple|m&m/.test(p)) return 'Rings';
  return 'Other';
}

function findMoneyNearLabels(source, labels) {
  const lower = source.toLowerCase();
  for (const label of labels) {
    const idx = lower.indexOf(label.toLowerCase());
    if (idx < 0) continue;
    const window = source.slice(Math.max(0, idx - 80), idx + 180);
    const money = window.match(/(?:A\$|AU\$|\$)\s*\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*\.\d{2}\s*(?:A\$|AU\$|\$)/i);
    if (money) return moneyToNumber(money[0]);
  }
  return null;
}

function findIntegerNearLabels(source, labels) {
  const lower = source.toLowerCase();
  for (const label of labels) {
    const idx = lower.indexOf(label.toLowerCase());
    if (idx < 0) continue;
    const window = source.slice(Math.max(0, idx - 80), idx + 160);
    const candidates = [...window.matchAll(/\b\d{1,6}\b/g)].map(m => Number(m[0])).filter(n => Number.isFinite(n));
    if (candidates.length) return candidates[0];
  }
  return null;
}

function hasAny(lower, labels) { return labels.some(l => lower.includes(l.toLowerCase())); }

function mergeHourly(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const hour = row.hour || hourFromTimestamp(row.time || '');
    if (!hour) continue;
    const existing = map.get(hour) || { hour, sales: 0, orders: 0 };
    existing.sales = round2((existing.sales || 0) + (Number(row.sales) || 0));
    existing.orders = (existing.orders || 0) + (Number(row.orders) || 0);
    map.set(hour, existing);
  }
  return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

export function mergeProductRows(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const key = cleanText(row.product || 'Unknown');
    const existing = map.get(key) || { product: key, qty: 0, sales: 0, category: row.category || inferCategory(key) };
    existing.qty += Number(row.qty) || 0;
    existing.sales = round2((existing.sales || 0) + (Number(row.sales) || 0));
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => (b.sales || b.qty || 0) - (a.sales || a.qty || 0));
}

export function combineHourlyRows(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const hour = row.hour || hourFromTimestamp(row.time || '');
    if (!hour) continue;
    const existing = map.get(hour) || { hour, sales: 0, orders: 0 };
    existing.sales = round2((existing.sales || 0) + (Number(row.sales) || 0));
    existing.orders += Number(row.orders) || 0;
    map.set(hour, existing);
  }
  return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

export function periodFromRow(row = {}) {
  return parseDisplayDate(row.date || row.period || row.timestamp || '');
}
