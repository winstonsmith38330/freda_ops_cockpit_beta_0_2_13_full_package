import { parseDashboardPage, combineHourlyRows, mergeProductRows } from '../utils/pageParsers.js';
import { cleanText, maskSecret, round2 } from '../utils/safe.js';
import { currentDateInTimeZone, dateParamVariants, normalizeReportingDate, periodMatchesSelectedDate } from '../utils/dateUtils.js';

const DEFAULT_STORES = [
  { name: 'Beverly Hills', envKey: 'REPORTING_STORE_BEVERLY_HILLS', slug: 'ladonuts_beverlyhills' },
  { name: 'Penrith', envKey: 'REPORTING_STORE_PENRITH', slug: 'ladonuts_penrith' },
  { name: 'Taren Point', envKey: 'REPORTING_STORE_TAREN_POINT', slug: 'ladonuts_tarenpoint' }
];

const DEFAULT_VIEWS = [
  'dashboard.php',
  'eod_summary.php',
  'daily_sales.php',
  'busy_hours.php',
  'product_sales.php',
  'product_sales_summary.php',
  'sold_out_date.php',
  'lineremoved.php',
  'ticket_sales.php'
];

export async function syncReportingSite(env, fetchImpl = fetch, opts = {}) {
  const selectedDate = normalizeReportingDate(opts.reportingDate || opts.date || opts.today, env.TIMEZONE || 'Australia/Sydney');
  const startedAt = new Date().toISOString();
  const result = {
    ok: false,
    status: 'failed',
    mode: 'reporting-site-dashboard-first',
    source: 'reporting.site',
    reportingDate: selectedDate,
    periodMatched: false,
    startedAt,
    finishedAt: null,
    reportingPOS: {},
    ticketRowsByStore: {},
    details: [],
    warnings: [],
    errors: [],
    diagnostics: reportingDiagnostics(env, { includeAttempts: false })
  };

  const cookieHeader = buildCookieHeader(env);
  if (!cookieHeader) {
    result.status = 'not_synced';
    result.errors.push('Missing REPORTING_COOKIE or REPORTING_PHPSESSID. Add it in Render Environment.');
    result.finishedAt = new Date().toISOString();
    return result;
  }

  const stores = DEFAULT_STORES.map(s => ({ ...s, slug: env[s.envKey] || s.slug }));
  for (const store of stores) {
    const storeResult = await syncReportingStore(env, fetchImpl, store, selectedDate, cookieHeader, opts);
    result.details.push(storeResult.detail);
    if (storeResult.metric) result.reportingPOS[store.name] = storeResult.metric;
    if (storeResult.ticketRows?.length) result.ticketRowsByStore[store.name] = storeResult.ticketRows;
  }

  const successes = Object.values(result.reportingPOS).length;
  result.ok = successes > 0;
  result.periodMatched = Object.values(result.reportingPOS).some(x => x.period === selectedDate);
  result.status = successes ? (result.details.some(d => d.status === 'partial_success') ? 'partial_success' : 'success') : 'not_synced';
  if (!successes && !result.errors.length) result.errors.push('No reporting.site KPI page returned an exact selected-date period. Stale or undated pages were rejected.');
  result.finishedAt = new Date().toISOString();
  return result;
}

export function reportingDiagnostics(env, extra = {}) {
  const views = getViews(env);
  const stores = DEFAULT_STORES.map(s => ({ name: s.name, slug: env[s.envKey] || s.slug, envKey: s.envKey }));
  return {
    source: 'reporting.site',
    baseUrl: trimSlash(env.REPORTING_BASE_URL || 'https://reporting.site'),
    reportingCookie: maskSecret(env.REPORTING_COOKIE || ''),
    phpSessionId: maskSecret(env.REPORTING_PHPSESSID || ''),
    legacyEmailEnvPresent: Boolean(env.REPORTING_EMAIL),
    legacyPasswordEnvPresent: Boolean(env.REPORTING_PASSWORD),
    timezone: env.TIMEZONE || 'Australia/Sydney',
    browserFallbackEnabled: String(env.ENABLE_BROWSER_SYNC || '').toLowerCase() === 'true',
    views,
    stores,
    ...extra
  };
}

