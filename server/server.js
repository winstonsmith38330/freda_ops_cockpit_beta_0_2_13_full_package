// Freda Ops Cockpit Beta 0.2.13
// Render injects environment variables directly. No dotenv import required.
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parsePageTextCapture } from './src/captureParser.js';
import { readJson, writeJson, emptyLiveState, mergeLive, applySyncResult, addCapture, addWhatsapp, saveShapeMap, addCandidate, addTrainingCompletion, addAudit } from './src/store.js';
import { syncReportingSite, reportingDiagnostics } from './src/connectors/reportingSiteConnector.js';
import { syncUber, uberDiagnostics } from './src/connectors/uberConnector.js';
import { syncSquare, diagnoseSquare, squareDiagnostics } from './src/connectors/squareConnector.js';
import { syncWhatsappUpload, whatsappDiagnostics } from './src/connectors/whatsappConnector.js';
import { syncAll } from './src/services/syncService.js';
import { analyseOperations } from './src/services/operationsAnalysis.js';
import { analyseProductionMix } from './src/services/productionMix.js';
import { buildBriefing } from './src/services/briefingEngine.js';
import { normalizeReportingDate, currentDateInTimeZone } from './src/utils/dateUtils.js';
import { maskSecret } from './src/utils/safe.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads/') });
const PORT = process.env.PORT || 8787;
const DATA_PATH = path.resolve(__dirname, process.env.SEED_DATA_PATH || '../seed-data.json');
const LIVE_PATH = path.resolve(__dirname, process.env.LIVE_DATA_PATH || './data/live-snapshots.json');
const WEB_PATH = path.resolve(__dirname, '../web');

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins, credentials: true }));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

function seed() { return readJson(DATA_PATH, {}); }
function liveRaw() { return readJson(LIVE_PATH, emptyLiveState()); }
function saveLive(data) { return writeJson(LIVE_PATH, data); }
function liveMerged() {
  const live = mergeLive(seed(), liveRaw());
  const analysis = analyseOperations(live);
  const production = analyseProductionMix(live);
  const briefing = buildBriefing(live, analysis);
  return { ...live, analysis, production, briefing };
}
function reportingDateFrom(req) { return normalizeReportingDate(req.body?.reportingDate || req.query?.reportingDate || req.body?.date || req.query?.date || liveRaw().reportingDate, process.env.TIMEZONE || 'Australia/Sydney'); }

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'freda-ops-cockpit-server',
    version: '0.2.13',
    webPath: WEB_PATH,
    webIndexExists: fs.existsSync(path.join(WEB_PATH, 'index.html')),
    livePath: LIVE_PATH
  });
});

app.get('/api/config/status', (_req, res) => {
  res.json({
    ok: true,
    service: 'freda-ops-cockpit-server',
    version: '0.2.13',
    timezone: process.env.TIMEZONE || 'Australia/Sydney',
    nodeVersion: process.version,
    storage: { livePath: LIVE_PATH, prototypeJsonStorage: true, liveExists: fs.existsSync(LIVE_PATH) },
    env: {
      ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS ? 'present' : 'missing',
      REPORTING_COOKIE: maskSecret(process.env.REPORTING_COOKIE || ''),
      REPORTING_PHPSESSID: maskSecret(process.env.REPORTING_PHPSESSID || ''),
      UBER_COOKIE: maskSecret(process.env.UBER_COOKIE || ''),
      SQUARE_ACCESS_TOKEN: maskSecret(process.env.SQUARE_ACCESS_TOKEN || ''),
      SQUARE_LOCATION_ID: maskSecret(process.env.SQUARE_LOCATION_ID || ''),
      OPENAI_API_KEY: maskSecret(process.env.OPENAI_API_KEY || '')
    }
  });
});

app.get('/api/seed', (_req, res) => res.json(seed()));
app.get('/api/live/summary', (_req, res) => res.json({ ok: true, live: liveMerged(), generatedAt: new Date().toISOString() }));

app.get('/api/diagnostics/connectors', (_req, res) => {
  res.json({ ok: true, generatedAt: new Date().toISOString(), reporting: reportingDiagnostics(process.env), uber: uberDiagnostics(process.env), square: squareDiagnostics(process.env), whatsapp: whatsappDiagnostics() });
});
app.get('/api/diagnostics/reporting', (_req, res) => res.json({ ok: true, diagnostics: reportingDiagnostics(process.env) }));
app.get('/api/diagnostics/uber', (_req, res) => res.json({ ok: true, diagnostics: uberDiagnostics(process.env) }));
app.get('/api/diagnostics/square', async (_req, res) => res.json({ ok: true, diagnostics: await diagnoseSquare(process.env, fetch) }));

