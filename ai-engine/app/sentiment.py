"""News sentiment. Preferred model: FinBERT (ProsusAI/finbert, free open-source).
If transformers is not installed or the model fails to load, falls back to a
financial lexicon and reports source=RULE_BASED. Never fabricates sentiment."""
from __future__ import annotations

from typing import Dict

FINBERT_AVAILABLE = False
_finbert_pipeline = None

try:
    from transformers import pipeline  # type: ignore
    _finbert_pipeline = pipeline(
        "sentiment-analysis",
        model="ProsusAI/finbert",
        tokenizer="ProsusAI/finbert",
        truncation=True,
        max_length=128,
    )
    FINBERT_AVAILABLE = True
except Exception:
    _finbert_pipeline = None

POSITIVE = {
    "beat", "beats", "surge", "surges", "gain", "gains", "rally", "rallies", "strong",
    "growth", "rise", "rises", "raised", "boost", "boosted", "outperform", "record",
    "rebound", "rebounds", "upgrade", "upgrades", "improve", "improves", "expansion",
    "optimistic", "recovery", "jump", "jumps",
}
NEGATIVE = {
    "miss", "misses", "plunge", "plunges", "drop", "drops", "fall", "falls", "slump",
    "slumps", "weak", "slowdown", "cut", "cuts", "lowered", "downgrade", "downgrades",
    "decline", "declines", "loss", "losses", "fear", "fears", "worst", "recession",
    "deficit", "pressure", "turmoil", "crash", "crashes", "bearish", "selloff",
    "sell-off", "tumble", "tumbles",
}


def _lexicon(text: str) -> Dict[str, float | str]:
    words = [w for w in text.lower().split() if len(w) > 2]
    score = sum(1 if w in POSITIVE else -1 if w in NEGATIVE else 0 for w in words)
    conf = 0.4 if score == 0 else 0.4 + min(1.0, abs(score) / 4) * 0.5
    cls = "positive" if score > 0 else "negative" if score < 0 else "neutral"
    return {"class": cls, "score": max(-1.0, min(1.0, score / 4)), "confidence": conf}


def score_text(text: str) -> Dict[str, float | str]:
    if _finbert_pipeline is not None:
        try:
            result = _finbert_pipeline(text[:512])[0]
            label = result["label"].lower()
            cls = "positive" if "positive" in label else "negative" if "negative" in label else "neutral"
            score = {"positive": 1.0, "negative": -1.0, "neutral": 0.0}[cls]
            return {
                "class": cls,
                "score": score,
                "confidence": float(result["score"]),
                "model": "ProsusAI/finbert",
                "source": "FINBERT",
            }
        except Exception:
            pass
    out = _lexicon(text)
    out["model"] = "financial-lexicon-v1"
    out["source"] = "RULE_BASED"
    return out
