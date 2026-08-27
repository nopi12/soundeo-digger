#!/usr/bin/env python3
"""Local checks for community rating math (no live API)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.rating import listen_points, user_contribution, parse_local_key


def check(cond, msg):
    if not cond:
        raise SystemExit("FAIL: " + msg)


check(parse_local_key("sc:/nuah/track") == ("soundcloud", "/nuah/track"), "sc key")
check(parse_local_key("12345") == ("soundeo", "12345"), "soundeo key")

check(listen_points(1.5) == 0.0, "too short")
check(listen_points(2) == -2.0, "min listen")
check(listen_points(45) == 1.0, "full listen")
pts_5 = listen_points(5)
check(-2.0 < pts_5 < -1.0, "5s negative but not full skip")
pts_20 = listen_points(20)
check(-1.0 < pts_20 < 0.5, "20s near neutral")

check(user_contribution(download_count=1, best_listen_sec=3) == 5, "download over listen")
check(user_contribution(best_listen_sec=45) == 1, "full listen")
check(user_contribution(best_listen_sec=5) == round(listen_points(5)), "continuous 5s")
check(user_contribution(play_count=2, best_listen_sec=45) == 2, "replay")
check(user_contribution(skip_count=1) == -2, "legacy skip")
print("OK")
