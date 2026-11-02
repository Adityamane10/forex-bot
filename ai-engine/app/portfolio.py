"""
Portfolio risk analytics backed by skfolio (https://github.com/skfolio/skfolio).

Consumes an aligned simple-returns matrix (symbol -> ordered returns, all same
length and timestamps) and produces:

  - Ledoit-Wolf shrunk covariance + correlation matrix
  - Mean-Variance (minimum-volatility) weights
  - Hierarchical Risk Parity weights (CVaR as risk measure)
  - portfolio volatility (per-period + annualized), CVaR 95, effective N
  - per-symbol marginal risk contribution

If skfolio is not installed the module degrades honestly to numpy-only
empirical estimates (engine flagged 'FALLBACK') — never crashes the AI engine.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np

try:
    import pandas as pd
    from skfolio.moments import LedoitWolf
    from skfolio.optimization import HierarchicalRiskParity, MeanRisk, ObjectiveFunction
    from skfolio.measures import RiskMeasure, cvar, effective_number_assets, correlation

    SKFOLIO_AVAILABLE = True
except Exception:  # pragma: no cover - environment dependent
    pd = None
    SKFOLIO_AVAILABLE = False


def _empirical_cov(X: np.ndarray) -> np.ndarray:
    T, N = X.shape
    demeaned = X - X.mean(axis=0)
    return (demeaned.T @ demeaned) / max(1, T - 1)


def _empirical_weights(X: np.ndarray, method: str) -> np.ndarray:
    """numpy-only fallbacks: inverse-volatility weights."""
    cov = _empirical_cov(X)
    vols = np.sqrt(np.diag(cov))
    vols = np.where(vols < 1e-12, 1e-12, vols)
    w = 1.0 / vols
    w = w / w.sum()
    if method == "mv":  # minimum-variance via closed form (full-rank assumption)
        try:
            inv = np.linalg.inv(cov + 1e-9 * np.eye(cov.shape[0]))
            ones = np.ones(cov.shape[0])
            w = inv @ ones / (ones @ inv @ ones)
        except np.linalg.LinAlgError:
            pass
    return w


def analyze_portfolio(
    returns: Dict[str, List[float]],
    weights: Optional[Dict[str, float]] = None,
    annualization_factor: float = 6048.0,  # 1h bars: 24 * 252
) -> Dict[str, Any]:
    symbols = list(returns.keys())
    if len(symbols) == 0:
        return {"status": "INSUFFICIENT_DATA", "detail": "no symbols provided"}
    # Single-asset portfolios cannot build HRP / correlation matrices — they are
    # not diversified portfolios, but the Risk page still polls them. Return a
    # honest single-asset response via the empirical fallback instead of crashing
    # skfolio (HierarchicalRiskParity requires N>=2 and fails with
    # "DataFrame constructor not properly called" on 1 column).
    if len(symbols) == 1:
        lengths = {len(v) for v in returns.values()}
        if list(lengths)[0] < 10:
            return {
                "status": "INSUFFICIENT_DATA",
                "detail": "returns series must be aligned and have >= 10 observations",
            }
        T = list(lengths)[0]
        X = np.asarray([returns[s] for s in symbols], dtype=float).T  # (T, 1)
        if np.any(~np.isfinite(X)):
            return {
                "status": "INSUFFICIENT_DATA",
                "detail": "non-finite returns present",
            }
        current = weights or {}
        current_w = np.asarray([current.get(s, 0.0) for s in symbols], dtype=float)
        current_w = current_w / (current_w.sum() or 1.0)
        cov = _empirical_cov(X)
        vol = float(np.sqrt(cov[0, 0])) if cov.size else 0.0
        return {
            "status": "OK",
            "engine": "FALLBACK_SINGLE",
            "symbols": symbols,
            "samples": T,
            "annualizationFactor": annualization_factor,
            "correlation": [[1.0]],
            "volatility": [vol],
            "weights": {
                "current": current_w.tolist(),
                "minVariance": [1.0],
                "hrp": [1.0],
            },
            "portfolio": {
                "currentVolatility": vol if current_w.sum() > 0 else None,
                "minVarianceVolatility": vol,
                "hrpVolatility": vol,
                "hrpCvar95": None,
                "effectiveN": 1.0,
            },
            "riskContributionPct": [100.0],
            "recommendation": "single-asset",
        }
    lengths = {len(v) for v in returns.values()}
    if len(lengths) > 1 or list(lengths)[0] < 10:
        return {
            "status": "INSUFFICIENT_DATA",
            "detail": "returns series must be aligned and have >= 10 observations",
        }
    T = list(lengths)[0]
    X = np.asarray([returns[s] for s in symbols], dtype=float).T  # (T, N)
    if np.any(~np.isfinite(X)):
        return {"status": "INSUFFICIENT_DATA", "detail": "non-finite returns present"}

    current = weights or {}
    current_w = np.asarray([current.get(s, 0.0) for s in symbols], dtype=float)
    current_w = current_w / (current_w.sum() or 1.0)

    engine = "SKFOLIO"
    cov: Any = None  # type: ignore
    mv_w: Any = None  # type: ignore
    hrp_w: Any = None  # type: ignore
    cvar95: Any = None
    eff_n: Any = None
    hrp_vol: Any = None
    corr: Any = None
    if SKFOLIO_AVAILABLE:
        try:
            assert pd is not None  # for type checker — guarded by SKFOLIO_AVAILABLE
            df = pd.DataFrame(X, columns=symbols)  # type: ignore
            cov = LedoitWolf().fit(df).covariance_
            mv = MeanRisk(
                objective_function=ObjectiveFunction.MINIMIZE_RISK,
                portfolio_params={"name": "MinVol"},
            ).fit(df)
            hrp = HierarchicalRiskParity(
                risk_measure=RiskMeasure.CVAR,
                portfolio_params={"name": "HRP-CVaR"},
            ).fit(df)
            mv_w = np.asarray(mv.weights_)
            hrp_w = np.asarray(hrp.weights_)
            corr = correlation(cov)
            # portfolio returns = X @ w; skfolio reports CVaR as a loss magnitude
            cvar95 = float(cvar(np.asarray(df) @ hrp_w, beta=0.95))
            eff_n = float(effective_number_assets(hrp_w))
            hrp_vol = float(np.sqrt(hrp_w @ cov @ hrp_w))
        except Exception as e:
            # Any skfolio failure (singular cov, 1-asset HRP bug, numerical edge)
            # degrades honestly to the numpy fallback — never crashes the engine.
            # The backend treats this as advisory only (Risk page).
            import traceback as _tb

            # Log to uvicorn stderr for ops visibility, but return a usable payload.
            print(
                f"[portfolio] skfolio failed, falling back: {e}\n{_tb.format_exc()}",
                flush=True,
            )
            engine = "FALLBACK"
            cov = _empirical_cov(X)
            mv_w = _empirical_weights(X, "mv")
            hrp_w = _empirical_weights(X, "invvol")
            vols = np.sqrt(np.diag(cov))
            denom = np.outer(vols, vols)
            corr = cov / np.where(denom == 0, 1.0, denom)
            port_var = hrp_w @ cov @ hrp_w
            cvar95 = None
            hrp_vol = float(np.sqrt(port_var))
            eff_n = float(1.0 / np.sum(hrp_w**2))
    if cov is None:  # fallback path (skfolio unavailable from import)
        engine = "FALLBACK"
        cov = _empirical_cov(X)
        mv_w = _empirical_weights(X, "mv")
        hrp_w = _empirical_weights(X, "invvol")
        vols = np.sqrt(np.diag(cov))
        denom = np.outer(vols, vols)
        corr = cov / np.where(denom == 0, 1.0, denom)
        port_var = hrp_w @ cov @ hrp_w
        cvar95 = None  # honest: no distributional model without skfolio
        hrp_vol = float(np.sqrt(port_var))
        eff_n = float(1.0 / np.sum(hrp_w**2))

    # marginal risk contribution in vol terms: mrc_i = (cov @ w)_i / vol_p
    vol_p = float(np.sqrt(hrp_w @ cov @ hrp_w))
    mrc = ((cov @ hrp_w) / vol_p) if vol_p > 0 else np.zeros(len(symbols))
    contribution_pct = (
        (hrp_w * mrc / vol_p * 100) if vol_p > 0 else np.zeros(len(symbols))
    )
    # current portfolio (user's open positions, notional weights) stats
    cur_vol = (
        float(np.sqrt(current_w @ cov @ current_w)) if current_w.sum() > 0 else None
    )

    return {
        "status": "OK",
        "engine": engine,
        "symbols": symbols,
        "samples": T,
        "annualizationFactor": annualization_factor,
        "correlation": corr.tolist(),
        "volatility": np.sqrt(np.diag(cov)).tolist(),
        "weights": {
            "current": current_w.tolist(),
            "minVariance": mv_w.tolist(),
            "hrp": hrp_w.tolist(),
        },
        "portfolio": {
            "currentVolatility": cur_vol,
            "minVarianceVolatility": float(np.sqrt(mv_w @ cov @ mv_w)),
            "hrpVolatility": hrp_vol,
            "hrpCvar95": cvar95,
            "effectiveN": eff_n,
        },
        "riskContributionPct": contribution_pct.tolist(),
        "recommendation": "diversified"
        if eff_n >= min(3, len(symbols)) * 0.6
        else "concentrated",
    }


def load_dataset_returns(
    symbols: List[str], dataset: Dict[str, Any]
) -> Dict[str, List[float]]:
    """Extract aligned simple returns from a backend-supplied dataset snapshot
    ({symbol: [closes]}) — the backend aligns by candle openTime."""
    out: Dict[str, List[float]] = {}
    for sym in symbols:
        closes = dataset.get(sym)
        if not closes or len(closes) < 11:
            continue
        arr = np.asarray(closes, dtype=float)
        out[sym] = (arr[1:] / arr[:-1] - 1.0).tolist()
    return out
