const state = {
  activeTab: localStorage.getItem('freda.tab') || 'today',
  role: 'Freda / Owner',
  live: null,
  config: null,
  reportingDate: localStorage.getItem('freda.reportingDate') || '',
  deferredPrompt: null
};

const tabs = [
  ['today', 'Today'],
  ['sales', 'Live Sales / Ops'],
  ['sync', 'POS / Uber / Square Sync'],
  ['hourly', 'Hourly Analysis'],
  ['production', 'Production'],
  ['hiring', 'Hiring'],
  ['training', 'Training'],
  ['audits', 'Store Audits'],
  ['whatsapp', 'WhatsApp'],
  ['ask', 'Ask AI']
];

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
const money = n => n == null || Number.isNaN(Number(n)) ? '—' : '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 });
const num = n => n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toLocaleString('en-AU');
const selectedDate = () => state.reportingDate || state.live?.reportingDate || new Date().toISOString().slice(0, 10);
const sourceSales = m => m?.sales ?? m?.totalSales ?? m?.netSales ?? null;

window.addEventListener('beforeinstallprompt', ev => { ev.preventDefault(); state.deferredPrompt = ev; $('#installBtn').hidden = false; });
$('#installBtn').addEventListener('click', async () => { if (state.deferredPrompt) await state.deferredPrompt.prompt(); state.deferredPrompt = null; $('#installBtn').hidden = true; });
$('#roleSelect').addEventListener('change', ev => { state.role = ev.target.value; render(); });

init();

async function init() {
  renderTabs();
  await Promise.all([loadLive(), loadConfig()]);
  render();
}

async function loadConfig() {
  try { state.config = await (await fetch('/api/config/status', { cache: 'no-store' })).json(); } catch { state.config = null; }
}
async function loadLive() {
  try {
    const data = await (await fetch('/api/live/summary', { cache: 'no-store' })).json();
    state.live = data.live;
    if (!state.reportingDate) state.reportingDate = state.live.reportingDate;
    $('#syncStatus').textContent = 'Live server connected';
  } catch (err) {
    $('#syncStatus').textContent = 'Offline / seed fallback';
    state.live = { stores: [], reportingDate: selectedDate(), analysis: {}, production: {}, briefing: { priorities: ['Server not connected.'] } };
  }
}

function renderTabs() {
  $('#tabs').innerHTML = tabs.map(([id, label]) => `<button class="tab ${state.activeTab === id ? 'active' : ''}" data-tab="${id}">${label}</button>`).join('');
  $('#tabs').onclick = ev => {
    const btn = ev.target.closest('[data-tab]');
    if (!btn) return;
    state.activeTab = btn.dataset.tab;
    localStorage.setItem('freda.tab', state.activeTab);
    renderTabs(); render();
  };
}

function render() {
  if (!state.live) return;
  const map = { today: renderToday, sales: renderSales, sync: renderSync, hourly: renderHourly, production: renderProduction, hiring: renderHiring, training: renderTraining, audits: renderAudits, whatsapp: renderWhatsapp, ask: renderAsk };
  $('#screen').innerHTML = (map[state.activeTab] || renderToday)();
  bindScreen();
}

function dateControls() {
  return `<div class="date-controls"><label>Reporting date</label><input id="reportingDateInput" type="date" value="${esc(selectedDate())}"><button class="secondary" data-action="set-date">Use date</button><span class="small">Daily cards accept only exact selected-date data.</span></div>`;
}

function renderToday() {
  const b = state.live.briefing || {};
  const actions = state.live.analysis?.openActions || [];
  return `<section class="card">
    <div class="pills"><span class="pill">Beta 0.2.13</span><span class="pill">${esc(state.role)}</span><span class="pill">Dashboard-first sync</span></div>
    <h2>${esc(b.title || 'Today')}</h2>${dateControls()}
    <div class="notice"><b>${esc(b.statusLine || 'Sync today’s data first.')}</b></div>
    <div class="grid grid-2">${(b.priorities || []).map(p => `<div class="kpi"><div class="label">Priority</div><div>${esc(p)}</div></div>`).join('')}</div>
  </section>
  ${storeStatusCards()}
  <section class="card"><h2>Open actions</h2>${actionList(actions)}</section>`;
}

