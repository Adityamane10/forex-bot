"""
Feature engineering for the AI engine.

NO-LOOKAHEAD GUARANTEE
----------------------
For a feature vector at bar index i:
  - features are computed ONLY from bars [0 .. i] (closed at i)
  - the target label uses ONLY bars (i+1 .. i+horizon) — strictly in the future
The dataset builder enforces this by construction and the tests verify it.

PERFORMANCE
-----------
All indicator series are computed in a single pass per symbol (O(n)); the
per-bar feature vector then indexes into precomputed arrays, so dataset
building is linear in the number of bars.
"""
from __future__ import annotations

import numpy as np
from typing import List, Dict, Any, Optional

FEATURE_VERSION = "features-v4"

# features-v4 replaces the raw absolute `close` with `closeVsEma200`
# ((close-EMA200)/ATR) — the raw price was a symbol-identity feature that let
# trees split per symbol and degenerated the model to a per-symbol constant
# (the AI gate froze at one number). Bumped from features-v3 — the predict
# path refuses models trained on an older feature set.
FEATURE_NAMES: List[str] = [
    "close", "rsi14", "macdHistogram", "macdLine", "adx", "atrPct",
    "bbPosition", "ema9minus20", "ema20minus50", "ema50minus200",
    "stochK", "williamsR14", "cci20", "roc10", "momentum10", "bbWidth",
    "supertrendDirection", "candleBody", "upperWick", "lowerWick",
    "swingHighDistance", "swingLowDistance", "spreadPips", "session",
    "regimeBullish", "regimeBearish", "regimeRange", "regimeBreakout",
    "eventRisk", "newsSentiment", "historicalBuyProbability", "dataQualityScore",
    "hourOfDaySin", "hourOfDayCos", "dayOfWeekSin", "dayOfWeekCos",
    "goldMomentum",
]


# ---------------------------------------------------------------------------
# Indicator primitives (numpy, aligned arrays with NaN warm-up)
# ---------------------------------------------------------------------------

def sma(v: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(v), np.nan)
    if len(v) < period or period <= 0:
        return out
    c = np.cumsum(np.nan_to_num(v, nan=0.0))
    n = np.cumsum(~np.isnan(v))
    for i in range(period - 1, len(v)):
        if n[i] - (n[i - period] if i >= period else 0) == period:
            out[i] = (c[i] - (c[i - period] if i >= period else 0)) / period
    return out


def ema(v: np.ndarray, period: int) -> np.ndarray:
    out = np.full(len(v), np.nan)
    if len(v) < period or period <= 0:
        return out
    k = 2.0 / (period + 1)
    prev = np.nan
    for i in range(len(v)):
        val = v[i]
        if np.isnan(prev):
            if np.isnan(val):
                continue
            window = v[max(0, i - period + 1): i + 1]
            finite = window[np.isfinite(window)]
            if len(finite) < period:
                continue
            prev = np.mean(finite[:period])
            out[i] = prev
        else:
            if np.isnan(val):
                out[i] = prev  # carry forward through missing values
            else:
                prev = val * k + prev * (1 - k)
                out[i] = prev
    return out