async function syncReportingStore(env, fetchImpl, store, selectedDate, cookieHeader, opts) {
  const detail = {
    store: store.name,
    slug: store.slug,
    status: 'failed',
    ok: false,
    sourcePagesUsed: [],
    attemptedUrls: [],
    periodChecks: [],
    metricsFound: 0,
    hourlyRows: 0,
    productRows: 0,
    warnings: [],
    errors: []
  };
  const parsedPages = [];
  const views = getViews(env).filter(v => v !== 'script.php');
  for (const view of views) {
    try {
      const page = await fetchViewWithDate(env, fetchImpl, store, view, selectedDate, cookieHeader, detail);
      if (!page) continue;
      parsedPages.push(page);
      if (page.accepted) detail.sourcePagesUsed.push(view);
    } catch (err) {
      detail.errors.push(`${view}: ${err.message || err}`);
    }
  }

  // Browser fallback exists as automatic fallback, but only runs when enabled because it is heavier.
  if (!parsedPages.some(p => p.accepted) && String(env.ENABLE_BROWSER_SYNC || '').toLowerCase() === 'true') {
    const browserPage = await tryBrowserFallback(env, store, selectedDate, cookieHeader, detail).catch(err => ({ error: String(err?.message || err) }));
    if (browserPage?.parsed) {
      parsedPages.push(browserPage.parsed);
      if (browserPage.parsed.accepted) detail.sourcePagesUsed.push(browserPage.parsed.sourcePage || 'browser-render');
    } else if (browserPage?.error) {
      detail.warnings.push(`Browser fallback unavailable: ${browserPage.error}`);
    }
  }

  const accepted = parsedPages.filter(p => p.accepted);
  const metric = buildStoreMetric(store, selectedDate, accepted);
  detail.metricsFound = accepted.filter(p => p.parsed?.metrics?.sales != null || p.parsed?.metrics?.orders != null).length;
  detail.hourlyRows = metric?.hourlyRows?.length || 0;
  detail.productRows = metric?.productRows?.length || 0;

  // Ticket rows are optional enrichment. Never fail the store because ticket rows fail.
  const ticket = await tryTicketEnrichment(env, fetchImpl, store, selectedDate, cookieHeader, detail).catch(err => ({ rows: [], error: String(err?.message || err) }));
  if (ticket?.error) detail.warnings.push(`Ticket enrichment skipped: ${ticket.error}`);

  if (metric) {
    detail.ok = true;
    detail.status = ticket?.rows?.length ? 'success' : 'partial_success';
    if (!ticket?.rows?.length) detail.warnings.push('Dashboard/eod/daily KPI pages parsed. Ticket rows unavailable; POS marked partial success, not failed.');
    metric.status = detail.status;
    metric.warnings = [...new Set([...(metric.warnings || []), ...detail.warnings])];
    return { detail, metric, ticketRows: ticket?.rows || [] };
  }

  detail.status = 'not_synced';
  if (!detail.errors.length) detail.errors.push(`No exact selected-date POS KPI page accepted for ${selectedDate}.`);
  return { detail, metric: null, ticketRows: [] };
}

async function fetchViewWithDate(env, fetchImpl, store, view, selectedDate, cookieHeader, detail) {
  const base = trimSlash(env.REPORTING_BASE_URL || 'https://reporting.site');
  const baseUrl = `${base}/${store.slug}/dashboard/${view}`;
  const attempts = buildUrlAttempts(baseUrl, selectedDate);
  for (const url of attempts.slice(0, Number(env.REPORTING_MAX_DATE_ATTEMPTS || 20))) {
    const cleanUrl = scrubUrl(url);
    detail.attemptedUrls.push(cleanUrl);
    const response = await fetchText(fetchImpl, url, cookieHeader, Number(env.REPORTING_SYNC_TIMEOUT_MS || 15000));
    const parsed = parseDashboardPage(response.text, { sourcePage: view });
    const accepted = periodMatchesSelectedDate(parsed.period, selectedDate);
    const hasData = Boolean(parsed.metrics?.sales != null || parsed.metrics?.orders != null || parsed.hourlyRows?.length || parsed.productRows?.length);
    const periodSource = parsed.textPeriod?.start ? 'page-text' : parsed.inputPeriod?.start ? 'date-inputs' : 'none';
    detail.periodChecks.push({ view, url: cleanUrl, status: response.status, finalUrl: scrubUrl(response.finalUrl || url), period: parsed.period, periodSource, accepted, hasData });
    if (response.looksUnauthenticated) throw new Error('Authentication failed or login page returned. Refresh REPORTING_COOKIE / REPORTING_PHPSESSID.');
    if (accepted && hasData) return { sourcePage: view, url: cleanUrl, parsed, accepted: true };
  }
  return null;
}

