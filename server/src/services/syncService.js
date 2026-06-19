import { syncReportingSite } from '../connectors/reportingSiteConnector.js';
import { syncUber } from '../connectors/uberConnector.js';
import { syncSquare } from '../connectors/squareConnector.js';
import { normalizeReportingDate } from '../utils/dateUtils.js';

export async function syncAll(env, fetchImpl, opts = {}) {
  const reportingDate = normalizeReportingDate(opts.reportingDate || opts.date || opts.today, env.TIMEZONE || 'Australia/Sydney');
  const pos = await syncReportingSite(env, fetchImpl, { ...opts, reportingDate });
  const uber = await syncUber(env, fetchImpl, { ...opts, reportingDate });
  const square = await syncSquare(env, fetchImpl, { ...opts, reportingDate });
  return {
    ok: Boolean(pos.ok || uber.ok || square.ok),
    status: [pos, uber, square].every(r => r.ok) ? 'success' : [pos, uber, square].some(r => r.ok) ? 'partial_success' : 'not_synced',
    reportingDate,
    startedAt: pos.startedAt,
    finishedAt: new Date().toISOString(),
    pos,
    uber,
    square
  };
}
