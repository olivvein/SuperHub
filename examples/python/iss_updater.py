# iss_updater.py
from __future__ import annotations

import argparse
import asyncio
import math
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional, Tuple

import websockets
from sgp4.api import Satrec, jday  # pip install sgp4

from hub_protocol import (
    decode_json,
    default_http_url,
    default_ws_url,
    make_envelope,
    make_presence_envelope,
    now_ms,
    send_json,
    tls_context_for_url,
    ws_url_with_token,
)

DEFAULT_TLE_SOURCES = (
    "https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle",
    "https://celestrak.org/NORAD/elements/stations.txt",
    "http://www.celestrak.com/NORAD/elements/stations.txt",
)
DEFAULT_TLE_CACHE_FILE = os.path.join(os.path.expanduser("~"), ".superhub", "iss_tle.txt")
DEFAULT_SEND_HZ = 1.0
MIN_SEND_HZ = 1.0
MAX_SEND_HZ = 50.0


def _fetch_text(url: str, timeout: float = 10.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "py-iss-updater/0.1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


@dataclass
class IssTle:
    name: str
    line1: str
    line2: str


def parse_iss_tle(text: str) -> IssTle:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    # Usually 3-line groups: NAME, L1, L2
    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if "ISS" in name.upper() and l1.startswith("1 ") and l2.startswith("2 "):
            return IssTle(name=name, line1=l1, line2=l2)

    # Fallback sliding window
    for i in range(0, len(lines) - 2):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if "ISS" in name.upper() and l1.startswith("1 ") and l2.startswith("2 "):
            return IssTle(name=name, line1=l1, line2=l2)

    raise RuntimeError("ISS TLE not found in source payload")


def resolve_tle_sources() -> list[str]:
    raw = os.getenv("ISS_TLE_URLS", "").strip()
    if not raw:
        return list(DEFAULT_TLE_SOURCES)

    sources = [item.strip() for item in raw.split(",") if item.strip()]
    return sources or list(DEFAULT_TLE_SOURCES)


def load_cached_tle(cache_file: str) -> Optional[IssTle]:
    try:
        with open(cache_file, "r", encoding="utf-8") as handle:
            text = handle.read()
        return parse_iss_tle(text)
    except Exception:
        return None


def save_cached_tle(cache_file: str, tle: IssTle) -> None:
    try:
        os.makedirs(os.path.dirname(cache_file), exist_ok=True)
        with open(cache_file, "w", encoding="utf-8") as handle:
            handle.write(f"{tle.name}\n{tle.line1}\n{tle.line2}\n")
    except Exception:
        return


async def fetch_iss_tle(sources: list[str]) -> IssTle:
    errors: list[str] = []
    for source in sources:
        try:
            text = await asyncio.to_thread(_fetch_text, source, 10.0)
            return parse_iss_tle(text)
        except urllib.error.HTTPError as exc:
            errors.append(f"{source} -> HTTP {exc.code}")
        except Exception as exc:
            errors.append(f"{source} -> {exc}")

    raise RuntimeError("All TLE sources failed: " + "; ".join(errors))


def gmst_from_jd(jd_ut1: float) -> float:
    # Vallado GMST approximation (ok for realtime visualization)
    T = (jd_ut1 - 2451545.0) / 36525.0
    gmst_sec = (
        67310.54841
        + (876600.0 * 3600.0 + 8640184.812866) * T
        + 0.093104 * T * T
        - 6.2e-6 * T * T * T
    )
    gmst_deg = (gmst_sec % 86400.0) / 240.0  # seconds -> degrees
    return math.radians(gmst_deg)


def teme_to_ecef(r_teme_km: Tuple[float, float, float], jd_ut1: float) -> Tuple[float, float, float]:
    theta = gmst_from_jd(jd_ut1)
    c = math.cos(theta)
    s = math.sin(theta)

    x, y, z = r_teme_km
    x_ecef = c * x + s * y
    y_ecef = -s * x + c * y
    z_ecef = z
    return (x_ecef, y_ecef, z_ecef)


def ecef_to_geodetic_wgs84(r_ecef_km: Tuple[float, float, float]) -> Tuple[float, float, float]:
    # Returns (lat_deg, lon_deg, alt_km)
    x, y, z = (r_ecef_km[0] * 1000.0, r_ecef_km[1] * 1000.0, r_ecef_km[2] * 1000.0)

    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = f * (2.0 - f)

    lon = math.atan2(y, x)
    p = math.hypot(x, y)

    lat = math.atan2(z, p * (1.0 - e2))
    for _ in range(8):
        sin_lat = math.sin(lat)
        N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
        alt = p / math.cos(lat) - N
        lat = math.atan2(z, p * (1.0 - e2 * (N / (N + alt))))

    sin_lat = math.sin(lat)
    N = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    alt = p / math.cos(lat) - N

    lat_deg = math.degrees(lat)
    lon_deg = (math.degrees(lon) + 540.0) % 360.0 - 180.0
    alt_km = alt / 1000.0
    return (lat_deg, lon_deg, alt_km)


def iss_position_now(sat: Satrec) -> Tuple[float, float, float]:
    # Use UTC for jday; add fractional seconds for smoother updates
    now = time.time()
    t = time.gmtime(now)
    frac = now - int(now)

    jd, fr = jday(t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec + frac)

    e, r_teme_km, _v = sat.sgp4(jd, fr)
    if e != 0:
        raise RuntimeError(f"sgp4 error {e}")

    jd_ut1 = jd + fr
    r_ecef_km = teme_to_ecef((r_teme_km[0], r_teme_km[1], r_teme_km[2]), jd_ut1)
    lat, lon, alt_km = ecef_to_geodetic_wgs84(r_ecef_km)
    return (lat, lon, alt_km)


def resolve_send_hz(cli_hz: Optional[float]) -> float:
    raw = cli_hz if cli_hz is not None else os.getenv("ISS_SEND_HZ", str(DEFAULT_SEND_HZ))
    try:
        hz = float(raw)
    except (TypeError, ValueError):
        print(f"Invalid ISS send rate '{raw}', fallback to {DEFAULT_SEND_HZ} Hz")
        return DEFAULT_SEND_HZ

    if hz < MIN_SEND_HZ:
        print(f"ISS send rate {hz} Hz is below {MIN_SEND_HZ} Hz, clamped.")
        return MIN_SEND_HZ
    if hz > MAX_SEND_HZ:
        print(f"ISS send rate {hz} Hz is above {MAX_SEND_HZ} Hz, clamped.")
        return MAX_SEND_HZ
    return hz


async def run(send_hz: float) -> None:
    token = os.getenv("HUB_TOKEN")
    client_id = os.getenv("CLIENT_ID") or f"py-iss-updater-{now_ms()}"
    send_interval_s = 1.0 / send_hz

    http_url = default_http_url()
    ws_url = ws_url_with_token(default_ws_url(http_url), token)
    source = {"clientId": client_id, "serviceName": "iss-updater"}

    sat: Optional[Satrec] = None
    tle: Optional[IssTle] = None
    last_tle_fetch = 0.0
    next_tle_retry_at = 0.0
    last_tle_error_log_at = 0.0
    tle_sources = resolve_tle_sources()
    tle_cache_file = os.getenv("ISS_TLE_CACHE_FILE", DEFAULT_TLE_CACHE_FILE)
    tle_refresh_s = 6 * 3600.0
    tle_retry_s = 15.0
    tle_error_log_interval_s = 15.0

    async with websockets.connect(
        ws_url,
        ping_interval=20,
        ping_timeout=20,
        max_size=1024 * 1024,
        ssl=tls_context_for_url(ws_url),
    ) as ws:
        print(f"iss-updater connected ({client_id}) -> {ws_url}")
        print(f"ISS update rate: {send_hz:.3f} Hz ({send_interval_s * 1000.0:.1f} ms)")

        await send_json(
            ws,
            make_presence_envelope(
                client_id=client_id,
                service_name="iss-updater",
                version="0.1.0",
                provides=[],
                consumes=[],
                tags=["example", "python", "updater"],
            ),
        )

        async def ensure_tle() -> bool:
            nonlocal sat, tle, last_tle_fetch, next_tle_retry_at, last_tle_error_log_at
            now_s = time.time()
            if sat is not None and (now_s - last_tle_fetch) < tle_refresh_s:
                return True
            if now_s < next_tle_retry_at:
                return sat is not None

            try:
                tle = await fetch_iss_tle(tle_sources)
                sat = Satrec.twoline2rv(tle.line1, tle.line2)
                last_tle_fetch = now_s
                next_tle_retry_at = 0.0
                print("TLE loaded:", tle.name)
                save_cached_tle(tle_cache_file, tle)
                try:
                    await send_json(
                        ws,
                        make_envelope(
                            msg_type="cmd",
                            name="state_set",
                            source=source,
                            target={"serviceName": "hub"},
                            schema_version=1,
                            payload={
                                "path": "state/iss/tle",
                                "value": {
                                    "name": tle.name,
                                    "line1": tle.line1,
                                    "line2": tle.line2,
                                    "fetchedAt": now_ms(),
                                },
                            },
                        ),
                    )
                except Exception as exc:
                    print("warning: failed to publish TLE state:", exc)
                return True
            except Exception as exc:
                next_tle_retry_at = now_s + tle_retry_s

                if sat is None:
                    cached = load_cached_tle(tle_cache_file)
                    if cached is not None:
                        tle = cached
                        sat = Satrec.twoline2rv(cached.line1, cached.line2)
                        last_tle_fetch = now_s
                        print(f"TLE fetch failed, using cached TLE from {tle_cache_file}: {cached.name}")
                        return True

                if (now_s - last_tle_error_log_at) >= tle_error_log_interval_s:
                    print(f"TLE fetch failed: {exc}. Next retry in {tle_retry_s:.0f}s.")
                    last_tle_error_log_at = now_s
                return sat is not None

        async def reader() -> None:
            async for raw in ws:
                msg = decode_json(raw)
                if msg.get("type") == "error":
                    print("hub error", msg.get("payload"))

        reader_task = asyncio.create_task(reader())

        try:
            next_tick = time.monotonic()
            while True:
                if not await ensure_tle():
                    await asyncio.sleep(min(tle_retry_s, 1.0))
                    next_tick = time.monotonic()
                    continue

                try:
                    if sat is None:
                        continue
                    lat, lon, alt_km = iss_position_now(sat)
                    payload = {"lat": lat, "lon": lon, "altKm": alt_km, "at": now_ms()}
                    print(f"ISS position: {lat:.4f}, {lon:.4f}, {alt_km:.2f} km")

                    await send_json(
                        ws,
                        make_envelope(
                            msg_type="cmd",
                            name="state_set",
                            source=source,
                            target={"serviceName": "hub"},
                            schema_version=1,
                            payload={"path": "state/iss/position", "value": payload},
                        ),
                    )

                    await send_json(
                        ws,
                        make_envelope(
                            msg_type="event",
                            name="iss.position",
                            source=source,
                            target="*",
                            schema_version=1,
                            payload=payload,
                        ),
                    )
                except Exception as e:
                    print("update error:", e)

                next_tick += send_interval_s
                sleep_for = next_tick - time.monotonic()
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)
                else:
                    # We are behind schedule, reset anchor to avoid drift accumulation.
                    next_tick = time.monotonic()
        finally:
            reader_task.cancel()


def main() -> None:
    parser = argparse.ArgumentParser(description="ISS realtime updater for SuperHub")
    parser.add_argument(
        "--hz",
        type=float,
        default=None,
        help=f"Send rate in Hz ({MIN_SEND_HZ}-{MAX_SEND_HZ}). Overrides ISS_SEND_HZ.",
    )
    args = parser.parse_args(sys.argv[1:])
    send_hz = resolve_send_hz(args.hz)

    try:
        asyncio.run(run(send_hz))
    except KeyboardInterrupt:
        print("iss-updater stopped")


if __name__ == "__main__":
    main()
