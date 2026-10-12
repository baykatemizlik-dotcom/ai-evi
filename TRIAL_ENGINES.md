# Deneme 1 / Deneme 2 — isolated Yahoo paper adaptation

Feed scheduling fix: each active Actions runner polls internally every 300 seconds for a bounded 25-minute session, then dispatches only this same workflow during weekday market hours using its standard ephemeral GITHUB_TOKEN (actions:write). Existing single-concurrency group prevents overlap; the cron remains a fallback. This removes cron dependence between polls, not all runner/network handoff latency. No guaranteed hard-real-time service claim.

This installation starts the delayed source-time paper simulation at 12 October 2026 10:00 TRT. Source bars may precede installation wall time, but every event records the actual later observation time. This is explicitly delayed simulation, not a claim that orders were placed at that historical instant.

Deneme 1 descends from V4QQ (ExtraTrees + prior-session ATR); Deneme 2 from V4PT (standardized Ridge alpha20). Each has its own 25,000 TRY account in research_paper_trials. Existing SCALP/SWING tables, trigger logic, balances, cron and histories are untouched.

The two JSON models are trained on archived 180-minute unit-position labels known before 12 October 2026, not on future data or realised winner lists. References are generated from the verified historical cache. Model export matches fitted model predictions within 1e-12. Models are frozen at installation, not retrained daily: these are expressly Yahoo adapters, NOT byte-identical replicas of the historical research.

Feed: Yahoo 1-minute closed bars, fetched every five minutes by an independent Actions workflow. Yahoo delay and job latency apply. Market/source and observation timestamps are separately recorded. At least 400 stocks must cover the processing minute and breadth. Missing data is never filled synthetically; incomplete market/risk data blocks new entries. Current official eligible-risk rows are read, never mutated. Data more than 35 minutes old blocks processing. Before-installation market minutes cannot produce entries.

Signal decisions use ONLY completed earlier source bars. Exact next source-minute Open is used for delayed PAPER simulation, observed later: not an attainable real-time execution claim. Entry fill Open*1.001, commission .0004 per side, sell raw*.999, one slot, >=2 integer lots, single rolling account, full +3% TP, first -1.5% SL, stop-first, high-reset 45-active-minute idle and 17:58/next observed Open session exit. Separate cash ledger is independently reconstructed after every minute. No broker API or real order path exists.

Runtime updates use revision compare-and-swap, immutable ledger prefixes and single-workflow concurrency. Retry does not refill accounts or erase history. Old test gains are never credited. Yahoo price adjustments/provider differences, frozen models, availability and delayed execution are material differences: historical 39,033 / 37,197 results are not current paper performance or live/OOS evidence.

Build models: bridge/build_trial_models.py with --base, --atr, --cache, --output. Run tests with python3 -m unittest discover -s tests -p test_trial_paper.py. Run bridge/trial_paper.py with existing configured worker URL/ingest secret. Never expose those secrets.
