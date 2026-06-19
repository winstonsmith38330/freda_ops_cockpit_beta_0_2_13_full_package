import fs from 'fs';
import path from 'path';
import { currentDateInTimeZone, normalizeReportingDate } from './utils/dateUtils.js';
import { makeId } from './utils/safe.js';
import { DEFAULT_SHAPE_MAP, normaliseShapeMap } from './services/productionMix.js';

export function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return clone(fallback);
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return clone(fallback);
    return JSON.parse(raw);
  } catch (err) {
    return { ...clone(fallback), readError: String(err?.message || err) };
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return value;
}

export function emptyLiveState() {
  return {
    version: '0.2.13',
    reportingDate: currentDateInTimeZone('Australia/Sydney'),
    updatedAt: null,
    reportingPOS: {},
    uberEats: {},
    square: {},
    staleExternalSources: { uberEats: {}, square: {} },
    connectorStatus: {},
    syncRuns: [],
    captures: [],
    whatsapp: { summaries: [], actions: [] },
    ticketRowsByStore: {},
    posTicketWatermarks: {},
    productionShapeMap: DEFAULT_SHAPE_MAP,
    hourlyHistory: {},
    sellOutPlans: {},
    candidates: seedCandidates(),
    training: seedTraining(),
    audits: seedAudits(),
    actions: []
  };
}

export function mergeLive(seed = {}, live = {}) {
  const reportingDate = normalizeReportingDate(live.reportingDate || seed.reportingDate, 'Australia/Sydney');
  const merged = {
    ...(seed || {}),
    liveVersion: live.version || '0.2.13',
    version: '0.2.13',
    reportingDate,
    updatedAt: live.updatedAt || seed.generatedAt || null,
    stores: seed.stores || defaultStores(),
    fredaFeedbackPriorities: seed.fredaFeedbackPriorities || [],
    reportingPOS: sameDayMap(live.reportingPOS, reportingDate),
    uberEats: sameDayMap(live.uberEats, reportingDate),
    square: sameDayMap(live.square, reportingDate),
    staleExternalSources: {
      uberEats: staleMap(live.uberEats, reportingDate),
      square: staleMap(live.square, reportingDate)
    },
    referenceExternalSources: {
      uberEats: { ...(seed.sampleMetrics?.uberEats || {}), ...staleMap(live.uberEats, reportingDate) },
      square: { ...(seed.sampleMetrics?.square || {}), ...staleMap(live.square, reportingDate) }
    },
    connectorStatus: live.connectorStatus || {},
    syncRuns: live.syncRuns || [],
    captures: live.captures || [],
    whatsapp: live.whatsapp || { summaries: [], actions: [] },
    ticketRowsByStore: live.ticketRowsByStore || {},
    posTicketWatermarks: live.posTicketWatermarks || {},
    productionShapeMap: normaliseShapeMap(live.productionShapeMap || seed.productRules?.shapeMap || DEFAULT_SHAPE_MAP),
    hourlyHistory: live.hourlyHistory || seed.hourlyHistory || {},
    sellOutPlans: live.sellOutPlans || seed.sellOutPlans || {},
    candidates: live.candidates?.length ? live.candidates : seedCandidates(),
    training: live.training || seedTraining(),
    audits: live.audits || seedAudits(),
    actions: live.actions || []
  };
  return merged;
}

export function applySyncResult(state, result) {
  let next = { ...state, version: '0.2.13', reportingDate: result.reportingDate || state.reportingDate, updatedAt: new Date().toISOString() };
  if (result.reportingPOS) next.reportingPOS = { ...(next.reportingPOS || {}), ...result.reportingPOS };
  if (result.uberEats) next.uberEats = { ...(next.uberEats || {}), ...result.uberEats };
  if (result.square) next.square = { ...(next.square || {}), ...result.square };
  if (result.ticketRowsByStore) next.ticketRowsByStore = { ...(next.ticketRowsByStore || {}), ...result.ticketRowsByStore };
  next.connectorStatus = { ...(next.connectorStatus || {}) };
  if (result.source === 'reporting.site' || result.mode?.includes('reporting')) next.connectorStatus.reportingSite = statusFromResult(result);
  if (result.source === 'Uber Eats Manager' || result.mode?.includes('uber')) next.connectorStatus.uberEats = statusFromResult(result);
  if (result.source === 'Square API' || result.mode?.includes('square')) next.connectorStatus.square = statusFromResult(result);
  if (result.pos) next = applySyncResult(next, result.pos);
  if (result.uber) next = applySyncResult(next, result.uber);
  if (result.square && result.square.source === 'Square API') next = applySyncResult(next, result.square);
  next.syncRuns = [{ id: makeId('sync'), source: result.source || result.mode || 'sync', status: result.status, ok: result.ok, reportingDate: result.reportingDate, startedAt: result.startedAt, finishedAt: result.finishedAt || new Date().toISOString(), errors: result.errors || [], warnings: result.warnings || [], details: result.details || [] }, ...(next.syncRuns || [])].slice(0, 80);
  return next;
}

export function addCapture(state, capture) {
  return { ...state, updatedAt: new Date().toISOString(), captures: [{ id: makeId('cap'), capturedAt: new Date().toISOString(), ...capture }, ...(state.captures || [])].slice(0, 100) };
}

export function addWhatsapp(state, syncResult) {
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    whatsapp: {
      summaries: [syncResult.summary, ...(state.whatsapp?.summaries || [])].filter(Boolean).slice(0, 20),
      actions: [...(syncResult.actions || []), ...(state.whatsapp?.actions || [])].slice(0, 120)
    }
  };
}

