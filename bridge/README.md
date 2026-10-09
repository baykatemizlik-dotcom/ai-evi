# BIST AVCI Data Bridge

This is the **sender**, not a market-data provider. It does not scrape Yahoo or bypass HTTP 429. Set an authorized HTTPS feed and worker token in the server environment. No real broker orders.

```sh
export BIST_FEED_URL='https://your-authorized-feed.example/api/bist/ohlcv'
export BIST_ACCESS_TOKEN='YOUR_WORKER_ACCESS_TOKEN'
export BIST_WORKER_URL='https://ai-evi.baykatemizlik.workers.dev'
python3 bridge_sender.py
```

Provision a trusted always-on server with a systemd timer or cron. Do **not** commit or paste tokens. Backend POST batches to /bist/bridge/import, storing verified-format bars in D1 without fabricating quotes. Night scan reads D1 bridge cache. Still requires source licensing, symbol/pazar verification, freshness testing, official KAP/VBTS confirmation, demo ledger and push before any approved signals.

The sender is not deployed as a running service by adding it to GitHub; server credentials and feed must exist.
