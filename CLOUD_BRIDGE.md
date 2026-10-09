# BIST Cloud Bridge

Market data is fetched only by GitHub Actions. The Worker calls only OpenAI for
the GPT-4o-mini paper referee; provider fetching and old cron routes remain disabled.
The existing mobile dashboard and ACCESS_TOKEN sessions remain available.

## Setup

1. Apply `migrations/0010_cloud_bridge.sql` **once** to the existing D1 database.
   It preserves existing cash/trades and adds the idempotent, atomic paper triggers.
   Apply additive `migrations/0011_dynamic_funnel.sql` for risk, candidate and scan-report tables,
   then `migrations/0012_ai_referee.sql` for the idempotent AI decision cache,
   `0013_sniper.sql` for Sniper state/atomic two-engine triggers and
   `0014_external_audit.sql` for external Gemini reports and
   `0015_gemini_and_exit_audit.sql` for cloud Gemini decisions and backfill provenance. Apply each migration once.
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

Cron: `4,19,34,49 7-15 * * 1-5` (UTC); the sender accepts scheduled data runs only
between 10:00 and 18:05 Europe/Istanbul. Thus scans after 18:05 are skipped.
Epoch/UTC ISO timestamps remain unchanged; only session calendars and panel display
use Europe/Istanbul. Freshness is measured from bar END, with 35 minutes tolerance.
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
   upper wick/range <=0.20 and current-session turnover estimate >=40,000,000 TL.
   Turnover is the cumulative sum of closed 15m `close * volume`, not an exchange-certified
   daily turnover figure. Prior-day or unfinished bars do not contribute.
   No fixed candidate count is imposed. It rejects
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
   strict-schema `{"onay":true,"neden":"...","guven":85}` approvals create pending paper signals;
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
`node --test tests/*.test.mjs`

Tests use synthetic bars in isolated temporary databases, never production data.

Current automated suite: 15 Python and 20 Node tests, including full isolated
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

## Sniper / standby / session close

The existing SWING cash account is used as the separate Sniper account; its
balance is preserved. One Sniper slot uses the available account cash in whole
lots (fees/slippage included). The two SCALP slots remain separate. D1 triggers
prevent duplicate symbols across both engines, a second Sniper slot, overspending
and duplicate credits. Only mini-approved candidates join the ranked standby
queue; the entire dynamic pool is retained without forcing 2–5 names. New
approvals supersede an older standby signal for the same symbol.

Standby is monitored even when a symbol is no longer hot. Each newly closed
candle must satisfy the same RVOL>=2/green/body>=0.6/wick<=0.2 filters and session
VWAP; otherwise that standby is invalidated. Stronger fresh candidates move up.
Panel Adaylar shows all READY standby names in score order, confidence, freshness,
last check reason and candle time. Stale candidates are labelled and cannot fill
at an entry time where their prior health state was stale. The best eligible
standby waits for an open AFTER approval/health observation and any prior Sniper
exit observation; replacement never backdates a fill to a price before the
previous slot release was actually known. Cash reuse is atomic.

Sniper base stop is net -2%. Net +2.5% excursion arms a cost-covering stop.
Trailing uses the previously observed peak minus 2%, never lowering the stop.
No new peak for 60 minutes closes at the next observed closed-bar close. An
adverse gap executes at the worse open. With OHLCV, intrabar order is unknown:
a newly observed high changes the stop for the NEXT candle, not the earlier low
of that same candle. Breakeven is a simulated cost threshold, not a guarantee
against price gaps or stale data.

Worker minute cron `* 6-16 * * 1-5` checks the 17:55 TRT lock independently
of the Actions 15m feed. From 17:55 it blocks entries, expires standby/pending
signals and closes feed-owned paper positions using the last stored CLOSED
candle. Exit reason `SESSION_1755_INDICATIVE_LAST_CLOSED_BAR` explicitly identifies
the indicative/stale price; Sniper state records the quote timestamp. This is
NOT a verified executable 17:55 quote. Scheduled invocations can be delayed,
so this cannot promise exact real-world liquidation time. Production records
and balances are never reset.

