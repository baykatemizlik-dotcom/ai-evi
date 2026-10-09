# BIST Cloud Bridge

Market data is fetched only by GitHub Actions. The Worker calls only OpenAI for
the GPT-4o-mini paper referee; provider fetching and old cron routes remain disabled.
The existing mobile dashboard and ACCESS_TOKEN sessions remain available.

## Setup

1. Apply `migrations/0010_cloud_bridge.sql` **once** to the existing D1 database.
   It preserves existing cash/trades and adds the idempotent, atomic paper triggers.
   Apply additive `migrations/0011_dynamic_funnel.sql` for risk, candidate and scan-report tables,
   then `migrations/0012_ai_referee.sql` for the idempotent AI decision cache.
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

A validated recent closed candle enables ACTIVE for that symbol. After 35 minutes
without a newly closed candle, status becomes BLOCKED again. No authenticated
provider/KAP/risk verification is claimed: `market_feed_verified=false`,
`risk_verified=false`, `orders_sent=0` always. Signals and trades are technical
paper simulations only; real broker orders are disabled; only the OpenAI paper-referee request is enabled.

## Three-stage dynamic funnel

KAP equity-market classification, company type and a strict `[A-Z0-9]{3,6}`
symbol filter exclude warrants, funds/ETFs and debt instruments. The current
snapshot contains 631 equity symbols; this is not a fixed symbol-count target.
Prepare refreshes KAP (a dated snapshot may be used for at most seven days).
The official Borsa Istanbul daily restrictions CSV is checked independently.
ALT, YAKIN IZLEME and PIYASA ONCESI markets use gross settlement and are excluded;
all currently restricted shares are excluded as well. On 2026-10-09 this leaves
530 eligible shares. An unavailable/stale risk list blocks new candidates;
existing positions still receive monitoring bars. Neither a regex nor OHLCV
patterns can prove absence of manipulation or wash trading.

1. Python partitions the eligible universe exactly once across eight Actions
   jobs. Pandas/NumPy filters each symbol's latest closed 15m bar simultaneously:
   RVOL >=2 against the **previous** 20 bars, close > open, body/range >=0.60,
   upper wick/range <=0.20. No fixed candidate count is imposed. It rejects
   off-grid timestamps and bars not closed according to both wall clock and
   Yahoo's provider timestamp. The final row is discarded only if unfinished.
2. Only hot candidates are posted with up to 100 historical closed bars for
   session VWAP. Open-position/pending-signal symbols also receive monitoring
   bars even when cold, so stops and later entries continue to work. The Worker
   rechecks stage 1, previous-20-high breakout and current-session VWAP. Freshness
   tolerance is 35 minutes from bar end. Each shard reports actual fetched
   coverage separately from the number of posted candidates.
3. After the shard jobs finish, finalize ranks fresh momentum candidates globally
   and sends the **entire eligible momentum pool** to GPT-4o-mini, without a
   candidate-count cap. Five concurrent calls throttle transport only. Only
   strict-schema `{"onay":true,"neden":"..."}` approvals create pending paper signals;
   it never fabricates trades merely to fill the two slots.

Previously imported off-grid rows are preserved for audit and excluded from
freshness, signals, entries and exits. D1 records and cash are never reset.

A signal can fill only at a subsequent bar open at or after the time it was
actually observed. The fill is recorded when that closed bar later arrives.
N+1 is usable only when its open is at or after signal observation; with delayed
Yahoo data, finalization may already be later than N+1 open, so the engine waits
for a later eligible bar. It never backdates a signal or uses future bars to
select a signal. This delayed indicative feed cannot offer real-time scalp fills.

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

Current automated suite: 13 Python and 15 Node tests, including full isolated
risk → hot ingest → selection → future entry → stop → idempotent retry flow.

## AI referee

Worker secret `OPENAI_API_KEY` must contain an actual OpenAI API key, not the
application access token. Existing secrets are inherited during deployment;
GitHub does not need this key. No search tool or additional AI provider is called.
Each symbol/bar decision is claimed and cached in D1 before the API call.
Timeout, missing key, refusal, HTTP error, malformed output or expired restrictions
blocks entry. Errors are logged without upstream response bodies or secret values.
The model receives numeric metrics and dated official restrictions, not invented
news checks. OHLCV cannot certify absence of wash trading or other sanctions.

Each request uses strict JSON schema, 200 maximum output tokens and a 12-second
timeout. API usage tokens and the approval/rejection reason are stored in
`bist_ai_decisions`. Authenticated GET `/bist/ai/decisions` shows recent decisions.
`/bist/connections` reports CONFIGURED before the first real decision; CONNECTED
requires a successful actual model reply, never just a present secret.
