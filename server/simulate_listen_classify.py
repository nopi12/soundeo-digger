#!/usr/bin/env python3
"""Simulate listen-behavior classification on stored Chrome sessions."""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location(
    "q", r"E:\Programmieren\Cursor\Soundeo Links\server\query_listen_sessions.py"
)
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

MIN_PROFILE = 8


def percentile(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[int((len(s) - 1) * p)]


def classify(rec, prof):
    elapsed = float(rec.get("elapsedSec") or 0)
    if elapsed < 2:
        return None
    if not prof or prof["sampleSize"] < MIN_PROFILE:
        return "listen" if elapsed >= 45 else "skip"
    pct = rec.get("pct")
    if pct is not None and float(pct) >= 0.85:
        return "deep"
    if elapsed >= prof["listenElapsedThreshold"]:
        return "listen"
    if (
        pct is not None
        and float(pct) >= prof["listenPctThreshold"]
        and elapsed >= prof["skipElapsedThreshold"] + 1.5
    ):
        return "listen"
    if elapsed <= prof["skipElapsedThreshold"]:
        return "skip"
    if elapsed < prof["listenElapsedThreshold"]:
        return "preview"
    return "preview"


def compute_profile(sessions):
    recent = sessions[-300:]
    switches = [
        s for s in recent if s.get("endReason") in ("switch", "stop")
    ]
    elapsed_vals = [
        float(s["elapsedSec"])
        for s in switches
        if float(s.get("elapsedSec") or 0) >= 2
    ]
    pct_vals = [
        float(s["pct"])
        for s in recent
        if s.get("pct") is not None and 0 < float(s["pct"]) <= 1
    ]
    skip_elapsed = percentile(elapsed_vals, 0.3) or 12
    listen_elapsed = percentile(elapsed_vals, 0.78) or 45
    listen_pct = percentile(pct_vals, 0.62) or 0.32
    skip_threshold = min(max(skip_elapsed, 2), 3.5)
    listen_threshold = max(
        listen_elapsed, skip_threshold + 4, percentile(elapsed_vals, 0.78) or skip_threshold + 4
    )
    prof = {
        "sampleSize": len(recent),
        "skipElapsedThreshold": skip_threshold,
        "listenElapsedThreshold": min(listen_threshold, 180),
        "listenPctThreshold": min(max(listen_pct, 0.18), 0.75),
    }
    return prof


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    data = q.load_blob(q.DEFAULT_BASE)
    sessions = q.extract_json_array(data, b"diggerListenSessions") or []
    prof = compute_profile(sessions)
    print(prof)
    buckets = {}
    for s in sessions:
        oc = classify(s, prof) or "empty"
        el = float(s.get("elapsedSec") or 0)
        lo = int(el)
        buckets.setdefault((lo, oc), 0)
        buckets[(lo, oc)] += 1
    print("\nby second:")
    for sec in range(0, 10):
        parts = [
            f"{oc}:{buckets.get((sec, oc), 0)}"
            for oc in ("empty", "skip", "preview", "listen", "deep")
            if buckets.get((sec, oc), 0)
        ]
        if parts:
            print(f"  {sec}s -> {', '.join(parts)}")
    print("\n2-5s detail (new):")
    for s in sorted(sessions, key=lambda x: float(x.get("elapsedSec") or 0)):
        el = float(s.get("elapsedSec") or 0)
        if el < 2 or el > 5:
            continue
        oc = classify(s, prof) or "-"
        print(
            f"  {el:4.1f}s {oc:7} {(s.get('title') or '')[:45]}"
        )


if __name__ == "__main__":
    main()