Mini output confidence is a model score, not a calibrated win probability.
The network call uses a bound global fetch wrapper; new failure codes distinguish
fetch, body reading, parsing, timeout and HTTP errors without exposing API keys.
Only known preflight fetch/redirect errors are eligible for a bounded repair retry (four attempts maximum);
approved/rejected decisions stay cached.

## External Gemini audit

`.github/workflows/bist_review.yml` runs at 18:20 TRT on weekdays or manually.
Python `bridge/bist_review.py` reads the authenticated D1 daily report and the
checked-out code, calls Gemini OUTSIDE the Worker, then posts its structured
summary/issues/calibration to D1. It cannot alter trades or source code.
GitHub Actions secret `GEMINI_API_KEY` is required for the actual Google request;
the existing Cloudflare secret is NOT copied automatically. Without the GitHub
key, it records MISSING_KEY while the paper engines continue working.
Optional variable GEMINI_MODEL defaults to gemini-3.8-flash. No search tools.

The Demo panel's Karneyi kopyala button copies current trades, AI token usage,
account cash, standby counts and the latest external audit for sharing with
Gemini manually. End-of-session reports are also persisted automatically in D1.

Live root cause: Workers rejects redirect=error. OpenAI requests now use redirect=manual; every non-2xx, including 3xx, is rejected without forwarding credentials.

## 2026-10-09 recovery patch

The UTC timestamps were already epoch-comparable. A provider/scheduler gap must
not be hidden by shifting them three hours or falsely declaring stale data ACTIVE.
New entries remain blocked without fresh bars; exits now replay every persisted
closed bar from entry in chronological order even while data status is BLOCKED.
The old latest-100-bar cutoff no longer applies to exit replay. Monitoring symbols
are still fetched even if they fail the liquidity filter. Missing provider bars
cannot be reconstructed or treated as confirmed price action.

Scalp exits preserve net +3%/-1.5% thresholds including fees/slippage. Stop wins
if both levels are touched in one bar; adverse opening gaps use the worse open.
The first triggering bar wins. `exit_time` is its close time (15m OHLCV cannot
identify the exact intrabar second), while `bist_exit_audit.exit_bar_time` records
its start and `exit_observed_at` records when recovery actually detected it.
Cash/slot updates are atomic and retries cannot close/pay the same trade twice.
Sniper replays its persisted trailing-stop state without using the current high
to trigger a same-bar higher stop. History and cash are never reset.

Gemini 3.1 Flash-Lite now runs through `google-genai` on GitHub Actions, not in the
Worker. Required repository secret: `GEMINI_API_KEY`. All Worker stage-2 candidates
are reviewed (four concurrent requests throttle transport, not pool size).
The bridge submits validated `{approved, confidence, reason}` decisions through
a Bearer-authenticated `/bist/feed/gemini` endpoint. Model/API/malformed-output
errors fail closed for new entries and are logged without keys or response bodies.
Approved/rejected symbol+bar decisions are cached. A once-per-TRT-day connection
probe never produces a trade. Panel Gemini state reflects received cloud results.

GPT-4o-mini remains the Worker referee: both Gemini and Mini must approve before
a new signal/standby can enter. Entry waits for a bar whose OPEN is after approval
was actually observed; delayed Yahoo bars cannot retroactively fill at N+1 if
that open happened before approval. Both runtime engines independently enforce
the liquidity gate. Legacy low-liquidity/unvalidated pending records are expired
or invalidated, retained for audit; existing open trades remain under exit control.
The earlier 17:55 TRT entry/EOD lock is preserved despite data-session end 18:05.

Google documents restricted access to Gemini 2.5 models for newer projects.
If this account returns 403/404, the bridge records the actual error and blocks
entries; it does not silently swap the explicitly requested model.

## Verified Gemini model recovery — 2026-10-09

