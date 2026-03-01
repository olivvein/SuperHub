# iss_updater.py
from __future__ import annotations

import asyncio
import math
import os
import time
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
    ws_url_with_token,
)

CELESTRAK_STATIONS_URL = "http://www.celestrak.com/NORAD/elements/stations.txt"


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

    raise RuntimeError("ISS TLE not found in stations.txt")


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


async def run() -> None:
    token = os.getenv("HUB_TOKEN")
    client_id = os.getenv("CLIENT_ID") or f"py-iss-updater-{now_ms()}"

    http_url = default_http_url()
    ws_url = ws_url_with_token(default_ws_url(http_url), token)
    source = {"clientId": client_id, "serviceName": "iss-updater"}

    sat: Optional[Satrec] = None
    tle: Optional[IssTle] = None
    last_tle_fetch = 0.0

    async with websockets.connect(ws_url, ping_interval=20, ping_timeout=20, max_size=1024 * 1024) as ws:
        print(f"iss-updater connected ({client_id}) -> {ws_url}")

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

        async def ensure_tle() -> None:
            nonlocal sat, tle, last_tle_fetch
            now_s = time.time()
            if sat is not None and (now_s - last_tle_fetch) < 6 * 3600:
                return

            tle = await fetch_iss_tle()
            sat = Satrec.twoline2rv(tle.line1, tle.line2)
            last_tle_fetch = now_s
            print("TLE loaded:", tle.name)

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

        async def reader() -> None:
            async for raw in ws:
                msg = decode_json(raw)
                if msg.get("type") == "error":
                    print("hub error", msg.get("payload"))

        reader_task = asyncio.create_task(reader())

        try:
            while True:
                await ensure_tle()
                assert sat is not None

                try:
                    lat, lon, alt_km = iss_position_now(sat)
                    payload = {"lat": lat, "lon": lon, "altKm": alt_km, "at": now_ms()}

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

                await asyncio.sleep(1.0)
        finally:
            reader_task.cancel()


def main() -> None:
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("iss-updater stopped")


if __name__ == "__main__":
    main()