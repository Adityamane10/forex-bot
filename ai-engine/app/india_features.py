"""
Indian-market feature engineering (spec §19).

Completely separate from the Forex/Crypto feature pipeline (features.py):
Indian features are NEVER mixed with Forex features, and no Forex model is ever
used to predict Indian markets.

The feature names and the normalization bounds in this module MUST stay in sync
with backend/src/india/ml.ts (buildIndiaFeatures) — the TypeScript side computes
the vector for live prediction, this module computes it for training.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import numpy as np
import pandas as pd

FEATURE_VERSION = "india-features-v1"
INDIA_FEATURE_NAMES = [
    "close",
    "ema9minus20",
    "ema20minus50",
    "rsi14",
    "macdHistogram",
    "adx",
    "atrPct",
    "bbPosition",
    "bbWidth",
    "vwapPosition",
    "volumeRatio",
    "swingHighDistance",
    "swingLowDistance",
    "candleBody",
    "upperWick",
    "lowerWick",
    "trend",
    "volatility",
    "dayRange",
    "session",
    "regime",
    "spread",
    "timestamp",
]
TARGET = "FUTURE_DIRECTION"

IST = timezone(timedelta(hours=5, minutes=30))


def add_triple_barrier_labels(
    df: pd.DataFrame,
    horizon: int = 5,
    pt_mult: float = 1.0,
    sl_mult: float = 1.0,
) -> pd.DataFrame:
    """López de Prado triple-barrier labeling (spec §19, v2 pipeline).

    For each bar i: place a profit-take barrier at close + pt_mult*ATR, a stop
    barrier at close - sl_mult*ATR, and a vertical barrier `horizon` bars later.
    side  = +1 if the PT barrier is touched first (or close is higher at the
            vertical barrier), -1 if the SL barrier is touched first (or close
            is lower), 0 when there is no forward data.
    outcome = 1 when side == +1, else 0.

    The ATR series must already exist on `df` (column "atr") — it is computed by
    build_india_features. The returned columns are tbarSide and tbarOutcome.
    """
    n = len(df)
    side = np.zeros(n, dtype=int)
    outcome = np.zeros(n, dtype=int)
    close = df["close"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    atr = df["atr"].to_numpy(dtype=float)
    # warmup NaNs are left as NaN and skipped in the loop (dropped downstream) rather than mean-filled

    for i in range(n - 1):
        if not np.isfinite(atr[i]) or atr[i] <= 0:
            continue
        pt = close[i] + pt_mult * atr[i]
        sl = close[i] - sl_mult * atr[i]
        hit = 0
        j = i + 1
        end = min(i + 1 + horizon, n)
        while j < end:
            if high[j] >= pt:
                hit = 1
                break
            if low[j] <= sl:
                hit = -1
                break
            j += 1
        if hit == 0 and j < n:
            hit = 1 if close[j] > close[i] else (-1 if close[j] < close[i] else 0)
        side[i] = hit
        outcome[i] = 1 if hit == 1 else 0
    df = df.copy()
    df["tbarSide"] = side
    df["tbarOutcome"] = outcome
    return df


def _normalize(x: pd.Series, lo: float, hi: float) -> pd.Series:
    if hi == lo:
        return pd.Series(0.0, index=x.index)
    return (x - lo) / (hi - lo)


def _ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def _rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = gain / loss.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def _atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def _adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    tr = _atr(df, n)
    plus_di = (
        100 * plus_dm.ewm(alpha=1 / n, adjust=False).mean() / tr.replace(0, np.nan)
    )
    minus_di = (
        100 * minus_dm.ewm(alpha=1 / n, adjust=False).mean() / tr.replace(0, np.nan)
    )
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean()


def _bollinger(close: pd.Series, n: int = 20, k: float = 2.0):
    mid = close.rolling(n).mean()
    std = close.rolling(n).std()
    return mid + k * std, mid - k * std


def _session_index(open_time_ms: int) -> int:
    """IST hour bucket: 9-10->0 ... 15-16->6, else 0. Sync with TS analysis."""
    dt = datetime.fromtimestamp(open_time_ms / 1000, tz=IST)
    h = dt.hour
    if 9 <= h <= 15:
        return h - 9
    return 0


def _regime(adx: float, ema9: float, ema50: float, volatility: float) -> int:
    """0..8 market regime used by TS + training. Sync with TS analysis engine."""
    r = int(round(adx / 10.0)) if np.isfinite(adx) else 0
    if ema9 > ema50:
        r += 1
    r += int(volatility)
    return max(0, min(8, r))


def _trend_value(ema9: float, ema20: float, ema50: float, adx: float) -> int:
    if ema9 > ema20 > ema50 and adx >= 20:
        return 1
    if ema9 < ema20 < ema50 and adx >= 20:
        return -1
    return 0


def _volatility_value(bb_width: float, atr_pct: float) -> int:
    if bb_width > 0.06 or atr_pct > 0.01:
        return 2
    if bb_width < 0.03:
        return 0
    return 1


def build_india_features(
    candles: List[Dict[str, Any]],
    horizon: int = 1,
    include_triple_barrier: bool = False,
    tbar_horizon: int = 5,
    tbar_pt: float = 1.0,
    tbar_sl: float = 1.0,
) -> pd.DataFrame:
    """candles: time-ordered (oldest -> newest) broker candles. Returns a labeled
    feature frame with INDIA_FEATURE_NAMES + target + timestamp.

    include_triple_barrier adds the López de Prado triple-barrier columns
    (tbarSide/tbarOutcome) used by the v2 meta-labeling pipeline. The plain
    `target` column is always present for backward compatibility with v1.
    """
    df = pd.DataFrame(candles).sort_values("openTime").reset_index(drop=True)
    if len(df) < 200:
        return pd.DataFrame(columns=INDIA_FEATURE_NAMES + ["target", "timestamp"])
    close = df["close"].astype(float)
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    vol = df.get("volume", pd.Series(0.0, index=df.index)).fillna(0).astype(float)

    ema9 = _ema(close, 9)
    ema20 = _ema(close, 20)
    ema50 = _ema(close, 50)
    rsi = _rsi(close)
    macd_line = _ema(close, 12) - _ema(close, 26)
    macd_signal = _ema(macd_line, 9)
    atr = _atr(df)
    adx = _adx(df)
    bb_up, bb_low = _bollinger(close)
    bb_mid = (bb_up + bb_low) / 2
    bb_width = (bb_up - bb_low) / bb_mid
    bb_pos = (close - bb_low) / (bb_up - bb_low).replace(0, np.nan)

    typical = (high + low + close) / 3
    day = pd.to_datetime(df["openTime"], unit="ms", utc=True).dt.tz_convert(IST).dt.date
    cum_vol = vol.groupby(day).cumsum().where(vol > 0)
    cum_pv = (typical * vol).groupby(day).cumsum()
    vwap = cum_pv / cum_vol.replace(0, np.nan)
    vol_avg = vol.rolling(20).mean()
    vol_ratio = vol / vol_avg.replace(0, np.nan)

    swing_high = high.rolling(5).max().shift(1)
    swing_low = low.rolling(5).min().shift(1)

    atr_pct = atr / close
    trend = [_trend_value(a, b, c, d) for a, b, c, d in zip(ema9, ema20, ema50, adx)]
    vol_vals = [_volatility_value(a, b) for a, b in zip(bb_width, atr_pct)]
    regimes = [_regime(a, b, c, d) for a, b, c, d in zip(adx, ema9, ema50, vol_vals)]
    sessions = [_session_index(int(t)) for t in df["openTime"]]

    feat = pd.DataFrame(
        {
            "close": _normalize(close, 1000, 30000),
            "ema9minus20": _normalize(ema9 - ema20, -200, 200),
            "ema20minus50": _normalize(ema20 - ema50, -300, 300),
            "rsi14": _normalize(rsi, 0, 100),
            "macdHistogram": _normalize(macd_line - macd_signal, -50, 50),
            "adx": _normalize(adx, 0, 60),
            "atrPct": _normalize(atr_pct, 0, 0.03),
            "bbPosition": _normalize(bb_pos, 0, 1),
            "bbWidth": _normalize(bb_width, 0, 0.15),
            "vwapPosition": _normalize((close - vwap) / vwap, -0.03, 0.03),
            "volumeRatio": _normalize(vol_ratio, 0, 5),
            "swingHighDistance": _normalize(close - swing_high, -500, 500),
            "swingLowDistance": _normalize(close - swing_low, -500, 500),
            "candleBody": _normalize((close - df["open"].astype(float)).abs(), 0, 300),
            "upperWick": _normalize(
                high - pd.concat([close, df["open"].astype(float)], axis=1).max(axis=1),
                0,
                300,
            ),
            "lowerWick": _normalize(
                pd.concat([close, df["open"].astype(float)], axis=1).min(axis=1) - low,
                0,
                300,
            ),
            "trend": _normalize(pd.Series(trend, index=df.index), -1, 1),
            "volatility": _normalize(pd.Series(vol_vals, index=df.index), 0, 2),
            "dayRange": _normalize(high - low, 0, 1500),
            "session": _normalize(pd.Series(sessions, index=df.index), 0, 6),
            "regime": _normalize(pd.Series(regimes, index=df.index), 0, 8),
            "spread": _normalize(pd.Series(0.0, index=df.index), 0, 10),
            "timestamp": _normalize(df["openTime"] % 86_400_000, 0, 86_400_000),
        }
    )
    # Fixed C1: keep normalized timestamp (delete raw epoch overwrite)
    # Mask last horizon rows where future close is NaN -> set target NaN and drop (M2)
    _close_shift = close.shift(-horizon)
    _valid_mask = _close_shift.notna()
    feat["target"] = np.where(_valid_mask, (_close_shift > close).astype(int), np.nan)
    out_cols = INDIA_FEATURE_NAMES + ["target"]
    if include_triple_barrier:
        df_with_atr = df.copy()
        df_with_atr["atr"] = atr
        tb = add_triple_barrier_labels(
            df_with_atr, horizon=tbar_horizon, pt_mult=tbar_pt, sl_mult=tbar_sl
        )
        feat["tbarSide"] = tb["tbarSide"].values
        feat["tbarOutcome"] = tb["tbarOutcome"].values
        out_cols = out_cols + ["tbarSide", "tbarOutcome"]
        # Also mask last tbar_horizon rows for triple barrier (insufficient forward data)
        _valid_mask = _valid_mask & close.shift(-tbar_horizon).notna()
        feat["target"] = np.where(_valid_mask, feat["target"], np.nan)
    out = feat[out_cols].replace([np.inf, -np.inf], np.nan)
    # Drop rows where target is NaN (last horizon rows) - prevents fabricated down labels
    out = out[_valid_mask.values].reset_index(drop=True)
    return out