function buildStoreMetric(store, selectedDate, acceptedPages = []) {
  if (!acceptedPages.length) return null;
  const allMetrics = acceptedPages.map(p => p.parsed.metrics || {});
  const sales = firstNumber(allMetrics, ['sales', 'totalSales', 'netSales']);
  const orders = firstNumber(allMetrics, ['orders', 'transactions']);
  const aov = firstNumber(allMetrics, ['aov']) ?? (sales != null && orders ? round2(sales / orders) : null);
  const hourlyRows = combineHourlyRows(acceptedPages.flatMap(p => p.parsed.hourlyRows || []));
  const productRows = mergeProductRows(acceptedPages.flatMap(p => p.parsed.productRows || [])).slice(0, 50);
  return {
    store: store.name,
    source: 'reporting.site-dashboard-pages',
    period: selectedDate,
    periodLabel: 'POS Today from reporting.site dashboard/eod/daily pages',
    totalSales: sales,
    netSales: sales,
    sales,
    orders,
    transactions: orders,
    aov,
    topProduct: productRows[0]?.product || null,
    topCategory: productRows[0]?.category || null,
    hourlyRows,
    productRows,
    categoryRows: categoryRows(productRows),
    sellOutSignals: buildSellOutSignals(productRows, hourlyRows),
    leftoverSignals: [],
    sourcePagesUsed: acceptedPages.map(p => p.sourcePage),
    sourceUrls: acceptedPages.map(p => p.url),
    capturedAt: new Date().toISOString(),
    warnings: []
  };
}

async function tryTicketEnrichment(env, fetchImpl, store, selectedDate, cookieHeader, detail) {
  if (String(env.REPORTING_DISABLE_TICKET_ENRICHMENT || '').toLowerCase() === 'true') return { rows: [] };
  const base = trimSlash(env.REPORTING_BASE_URL || 'https://reporting.site');
  const url = `${base}/${store.slug}/dashboard/ticket_sales.php`;
  detail.attemptedUrls.push(scrubUrl(url));
  const response = await fetchText(fetchImpl, url, cookieHeader, Number(env.REPORTING_SYNC_TIMEOUT_MS || 15000));
  const parsed = parseDashboardPage(response.text, { sourcePage: 'ticket_sales.php' });
  if (!periodMatchesSelectedDate(parsed.period, selectedDate)) return { rows: [], error: 'ticket_sales.php did not show the selected reporting date.' };
  return { rows: [] };
}

async function tryBrowserFallback(env, store, selectedDate, cookieHeader, detail) {
  let chromium;
  try {
    const mod = await import('playwright');
    chromium = mod.chromium;
  } catch (_err) {
    return { error: 'Playwright package/browser is not installed. Server fetch diagnostics still ran.' };
  }
  const headless = String(env.PLAYWRIGHT_HEADLESS || 'true').toLowerCase() !== 'false';
  const base = trimSlash(env.REPORTING_BASE_URL || 'https://reporting.site');
  const url = `${base}/${store.slug}/dashboard/dashboard.php`;
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({ extraHTTPHeaders: { cookie: cookieHeader, 'user-agent': userAgent() } });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(env.BROWSER_SYNC_TIMEOUT_MS || 30000) });
    const dateSelectors = ['input[type="date"]', 'input[name*="date" i]', 'input[id*="date" i]', 'input[name*="from" i]', 'input[name*="start" i]'];
    for (const sel of dateSelectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) await el.fill(selectedDate).catch(() => {});
    }
    const apply = await page.getByText(/apply|filter|search|go|show|appliquer|filtrer/i).first().catch(() => null);
    if (apply) await apply.click().catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    const html = await page.content();
    const parsed = parseDashboardPage(html, { sourcePage: 'browser-render-dashboard.php' });
    parsed.accepted = periodMatchesSelectedDate(parsed.period, selectedDate);
    detail.attemptedUrls.push(`${scrubUrl(url)}#browser-render`);
    return { parsed };
  } finally {
    await browser.close().catch(() => {});
  }
}

