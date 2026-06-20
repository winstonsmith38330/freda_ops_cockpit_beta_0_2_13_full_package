# Freda Ops Cockpit - Beta 0.2.13 Sync Hotfix

Lean Phase 1 prototype for the L.A. Donuts / Frieda's Pies AI Operations Assistant.

## What changed in 0.2.13 sync hotfix
- Removed `server/package-lock.json` so Render can install fresh public dependencies.
- Reporting cookie handling now tolerates a PHPSESSID accidentally pasted into `REPORTING_COOKIE`.
- POS page parser now reads date inputs/hidden form fields as selected-date evidence, not just visible body text.

## What changed in 0.2.13

- POS sync is now dashboard-first: `dashboard.php`, `eod_summary.php`, `daily_sales.php`, `busy_hours.php`, `product_sales.php`, `product_sales_summary.php`, `sold_out_date.php`, `lineremoved.php` are attempted before ticket enrichment.
- `ticket_sales.php` is optional enrichment. If KPI pages parse but tickets fail, POS is marked `partial_success`, not failed.
- Date validation rejects stale WTD/MTD/month values unless the parsed page/API period equals the selected reporting date.
- Uber and Square values are shown as `not synced today` unless their period matches.
- Square uses the official Square REST API first.
- Uber has diagnostics and browser/API fallback scaffolding for private Manager pages.
- Production shape map exists and is editable.
- Hiring, training, audits, WhatsApp workflow and daily briefing are visible in the app.

## Repo shape

This package is intended to be uploaded to GitHub with this root shape:

```text
server/
web/
docs/
seed-data.json
.env.example
README.md
```

Render settings for this shape:

```text
Runtime: Node
Root Directory: server
Build Command: npm install
Start Command: npm start
Health Check Path: /health
Node version: 20+
```

## Local run

```bash
cd server
npm install
npm run check
npm start
```

Open:

```text
http://localhost:8787/health
http://localhost:8787/
```

## Main endpoints

```text
GET  /health
GET  /api/config/status
GET  /api/live/summary
GET  /api/diagnostics/connectors
GET  /api/diagnostics/reporting
GET  /api/diagnostics/uber
GET  /api/diagnostics/square
POST /api/sync/all
POST /api/sync/pos
POST /api/sync/uber
POST /api/sync/square
POST /api/sync/whatsapp
POST /api/captures/browser
POST /api/assistant
```

## Security note

Never commit real `.env` values. Use Render Environment variables. Diagnostics mask secrets and show present/missing, length and short previews only.

## Prototype storage

0.2.13 uses `server/data/live-snapshots.json` as prototype JSON storage. Render's filesystem is ephemeral unless you add a Render Disk. Supabase/Postgres should replace JSON storage in the next durable build.
