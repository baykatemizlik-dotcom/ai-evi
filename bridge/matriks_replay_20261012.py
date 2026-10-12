"""Read-only, retrospective 12 Oct replay of the installed trial engines.

Uses the frozen V4QQ/V4PT model bundle and the existing trial_paper decision
and accounting functions. The Matriks history bootstrap is historical data,
not what the live Yahoo Actions runner observed on the session date.
"""
import datetime as dt
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

from trial_paper import breadth, features, model_vector, predict, reconcile, reduce_minute, stamp

DAY = dt.date(2026, 10, 12)
UTC = dt.timezone.utc


def load_bars(path, symbols):
    result = defaultdict(dict)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        for symbol, bar_time, payload in conn.execute(
            "SELECT symbol,bar_time,payload FROM bars WHERE interval='1m' "
            "AND bar_time>='2026-10-12T07:00:00' "
            "AND bar_time<'2026-10-12T15:00:00' ORDER BY bar_time,symbol"
        ):
            if symbol not in symbols:
                continue
            b = json.loads(payload)
            if b.get('closed') is not True or b.get('interval') != '1m':
                continue
            t = dt.datetime.fromisoformat(bar_time.replace('Z', '+00:00'))
            minute = int(t.timestamp() // 60) + 180
            row = [b.get(k) for k in ('open', 'high', 'low', 'close', 'volume')]
            if all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in row):
                result[symbol][minute] = row
    finally:
        conn.close()
    return dict(result)


def run(feed, allowed, bundle):
    day = int(dt.datetime(2026, 10, 12, 12, tzinfo=UTC).timestamp() // 60 + 180) // 1440
    counts = defaultdict(int)
    for bars in feed.values():
        for minute in bars:
            if minute // 1440 == day:
                counts[minute] += 1
    eligible = sorted(m for m, n in counts.items() if n >= 400)
    accounts = []
    for arm in ('V4QQ', 'V4PT'):
        model = bundle['models'][arm]
        state = dict(arm=arm, initial_cash='25000', cash='25000', equity='25000',
                     realised_pnl='0', ledger=[], open_trades=[], closed_trades=[],
                     cursor=0, candidates=0)
        diag = dict(processed_minutes=0, technical_pass=0, risk_rejected=0,
                    model_rejected=0, entry_candidates=0, missing_next_open=0)
        timeline = []
        technical_events = []
        for minute in eligible:
            ratio, width = breadth(feed, minute)
            if width < 400:
                continue
            diag['processed_minutes'] += 1
            selected = []
            for symbol, bars in feed.items():
                f = features(symbol, bars, bundle['references'][symbol], minute, ratio)
                if not f:
                    continue
                diag['technical_pass'] += 1
                if symbol not in allowed:
                    diag['risk_rejected'] += 1
                    technical_events.append(dict(at=stamp(minute), symbol=symbol,
                                                 source=f['source'], outcome='RISK_REJECTED'))
                    continue
                f = dict(f)
                if f['source'] == 'INTRADAY':
                    ref = bundle['references'][symbol]
                    vec = model_vector(f, ref, model['atr'])
                    baseline = predict(bundle['models']['V4PT'], model_vector(f, ref, False))
                    score = predict(model, vec) if vec is not None else None
                    primary = score is not None and score >= (.001 if model['atr'] else .003)
                    if model['atr']:
                        primary = bool(primary and .02 <= vec[9] <= 1 and ratio >= .4 and vec[12] >= -1)
                    if not primary and not (model['atr'] and baseline >= .003):
                        diag['model_rejected'] += 1
                        technical_events.append(dict(at=stamp(minute), symbol=symbol,
                                                     source=f['source'], outcome='MODEL_REJECTED',
                                                     score=score, baseline=baseline))
                        continue
                    f['score'] = score if primary else baseline
                technical_events.append(dict(at=stamp(minute), symbol=symbol,
                                             source=f['source'], outcome='ELIGIBLE', score=f['score']))
                selected.append(f)
            selected.sort(key=lambda f:('INTRADAY' != f['source'] if minute % 1440 != 602
                                        else f['source'] != 'OPENING_MAIN',
                                        -f['score'], -f['turnover'], f['symbol']))
            diag['entry_candidates'] += len(selected)
            diag['missing_next_open'] += sum(minute not in feed[f['symbol']] for f in selected)
            state['candidates'] += len(selected)
            reduce_minute(state, feed, minute, selected, stamp(minute))
            if minute % 15 == 0 or minute == eligible[-1]:
                timeline.append(dict(at=stamp(minute), covered_symbols=counts[minute],
                                     breadth_symbols=width, technical_pass=diag['technical_pass'],
                                     model_rejected=diag['model_rejected'],
                                     entry_candidates=diag['entry_candidates'],
                                     closed_trades=len(state['closed_trades']),
                                     open_trades=len(state['open_trades']),
                                     cash=state['cash'], equity=state['equity']))
        reconcile(state)
        accounts.append(dict(arm=arm, initial_cash=state['initial_cash'],
                             ending_cash=state['cash'], ending_equity=state['equity'],
                             realised_pnl=state['realised_pnl'],
                             trades=state['closed_trades'], open_trades=state['open_trades'],
                             diagnostics=diag, timeline=timeline,
                             technical_events=technical_events))
    return dict(date_trt=DAY.isoformat(), source='MATRIKS_HISTORY_BOOTSTRAP',
                mode='RETROSPECTIVE_PAPER_SIMULATION', model_trained_through=bundle['trained_through'],
                covered_symbols=len(feed), covered_minutes=len(counts),
                minutes_at_400_symbols=len(eligible),
                first_replay_minute=stamp(eligible[0]) if eligible else None,
                last_replay_minute=stamp(eligible[-1]) if eligible else None,
                risk_eligible_count=len(allowed), accounts=accounts,
                limitations=['Historical bars were downloaded after the session; the live bot did not observe them at these timestamps.',
                             'Matriks OHLCV differs from the Yahoo feed used to train and run the installed trial models.',
                             'Matriks history bars vary by symbol/minute; absent bars are not synthesized.',
                             'This does not rerun live GPT/Gemini decisions, SCALP/SWING, or broker orders.'])


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    feed_path = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'matriks_local/matriks_feed.sqlite'
    bundle = json.loads(Path(__file__).with_name('trial_models.json').read_text())
    feed = load_bars(feed_path, set(bundle['references']))
    risk_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(__file__).resolve().parents[1] / 'data/replay_risk_2026-10-12.json'
    allowed = set(json.loads(risk_path.read_text()))
    report = run(feed, allowed, bundle)
    target = root / 'replay_2026-10-12.json'
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(target)
    for a in report['accounts']:
        print(a['arm'], 'cash', a['ending_cash'], 'pnl', a['realised_pnl'],
              'closed', len(a['trades']), 'open', len(a['open_trades']), a['diagnostics'])
