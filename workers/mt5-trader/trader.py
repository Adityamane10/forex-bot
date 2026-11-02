"""
MT5 demo-account trade executor.

Pairs with the backend's Mt5MirrorService: the backend queues OPEN/CLOSE
commands whenever the signal engine opens/closes a PAPER position; this worker
long-polls the command queue, executes each command on the local MetaTrader 5
(demo account), and reports results back. The dashboard stays the source of
truth — every mirrored trade exists in BOTH places, opened and closed together.

Commands:
    {id, action:"OPEN",   symbol, direction:"BUY"|"SELL", lots,
     sl?: number|null, tp?: number|null, comment}
    {id, action:"CLOSE",  ticket, lots?, comment}

Results:
    {id, ok, ticket?, price?, error?}

Requirements: same host as the MT5 terminal; pip install MetaTrader5;
MT5_LOGIN / MT5_PASSWORD / MT5_SERVER for an explicit DEMO login (or omit to
attach to the already-logged-in terminal).

REAL-MONEY SAFETY
-----------------
The worker reports which kind of account it is attached to (DEMO / CONTEST /
REAL) and refuses to place any order on a REAL or CONTEST account unless
MT5_ALLOW_REAL=1 is set explicitly on THIS host. The backend additionally gates
dispatch on the broker-account binding (see backend/src/broker), so a real
account cannot be traded by accident from either side.

Run:  py workers/mt5-trader/trader.py
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

BACKEND_URL = os.environ.get("BACKEND_URL", "http://127.0.0.1:4000")
TOKEN = os.environ.get("INTERNAL_API_TOKEN", "")
POLL_SECONDS = float(os.environ.get("MT5_TRADER_POLL_S", "1.0"))
HEARTBEAT_SECONDS = 10.0
# Live-money opt-in. Off by default: a real XM account bound to this terminal
# must never start trading because the platform happened to be running.
ALLOW_REAL = os.environ.get("MT5_ALLOW_REAL", "").lower() in ("1", "true", "yes")
# Trade mode of the attached account (DEMO / CONTEST / REAL / UNKNOWN), read at
# startup and refreshed on every heartbeat so a terminal that gets switched to a
# real login is noticed instead of silently traded.
ACCOUNT_TRADE_MODE = "UNKNOWN"

SYMBOL_ALIASES = {
    # Backend symbol -> common MT5 broker names. First match wins.
    "EUR/USD": ["EURUSD"],
    "GBP/USD": ["GBPUSD"],
    "USD/JPY": ["USDJPY"],
    "USD/CHF": ["USDCHF"],
    "AUD/USD": ["AUDUSD"],
    "USD/CAD": ["USDCAD"],
    "NZD/USD": ["NZDUSD"],
    "EUR/GBP": ["EURGBP"],
    "EUR/JPY": ["EURJPY"],
    "GBP/JPY": ["GBPJPY"],
    "XAU/USD": ["XAUUSD", "GOLD", "XAUUSD.a"],
}


def log(msg: str) -> None:
    print(f"[mt5-trader] {msg}", flush=True)


def fail(msg: str) -> None:
    print(f"[mt5-trader] FATAL: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def http_json(
    path: str, payload: dict | None = None, method: str = "POST"
) -> dict | list | None:
    req = urllib.request.Request(
        f"{BACKEND_URL}/api{path}",
        data=json.dumps(payload).encode() if payload is not None else b"",
        headers={"Content-Type": "application/json", "X-Internal-Token": TOKEN},
        method=method,
    )
    try:
        with urllib.request.urlopen(
            req, timeout=35 if path == "/internal/mt5/commands" else 10
        ) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:200]
        except Exception:
            pass
        # A 404 means the trader feature is disabled server-side — fatal so the
        # operator notices instead of a silent no-op loop.
        raise RuntimeError(f"{path} -> HTTP {e.code} {body}")
    except urllib.error.URLError as e:
        # Transient (backend restarting): caller decides whether to retry.
        raise ConnectionError(str(e))


def attach_mt5(mt5, login, password, server):
    """Wait until the terminal is running AND logged in, then return the account.

    The all-in-one dev startup launches the MetaTrader application together with
    the platform, so the terminal is often still loading (or still logging in)
    when this worker starts. Failing instantly there is not a helpful error — it
    is a race that costs a watchdog cooldown with nothing executing. So wait,
    bounded by MT5_STARTUP_WAIT_S (default 180s), and only then give up.

    Returns (account_info, last_error); account_info is None on timeout.
    """
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
        except Exception as exc:  # noqa: BLE001 — a failing terminal raises too
            ok = False
            err = str(exc)
        else:
            err = mt5.last_error()
        if ok:
            acct = mt5.account_info()
            if acct is not None:
                return acct, err
        else:
            acct = None
        # Not usable yet: release the (possibly partial) connection first, or the
        # next initialize() can no-op against a half-open terminal handle.
        try:
            mt5.shutdown()
        except Exception:  # noqa: BLE001
            pass
        if time.time() >= deadline:
            return None, err
        if attempt == 1:
            log(
                f"waiting for the MetaTrader terminal to be running and logged in "
                f"(up to {int(wait_s)}s)… last error: {err}"
            )
        elif attempt % 5 == 0:
            log(f"still waiting for MT5 ({int(deadline - time.time())}s left, last error: {err})")
        time.sleep(3)


def trade_mode_name(mt5, acct) -> str:
    """Map MT5's numeric trade_mode onto the backend's vocabulary."""
    mode = getattr(acct, "trade_mode", None)
    table = {
        getattr(mt5, "ACCOUNT_TRADE_MODE_DEMO", 0): "DEMO",
        getattr(mt5, "ACCOUNT_TRADE_MODE_CONTEST", 1): "CONTEST",
        getattr(mt5, "ACCOUNT_TRADE_MODE_REAL", 2): "REAL",
    }
    if mode is None:
        return "UNKNOWN"
    return table.get(int(mode), "UNKNOWN")


def collect_symbol_specs(mt5) -> list:
    """Broker-issued contract specs for every symbol this worker trades.

    These are the account's REAL lot geometry (contract size, min/max/step,
    minimum stop distance, live spread, swaps). The backend uses them to size
    positions for the SELECTED account type instead of platform constants.
    """
    out = []
    # One instrument, one spec. Two alias keys can legitimately point at the same
    # broker symbol (any '/' vs '' spelling of a pair); without this guard the
    # backend would receive a second spec under a symbol the platform does not
    # know, and publish a sizing override for it.
    seen: set[str] = set()
    for platform_symbol, candidates in SYMBOL_ALIASES.items():
        info = None
        for cand in candidates:
            info = mt5.symbol_info(cand)
            if info is not None:
                break
        if info is None:
            continue
        resolved = str(info.name)
        if resolved in seen:
            continue
        seen.add(resolved)
        out.append(
            {
                "symbol": resolved,
                "platformSymbol": platform_symbol,
                "contractSize": float(getattr(info, "trade_contract_size", 0.0) or 0.0),
                "volumeMin": float(getattr(info, "volume_min", 0.0) or 0.0),
                "volumeMax": float(getattr(info, "volume_max", 0.0) or 0.0),
                "volumeStep": float(getattr(info, "volume_step", 0.0) or 0.0),
                "digits": int(getattr(info, "digits", 0) or 0),
                "point": float(getattr(info, "point", 0.0) or 0.0),
                "stopsLevelPoints": int(getattr(info, "trade_stops_level", 0) or 0),
                "spreadPoints": int(getattr(info, "spread", 0) or 0),
                "swapLong": float(getattr(info, "swap_long", 0.0) or 0.0),
                "swapShort": float(getattr(info, "swap_short", 0.0) or 0.0),
                # Which unit swaps are charged in. Only POINTS (0) is interpreted
                # by the backend; anything else is reported honestly as
                # unmodelled instead of being misread as points.
                "swapMode": int(getattr(info, "swap_mode", -1)),
                # Execution capability of the symbol (FOK/IOC/RETURN bitmask).
                "fillingMode": int(getattr(info, "filling_mode", 0) or 0),
                "path": str(getattr(info, "path", "") or ""),
                "description": str(getattr(info, "description", "") or ""),
            }
        )
    return out


def collect_open_positions(mt5) -> list:
    """Every open position on the account, for backend reconciliation.

    The backend diffs this against its own open positions: when the terminal's
    server-side SL/TP closes a position, the backend learns about it here
    instead of showing a position the broker no longer holds.
    """
    out = []
    reverse_alias = {}
    for platform_symbol, candidates in SYMBOL_ALIASES.items():
        for cand in candidates:
            reverse_alias.setdefault(cand.upper(), platform_symbol)
    for p in mt5.positions_get() or []:
        broker_sym = str(p.symbol).upper()
        platform_symbol = reverse_alias.get(broker_sym, broker_sym)
        ptype = getattr(p, "type", -1)
        direction = "BUY" if ptype == getattr(mt5, "POSITION_TYPE_BUY", 0) else "SELL"
        out.append(
            {
                "ticket": int(p.ticket),
                "symbol": platform_symbol,
                "brokerSymbol": str(p.symbol),
                "direction": direction,
                "lots": float(p.volume),
                "openPrice": float(p.price_open),
                "currentPrice": float(getattr(p, "price_current", 0.0) or 0.0),
                "profit": float(getattr(p, "profit", 0.0)),
                "swap": float(getattr(p, "swap", 0.0)),
                "sl": float(getattr(p, "sl", 0.0) or 0.0),
                "tp": float(getattr(p, "tp", 0.0) or 0.0),
                "magic": int(getattr(p, "magic", 0) or 0),
            }
        )
    return out


def request_price(mt5, info, direction: str):
    """Fresh tick with a bounded refresh: retcodes like REQUOTE / PRICE_CHANGED
    need a NEW price, not a retry of the stale one. Returns (price, tick) or
    (None, None)."""
    for _ in range(3):
        tick = mt5.symbol_info_tick(info.name)
        if tick is not None:
            price = tick.ask if direction == "BUY" else tick.bid
            if price and price > 0:
                return price, tick
        time.sleep(0.05)
    return None, None


def send_order_with_retry(mt5, request: dict, info, direction: str, max_attempts: int = 3):
    """order_send with requote/price-change retry and filling-mode fallback.

    Retries are TRANSIENT-ONLY (REQUOTE, PRICE_CHANGED, PRICE_OFF, TIMEOUT,
    CONNECTION): every attempt refreshes the price first, so a stale quote is
    never resubmitted. Permanent rejects return immediately with the retcode.
    """
    transient = {
        getattr(mt5, "TRADE_RETCODE_REQUOTE", 10004),
        getattr(mt5, "TRADE_RETCODE_PRICE_CHANGED", 10015),
        getattr(mt5, "TRADE_RETCODE_PRICE_OFF", 10021),
        getattr(mt5, "TRADE_RETCODE_TIMEOUT", 10012),
        getattr(mt5, "TRADE_RETCODE_CONNECTION", 10031),
    }
    filling_modes = [request.get("type_filling", mt5.ORDER_FILLING_IOC), mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_RETURN]
    filling_idx = 0
    last = None
    for attempt in range(1, max_attempts + 1):
        price, _tick = request_price(mt5, info, direction)
        if price is None:
            return None, "no fresh quote available for retry"
        request["price"] = price
        request["type_filling"] = filling_modes[min(filling_idx, len(filling_modes) - 1)]
        result = mt5.order_send(request)
        if result is None:
            last = f"order_send returned None ({mt5.last_error()})"
        elif result.retcode == getattr(mt5, "TRADE_RETCODE_DONE", 10009):
            return result, None
        elif result.retcode == getattr(mt5, "TRADE_RETCODE_INVALID_FILL", 10030):
            # Filling mode unsupported: next attempt tries the next mode.
            filling_idx = min(filling_idx + 1, len(filling_modes) - 1)
            last = f"retcode {result.retcode} (invalid filling, switching mode)"
        elif result.retcode in transient:
            last = f"retcode {result.retcode} (transient, attempt {attempt}/{max_attempts})"
            time.sleep(0.1 * attempt)
        else:
            # Permanent: no point retrying (NO_MONEY, INVALID, MARKET_CLOSED...)
            return result, f"retcode {result.retcode}: {getattr(result, 'comment', '')}"
    return None, last


def resolve_symbol(mt5, symbol: str):
    """Backend 'EUR/USD' style names -> broker symbol that exists in Market Watch."""
    candidates = SYMBOL_ALIASES.get(symbol, [symbol.replace("/", "")])
    for cand in candidates:
        info = mt5.symbol_info(cand)
        if info is not None:
            mt5.symbol_select(cand, True)
            return info
    return None


def resolve_open_ticket(mt5, result) -> int:
    """Resolve the POSITION id that owns a filled market order.

    Some brokers (netting accounts, certain XM/derivative servers) fill the
    order but report result.order == 0 on the DEAL response — trusting that
    field made the backend reject the result (ticket must be > 0) and re-serve
    the same OPEN forever (duplicate fills observed live). The position id is
    what positions_get()/do_close() need, so resolve it properly:
      1. result.deal -> history_deals_get(ticket=deal).position   (normal case)
      2. history_deals_get(...) filtered by result.order             (deal==0)
      3. the newest OUT-free DEAL on our magic in the last hour       (last resort)
      4. result.order itself, if the broker ever reports a nonzero one
    """
    order_ticket = int(getattr(result, "order", 0) or 0)
    deal_ticket = int(getattr(result, "deal", 0) or 0)
    magic = int(os.environ.get("MT5_MAGIC", "860860"))

    def deal_position(d) -> int:
        return int(getattr(d, "position", 0) or 0)

    if deal_ticket:
        try:
            deals = mt5.history_deals_get(ticket=deal_ticket) or []
            for d in deals:
                p = deal_position(d)
                if p:
                    return p
        except Exception:  # noqa: BLE001 — history lookup is best-effort
            pass

    # Give the trade transaction a beat to land in history, then search.
    for wait in (0.0, 0.25, 0.5):
        if wait:
            time.sleep(wait)
        try:
            frm = time.time() - 3600
            deals = mt5.history_deals_get(frm, time.time() + 60) or []
            candidates = [
                d for d in deals
                if order_ticket and int(getattr(d, "order", 0) or 0) == order_ticket
            ]
            if not candidates:
                # Fall back to the newest entry DEAL matching our magic that
                # still has a live position (an OPEN we just placed).
                entry_like = [
                    d for d in deals
                    if int(getattr(d, "magic", 0) or 0) == magic
                    and deal_position(d)
                    and str(getattr(d, "entry", "") ) in ("0", "DEAL_ENTRY_IN")
                ]
                candidates = sorted(
                    entry_like,
                    key=lambda d: getattr(d, "time_msc", 0) or getattr(d, "time", 0),
                    reverse=True,
                )[:1]
            for d in candidates:
                p = deal_position(d)
                if p:
                    return p
        except Exception:  # noqa: BLE001
            continue

    return order_ticket  # better than nothing; usually nonzero on retry


def do_open(mt5, cmd: dict) -> dict:
    info = resolve_symbol(mt5, cmd["symbol"])
    if info is None:
        return {"ok": False, "error": f"symbol not found in MT5: {cmd['symbol']}"}

    direction = cmd["direction"].upper()
    order_type = mt5.ORDER_TYPE_BUY if direction == "BUY" else mt5.ORDER_TYPE_SELL
    digits = info.digits

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": info.name,
        "volume": float(cmd["lots"]),
        "type": order_type,
        "deviation": int(os.environ.get("MT5_DEVIATION_POINTS", "20")),
        "magic": int(os.environ.get("MT5_MAGIC", "860860")),
        "comment": str(cmd.get("comment", "fx-bot"))[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    sl, tp = cmd.get("sl"), cmd.get("tp")
    if sl:
        request["sl"] = round(float(sl), digits)
    if tp:
        request["tp"] = round(float(tp), digits)

    result, err = send_order_with_retry(mt5, request, info, direction)
    # err is non-None for EVERY non-DONE outcome (e.g. retcode 10027
    # "AutoTrading disabled by client" comes back as a non-None result).
    # Treating a rejected order as ok=True made the backend mark the mirror
    # EXECUTED while the terminal never received the order at all.
    if result is None or err:
        return {"ok": False, "error": err or "order failed"}

    deal_price = getattr(result, "price", None) or request.get("price") or 0.0
    # Report the POSITION id (never a raw order==0 — see resolve_open_ticket):
    # the backend stores it and every CLOSE targets positions_get(ticket=...).
    # With ticket omitted the command still completes (no duplicate fills),
    # but only a real ticket lets the backend close this position later.
    ticket = resolve_open_ticket(mt5, result)
    out = {"ok": True, "price": float(deal_price)}
    if ticket > 0:
        out["ticket"] = ticket
        out["broker_order"] = int(getattr(result, "order", 0) or 0)
    return out


def do_close(mt5, cmd: dict) -> dict:
    ticket = int(cmd["ticket"])
    pos = None
    for p in mt5.positions_get(ticket=ticket) or []:
        pos = p
        break
    if pos is None:
        # Already closed (e.g. broker-side SL/TP fired first) — treat as done.
        return {"ok": True, "ticket": ticket, "already_closed": True}

    info = mt5.symbol_info(pos.symbol)
    if info is None:
        return {"ok": False, "error": f"symbol vanished: {pos.symbol}"}

    close_type = (
        mt5.ORDER_TYPE_SELL if pos.type == mt5.POSITION_TYPE_BUY else mt5.ORDER_TYPE_BUY
    )
    direction = "SELL" if close_type == mt5.ORDER_TYPE_SELL else "BUY"
    volume = float(cmd.get("lots") or pos.volume)
    volume = min(volume, pos.volume)

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "position": ticket,
        "symbol": pos.symbol,
        "volume": volume,
        "type": close_type,
        "deviation": int(os.environ.get("MT5_DEVIATION_POINTS", "20")),
        "magic": int(os.environ.get("MT5_MAGIC", "860860")),
        "comment": str(cmd.get("comment", "fx-bot-close"))[:31],
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result, err = send_order_with_retry(mt5, request, info, direction)
    if result is None or err:
        return {"ok": False, "error": f"close failed: {err or 'order failed'}"}
    return {
        "ok": True,
        "ticket": ticket,
        "price": float(getattr(result, "price", None) or request.get("price") or 0.0),
        "closed_lots": volume,
    }


def do_flatten(mt5, cmd: dict) -> dict:
    """Close every open position (kill switch).

    When the command carries a magic number, only positions opened by this
    platform are closed; with no magic filter the operator wants EVERYTHING
    gone (that is the point of a kill switch). One bad close does not stop the
    sweep; every failure is reported back individually.
    """
    magic_filter = cmd.get("magic") or int(os.environ.get("MT5_MAGIC", "860860"))
    include_foreign = bool(cmd.get("includeForeign", False))
    closed, failed, errors = 0, 0, []
    for p in mt5.positions_get() or []:
        p_magic = int(getattr(p, "magic", 0) or 0)
        if p_magic and p_magic != magic_filter and not include_foreign:
            continue  # not ours — leave it alone unless explicitly asked
        res = do_close(mt5, {"ticket": int(p.ticket)})
        if res.get("ok"):
            closed += 1
        else:
            failed += 1
            errors.append({"ticket": int(p.ticket), "error": res.get("error", "unknown")})
    return {"ok": failed == 0, "closed": closed, "failed": failed, "errors": errors}


def main() -> None:
    name, lock_name = "mt5-trader", "forextbot-trader.lock"
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

    if not TOKEN:
        fail("INTERNAL_API_TOKEN not set (must match the backend)")
    try:
        import MetaTrader5 as mt5
    except ImportError:
        fail("MetaTrader5 package not installed on this host (pip install MetaTrader5)")

    login = os.environ.get("MT5_LOGIN")
    password = os.environ.get("MT5_PASSWORD")
    server = os.environ.get("MT5_SERVER")
    acct, err = attach_mt5(mt5, login, password, server)
    if acct is None:
        fail(
            f"MT5 not usable after waiting: {err} — is the terminal running, logged in "
            "and is Algo Trading enabled? (MT5_STARTUP_WAIT_S lengthens the wait)"
        )
    global ACCOUNT_TRADE_MODE
    ACCOUNT_TRADE_MODE = trade_mode_name(mt5, acct)
    log(
        f"attached: account {acct.login} server={acct.server} company={getattr(acct, 'company', '?')} "
        f"balance={acct.balance} {acct.currency} leverage=1:{getattr(acct, 'leverage', '?')} mode={ACCOUNT_TRADE_MODE}"
    )
    if ACCOUNT_TRADE_MODE == "REAL":
        if ALLOW_REAL:
            log("REAL-MONEY ACCOUNT: live order placement is ENABLED (MT5_ALLOW_REAL=1)")
        else:
            log(
                "REAL-MONEY ACCOUNT detected: orders will be REFUSED. "
                "Log in with a demo account, or set MT5_ALLOW_REAL=1 on this host to trade live money."
            )
    elif ACCOUNT_TRADE_MODE == "CONTEST":
        log("CONTEST account: orders will be refused (not a tradeable account type).")
    elif ACCOUNT_TRADE_MODE == "UNKNOWN":
        log("account trade mode could not be read: orders will be refused until it can be.")

    worker_id = os.environ.get("MT5_TRADER_ID", f"trader-{uuid.uuid4().hex[:6]}")
    log(
        f"worker {worker_id} polling every {POLL_SECONDS}s — executes at the backend's broker-account gate "
        f"(account type, verified conditions, demo/real mode)"
    )

    last_heartbeat = 0.0

    def send_heartbeat():
        try:
            info = mt5.account_info()
            if info is not None:
                payload = {
                    "workerId": worker_id,
                    "account": {
                        "login": int(info.login),
                        "server": str(info.server),
                        "company": str(getattr(info, "company", "") or ""),
                        "balance": float(info.balance),
                        "currency": str(info.currency),
                        "equity": float(getattr(info, "equity", info.balance)),
                        "profit": float(getattr(info, "profit", 0.0)),
                        "margin": float(getattr(info, "margin", 0.0)),
                        "freeMargin": float(getattr(info, "margin_free", 0.0)),
                        "leverage": int(getattr(info, "leverage", 0) or 0),
                        "tradeMode": trade_mode_name(mt5, info),
                        "marginCallLevelPct": float(getattr(info, "margin_so_call", 0.0) or 0.0),
                        "stopOutLevelPct": float(getattr(info, "margin_so_so", 0.0) or 0.0),
                        # Broker-issued contract specs: what makes lot sizing follow
                        # the SELECTED account type (a micro contract is 100x smaller).
                        "symbolSpecs": collect_symbol_specs(mt5),
                        # Live open positions for backend reconciliation (server-side
                        # SL/TP closures are discovered here).
                        "positions": collect_open_positions(mt5),
                    },
                }
                http_json("/internal/mt5/heartbeat", payload, method="POST")
                # The backend converts the balance into the dashboard currency over
                # the LIVE conversion feed (never a fixed rate) and holds orders
                # while the account binding is unverified.
                log(
                    f"heartbeat: bal={info.balance:.2f} {info.currency} eq={getattr(info, 'equity', info.balance):.2f} "
                    f"profit={getattr(info, 'profit', 0):.2f} mode={trade_mode_name(mt5, info)}"
                )
            else:
                http_json(
                    "/internal/mt5/heartbeat", {"workerId": worker_id}, method="POST"
                )
        except Exception as exc:  # noqa: BLE001 — heartbeat is best-effort
            log(f"heartbeat failed: {exc}")

    # initial heartbeat
    send_heartbeat()
    last_heartbeat = time.time()

    while True:
        # periodic heartbeat every HEARTBEAT_SECONDS — keeps dashboard balance in sync
        # with MT5 demo money (converted to INR when wallet is INR).
        if time.time() - last_heartbeat >= HEARTBEAT_SECONDS:
            send_heartbeat()
            last_heartbeat = time.time()

        try:
            res = http_json(
                "/internal/mt5/commands", {"workerId": worker_id}, method="POST"
            )
            commands = res.get("commands", []) if isinstance(res, dict) else []
        except RuntimeError as e:
            log(f"backend rejected command poll: {e}")
            time.sleep(5)
            continue
        except ConnectionError:
            time.sleep(3)
            continue

        for cmd in commands:
            cid = cmd.get("id") or f"cmd-{uuid.uuid4().hex[:8]}"
            action = (cmd.get("action") or "").upper()
            log(f"executing {cid}: {action} {cmd.get('symbol') or cmd.get('ticket')}")
            # Real-money guard, independent of the backend gate: this process
            # never places an order on a REAL or CONTEST account unless the
            # operator opted in on purpose on THIS host.
            if ACCOUNT_TRADE_MODE == "REAL" and not ALLOW_REAL:
                out = {
                    "id": cid,
                    "ok": False,
                    "error": "real-money account: order refused (set MT5_ALLOW_REAL=1 on the trader host to permit live orders)",
                }
                log(f"  -> REFUSED {cid}: real account, live orders not permitted")
                try:
                    http_json("/internal/mt5/results", {"results": [out]})
                except Exception as exc:  # noqa: BLE001
                    log(f"  refusal report failed: {exc}")
                continue
            if ACCOUNT_TRADE_MODE in ("CONTEST", "UNKNOWN"):
                out = {"id": cid, "ok": False, "error": f"account mode {ACCOUNT_TRADE_MODE}: orders are not permitted"}
                log(f"  -> REFUSED {cid}: account mode {ACCOUNT_TRADE_MODE}")
                try:
                    http_json("/internal/mt5/results", {"results": [out]})
                except Exception as exc:  # noqa: BLE001
                    log(f"  refusal report failed: {exc}")
                continue
            try:
                if action == "OPEN":
                    out = do_open(mt5, cmd)
                    # Log INR conversion for dashboard ₹ targets: lots already sized via
                    # backend's live USD/INR, so MT5 USD profit will map to ₹ target.
                    if out.get("ok"):
                        log(
                            f"  -> OPEN OK ticket={out.get('ticket')} price={out.get('price')} lots={cmd.get('lots')} (MT5 demo balance debited)"
                        )
                elif action == "CLOSE":
                    out = do_close(mt5, cmd)
                    if out.get("ok"):
                        log(
                            f"  -> CLOSE OK ticket={cmd.get('ticket')} (MT5 demo profit realized)"
                        )
                elif action == "FLATTEN":
                    # Kill-switch support: close EVERY position this platform's
                    # magic number owns (falls back to all positions when the
                    # command carries no magic filter and none is configured).
                    out = do_flatten(mt5, cmd)
                    if out.get("ok"):
                        log(f"  -> FLATTEN OK closed={out.get('closed')} failed={out.get('failed')}")
                else:
                    out = {"ok": False, "error": f"unknown action {action}"}
            except Exception as exc:  # noqa: BLE001 — one bad command must not kill the worker
                out = {"ok": False, "error": f"exception: {exc}"}
            out.update({"id": cid})
            try:
                http_json("/internal/mt5/results", {"results": [out]})
                log(
                    f"  -> {'OK' if out.get('ok') else 'FAILED'} {out.get('ticket') or out.get('error')}"
                )
            except Exception as exc:  # noqa: BLE001
                log(f"  result report failed (will retry via heartbeat): {exc}")
            # heartbeat immediately after execution so balance sync is instant
            try:
                send_heartbeat()
                last_heartbeat = time.time()
            except Exception:
                pass

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