function buildUrlAttempts(baseUrl, selectedDate) {
  const urls = [baseUrl];
  for (const params of dateParamVariants(selectedDate)) {
    const u = new URL(baseUrl);
    for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
    urls.push(u.toString());
  }
  return [...new Set(urls)];
}

async function fetchText(fetchImpl, url, cookieHeader, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        cookie: cookieHeader,
        accept: 'text/html,application/xhtml+xml,application/json,text/plain,*/*',
        'accept-language': 'en-AU,en;q=0.9,fr-FR;q=0.7,fr;q=0.6',
        'user-agent': userAgent(),
        referer: url
      },
      redirect: 'follow',
      signal: controller.signal
    });
    const text = await res.text();
    const lower = text.slice(0, 1200).toLowerCase();
    const looksUnauthenticated = res.url?.toLowerCase().includes('login') || (lower.includes('password') && lower.includes('login'));
    return { ok: res.ok, status: res.status, finalUrl: res.url, text, looksUnauthenticated };
  } finally {
    clearTimeout(timer);
  }
}

function buildCookieHeader(env) {
  const raw = String(env.REPORTING_COOKIE || '').trim();
  const sid = String(env.REPORTING_PHPSESSID || '').trim();
  const parts = [];

  // REPORTING_COOKIE should usually be the full raw Cookie header.
  // If the user accidentally pastes only the 32-char PHPSESSID into REPORTING_COOKIE,
  // turn it into a valid cookie instead of sending a valueless cookie fragment.
  if (raw) {
    if (raw.includes('=')) parts.push(raw);
    else parts.push(`PHPSESSID=${raw}`);
  }
  if (sid && !parts.some(p => /PHPSESSID=/i.test(p))) parts.push(`PHPSESSID=${sid}`);
  return parts.filter(Boolean).join('; ');
}

function getViews(env) {
  const raw = String(env.REPORTING_VIEWS || '').trim();
  return raw ? raw.split(',').map(x => x.trim()).filter(Boolean) : DEFAULT_VIEWS;
}

function firstNumber(objects = [], keys = []) {
  for (const obj of objects) for (const key of keys) if (Number.isFinite(obj?.[key])) return obj[key];
  return null;
}

function categoryRows(productRows = []) {
  const map = new Map();
  for (const row of productRows) {
    const key = row.category || 'Other';
    const existing = map.get(key) || { category: key, qty: 0, sales: 0 };
    existing.qty += Number(row.qty) || 0;
    existing.sales = round2((existing.sales || 0) + (Number(row.sales) || 0));
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => (b.sales || b.qty || 0) - (a.sales || a.qty || 0));
}

function buildSellOutSignals(productRows = [], hourlyRows = []) {
  const lateHours = hourlyRows.filter(r => Number(String(r.hour).slice(0, 2)) >= 15 && Number(r.sales) <= 0);
  const highDemand = productRows.slice(0, 8).map(r => ({ product: r.product, signal: 'high-demand-product-watch', lastSale: null, qty: r.qty }));
  if (lateHours.length) highDemand.unshift({ product: 'Cabinet / category', signal: 'possible-early-sell-out-or-quiet-late-trade', lastSale: lateHours[0].hour });
  return highDemand.slice(0, 10);
}

function trimSlash(v) { return String(v || '').replace(/\/+$/, ''); }
function scrubUrl(url) { try { const u = new URL(url); return `${u.origin}${u.pathname}${u.search}`; } catch { return cleanText(url); } }
function userAgent() { return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FredaOpsCockpit/0.2.13'; }
