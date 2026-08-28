#!/usr/bin/env python3
"""Local checks for community rating math (no live API)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.rating import listen_points, user_contribution, parse_local_key, coerce_stored_points


def check(cond, msg):
    if not cond:
        raise SystemExit("FAIL: " + msg)


check(parse_local_key("sc:/nuah/track") == ("soundcloud", "/nuah/track"), "sc key")
check(parse_local_key("12345") == ("soundeo", "12345"), "soundeo key")

check(listen_points(1.5) == 0.0, "too short")
pts_2 = listen_points(2)
pts_4_5 = listen_points(4.5)
pts_12 = listen_points(12)
pts_30_5 = listen_points(30.5)
pts_45 = listen_points(45)
check(pts_2 < pts_4_5 < pts_12 < pts_30_5 < pts_45, "monotonic continuous curve")
check(pts_2 < 0 < pts_45, "short negative, long positive")
check(abs(pts_12) <= 5, "≈12s near neutral")
gap = pts_30_5 - pts_4_5
check(20 <= gap <= 60, "4.5s vs 30.5s moderate gap, got " + str(gap))

check(user_contribution(download_count=1, best_listen_sec=3) == 100, "download over listen")
check(user_contribution(best_listen_sec=45) == int(round(listen_points(45))), "full listen")
check(user_contribution(best_listen_sec=5) == round(listen_points(5)), "continuous 5s")
check(
    user_contribution(play_count=2, best_listen_sec=45)
    == int(round(listen_points(45))) + 20,
    "replay",
)
check(user_contribution(skip_count=1) == -50, "legacy skip")
check(coerce_stored_points(1.0) == 48, "legacy +1 → +48")
check(coerce_stored_points(-2.0) == -48, "legacy -2 → -48")
check(coerce_stored_points(55) == 55, "new scale passthrough")
print("OK")