export function saveShapeMap(state, rows = []) {
  return { ...state, updatedAt: new Date().toISOString(), productionShapeMap: normaliseShapeMap(rows) };
}

export function addCandidate(state, body = {}) {
  const candidate = scoreCandidate({ id: makeId('cand'), createdAt: new Date().toISOString(), ...body });
  return { ...state, updatedAt: new Date().toISOString(), candidates: [candidate, ...(state.candidates || [])] };
}

export function addTrainingCompletion(state, body = {}) {
  const completion = { id: makeId('train'), completedAt: new Date().toISOString(), staffName: body.staffName || 'Staff', moduleId: body.moduleId || 'sop', score: Number(body.score || 0), managerSignoff: Boolean(body.managerSignoff) };
  return { ...state, updatedAt: new Date().toISOString(), training: { ...(state.training || seedTraining()), completions: [completion, ...((state.training || {}).completions || [])] } };
}

export function addAudit(state, body = {}) {
  const score = Math.max(1, Math.min(10, Number(body.score || 5)));
  const status = score >= 8 ? 'Green' : score >= 5 ? 'Amber' : 'Red';
  const audit = { id: makeId('audit'), createdAt: new Date().toISOString(), store: body.store || 'Unknown', type: body.type || 'opening', zone: body.zone || 'cabinet', score, status, comment: body.comment || 'Manager review required. AI photo scoring placeholder until vision configured.' };
  return { ...state, updatedAt: new Date().toISOString(), audits: { ...(state.audits || seedAudits()), records: [audit, ...((state.audits || {}).records || [])] } };
}

function statusFromResult(result = {}) {
  return { ok: Boolean(result.ok), status: result.status || (result.ok ? 'success' : 'failed'), mode: result.mode, source: result.source, reportingDate: result.reportingDate, periodMatched: Boolean(result.periodMatched), lastSync: result.finishedAt || new Date().toISOString(), error: (result.errors || []).join(' | ') || null, warnings: result.warnings || [], details: result.details || [] };
}

function sameDayMap(source = {}, reportingDate) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!value) continue;
    const period = normalizeReportingDate(value.period || value.reportingDate || '', 'Australia/Sydney');
    if (period === reportingDate) out[key] = value;
  }
  return out;
}

function staleMap(source = {}, reportingDate) {
  const out = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (!value) continue;
    const raw = value.period || value.reportingDate || '';
    const period = raw ? normalizeReportingDate(raw, 'Australia/Sydney') : '';
    if (period !== reportingDate) out[key] = { period: value.period || null, periodLabel: value.periodLabel || value.period || null, source: value.source || null, capturedAt: value.capturedAt || null, sales: value.sales || value.totalSales || value.netSales || null, transactions: value.transactions || value.orders || null, reason: `Ignored for daily cards because period is not ${reportingDate}` };
  }
  return out;
}

function scoreCandidate(candidate) {
  const text = `${candidate.availability || ''} ${candidate.transport || ''} ${candidate.experience || ''} ${candidate.answers || ''}`.toLowerCase();
  let score = 50;
  const flags = [];
  if (/fri|friday|sat|saturday|weekend/.test(text)) score += 20; else flags.push('Cannot confirm Friday/Saturday peak availability.');
  if (/car|drive|own transport|near|walk|bus/.test(text)) score += 15; else flags.push('Transport/distance needs checking.');
  if (/food|cafe|retail|customer|barista|kitchen/.test(text)) score += 15; else flags.push('Limited food/customer-service experience.');
  if (/quit|short|few weeks/.test(text)) { score -= 15; flags.push('Possible short-tenure risk.'); }
  const recommendation = score >= 80 ? 'Hire' : score >= 60 ? 'Maybe' : 'Pass';
  return { ...candidate, score: Math.max(0, Math.min(100, score)), recommendation, riskFlags: flags, interviewQuestions: ['Can you reliably work Friday/Saturday peaks?', 'How would you handle a customer complaint during a rush?', 'Which store can you get to fastest and how?'] };
}

function seedCandidates() { return [scoreCandidate({ id: 'sample_candidate_1', name: 'Sample strong weekend candidate', store: 'Penrith', availability: 'Friday Saturday Sunday', transport: 'Own car', experience: 'Cafe and customer service', answers: 'Likes fast-paced work' })]; }
function seedTraining() { return { modules: [
  { id: 'food-safety', title: 'Food safety and hygiene', steps: ['Wash hands before production and service.', 'Keep raw/finished areas separate.', 'Escalate any food safety concern to manager.'] },
  { id: 'cabinet', title: 'Cabinet presentation', steps: ['Keep display full and neat.', 'Group like products.', 'Face labels forward.', 'Escalate gaps before peak.'] },
  { id: 'upsell', title: 'Upsell and AOV', steps: ['Offer 6-pack or box.', 'Suggest drink combo.', 'Use one short friendly sentence.'] },
  { id: 'thickshake', title: 'Milkshake / thickshake', steps: ['Confirm flavour.', 'Use correct scoop count.', 'Blend to standard texture.', 'Wipe cup and hand over cleanly.'] }
], completions: [] }; }
function seedAudits() { return { records: [], zones: ['Cabinet and display', 'Front-of-house cleanliness', 'Production area', 'Beverage station', 'Signage and pricing'] }; }
function defaultStores() { return ['Beverly Hills', 'Penrith', 'Taren Point', "Frieda's Pies"].map(name => ({ name, status: 'Amber' })); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