def rsi(v: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(len(v), np.nan)
    if len(v) <= period:
        return out
    delta = np.diff(v)
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    avg_gain = np.mean(gain[:period])
    avg_loss = np.mean(loss[:period])
    out[period] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    for i in range(period + 1, len(v)):
        avg_gain = (avg_gain * (period - 1) + gain[i - 1]) / period
        avg_loss = (avg_loss * (period - 1) + loss[i - 1]) / period
        out[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return out


def macd(v: np.ndarray, fast: int = 12, slow: int = 26, sig: int = 9) -> Dict[str, np.ndarray]:
    ef, es = ema(v, fast), ema(v, slow)
    line = np.where(np.isnan(ef) | np.isnan(es), np.nan, ef - es)
    signal = ema(line, sig)
    hist = np.where(np.isnan(line) | np.isnan(signal), np.nan, line - signal)
    return {"line": line, "signal": signal, "histogram": hist}


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(len(close), np.nan)
    if len(close) <= 1:
        return out
    tr = np.full(len(close), np.nan)
    tr[1:] = np.maximum(high[1:] - low[1:], np.maximum(
        np.abs(high[1:] - close[:-1]), np.abs(low[1:] - close[:-1])))
    prev = np.nan
    for i in range(len(close)):
        if np.isnan(tr[i]):
            continue
        if np.isnan(prev):
            if i < period:
                continue
            prev = np.nanmean(tr[i - period + 1: i + 1])
        else:
            prev = (prev * (period - 1) + tr[i]) / period
        out[i] = prev
    return out


def adx(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(close)
    plus_dm = np.zeros(n)
    minus_dm = np.zeros(n)
    for i in range(1, n):
        up = high[i] - high[i - 1]
        down = low[i - 1] - low[i]
        plus_dm[i] = up if (up > down and up > 0) else 0.0
        minus_dm[i] = down if (down > up and down > 0) else 0.0
    atr_s = atr(high, low, close, period)
    plus_di = np.full(n, np.nan)
    minus_di = np.full(n, np.nan)
    p_sum = m_sum = 0.0
    for i in range(1, n):
        if i < period:
            p_sum += plus_dm[i]
            m_sum += minus_dm[i]
            continue
        if i == period:
            p_sum += plus_dm[i]
            m_sum += minus_dm[i]
        else:
            p_sum = p_sum - p_sum / period + plus_dm[i]
            m_sum = m_sum - m_sum / period + minus_dm[i]
        a = atr_s[i]
        if not np.isnan(a) and a > 0:
            plus_di[i] = (p_sum / period / a) * 100
            minus_di[i] = (m_sum / period / a) * 100
    dx = np.full(n, np.nan)
    for i in range(n):
        if np.isnan(plus_di[i]) or np.isnan(minus_di[i]):
            continue
        s = plus_di[i] + minus_di[i]
        dx[i] = 0 if s == 0 else np.abs(plus_di[i] - minus_di[i]) / s * 100
    out = np.full(n, np.nan)
    idxs = np.where(~np.isnan(dx))[0]
    if len(idxs) >= period:
        first = idxs[0]
        cur = np.nanmean(dx[first: first + period])
        out[first + period - 1] = cur
        for i in range(first + period, n):
            cur = (cur * (period - 1) + dx[i]) / period
            out[i] = cur
    return out


def bollinger(v: np.ndarray, period: int = 20, k: float = 2.0) -> Dict[str, np.ndarray]:
    mid = sma(v, period)
    upper = np.full(len(v), np.nan)
    lower = np.full(len(v), np.nan)
    bw = np.full(len(v), np.nan)
    for i in range(period - 1, len(v)):
        m = mid[i]
        if np.isnan(m):
            continue
        sd = np.std(v[i - period + 1: i + 1])
        upper[i] = m + k * sd
        lower[i] = m - k * sd
        bw[i] = (upper[i] - lower[i]) / m * 100 if m != 0 else np.nan
    return {"middle": mid, "upper": upper, "lower": lower, "bandwidth": bw}


def stochastic(high: np.ndarray, low: np.ndarray, close: np.ndarray, kp: int = 14, dp: int = 3) -> Dict[str, np.ndarray]:
    k = np.full(len(close), np.nan)
    for i in range(kp - 1, len(close)):
        hh = np.max(high[i - kp + 1: i + 1])
        ll = np.min(low[i - kp + 1: i + 1])
        k[i] = 50.0 if hh == ll else (close[i] - ll) / (hh - ll) * 100
    d = sma(k, dp)
    return {"k": k, "d": d}


def cci(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 20) -> np.ndarray:
    out = np.full(len(close), np.nan)
    tp = (high + low + close) / 3
    tp_sma = sma(tp, period)
    for i in range(period - 1, len(close)):
        m = tp_sma[i]
        if np.isnan(m):
            continue
        md = np.mean(np.abs(tp[i - period + 1: i + 1] - m))
        out[i] = 0 if md == 0 else (tp[i] - m) / (0.015 * md)
    return out


def williams_r(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full(len(close), np.nan)
    for i in range(period - 1, len(close)):
        hh = np.max(high[i - period + 1: i + 1])
        ll = np.min(low[i - period + 1: i + 1])
        out[i] = -50.0 if hh == ll else (hh - close[i]) / (hh - ll) * -100
    return out


def swing_points(high: np.ndarray, low: np.ndarray, strength: int = 3) -> Dict[str, list]:
    highs, lows = [], []
    for i in range(strength, len(high) - strength):
        if np.all(high[i] >= high[i - strength: i + strength + 1]):
            highs.append(i)
        if np.all(low[i] <= low[i - strength: i + strength + 1]):
            lows.append(i)
    return {"highs": highs, "lows": lows}


# ---------------------------------------------------------------------------
# Single-pass indicator series
# ---------------------------------------------------------------------------

class IndicatorSeries:
    """Precomputed indicator arrays so per-bar feature extraction is O(1)."""

    def __init__(self, candles: List[Dict[str, Any]]):
        closes = np.array([c["close"] for c in candles], dtype=float)
        highs = np.array([c["high"] for c in candles], dtype=float)
        lows = np.array([c["low"] for c in candles], dtype=float)
        # Bar timestamps (epoch ms) for the cyclical time features — the bar's
        # own openTime is the truth at training time; live predictions pass
        # the timestamp via context instead.
        self.times = np.array([float(c.get("openTime", 0) or 0) for c in candles], dtype=float)
        self.n = len(candles)
        self.closes = closes
        self.highs = highs
        self.lows = lows
        self.bodies = np.array([abs(c["close"] - c.get("open", c["close"])) for c in candles], dtype=float)
        self.upper_wick = np.array([h - max(c["close"], c.get("open", c["close"])) for c, h in zip(candles, highs)], dtype=float)
        self.lower_wick = np.array([min(c["close"], c.get("open", c["close"])) - l for c, l in zip(candles, lows)], dtype=float)
        self.rsi14 = rsi(closes, 14)
        m = macd(closes)
        self.macd_line = m["line"]
        self.macd_signal = m["signal"]
        self.macd_hist = m["histogram"]
        self.adx14 = adx(highs, lows, closes, 14)
        self.atr14 = atr(highs, lows, closes, 14)
        bb = bollinger(closes, 20, 2.0)
        self.bb_upper = bb["upper"]
        self.bb_lower = bb["lower"]
        self.bb_width = bb["bandwidth"]
        st = stochastic(highs, lows, closes, 14, 3)
        self.stoch_k = st["k"]
        self.stoch_d = st["d"]
        self.cci20 = cci(highs, lows, closes, 20)
        self.wr14 = williams_r(highs, lows, closes, 14)
        self.ema9 = ema(closes, 9)
        self.ema20 = ema(closes, 20)
        self.ema50 = ema(closes, 50)
        self.ema200 = ema(closes, 200)
        sw = swing_points(highs, lows, 3)
        self.swing_highs = np.full(self.n, np.nan)
        self.swing_lows = np.full(self.n, np.nan)
        # FIX H1: swing confirmation lag - swing at idx requires strength future bars to confirm,
        # so availability is delayed by strength to avoid lookahead.
        strength = 3
        for idx in sw["highs"]:
            avail = idx + strength
            if avail < self.n:
                self.swing_highs[avail] = highs[idx]
        for idx in sw["lows"]:
            avail = idx + strength
            if avail < self.n:
                self.swing_lows[avail] = lows[idx]
        # forward-fill swing levels so each bar sees the latest confirmed swing
        self.swing_high_filled = self._ffill(self.swing_highs)
        self.swing_low_filled = self._ffill(self.swing_lows)

    @staticmethod
    def _ffill(arr: np.ndarray) -> np.ndarray:
        out = np.copy(arr)
        last = np.nan
        for i in range(len(out)):
            if np.isnan(out[i]):
                out[i] = last
            else:
                last = out[i]
        return out


def _norm(v: float, lo: float, hi: float) -> float:
    if not np.isfinite(v):
        return 0.0
    if hi == lo:
        return 0.0
    return max(0.0, min(1.0, (v - lo) / (hi - lo)))


def _cyclical(timestamp: Any, period_ms: float, which: str) -> float:
    """Encode a periodic quantity as sin/cos (mapped -1..1 → 0..1) so the
    wraparound (midnight, week boundary) is learnable. epoch-ms timestamps."""
    ts = float(timestamp) if timestamp is not None else 0.0
    # Support both ms and s timestamps defensively.
    if ts < 1e11:
        ts *= 1000.0
    angle = 2.0 * np.pi * (ts % period_ms) / period_ms
    raw = np.sin(angle) if which == "sin" else np.cos(angle)
    return float((raw + 1.0) / 2.0)


def vector_at(s: IndicatorSeries, i: int, ctx: Optional[Dict[str, float]] = None) -> Dict[str, float]:
    """Feature vector at bar index i from precomputed series (O(1))."""
    c = dict(ctx or {})
    # Cyclical-time source of truth: the bar's own openTime at training time;
    # live predictions pass `timestamp` via context (backend contract).
    c.setdefault("timestamp", s.times[i] if i < len(s.times) else 0.0)
    close = s.closes[i]
    atr_s = s.atr14[i]
    atr_pct = atr_s / close * 100 if close and np.isfinite(atr_s) else 0.0
    bb_l, bb_u = s.bb_lower[i], s.bb_upper[i]
    bb_pos = (close - bb_l) / (bb_u - bb_l) if np.isfinite(bb_l) and np.isfinite(bb_u) and bb_u != bb_l else 0.5
    e9, e20 = s.ema9[i], s.ema20[i]
    e50, e200 = s.ema50[i], s.ema200[i]
    atr_guard = atr_s if np.isfinite(atr_s) and atr_s > 0 else 1e-6
    sh = s.swing_high_filled[i]
    sl = s.swing_low_filled[i]
    swing_high = sh if np.isfinite(sh) else close
    swing_low = sl if np.isfinite(sl) else close

    def last(x):
        v = x if np.isscalar(x) else x[-1] if hasattr(x, "__len__") and len(x) else x
        return float(v) if np.isfinite(v) else 0.0

    return {
        "close": _norm(close, close * 0.9, close * 1.1),
        "rsi14": _norm(s.rsi14[i], 0, 100),
        "macdHistogram": _norm(s.macd_hist[i], -0.005, 0.005),
        "macdLine": _norm(s.macd_line[i], -0.01, 0.01),
        "adx": _norm(s.adx14[i], 0, 60),
        "atrPct": _norm(atr_pct, 0, 1),
        "bbPosition": _norm(bb_pos, 0, 1),
        "ema9minus20": _norm(e9 - e20, -0.005, 0.005),
        "ema20minus50": _norm(e20 - e50, -0.008, 0.008),
        "ema50minus200": _norm(e50 - e200, -0.015, 0.015),
        "stochK": _norm(s.stoch_k[i], 0, 100),
        "williamsR14": _norm(s.wr14[i], -100, 0),
        "cci20": _norm(s.cci20[i], -200, 200),
        "roc10": _norm((float((close - s.closes[i - 10]) / s.closes[i - 10] * 100)) if i >= 10 and s.closes[i - 10] != 0 else 0.0, -2, 2),
        "momentum10": _norm(close - s.closes[i - 10] if i >= 10 else 0.0, -0.01, 0.01),
        "bbWidth": _norm(s.bb_width[i], 0, 10),
        "supertrendDirection": float(np.sign(close - e20)) if np.isfinite(e20) else 0.0,
        "candleBody": _norm(s.bodies[i], 0, atr_guard),
        "upperWick": _norm(s.upper_wick[i], 0, atr_guard),
        "lowerWick": _norm(s.lower_wick[i], 0, atr_guard),
        "swingHighDistance": _norm(swing_high - close, -0.02, 0.02),
        "swingLowDistance": _norm(close - swing_low, -0.02, 0.02),
        "spreadPips": _norm(c.get("spreadPips", 0.5), 0, 30),
        "session": float(c.get("session", 0.2)),
        "regimeBullish": float(c.get("regimeBullish", 0)),
        "regimeBearish": float(c.get("regimeBearish", 0)),
        "regimeRange": float(c.get("regimeRange", 1)),
        "regimeBreakout": float(c.get("regimeBreakout", 0)),
        "eventRisk": _norm(c.get("eventRisk", 0), 0, 1),
        "newsSentiment": _norm(c.get("newsSentiment", 0), -1, 1),
        "historicalBuyProbability": _norm(c.get("historicalBuyProbability", 0.5), 0, 1),
        "dataQualityScore": _norm(c.get("dataQualityScore", 0.9), 0, 1),
        # Cyclical time (forex-predictor adoption): session effects are
        # periodic; sin/cos makes the midnight/weekend wraparound learnable.
        # Timestamps are epoch ms UTC.
        "hourOfDaySin": _cyclical(c.get("timestamp"), 24 * 3600_000, "sin"),
        "hourOfDayCos": _cyclical(c.get("timestamp"), 24 * 3600_000, "cos"),
        "dayOfWeekSin": _cyclical(c.get("timestamp"), 7 * 24 * 3600_000, "sin"),
        "dayOfWeekCos": _cyclical(c.get("timestamp"), 7 * 24 * 3600_000, "cos"),
        # XAU/USD momentum bias (XAUUSD-LSTM adoption): the caller supplies
        # gold's 10-bar ROC in %% via context (goldRoc10, ±2%% → 0..1).
        # Neutral 0.5 when gold data is unavailable or the symbol IS gold.
        "goldMomentum": _norm(c.get("goldRoc10", None), -2.0, 2.0) if c.get("goldRoc10") is not None else 0.5,
    }


def compute_features_at(candles: List[Dict[str, Any]], i: int, context: Optional[Dict[str, float]] = None) -> Dict[str, float]:
    """Feature vector at bar index i using ONLY bars [0..i] (thin wrapper)."""
    s = IndicatorSeries(candles[: i + 1])
    return vector_at(s, i, context)


def build_dataset(candles: List[Dict[str, Any]], horizon: int = 12, min_index: int = 200,
                  context_fn=None) -> "object":
    """Build a labeled dataset. For each valid bar i:
      features = vector_at(series, i)                  [uses bars <= i]
      target   = sign(close[i+horizon] - close[i])     [uses bars > i  ONLY]
    Bars without `i + horizon` are dropped (no partial labels).
    """
    import pandas as pd
    s = IndicatorSeries(candles)
    rows = []
    for i in range(min_index, len(candles) - horizon):
        ctx = context_fn(i) if context_fn else None
        feats = vector_at(s, i, ctx)
        future_close = candles[i + horizon]["close"]
        current_close = candles[i]["close"]
        ret = (future_close - current_close) / current_close if current_close else 0.0
        feats["target"] = 1 if ret > 0.0005 else 0
        feats["forward_return"] = ret * 100
        feats["timestamp"] = candles[i].get("openTime", i)
        rows.append(feats)
    return pd.DataFrame(rows)