app.post('/api/sync/all', async (req, res) => {
  const result = await syncAll(process.env, fetch, { ...(req.body || {}), reportingDate: reportingDateFrom(req) });
  const next = applySyncResult(liveRaw(), result);
  saveLive(next);
  res.json({ ok: result.ok, result, live: liveMerged() });
});

app.post('/api/sync/pos', async (req, res) => {
  const result = await syncReportingSite(process.env, fetch, { ...(req.body || {}), reportingDate: reportingDateFrom(req) });
  const next = applySyncResult(liveRaw(), result);
  saveLive(next);
  res.json({ ok: result.ok, result, live: liveMerged() });
});

app.post('/api/sync/uber', async (req, res) => {
  const result = await syncUber(process.env, fetch, { ...(req.body || {}), reportingDate: reportingDateFrom(req) });
  const next = applySyncResult(liveRaw(), result);
  saveLive(next);
  res.json({ ok: result.ok, result, live: liveMerged() });
});

app.post('/api/sync/square', async (req, res) => {
  const result = await syncSquare(process.env, fetch, { ...(req.body || {}), reportingDate: reportingDateFrom(req) });
  const next = applySyncResult(liveRaw(), result);
  saveLive(next);
  res.json({ ok: result.ok, result, live: liveMerged() });
});

app.post('/api/sync/whatsapp', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No WhatsApp .txt/.zip file uploaded.' });
  try {
    const result = syncWhatsappUpload(req.file);
    if (!result.ok) return res.status(400).json(result);
    const next = addWhatsapp(liveRaw(), result);
    saveLive(next);
    res.json({ ok: true, result, live: liveMerged() });
  } finally {
    fs.promises.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/captures/browser', (req, res) => {
  const body = req.body || {};
  const period = normalizeReportingDate(body.period || body.reportingDate || liveRaw().reportingDate, process.env.TIMEZONE || 'Australia/Sydney');
  const parsed = parsePageTextCapture(body.source || body.url || 'browser-capture', body.text || body.pageText || '', { store: body.store || inferStore(`${body.url || ''} ${body.title || ''}`), period });
  const next = addCapture(liveRaw(), { source: body.source || 'browser-capture', store: body.store || inferStore(body.url || body.title || ''), period, url: body.url || '', title: body.title || '', parsed });
  saveLive(next);
  res.json({ ok: true, parsed, live: liveMerged(), note: 'Manual capture is emergency/diagnostic only. Normal 0.2.13 workflow is connector sync.' });
});

// Backward-compatible endpoints from earlier betas.
async function runPosSync(req, res) {
  const result = await syncReportingSite(process.env, fetch, { ...(req.body || {}), reportingDate: reportingDateFrom(req) });
  const next = applySyncResult(liveRaw(), result);
  saveLive(next);
  res.json({ ok: result.ok, result, live: liveMerged() });
}
async function runUberSync(req, res) {
  const result = await syncUber(process.env, fetch, { ...(req.body || {}), reportingDate: reportingDateFrom(req) });
  const next = applySyncResult(liveRaw(), result);
  saveLive(next);
  res.json({ ok: result.ok, result, live: liveMerged() });
}
async function runSquareSync(req, res) {
  const result = await syncSquare(process.env, fetch, { ...(req.body || {}), reportingDate: reportingDateFrom(req) });
  const next = applySyncResult(liveRaw(), result);
  saveLive(next);
  res.json({ ok: result.ok, result, live: liveMerged() });
}
app.post('/api/live/pos-ticket-sync', runPosSync);
app.post('/api/live/reporting/sync', runPosSync);
app.post('/api/live/uber/sync', runUberSync);
app.post('/api/live/square/sync', runSquareSync);
app.post('/api/bookmarklet/capture', (req, res) => {
  const body = req.body || {};
  const period = normalizeReportingDate(body.period || body.reportingDate || liveRaw().reportingDate, process.env.TIMEZONE || 'Australia/Sydney');
  const parsed = parsePageTextCapture(body.source || body.url || 'browser-capture', body.text || body.pageText || '', { store: body.store || inferStore(`${body.url || ''} ${body.title || ''}`), period });
  const next = addCapture(liveRaw(), { source: body.source || 'browser-capture', store: body.store || inferStore(body.url || body.title || ''), period, url: body.url || '', title: body.title || '', parsed });
  saveLive(next);
  res.json({ ok: true, parsed, live: liveMerged(), note: 'Manual capture is emergency/diagnostic only. Normal 0.2.13 workflow is connector sync.' });
});
app.post('/api/uploads', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });
  const lower = req.file.originalname.toLowerCase();
  try {
    if (lower.endsWith('.txt') || lower.endsWith('.zip') || lower.includes('whatsapp')) {
      const result = syncWhatsappUpload(req.file);
      if (!result.ok) return res.status(400).json(result);
      const next = addWhatsapp(liveRaw(), result);
      saveLive(next);
      return res.json({ ok: true, result, live: liveMerged() });
    }
    return res.json({ ok: true, status: 'stored', note: 'Generic upload accepted. CSV/XLSX import mapping is staged.' });
  } finally {
    fs.promises.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/production/shape-map', (req, res) => {
  const next = saveShapeMap(liveRaw(), req.body?.shapeMap || req.body || []);
  saveLive(next);
  res.json({ ok: true, live: liveMerged() });
});

