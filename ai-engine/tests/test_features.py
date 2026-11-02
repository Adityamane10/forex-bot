"""Feature engineering tests: correctness and strict no-lookahead."""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from app.features import compute_features_at, build_dataset, FEATURE_NAMES, sma, ema, rsi


def make_candles(n=400, start_price=1.0, drift=0.0002, vol=0.001, seed=7):
    rng = np.random.default_rng(seed)
    closes = [start_price]
    for i in range(1, n):
        closes.append(closes[-1] * (1 + drift + rng.normal(0, vol)))
    out = []
    for i, c in enumerate(closes):
        h = c * (1 + abs(rng.normal(0, vol * 0.5)))
        l = c * (1 - abs(rng.normal(0, vol * 0.5)))
        out.append({
            "symbol": "EUR/USD", "timeframe": "1h",
            "open": closes[i - 1] if i else c, "high": h, "low": l, "close": c,
            "volume": 100, "openTime": i * 3600_000, "closeTime": (i + 1) * 3600_000,
        })
    return out


def test_feature_vector_has_all_expected_names():
    candles = make_candles()
    feats = compute_features_at(candles, 250)
    for name in FEATURE_NAMES:
        assert name in feats, f"missing feature {name}"
    for name, val in feats.items():
        assert np.isfinite(val), f"non-finite {name}={val}"


def test_no_lookahead_features_ignore_future_bars():
    candles = make_candles()
    base = compute_features_at(candles, 200)
    # massively perturb the NEXT bar's values
    mutated = [dict(c) for c in candles]
    mutated[201] = {**mutated[201], "open": 999.0, "high": 1000.0, "low": 1.0, "close": 998.0}
    after = compute_features_at(mutated, 200)
    assert base == after, "features at bar 200 must not depend on bar 201"


def test_targets_use_only_future_bars():
    candles = make_candles()
    df = build_dataset(candles, horizon=12, min_index=200)
    assert len(df) > 100
    for _, row in df.iterrows():
        i = int(row["timestamp"] / 3600_000)
        future_close = candles[i + 12]["close"]
        current_close = candles[i]["close"]
        expected = 1 if (future_close - current_close) / current_close > 0.0005 else 0
        assert int(row["target"]) == expected, f"target mismatch at bar {i}"


def test_no_partial_labels():
    candles = make_candles(n=250)
    df = build_dataset(candles, horizon=12, min_index=200)
    # the last index with a full horizon is len - 1 - horizon
    max_i = 250 - 1 - 12
    timestamps = df["timestamp"].values
    assert max(timestamps) <= max_i * 3600_000


def test_sma_known_value():
    out = sma(np.array([1.0, 2.0, 3.0, 4.0, 5.0]), 3)
    assert np.isnan(out[1])
    assert out[2] == 2.0
    assert out[4] == 4.0


def test_ema_constant():
    out = ema(np.full(50, 10.0), 10)
    assert out[49] == 10.0


def test_rsi_bounds():
    values = np.array([float(i) for i in range(100, 0, -1)])
    out = rsi(values, 14)
    assert out[-1] < 30
    assert 0 <= out[-1] <= 100