function storeStatusCards() {
  const rows = state.live.analysis?.storeStatus || [];
  return `<section class="card"><h2>Store status</h2><div class="grid grid-2">${rows.map(s => `<div class="store-card"><div class="store-head"><h3>${esc(s.store)}</h3><span class="status ${esc(s.status)}">${esc(s.status)}</span></div><div class="grid grid-3"><div class="kpi"><div class="label">POS</div><div class="value">${money(s.posSales)}</div></div><div class="kpi"><div class="label">${esc(s.externalLabel || 'External')}</div><div class="value">${s.externalSales == null ? 'Not synced' : money(s.externalSales)}</div></div><div class="kpi"><div class="label">Total</div><div class="value">${money(s.total)}</div></div></div><p class="small">${esc((s.warnings || []).join(' ') || 'No warnings.')}</p></div>`).join('')}</div></section>`;
}

function renderSales() {
  return `<section class="card"><h2>Live Sales / Ops</h2>${dateControls()}<p>POS + Uber combined totals are shown only when each source period equals ${esc(selectedDate())}. Square is separate for Frieda’s Pies.</p><div class="actions"><button class="primary" data-action="sync-all">Sync all</button><button class="secondary" data-action="sync-pos">Sync POS</button><button class="secondary" data-action="sync-uber">Sync Uber</button><button class="secondary" data-action="sync-square">Sync Square</button><button class="ghost" data-action="refresh">Refresh</button></div></section>${storeSalesCards()}${staleWarnings()}`;
}

function storeSalesCards() {
  return `<section class="card"><h2>Daily captured totals</h2>${(state.live.stores || []).map(store => {
    const pos = state.live.reportingPOS?.[store.name] || {};
    const uber = state.live.uberEats?.[store.name] || null;
    const square = state.live.square?.[store.name] || null;
    const isPie = store.name.includes('Frieda');
    const ext = isPie ? square : uber;
    const extLabel = isPie ? 'Square' : 'Uber';
    const posValue = sourceSales(pos);
    const extValue = ext?.period === selectedDate() ? sourceSales(ext) : null;
    const total = (posValue || 0) + (extValue || 0);
    return `<div class="store-card"><div class="store-head"><h3>${esc(store.name)}</h3><span class="status ${posValue ? 'Green' : 'Amber'}">${posValue ? 'Live' : 'Waiting'}</span></div><div class="grid grid-3"><div class="kpi"><div class="label">POS Today</div><div class="value">${money(posValue)}</div></div><div class="kpi"><div class="label">${extLabel} Today</div><div class="value">${extValue == null ? 'Not synced today' : money(extValue)}</div></div><div class="kpi"><div class="label">Daily total</div><div class="value">${total ? money(total) : '—'}</div></div></div><p class="small">Orders ${num(pos.orders || ext?.orders)} · AOV ${money(pos.aov || ext?.aov)} · Source pages: ${esc((pos.sourcePagesUsed || []).join(', ') || pos.source || 'not synced')}</p></div>`;
  }).join('')}</section>`;
}

function staleWarnings() {
  const staleUber = Object.entries(state.live.staleExternalSources?.uberEats || {});
  const staleSquare = Object.entries(state.live.staleExternalSources?.square || {});
  if (!staleUber.length && !staleSquare.length) return '';
  return `<section class="card"><h2>Stale external values excluded</h2>${[...staleUber.map(([k,v]) => ['Uber',k,v]), ...staleSquare.map(([k,v]) => ['Square',k,v])].map(([kind, store, v]) => `<div class="notice"><b>${kind} · ${esc(store)}</b><br>${esc(v.reason || 'Excluded because period does not match selected date.')} Reference: ${money(v.sales)} ${esc(v.periodLabel || v.period || '')}</div>`).join('')}</section>`;
}

function renderSync() {
  const s = state.live.connectorStatus || {};
  return `<section class="card"><h2>POS / Uber / Square Sync</h2>${dateControls()}<p>0.2.13 attempts reporting.site dashboard/eod/daily/busy/product/sold-out pages before ticket rows. Ticket failure becomes partial success when KPI pages parse.</p><div class="actions"><button class="primary" data-action="sync-all">Sync all</button><button class="secondary" data-action="sync-pos">Sync POS</button><button class="secondary" data-action="sync-uber">Sync Uber</button><button class="secondary" data-action="sync-square">Sync Square</button><button class="ghost" data-action="diagnostics">Refresh diagnostics</button></div></section><section class="card"><h2>Connector status</h2>${statusTable(s)}</section><section class="card"><h2>Environment status</h2>${envStatus()}</section><section class="card"><h2>Last sync runs</h2>${syncRuns()}</section>`;
}