app.post('/api/hiring/candidates', (req, res) => {
  const next = addCandidate(liveRaw(), req.body || {});
  saveLive(next);
  res.json({ ok: true, live: liveMerged() });
});

app.post('/api/training/completions', (req, res) => {
  const next = addTrainingCompletion(liveRaw(), req.body || {});
  saveLive(next);
  res.json({ ok: true, live: liveMerged() });
});

app.post('/api/audits', (req, res) => {
  const next = addAudit(liveRaw(), req.body || {});
  saveLive(next);
  res.json({ ok: true, live: liveMerged() });
});

app.post('/api/actions/:id/status', (req, res) => {
  const state = liveRaw();
  const id = req.params.id;
  const status = req.body?.status || 'done';
  const actions = (state.actions || []).map(a => a.id === id ? { ...a, status, updatedAt: new Date().toISOString() } : a);
  const next = { ...state, updatedAt: new Date().toISOString(), actions };
  saveLive(next);
  res.json({ ok: true, live: liveMerged() });
});

app.post('/api/assistant', (req, res) => {
  const q = String(req.body?.question || '').toLowerCase();
  const live = liveMerged();
  let answer = live.briefing?.priorities?.join(' ') || 'Sync data first, then review store actions.';
  if (q.includes('sync')) answer = connectorAnswer(live);
  if (q.includes('sell')) answer = sellOutAnswer(live);
  if (q.includes('hour')) answer = hourlyAnswer(live);
  if (q.includes('staff') || q.includes('training') || q.includes('hire')) answer = 'Biggest focus: finding the right staff and training them. Use Hiring to screen applicants, Training/SOP for sign-off, and keep admin follow-up off Freda where possible.';
  if (q.includes('production') || q.includes('ball') || q.includes('ring')) answer = productionAnswer(live);
  res.json({ ok: true, answer, liveUpdatedAt: live.updatedAt });
});

app.use(express.static(WEB_PATH, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(WEB_PATH, 'index.html')));

app.listen(PORT, () => console.log(`Freda Ops Cockpit Beta 0.2.13 running on http://localhost:${PORT}`));

function connectorAnswer(live) {
  const s = live.connectorStatus || {};
  return `POS: ${s.reportingSite?.status || 'not synced'}; Uber: ${s.uberEats?.status || 'not synced today'}; Square: ${s.square?.status || 'not synced today'}. Stale WTD/MTD values are excluded from daily totals.`;
}
function sellOutAnswer(live) {
  const rows = live.analysis?.sellOut || [];
  return rows.length ? rows.map(r => `${r.store}: ${r.status}`).join('; ') : 'No sell-out signals yet. Sync POS product/sold-out pages or upload WhatsApp stock messages.';
}
function hourlyAnswer(live) {
  const rows = live.analysis?.hourly || [];
  return rows.map(r => `${r.store}: ${r.status}${r.includesUber ? ' including Uber' : ''}`).join('; ') || 'Hourly comparison waits for POS/Uber same-day hourly rows.';
}
function productionAnswer(live) {
  const p = live.production || {};
  return `Production mix: rings ${p.totals?.ring ?? 0}, balls ${p.totals?.ball ?? 0}, longs ${p.totals?.long ?? 0}. ${p.warnings?.join(' ') || 'No shortage warning yet.'}`;
}
function inferStore(text = '') {
  const s = String(text).toLowerCase();
  if (s.includes('beverly')) return 'Beverly Hills';
  if (s.includes('penrith')) return 'Penrith';
  if (s.includes('taren')) return 'Taren Point';
  if (s.includes('frieda') || s.includes('frida') || s.includes('square')) return "Frieda's Pies";
  return '';
}
