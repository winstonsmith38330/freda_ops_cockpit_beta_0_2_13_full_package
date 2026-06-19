import { round2 } from '../utils/safe.js';

export function analyseOperations(live = {}) {
  const reportingDate = live.reportingDate;
  const stores = live.stores || [];
  const storeStatus = stores.map(store => analyseStore(store, live, reportingDate));
  const hourly = buildHourlyComparison(live, reportingDate);
  const sellOut = buildSellOutAnalysis(live);
  const openActions = buildOpenActions(live, storeStatus, sellOut);
  return { reportingDate, storeStatus, hourly, sellOut, openActions, generatedAt: new Date().toISOString() };
}

function analyseStore(store, live, reportingDate) {
  const pos = live.reportingPOS?.[store.name] || null;
  const uber = live.uberEats?.[store.name] || null;
  const square = live.square?.[store.name] || null;
  const external = store.name.includes('Frieda') ? square : uber;
  const externalLabel = store.name.includes('Frieda') ? 'Square' : 'Uber';
  const posSales = value(pos, ['sales', 'totalSales', 'netSales']);
  const extSales = external?.period === reportingDate ? value(external, ['sales', 'totalSales', 'netSales']) : null;
  const total = round2((posSales || 0) + (extSales || 0));
  const warnings = [];
  if (!pos) warnings.push('POS not synced for selected date.');
  if (!external && !store.name.includes('Frieda')) warnings.push('Uber not synced today.');
  if (store.name.includes('Frieda') && !square) warnings.push('Square not synced today.');
  if (external && external.period !== reportingDate) warnings.push(`${externalLabel} period is stale and excluded.`);
  const status = !pos ? 'Red' : warnings.length ? 'Amber' : 'Green';
  return { store: store.name, status, posSales, externalSales: extSales, externalLabel, total, orders: pos?.orders || external?.orders || null, aov: pos?.aov || external?.aov || null, warnings };
}

export function buildHourlyComparison(live = {}, reportingDate) {
  const out = [];
  for (const store of live.stores || []) {
    const pos = live.reportingPOS?.[store.name];
    const uber = live.uberEats?.[store.name];
    const hourly = mergeHourly([...(pos?.hourlyRows || []), ...(uber?.period === reportingDate ? uber.hourlyRows || [] : [])]);
    const history = live.hourlyHistory?.[store.name] || {};
    const sameDayLastWeek = history.sameDayLastWeek || [];
    const last4WeekAverage = history.last4WeekAverage || [];
    const rows = hourly.map(row => {
      const lastWeek = sameDayLastWeek.find(x => x.hour === row.hour)?.sales ?? null;
      const avg4 = last4WeekAverage.find(x => x.hour === row.hour)?.sales ?? null;
      return { hour: row.hour, today: row.sales, sameDayLastWeek: lastWeek, last4WeekAverage: avg4, deltaVsLastWeekPct: pctDelta(row.sales, lastWeek), deltaVs4WeekAvgPct: pctDelta(row.sales, avg4) };
    });
    out.push({ store: store.name, rows, includesUber: Boolean(uber?.period === reportingDate && uber?.hourlyRows?.length), status: rows.length ? 'available' : 'waiting_for_sync' });
  }
  return out;
}

function buildSellOutAnalysis(live = {}) {
  const out = [];
  for (const [store, pos] of Object.entries(live.reportingPOS || {})) {
    const signals = pos.sellOutSignals || [];
    const leftovers = pos.leftoverSignals || [];
    const planned = live.sellOutPlans?.[store] || {};
    out.push({ store, plannedFomo: Boolean(planned.plannedFomo), expectedSellOutTime: planned.expectedSellOutTime || 'close', signals, leftovers, status: classifySellOut(signals, planned) });
  }
  return out;
}

function classifySellOut(signals = [], planned = {}) {
  if (!signals.length) return 'No signal yet';
  if (planned.plannedFomo) return 'Planned/FOMO sell-out watch';
  const early = signals.find(s => /early|short|sell-out/i.test(s.signal || ''));
  return early ? 'Operational sell-out risk' : 'Watch';
}

function buildOpenActions(live, storeStatus, sellOut) {
  const items = [];
  for (const s of storeStatus) {
    if (s.status !== 'Green') items.push({ owner: 'Ops', store: s.store, priority: s.status === 'Red' ? 'High' : 'Medium', title: `${s.store}: fix sync/data gap`, body: s.warnings.join(' ') });
  }
  for (const s of sellOut) if (s.status.includes('Operational')) items.push({ owner: 'Manager', store: s.store, priority: 'High', title: `${s.store}: early sell-out risk`, body: 'Increase or re-balance production before the same day next week.' });
  items.push({ owner: 'Freda/Admin', store: 'All stores', priority: 'High', title: 'Hiring and training remains the biggest focus', body: 'Use candidate shortlist, SOP training and manager sign-off before adding more load to Freda.' });
  return items.slice(0, 12);
}

function mergeHourly(rows = []) {
  const map = new Map();
  for (const r of rows) {
    if (!r.hour) continue;
    const e = map.get(r.hour) || { hour: r.hour, sales: 0, orders: 0 };
    e.sales = round2((e.sales || 0) + (Number(r.sales) || 0));
    e.orders += Number(r.orders) || 0;
    map.set(r.hour, e);
  }
  return [...map.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}
function value(obj, keys) { for (const k of keys) if (Number.isFinite(obj?.[k])) return obj[k]; return null; }
function pctDelta(today, base) { return base ? round2(((today - base) / base) * 100) : null; }
