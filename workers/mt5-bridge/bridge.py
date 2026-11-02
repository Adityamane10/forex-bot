"""
MT5 tick-streaming bridge.

Streams REAL ticks from a local MetaTrader 5 terminal (free broker demo account)
into the Freebuff backend over the internal feed endpoint. This is the
zero-polling option for real-time data: ticks arrive as fast as MT5 publishes
them, no REST polling, no per-minute budget.

Requirements
------------
- Windows host with the MetaTrader 5 terminal installed and a (demo) account
  logged in.
- `pip install MetaTrader5` on that host.
- Backend running with INTERNAL_API_TOKEN set.

Usage
-----
    py workers/mt5-bridge/bridge.py --symbols EURUSD,GBPUSD,USDJPY --preload

Env / flags
-----------
    MT5_LOGIN / MT5_PASSWORD / MT5_SERVER   optional demo-account credentials
    BACKEND_URL                             default http://127.0.0.1:4000
    INTERNAL_API_TOKEN                      required (must match backend)
    MT5_POLL_MS                             tick batch window, default 50
    --symbols  comma list, default the 10 majors
    --preload  fetch history (1h/4h/1D) into the backend before streaming
    --timeframes  timeframes for --preload, default 1h,4h,1D

This script NEVER fabricates data. If MT5 is missing, the terminal is closed or
the connection fails, it exits with a clear error instead of inventing ticks.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.error import URLError
from typing import Any, Dict, List, Optional

BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:4000")
INTERNAL_TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")
# Tick batch window. 50ms: ticks are polled every 10ms internally, and the
# batch is flushed as soon as anything changed - so worst-case added latency
# is ~50ms instead of the 200ms default (visibly laggy against MT5's own
# quote board). Overhead is one small POST per 50ms only while ticks move.
POLL_MS = int(os.environ.get("MT5_POLL_MS", "50"))
# MT5 timestamps are SERVER time (broker timezone, e.g. MetaQuotes demo = UTC+3),
# while the backend stores UTC epochs. The bridge measures the server->UTC offset
# once at startup and subtracts it from every tick/candle timestamp.
TFS = {
    "1M": "M1",
    "5M": "M5",
    "15M": "M15",
    "30M": "M30",
    "1H": "H1",
    "4H": "H4",
    "1D": "D1",
}
SERVER_OFFSET_MS = 0


def log(msg: str) -> None:
    print(f"[mt5-bridge] {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"[mt5-bridge] FATAL: {msg}", file=sys.stderr)
    sys.exit(1)


def post(path: str, payload: Dict[str, Any], retries: int = 10) -> None:
    if not INTERNAL_TOKEN:
        fail(
            "INTERNAL_API_TOKEN is not set (must match the backend's INTERNAL_API_TOKEN)"
        )
    headers = {
        "Content-Type": "application/json",
        "X-Internal-Token": INTERNAL_TOKEN,
    }
    if SERVER_OFFSET_MS:
        headers["X-MT5-Server-Offset-Ms"] = str(SERVER_OFFSET_MS)
    req = urllib.request.Request(
        f"{BACKEND_URL}/api{path}",
        data=json.dumps(payload).encode(),
        headers=headers,
        method="POST",
    )
    # The backend may be briefly restarting (tsx watch reloads on file changes).
    # retries=-1 blocks forever (preload must not stream before history lands);
    # retries=0 fails fast so the streaming loop can drop the batch and continue.
    delay = 2.0
    attempt = 0
    while True:
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status >= 300:
                    fail(f"backend rejected {path}: HTTP {resp.status}")
                return
        except urllib.error.HTTPError as e:
            # HTTPError subclasses URLError: a 400/401/429 is PERMANENT for this
            # request and must not be retried (retries=-1 would hang forever on
            # a bad INTERNAL_API_TOKEN). Connection-level failures retry below.
            fail(f"backend rejected {path}: HTTP {e.code}")
        except URLError as e:
            attempt += 1
            if retries >= 0 and attempt > retries:
                raise
            print(
                f"[mt5-bridge] backend unreachable, retrying {path} ({attempt}/{'∞' if retries < 0 else retries})..."
            )
            time.sleep(min(delay, 10.0))
            delay += 2.0


def to_python_price(v: Any) -> float:
    return float(v)


def main() -> None:
    name, lock_name = "mt5-bridge", "forextbot-bridge.lock"
    # ---- single-instance lock (atomic, PID-liveness-checked) ----
    # Exactly one worker may run: the launcher starts one directly AND a
    # watchdog can spawn another within seconds - a process-name probe loses
    # that race, an atomic O_CREAT|O_EXCL lockfile cannot. A stale lock (dead
    # owner after a crash/reboot) is broken and retaken, never wedged.
    import ctypes
    _lock_path = os.path.join(tempfile.gettempdir(), lock_name)
    while True:
        try:
            _fd = os.open(_lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(_fd, str(os.getpid()).encode())
            os.close(_fd)
            break
        except FileExistsError:
            pass
        except OSError:
            break  # unwritable temp dir - never wedge startup on a nicety
        _owner = 0
        try:
            with open(_lock_path, encoding="utf-8") as _fh:
                _owner = int((_fh.read() or "0").strip() or 0)
        except (OSError, ValueError):
            _owner = 0
        _alive = False
        if _owner > 0:
            try:
                _h = ctypes.windll.kernel32.OpenProcess(0x00100000, False, _owner)
                if _h:
                    _ec = ctypes.c_ulong()
                    ctypes.windll.kernel32.GetExitCodeProcess(_h, ctypes.byref(_ec))
                    ctypes.windll.kernel32.CloseHandle(_h)
                    _alive = _ec.value == 259  # STILL_ACTIVE
            except Exception:
                _alive = True  # cannot tell - assume alive, do not double-start
        if _alive:
            print(f"[{name}] instance already running (PID {_owner}) - nothing to do.", flush=True)
            sys.exit(0)
        try:
            os.remove(_lock_path)
        except OSError:
            pass
        time.sleep(0.05)

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--symbols",
        default=os.environ.get(
            "MT5_SYMBOLS",
            "EURUSD,GBPUSD,USDJPY,USDCHF,AUDUSD,USDCAD,NZDUSD,EURGBP,EURJPY,GBPJPY",
        ),
    )
    parser.add_argument("--preload", action="store_true")
    # All timeframes by default: the backend's intraday buffers then start with
    # real MT5 history (no sparse charts, no Yahoo bars mixed in).
    parser.add_argument(
        "--timeframes",
        default=os.environ.get("MT5_HISTORY_TFS", "1m,5m,15m,30m,1h,4h,1D"),
    )
    # Deep-history export for AI training: pulls up to --history-bars bars per
    # (symbol, tf) from MT5 and bulk-upserts them into the backend's Mongo
    # store. 0 disables. TFs for the export default to the training set (1h).
    parser.add_argument(
        "--history-bars",
        type=int,
        default=int(os.environ.get("MT5_HISTORY_BARS", "0")),
    )
    parser.add_argument(
        "--history-tfs",
        default=os.environ.get("MT5_HISTORY_EXPORT_TFS", "1h"),
    )
    args = parser.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    if not symbols:
        fail("no symbols given")

    try:
        import MetaTrader5 as mt5
    except ImportError:
        fail(
            "MetaTrader5 package not installed. On Windows: pip install MetaTrader5. "
            "It also requires the MetaTrader 5 terminal installed and a (demo) account."
        )

    login = os.environ.get("MT5_LOGIN")
    password = os.environ.get("MT5_PASSWORD")
    server = os.environ.get("MT5_SERVER")
    # The all-in-one dev startup launches the MetaTrader application together
    # with the platform, so wait for it to finish loading and log in instead of
    # failing into a watchdog cooldown (see mt5-trader/trader.py:attach_mt5).
    wait_s = float(os.environ.get("MT5_STARTUP_WAIT_S", "180"))
    deadline = time.time() + max(0.0, wait_s)
    attempt = 0
    while True:
        attempt += 1
        try:
            if login and password:
                ok = mt5.initialize(
                    login=int(login), password=password, server=server or ""
                )
            else:
                ok = mt5.initialize()
        except Exception as exc:  # noqa: BLE001
            ok = False
            err = str(exc)
        else:
            err = mt5.last_error()
        if ok and mt5.account_info() is not None:
            break
        try:
            mt5.shutdown()
        except Exception:  # noqa: BLE001
            pass
        if time.time() >= deadline:
            fail(
                f"MT5 not usable after waiting: {err} — is the terminal running and logged in? "
                "(MT5_STARTUP_WAIT_S lengthens the wait)"
            )
        if attempt == 1:
            log(f"waiting for the MetaTrader terminal (up to {int(wait_s)}s)… last error: {err}")
        elif attempt % 5 == 0:
            log(f"still waiting for MT5 ({int(deadline - time.time())}s left, last error: {err})")
        time.sleep(3)

    # verify symbols exist
    missing = [s for s in symbols if mt5.symbol_info(s) is None]
    if missing:
        mt5.shutdown()
        fail(
            f"symbols not found in MT5: {missing} — check the broker's symbol names (e.g. EURUSD)"
        )
    # Ensure every symbol is selected/visible — otherwise symbol_info_tick returns None
    # and charts for XAUUSD / cross pairs never tick (Market Watch hidden).
    for s in symbols:
        mt5.symbol_select(s, True)
    # let the terminal publish first ticks for the newly selected symbols
    time.sleep(0.5)

    global SERVER_OFFSET_MS
    # Measure the server->UTC offset from the MEDIAN of several ticks using
    # millisecond resolution (tick.time_msc when available). A single
    # second-resolution tick carried up to ±999ms of systematic error into
    # every downstream timestamp.
    samples = []
    for _ in range(7):
        t = mt5.symbol_info_tick(symbols[0])
        if t is not None:
            msc = getattr(t, "time_msc", None)
            server_ms = int(msc) if msc else int(t.time * 1000)
            samples.append(server_ms - int(time.time() * 1000))
        time.sleep(0.05)
    if not samples:
        fail(f"no tick received for {symbols[0]} — is the account connected?")
    samples.sort()
    SERVER_OFFSET_MS = samples[len(samples) // 2]
    print(
        f"[mt5-bridge] server time offset: {SERVER_OFFSET_MS}ms (server ahead by {-SERVER_OFFSET_MS // 1000}s)"
    )

    def fx_symbol(mt5_name: str) -> str:
        # EURUSD -> EUR/USD
        if len(mt5_name) == 6 and mt5_name.isalpha():
            return f"{mt5_name[:3]}/{mt5_name[3:]}"
        return mt5_name

    if args.preload:
        tfs = [t.strip().lower() for t in args.timeframes.split(",") if t.strip()]
        for symbol in symbols:
            fx = fx_symbol(symbol)
            for tf in tfs:
                frame = TFS.get(tf.upper())
                if frame is None:
                    print(f"[mt5-bridge] skipping unknown timeframe {tf}")
                    continue
                rates = mt5.copy_rates_from_pos(
                    symbol, getattr(mt5, f"TIMEFRAME_{frame}"), 0, 300
                )
                if rates is None or len(rates) == 0:
                    print(
                        f"[mt5-bridge] no history for {symbol} {tf} ({mt5.last_error()})"
                    )
                    continue
                tf_ms = {
                    "1M": 60_000,
                    "5M": 300_000,
                    "15M": 900_000,
                    "30M": 1_800_000,
                    "1H": 3_600_000,
                    "4H": 14_400_000,
                    "1D": 86_400_000,
                }[tf.upper()]
                candles = [
                    {
                        "open": to_python_price(r["open"]),
                        "high": to_python_price(r["high"]),
                        "low": to_python_price(r["low"]),
                        "close": to_python_price(r["close"]),
                        "openTime": int(r["time"]) * 1000 - SERVER_OFFSET_MS,
                        "closeTime": int(r["time"]) * 1000 - SERVER_OFFSET_MS + tf_ms,
                    }
                    for r in rates
                ]
                # Bounded retry on preload (was retries=-1, which deadlocked
                # the bridge forever if the backend was misconfigured). A
                # bounded retry surfaces real outages (the watchdog will
                # respawn us) while still tolerating a slow tsx-watch reload.
                # A URLError here means "this TF failed" — we continue to
                # the next TF/symbol so a single bad POST doesn't waste the
                # rest of the history we already pulled from MT5.
                try:
                    post(
                        "/internal/candles",
                        {
                            "symbol": fx,
                            "timeframe": "1D" if tf == "1d" else tf,
                            "candles": candles,
                        },
                        retries=30,
                    )
                    print(f"[mt5-bridge] preloaded {symbol} {tf}: {len(candles)} candles")
                except URLError as err:
                    print(
                        f"[mt5-bridge] preload FAILED for {symbol} {tf} after 30 retries: {err} — continuing (backend may be down; watchdog will respawn)"
                    )

    if args.history_bars > 0:
        export_tfs = [t.strip().lower() for t in args.history_tfs.split(",") if t.strip()]
        for symbol in symbols:
            fx = fx_symbol(symbol)
            for tf in export_tfs:
                frame = TFS.get(tf.upper())
                if frame is None:
                    continue
                rates = mt5.copy_rates_from_pos(
                    symbol, getattr(mt5, f"TIMEFRAME_{frame}"), 0, args.history_bars
                )
                if rates is None or len(rates) == 0:
                    print(f"[mt5-bridge] no history for {symbol} {tf} ({mt5.last_error()})")
                    continue
                tf_ms = {
                    "1M": 60_000,
                    "5M": 300_000,
                    "15M": 900_000,
                    "30M": 1_800_000,
                    "1H": 3_600_000,
                    "4H": 14_400_000,
                    "1D": 86_400_000,
                }[tf.upper()]
                candles = [
                    {
                        "open": to_python_price(r["open"]),
                        "high": to_python_price(r["high"]),
                        "low": to_python_price(r["low"]),
                        "close": to_python_price(r["close"]),
                        "openTime": int(r["time"]) * 1000 - SERVER_OFFSET_MS,
                        "closeTime": int(r["time"]) * 1000 - SERVER_OFFSET_MS + tf_ms,
                    }
                    for r in rates
                ]
                # Chunked: 20k-bar exports go out in 5k-bar batches so a single
                # request never blocks the tick stream for long.
                written = 0
                for i in range(0, len(candles), 5000):
                    chunk = candles[i : i + 5000]
                    try:
                        post(
                            "/internal/candles/history",
                            {"symbol": fx, "timeframe": "1D" if tf == "1d" else tf, "candles": chunk},
                            retries=10,
                        )
                        written += len(chunk)
                    except Exception as err:  # noqa: BLE001 - keep exporting
                        print(f"[mt5-bridge] history chunk FAILED {symbol} {tf}: {err}")
                print(
                    f"[mt5-bridge] history exported {symbol} {tf}: {written}/{len(candles)} candles"
                )

    print(
        f"[mt5-bridge] streaming {len(symbols)} symbols -> {BACKEND_URL} (mode=LIVE, source=MT5)"
    )
    batch: List[Dict[str, Any]] = []
    last_post = 0.0
    ticks = 0
    # symbol_info_tick returns the LAST KNOWN quote — without change detection
    # the 10ms inner loop appended ~20 copies of the same tick per symbol per
    # batch: duplicate noise, inflated counters, needless payload.
    last_sent: Dict[str, tuple] = {}
    while True:
        for symbol in symbols:
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                continue
            bid = to_python_price(tick.bid)
            ask = to_python_price(tick.ask)
            msc = getattr(tick, "time_msc", None)
            server_ms = int(msc) if msc else int(tick.time * 1000)
            sig = (bid, ask, server_ms)
            if last_sent.get(symbol) == sig:
                continue
            last_sent[symbol] = sig
            mid = (bid + ask) / 2.0
            batch.append(
                {
                    "timestamp": server_ms - SERVER_OFFSET_MS,
                    "symbol": fx_symbol(symbol),
                    "bid": bid,
                    "ask": ask,
                    "mid": round(mid, 5),
                    "spread": round(ask - bid, 5),
                    "source": "MT5",
                    "spreadModeled": False,
                }
            )
        now = time.time()
        if batch and (now - last_post) * 1000 >= POLL_MS:
            try:
                post("/internal/ticks", {"ticks": batch}, retries=0)
                ticks += len(batch)
            except Exception as err:  # noqa: BLE001 - bridge must keep running
                print(f"[mt5-bridge] push failed: {err}")
                time.sleep(2)
            batch = []
            last_post = now
        time.sleep(0.01)


if __name__ == "__main__":
    main()