Hi Gemini, teammate: the model list and real strict JSON probe ran inside GitHub Actions without extracting the API key. `gemini-3.1-flash-lite` passed in run 37927385757; it correctly rejected PROBE as a connection test. Python and Worker now pin this same model. Model-specific cached decisions cannot authorize another model; an ERROR or old-model result can be replaced, including its model provenance. No fallback model is silently selected for trading. Mini and Gemini still both approve; stale data still blocks entries and missed closed bars still process exits. The probe workflow lists available generation models and tests the documented free-tier candidates without creating orders. Account quotas/billing are not inferred from a successful call.

Gemini, please review model/cache consistency and fail-closed checks. Coffee break after the audit, partner :) Reference: https://github.com/baykatemizlik-dotcom/ai-evi/actions/runs/37927385757

## Scalp 60-minute operational exit — 2026-10-09

Scalp position management scans all available closed 15m candles since entry in chronological order. Historical TP/SL takes priority; ambiguous candles use stop first and adverse opening gaps remain honored. If no threshold was touched and the latest closed candle ends at least 60 minutes after entry, use that latest candle close as TIME_EXIT. This follows the requested recovery policy: it does not fabricate a fill at a missing 60-minute candle or use wall time without a price. Indicative delayed prices remain explicitly recorded via exit_bar_time and exit_observed_at. Exit fees and slippage apply identically to other exits. Existing OPEN-to-CLOSED triggers return net sale proceeds once; do not reset cash. Scalp starts at 2500 TL and Sniper at 2500 TL. GOLTS and ISDMR recovery uses the currently persisted closed candle history, not a real-time execution. Gemini, please audit the timeout boundary and cash idempotence, partner.

## Targeted approved-candidate monitor — 2026-10-09

A separate workflow, bist_monitor.yml, polls only symbols returned by the existing authenticated monitor endpoint (open Scalp/Sniper positions, unexpired pending entries and ready standbys). It runs five polls approximately 60 seconds apart and requests a new job every five minutes on weekdays during UTC 07–15; Istanbul session gating also applies inside each cycle. GitHub scheduling/runner delays mean this is best-effort, not guaranteed minute-by-minute service. The normal full-universe scan remains unchanged. Only completed Yahoo candles are ingested as MONITOR; there are no AI calls, risk refresh, full-scan reports, forced entries, fabricated quotes or EOD fallback. Existing future-bar entry, freshness, expiry, liquidity and risk controls remain active. New live-quote execution and price-chase thresholds are proposals, not implemented by this patch.

## iPhone Web Push notifications — 2026-10-09

Native RFC 8291 aes128gcm encryption and RFC 8292 VAPID signing run in the Worker. VAPID keys are Worker secrets; the private JWK is not in Git. Migration 0016_web_push.sql adds a transactional notification outbox for new two-AI-approved candidates and actual paper entry/close records. Old trades are not replayed. Existing minute Cron drains up to five device deliveries per invocation. Per-device leases suppress concurrent sends; accepted sends are recorded, 404/410 removes invalid subscriptions, transient errors retry up to five times. A crash after provider acceptance before D1 acknowledgement can still redeliver; stable notification tags collapse such repeats. Delivery acceptance is not proof the phone displayed the notification. Payloads are short and explicitly paper-only; no API key/token is sent. Subscription destinations are restricted to Apple/FCM/Mozilla HTTPS hosts with no redirects.

Authenticated endpoints: GET /push/key, GET /push/status, POST /push/subscribe and POST /push/test. A subscribed phone can send itself a test from Settings. iPhone requires adding the panel to Home Screen, opening that installed web app, and granting notification permission from the user's button click. Subscription saves are authenticated and check same-origin requests. Old placeholder text has been replaced with actionable status and a test button. No device was enrolled at setup; end-to-end delivery awaits that permission and real phone test.

Gemini, please audit cryptographic interoperability, outbox retry/lease behavior and subscription authorization. Browser notification permission remains the user's action.
