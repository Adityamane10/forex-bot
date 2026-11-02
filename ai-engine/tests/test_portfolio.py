"""Portfolio analytics tests: skfolio path and honest numpy fallback."""
import numpy as np
import pytest

from app.portfolio import analyze_portfolio

rng = np.random.default_rng(7)
RETURNS = {
    "EUR/USD": (0.0002 + 0.01 * rng.standard_normal(120)).tolist(),
    "GBP/USD": (0.0001 + 0.011 * rng.standard_normal(120)).tolist(),
    "USD/JPY": (-0.0001 + 0.009 * rng.standard_normal(120)).tolist(),
    "USD/CHF": (0.0001 + 0.008 * rng.standard_normal(120)).tolist(),
}


def test_skfolio_analyze_portfolio():
    out = analyze_portfolio(RETURNS, weights={"EUR/USD": 0.5, "GBP/USD": 0.5})
    assert out["status"] == "OK"
    assert out["engine"] == "SKFOLIO"
    assert out["samples"] == 120
    assert out["symbols"] == list(RETURNS.keys())
    for key in ("current", "hrp", "minVariance"):
        weights = out["weights"][key]
        assert len(weights) == 4
        assert sum(weights) == pytest.approx(1.0, abs=1e-6)
        assert all(w >= 0 for w in weights)
    assert 0 < out["portfolio"]["hrpVolatility"] < 0.05
    assert out["portfolio"]["effectiveN"] > 0
    assert out["recommendation"] in ("diversified", "concentrated")
    assert len(out["correlation"]) == 4 and len(out["correlation"][0]) == 4
    assert len(out["volatility"]) == 4
    assert len(out["riskContributionPct"]) == 4


def test_insufficient_data_rejected():
    short = {s: v[:5] for s, v in RETURNS.items()}
    assert analyze_portfolio(short)["status"] == "INSUFFICIENT_DATA"


def test_misaligned_lengths_rejected():
    ragged = {s: (v[: len(v) - i] if i else v) for i, (s, v) in enumerate(RETURNS.items())}
    assert analyze_portfolio(ragged)["status"] == "INSUFFICIENT_DATA"


def test_fallback_engine_without_skfolio(monkeypatch):
    import app.portfolio as portfolio

    monkeypatch.setattr(portfolio, "SKFOLIO_AVAILABLE", False)
    out = analyze_portfolio(RETURNS, weights={"EUR/USD": 0.5, "GBP/USD": 0.5})
    assert out["status"] == "OK"
    assert out["engine"] == "FALLBACK"
    for key in ("hrp", "minVariance"):
        weights = out["weights"][key]
        assert sum(weights) == pytest.approx(1.0, abs=1e-6)
        assert all(w >= 0 for w in weights)
    assert out["portfolio"]["effectiveN"] > 0