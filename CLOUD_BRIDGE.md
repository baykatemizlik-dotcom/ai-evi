# BIST Cloud Bridge

The Worker has zero outbound HTTP calls, including AI/provider/old cron routes.
The existing mobile dashboard and ACCESS_TOKEN sessions remain available.

## Setup

1. Apply `migrations/0010_cloud_bridge.sql` **once** to the existing D1 database.
   It preserves existing cash/trades and adds the idempotent, atomic paper triggers.
2. Deploy `worker/index.js` (self-contained). `worker/cloud_bridge.mjs` is its tested
   source module; it does not need a separate upload when using the dashboard editor.
3. GitHub repository Settings → Secrets and variables → Actions:
   - `BIST_INGEST_TOKEN`: same value as Worker `ACCESS_TOKEN`, or use a dedicated
     Worker secret named `BIST_INGEST_TOKEN` with the identical value in GitHub.
   - optional `TWELVE_DATA_API_KEY`: copied separately from your Twelve Data account.
     Cloudflare secrets are not automatically available to GitHub.
   - optional variable `BIST_WORKER_URL`: defaults to the current workers.dev URL.
4. Actions → BIST Cloud Bridge → Run workflow. Main-branch changes to the workflow
   or sender also trigger an immediate run. No laptop or Python installation required.

## Operation and limits

Cron: weekdays 07:00,07:15,…,15:00,15:15 UTC (10:00–18:15 TRT).
GitHub schedules can be delayed or dropped; this is a 15m paper radar, not an
execution-time SLA. Market holidays are handled by the closed-bar freshness gate.

Yahoo is an indicative, best-effort source; HTTP 429 can still occur on Actions.
No cookie/rate-limit bypass is attempted. Twelve Data XIST is documented EOD:
its fallback imports history but never enables intraday paper entries or ACTIVE.
The first 10:00 run cannot import a fully closed 10:00 candle; normally the first
current-session candle becomes usable after 10:15, depending on provider delay.

A validated recent closed candle enables ACTIVE for that symbol. After 20 minutes
without a newly closed candle, status becomes BLOCKED again. No authenticated
provider/KAP/risk verification is claimed: `market_feed_verified=false`,
`risk_verified=false`, `orders_sent=0` always. Signals and trades are technical
paper simulations only; real broker orders and AI requests are disabled.

Pilot symbols are a configured watchlist, not an assertion of today's official
index or market membership. Sender sends one symbol/request and up to 100 bars.
Each ingest uses JSON bulk SQL rather than one query per candle.

Signals: >=21 bars, RVOL >=2.5, green candle body >=0.6, breakout above the
previous 20 highs, close above session VWAP. A signal generated at ingestion
can only fill at a subsequent bar open AFTER its observation time. Thus the
first scan does not immediately buy historical prices. The paper simulation
records that next bar's open after the candle has closed and arrived.

SCALP: 2 slots, <=1250 TL each, existing 2500 TL cash, integer lots; buy +0.2%
slippage and 0.2% commission, sell -0.2% slippage and 0.2% commission.
TP +3% / SL -1.5% are NET of these costs. Both touched in the same candle:
stop first; gap stop uses the worse open. Cash and trade changes are atomic
D1 triggers. Unique entry keys, conditional OPEN→CLOSED updates and immutable
previously imported Yahoo candles prevent duplicate debits/credits on retries.

## Verification

`python3 -m unittest discover -s tests -p test_cloud_bridge.py`
`node --test tests/cloud_bridge.test.mjs`

Tests use synthetic bars in isolated temporary databases, never production data.