function statusTable(status) {
  const rows = [['POS reporting.site', status.reportingSite], ['Uber Eats', status.uberEats], ['Square', status.square]];
  return `<table class="table"><thead><tr><th>Source</th><th>Status</th><th>Period</th><th>Last sync</th><th>Error</th></tr></thead><tbody>${rows.map(([name, s]) => `<tr><td>${name}</td><td>${esc(s?.status || 'not synced')}</td><td>${esc(s?.reportingDate || selectedDate())}</td><td>${esc(s?.lastSync || '—')}</td><td>${esc(s?.error || (s?.warnings || []).join(' | ') || '—')}</td></tr>`).join('')}</tbody></table>`;
}
function envStatus() {
  const e = state.config?.env || {};
  return `<table class="table"><tbody>${Object.entries(e).map(([k,v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'object' ? (v.present ? `present · length ${v.length} · ${v.preview || ''}` : 'missing') : v)}</td></tr>`).join('')}</tbody></table>`;
}
function syncRuns() {
  const rows = state.live.syncRuns || [];
  return rows.length ? `<table class="table"><thead><tr><th>Time</th><th>Source</th><th>Status</th><th>Errors</th></tr></thead><tbody>${rows.slice(0,15).map(r => `<tr><td>${esc(r.finishedAt || r.startedAt)}</td><td>${esc(r.source)}</td><td>${esc(r.status || (r.ok?'ok':'failed'))}</td><td>${esc((r.errors || []).join(' | ') || '—')}</td></tr>`).join('')}</tbody></table>` : '<p>No sync runs yet.</p>';
}

function renderHourly() {
  const rows = state.live.analysis?.hourly || [];
  return `<section class="card"><h2>Hourly Analysis</h2>${dateControls()}<p>Compares today vs same day last week and 4-week average. Uber is included when same-day Uber hourly data is synced.</p></section>${rows.map(storeHourly).join('')}`;
}
function storeHourly(h) {
  return `<section class="card"><h2>${esc(h.store)} ${h.includesUber ? '· includes Uber' : ''}</h2>${h.rows?.length ? `<table class="table"><thead><tr><th>Hour</th><th>Today</th><th>Last week</th><th>4-week avg</th><th>Δ LW</th><th>Δ 4W</th></tr></thead><tbody>${h.rows.map(r => `<tr><td>${esc(r.hour)}</td><td>${money(r.today)}</td><td>${money(r.sameDayLastWeek)}</td><td>${money(r.last4WeekAverage)}</td><td>${r.deltaVsLastWeekPct == null ? '—' : r.deltaVsLastWeekPct + '%'}</td><td>${r.deltaVs4WeekAvgPct == null ? '—' : r.deltaVs4WeekAvgPct + '%'}</td></tr>`).join('')}</tbody></table>` : '<p>Waiting for same-day POS/Uber hourly sync.</p>'}</section>`;
}

function renderProduction() {
  const p = state.live.production || {};
  return `<section class="card"><h2>Production mix</h2><p>Editable ring / ball / long / scroll / apple mapping. Specials default supports ball-heavy demand.</p><div class="grid grid-3"><div class="kpi"><div class="label">Rings</div><div class="value">${num(p.totals?.ring)}</div></div><div class="kpi"><div class="label">Balls</div><div class="value">${num(p.totals?.ball)}</div></div><div class="kpi"><div class="label">Ball share</div><div class="value">${p.ballShare == null ? '—' : Math.round(p.ballShare*100)+'%'}</div></div></div>${(p.warnings || []).map(w => `<div class="notice">${esc(w)}</div>`).join('')}<div class="actions"><button class="secondary" data-action="save-shape-map">Save visible shape map</button></div></section><section class="card"><h2>Shape map</h2>${shapeMapTable()}</section><section class="card"><h2>Product drivers</h2>${driverTable(p.drivers || [])}</section>`;
}
function shapeMapTable() {
  const rows = state.live.productionShapeMap || [];
  return `<table class="table"><thead><tr><th>Product/family</th><th>Ring</th><th>Ball</th><th>Long</th><th>Scroll</th><th>Apple</th></tr></thead><tbody>${rows.map((r,i) => `<tr data-shape-row="${i}"><td><input value="${esc(r.product)}" data-field="product"></td>${['ring','ball','long','scroll','apple'].map(f => `<td><input value="${esc(r[f])}" data-field="${f}" inputmode="decimal"></td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function driverTable(rows) { return rows.length ? `<table class="table"><thead><tr><th>Product</th><th>Qty</th><th>Ring</th><th>Ball</th></tr></thead><tbody>${rows.map(r => `<tr><td>${esc(r.product)}</td><td>${num(r.qty)}</td><td>${num(r.ring)}</td><td>${num(r.ball)}</td></tr>`).join('')}</tbody></table>` : '<p>Sync product sales first.</p>'; }

function renderHiring() {
  const candidates = state.live.candidates || [];
  return `<section class="card"><h2>AI Hiring Assistant</h2><p>Screen candidates for availability, reliability, customer attitude, experience and communication.</p><div class="form-row"><input id="candName" placeholder="Candidate name"><input id="candStore" placeholder="Preferred store"></div><div class="form-row"><input id="candAvailability" placeholder="Availability"><input id="candTransport" placeholder="Transport / distance"></div><textarea id="candExperience" placeholder="Work history and answers"></textarea><div class="actions"><button class="primary" data-action="add-candidate">Score candidate</button></div></section><section class="card"><h2>Shortlist</h2>${candidateTable(candidates)}</section>`;
}
function candidateTable(rows) { return `<table class="table"><thead><tr><th>Name</th><th>Store</th><th>Score</th><th>Recommendation</th><th>Flags</th></tr></thead><tbody>${rows.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.store || '—')}</td><td>${num(c.score)}</td><td><b>${esc(c.recommendation)}</b></td><td>${esc((c.riskFlags || []).join(' | ') || 'Positive availability/transport')}</td></tr>`).join('')}</tbody></table>`; }

function renderTraining() {
  const t = state.live.training || { modules: [], completions: [] };
  return `<section class="card"><h2>AI Training Assistant</h2><p>Staff can search SOPs and managers can record practical sign-off.</p><input id="sopSearch" placeholder="Ask: How do I make a thickshake?" value=""><div class="actions"><button class="secondary" data-action="search-sop">Search SOP</button></div><div id="sopResult"></div></section><section class="card"><h2>Modules</h2>${(t.modules || []).map(m => `<div class="store-card"><h3>${esc(m.title)}</h3><ol>${(m.steps || []).map(s => `<li>${esc(s)}</li>`).join('')}</ol><button class="secondary" data-action="complete-training" data-module="${esc(m.id)}">Record sign-off</button></div>`).join('')}</section><section class="card"><h2>Completion tracking</h2>${(t.completions || []).length ? `<table class="table"><tbody>${t.completions.map(c => `<tr><td>${esc(c.staffName)}</td><td>${esc(c.moduleId)}</td><td>${esc(c.completedAt)}</td></tr>`).join('')}</tbody></table>` : '<p>No completions yet.</p>'}</section>`;
}

function renderAudits() {
  const a = state.live.audits || { records: [] };
  return `<section class="card"><h2>AI Store Standards Assistant</h2><p>Photo upload/scoring is staged; Phase 1 records opening/closing audit scores and corrective actions.</p><div class="form-row"><input id="auditStore" placeholder="Store"><select id="auditType"><option>opening</option><option>closing</option><option>manager walk</option></select></div><div class="form-row"><input id="auditZone" placeholder="Zone"><input id="auditScore" placeholder="Score 1-10" inputmode="numeric"></div><textarea id="auditComment" placeholder="Issue / corrective action"></textarea><div class="actions"><button class="primary" data-action="add-audit">Save audit</button></div></section><section class="card"><h2>Audit history</h2>${a.records?.length ? `<table class="table"><thead><tr><th>Store</th><th>Type</th><th>Zone</th><th>Score</th><th>Status</th></tr></thead><tbody>${a.records.map(r => `<tr><td>${esc(r.store)}</td><td>${esc(r.type)}</td><td>${esc(r.zone)}</td><td>${num(r.score)}</td><td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td></tr>`).join('')}</tbody></table>` : '<p>No audits yet.</p>'}</section>`;
}

function renderWhatsapp() {
  const w = state.live.whatsapp || { summaries: [], actions: [] };
  return `<section class="card"><h2>WhatsApp stock workflow</h2><p>Upload exported .txt/.zip to detect sold-out times, leftovers and stock pressure. Photo OCR is staged.</p><input id="whatsappFile" type="file"><div class="actions"><button class="primary" data-action="upload-whatsapp">Upload WhatsApp export</button></div></section><section class="card"><h2>WhatsApp actions</h2>${actionList(w.actions || [])}</section>`;
}

function renderAsk() {
  return `<section class="card"><h2>Ask AI Operations Manager</h2><p>Examples: What needs my attention today? Which store is underperforming? Are balls short? Show sell-out risk.</p><textarea id="askQuestion" placeholder="Ask Freda Ops..."></textarea><div class="actions"><button class="primary" data-action="ask-ai">Ask</button></div><div id="aiAnswer" class="notice" hidden></div></section>`;
}

function actionList(actions) { return actions?.length ? `<table class="table"><thead><tr><th>Priority</th><th>Store</th><th>Action</th><th>Owner</th></tr></thead><tbody>${actions.map(a => `<tr><td>${esc(a.priority || 'Medium')}</td><td>${esc(a.store || '')}</td><td><b>${esc(a.title || a.action || '')}</b><br><span class="small">${esc(a.body || a.reason || '')}</span></td><td>${esc(a.owner || 'Manager')}</td></tr>`).join('')}</tbody></table>` : '<p>No actions yet.</p>'; }

function bindScreen() {
  document.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', () => handleAction(btn.dataset.action, btn)));
}
async function handleAction(action, btn) {
  try {
    if (action === 'set-date') { state.reportingDate = $('#reportingDateInput').value || selectedDate(); localStorage.setItem('freda.reportingDate', state.reportingDate); await loadLive(); return render(); }
    if (action === 'refresh') { await loadLive(); await loadConfig(); return render(); }
    if (action === 'diagnostics') { await loadConfig(); return render(); }
    if (action.startsWith('sync-')) return await syncAction(action);
    if (action === 'save-shape-map') return await saveShapeMap();
    if (action === 'add-candidate') return await addCandidate();
    if (action === 'complete-training') return await postJson('/api/training/completions', { staffName: prompt('Staff name?') || 'Staff', moduleId: btn.dataset.module, score: 100, managerSignoff: true });
    if (action === 'search-sop') return searchSop();
    if (action === 'add-audit') return await addAudit();
    if (action === 'upload-whatsapp') return await uploadWhatsapp();
    if (action === 'ask-ai') return await askAi();
  } catch (err) { alert(err.message || err); }
}
async function syncAction(action) {
  $('#syncStatus').textContent = 'Sync running...';
  const route = action === 'sync-all' ? '/api/sync/all' : action === 'sync-pos' ? '/api/sync/pos' : action === 'sync-uber' ? '/api/sync/uber' : '/api/sync/square';
  const data = await postJson(route, { reportingDate: selectedDate() }, false);
  state.live = data.live;
  await loadConfig();
  $('#syncStatus').textContent = data.ok ? 'Sync updated' : 'Sync not complete';
  render();
}
async function saveShapeMap() {
  const shapeMap = [...document.querySelectorAll('[data-shape-row]')].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(i => [i.dataset.field, i.value])));
  await postJson('/api/production/shape-map', { shapeMap });
}
async function addCandidate() {
  await postJson('/api/hiring/candidates', { name: $('#candName').value, store: $('#candStore').value, availability: $('#candAvailability').value, transport: $('#candTransport').value, experience: $('#candExperience').value, answers: $('#candExperience').value });
}
function searchSop() {
  const q = ($('#sopSearch').value || '').toLowerCase();
  const mods = state.live.training?.modules || [];
  const found = mods.find(m => `${m.title} ${(m.steps||[]).join(' ')}`.toLowerCase().includes(q.replace(/[?]/g,''))) || mods[0];
  $('#sopResult').innerHTML = found ? `<div class="notice"><b>${esc(found.title)}</b><ol>${found.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>` : '<p>No SOP found.</p>';
}
async function addAudit() { await postJson('/api/audits', { store: $('#auditStore').value, type: $('#auditType').value, zone: $('#auditZone').value, score: $('#auditScore').value, comment: $('#auditComment').value }); }
async function uploadWhatsapp() {
  const file = $('#whatsappFile').files[0];
  if (!file) return alert('Choose a WhatsApp .txt/.zip export first.');
  const fd = new FormData(); fd.append('file', file);
  const res = await fetch('/api/sync/whatsapp', { method: 'POST', body: fd });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Upload failed');
  state.live = data.live; render();
}
async function askAi() {
  const data = await postJson('/api/assistant', { question: $('#askQuestion').value }, false);
  const box = $('#aiAnswer'); box.hidden = false; box.textContent = data.answer;
}
async function postJson(url, body, autoRefresh = true) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Request failed');
  if (autoRefresh && data.live) { state.live = data.live; render(); }
  return data;
}
