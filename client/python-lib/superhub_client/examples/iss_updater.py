from __future__ import annotations

import argparse
import asyncio
import math
import os
import sys
import time
import urllib.request
from dataclasses import dataclass
from typing import Optional, Tuple

try:
    from sgp4.api import Satrec, jday
except Exception as exc:  # pragma: no cover - runtime dependency hint
    raise RuntimeError("Missing dependency 'sgp4'. Install with: pip install sgp4") from exc

from superhub_client import SuperHubClient, now_ms

CELESTRAK_STATIONS_URL = "http://www.celestrak.com/NORAD/elements/stations.txt"
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


async def fetch_iss_tle() -> IssTle:
    text = await asyncio.to_thread(_fetch_text, CELESTRAK_STATIONS_URL, 10.0)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]

    for i in range(0, len(lines) - 2, 3):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if "ISS" in name.upper() and l1.startswith("1 ") and l2.startswith("2 "):
            return IssTle(name=name, line1=l1, line2=l2)

    for i in range(0, len(lines) - 2):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if "ISS" in name.upper() and l1.startswith("1 ") and l2.startswith("2 "):
            return IssTle(name=name, line1=l1, line2=l2)

    raise RuntimeError("ISS TLE not found in stations.txt")


def gmst_from_jd(jd_ut1: float) -> float:
    t = (jd_ut1 - 2451545.0) / 36525.0
    gmst_sec = (
        67310.54841
        + (876600.0 * 3600.0 + 8640184.812866) * t
        + 0.093104 * t * t
        - 6.2e-6 * t * t * t
    )
    gmst_deg = (gmst_sec % 86400.0) / 240.0
    return math.radians(gmst_deg)


def teme_to_ecef(r_teme_km: Tuple[float, float, float], jd_ut1: float) -> Tuple[float, float, float]:
    theta = gmst_from_jd(jd_ut1)
    c = math.cos(theta)
    s = math.sin(theta)
    x, y, z = r_teme_km
    return (c * x + s * y, -s * x + c * y, z)


def ecef_to_geodetic_wgs84(r_ecef_km: Tuple[float, float, float]) -> Tuple[float, float, float]:
    x, y, z = (r_ecef_km[0] * 1000.0, r_ecef_km[1] * 1000.0, r_ecef_km[2] * 1000.0)
    a = 6378137.0
    f = 1.0 / 298.257223563
    e2 = f * (2.0 - f)

    lon = math.atan2(y, x)
    p = math.hypot(x, y)
    lat = math.atan2(z, p * (1.0 - e2))

    for _ in range(8):
        sin_lat = math.sin(lat)
        n = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
        alt = p / math.cos(lat) - n
        lat = math.atan2(z, p * (1.0 - e2 * (n / (n + alt))))

    sin_lat = math.sin(lat)
    n = a / math.sqrt(1.0 - e2 * sin_lat * sin_lat)
    alt = p / math.cos(lat) - n
    lat_deg = math.degrees(lat)
    lon_deg = (math.degrees(lon) + 540.0) % 360.0 - 180.0
    return (lat_deg, lon_deg, alt / 1000.0)


def iss_position_now(sat: Satrec) -> Tuple[float, float, float]:
    now = time.time()
    t = time.gmtime(now)
    frac = now - int(now)
    jd, fr = jday(t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec + frac)
    code, r_teme_km, _velocity = sat.sgp4(jd, fr)
    if code != 0:
        raise RuntimeError(f"sgp4 error {code}")
    r_ecef_km = teme_to_ecef((r_teme_km[0], r_teme_km[1], r_teme_km[2]), jd + fr)
    return ecef_to_geodetic_wgs84(r_ecef_km)


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
    client = SuperHubClient(
        token=os.getenv("HUB_TOKEN"),
        client_id=os.getenv("CLIENT_ID") or f"py-iss-updater-{now_ms()}",
        service_name="iss-updater",
        version="0.1.0",
        provides=[],
        consumes=[],
        tags=["example", "python-lib", "updater"],
    )

    client.add_open_listener(lambda: print("iss-updater connected"))
    client.add_close_listener(lambda: print("iss-updater disconnected"))
    client.add_error_listener(lambda error: print("hub error", error))

    await client.connect()
    print(f"ISS update rate: {send_hz:.3f} Hz ({(1000.0 / send_hz):.1f} ms)")

    send_interval_s = 1.0 / send_hz
    sat: Optional[Satrec] = None
    tle: Optional[IssTle] = None
    last_tle_fetch = 0.0

    async def ensure_tle() -> None:
        nonlocal sat, tle, last_tle_fetch
        now_s = time.time()
        if sat is not None and (now_s - last_tle_fetch) < 6 * 3600:
            return

        tle = await fetch_iss_tle()
        sat = Satrec.twoline2rv(tle.line1, tle.line2)
        last_tle_fetch = now_s
        print("TLE loaded:", tle.name)

        await client.set_state(
            "state/iss/tle",
            {
                "name": tle.name,
                "line1": tle.line1,
                "line2": tle.line2,
                "fetchedAt": now_ms(),
            },
        )

    try:
        next_tick = time.monotonic()
        while True:
            await ensure_tle()
            assert sat is not None

            try:
                lat, lon, alt_km = iss_position_now(sat)
                payload = {"lat": lat, "lon": lon, "altKm": alt_km, "at": now_ms()}
                print(f"ISS position: {lat:.4f}, {lon:.4f}, {alt_km:.2f} km")

                await client.set_state("state/iss/position", payload)
                await client.publish("iss.position", payload)
            except Exception as error:
                print("update error:", error)

            next_tick += send_interval_s
            sleep_for = next_tick - time.monotonic()
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)
            else:
                next_tick = time.monotonic()
    finally:
        await client.close()


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
