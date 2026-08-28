"""Community track ratings from personalized listen points and purchases."""

from __future__ import annotations

import math
import time
from typing import Any

from . import db as store

DOWNLOAD_PTS = 100
REPLAY_PTS = 20
LEGACY_LISTEN_PTS = 40
LEGACY_SKIP_PTS = -50
MIN_ELAPSED_SEC = 2.0
FULL_LISTEN_SEC = 45.0
POSITIVE_THRESHOLD = 20.0
NEGATIVE_THRESHOLD = -20.0

SIGNAL_KINDS = ("listen_time", "listen", "skip", "download", "undownload")


def parse_local_key(key: str) -> tuple[str, str] | None:
    raw = str(key or "").strip()
    if not raw:
        return None
    if raw.startswith("sc:"):
        ext = raw[3:].strip()
        return ("soundcloud", ext) if ext else None
    return "soundeo", raw


def listen_target_sec(duration_sec: float | int | None) -> float:
    dur = float(duration_sec or 0)
    if dur > 30:
        return min(FULL_LISTEN_SEC, dur * 0.35)
    return FULL_LISTEN_SEC


def listen_target_sec(duration_sec: float | int | None) -> float:
    dur = float(duration_sec or 0)
    if dur > 30:
        return min(FULL_LISTEN_SEC, dur * 0.35)
    return FULL_LISTEN_SEC


def listen_points(
    elapsed_sec: float | int | None,
    duration_sec: float | int | None = None,
) -> float:
    """Continuous tanh-log fallback when client points are unavailable."""
    elapsed = max(0.0, float(elapsed_sec or 0))
    if elapsed < MIN_ELAPSED_SEC:
        return 0.0
    z = math.log(max(elapsed, MIN_ELAPSED_SEC) / 12.0) * 0.55
    tanh = math.tanh(z)
    points = 48.0 * tanh
    dur = float(duration_sec or 0)
    if dur > 0:
        pct = max(0.0, min(1.0, elapsed / dur))
        points += 28.0 * pct * pct
    return float(max(-100, min(100, round(points))))


def coerce_stored_points(pts: float) -> int:
    """Map legacy client scale [−2…+1] onto the new −100…+100 range."""
    p = float(pts or 0)
    if p == 0:
        return 0
    if -2.05 <= p <= 1.05:
        t = (p - (-2.0)) / 3.0
        return int(round(-48 + 96 * t))
    return int(round(p))


def user_contribution(
    *,
    play_count: int = 0,
    best_listen_sec: float = 0,
    best_listen_points: float = 0,
    duration_sec: float | None = None,
    download_count: int = 0,
    skip_count: int = 0,
    listen_count: int = 0,
) -> int:
    score = 0
    if download_count > 0:
        score += DOWNLOAD_PTS
    elif best_listen_points != 0:
        score += coerce_stored_points(best_listen_points)
    elif best_listen_sec >= MIN_ELAPSED_SEC:
        score += int(round(listen_points(best_listen_sec, duration_sec)))
    elif listen_count > 0:
        score += LEGACY_LISTEN_PTS
    elif skip_count > 0:
        score += LEGACY_SKIP_PTS
    if play_count >= 2:
        score += REPLAY_PTS
    return int(score)


def _row_int(row: Any, key: str) -> int:
    try:
        return int(row[key] or 0)
    except Exception:
        return 0


def _row_float(row: Any, key: str) -> float:
    try:
        return float(row[key] or 0)
    except Exception:
        return 0.0


def _ensure_user_track(
    conn: Any, user_id: str, track_id: str, now: float | None = None
) -> None:
    existing = conn.execute(
        "SELECT 1 FROM user_tracks WHERE user_id = ? AND track_id = ?",
        (user_id, track_id),
    ).fetchone()
    if existing:
        return
    ts = float(now if now is not None else time.time())
    conn.execute(
        """
        INSERT INTO user_tracks (
          user_id, track_id, play_count, first_played_at, last_played_at,
          skip_count, listen_count, download_count, best_listen_sec, best_listen_points
        )
        VALUES (?, ?, 0, ?, ?, 0, 0, 0, 0, 0)
        """,
        (user_id, track_id, ts, ts),
    )


def record_signal(
    conn: Any,
    user_id: str,
    kind: str,
    *,
    platform: str,
    external_id: str,
    raw_title: str = "",
    artist: str = "",
    title: str = "",
    url: str = "",
    duration_sec: float | int | None = None,
    bpm: float | int | None = None,
    label: str | None = None,
    musical_key: str | None = None,
    elapsed_sec: float | int | None = None,
    listen_points_value: float | int | None = None,
) -> dict[str, Any]:
    kind_n = str(kind or "").strip().lower()
    if kind_n not in SIGNAL_KINDS:
        raise ValueError("unknown signal kind")
    resolved = store.resolve_track(
        conn,
        platform=platform,
        external_id=external_id,
        raw_title=raw_title,
        artist=artist,
        title=title,
        url=url,
        duration_sec=duration_sec,
        bpm=bpm,
        label=label,
        musical_key=musical_key,
    )
    track_id = str(resolved["track_id"])
    _ensure_user_track(conn, user_id, track_id)
    track_duration = duration_sec
    if track_duration is None:
        track_row = conn.execute(
            "SELECT duration_sec FROM tracks WHERE id = ?",
            (track_id,),
        ).fetchone()
        if track_row:
            track_duration = track_row["duration_sec"]

    if kind_n == "listen_time":
        elapsed = max(0.0, float(elapsed_sec or 0))
        if elapsed >= MIN_ELAPSED_SEC:
            if listen_points_value is not None:
                pts = float(listen_points_value)
            else:
                pts = listen_points(elapsed, track_duration)
            conn.execute(
                """
                UPDATE user_tracks
                SET best_listen_sec = MAX(best_listen_sec, ?),
                    best_listen_points = MAX(best_listen_points, ?)
                WHERE user_id = ? AND track_id = ?
                """,
                (elapsed, pts, user_id, track_id),
            )
    elif kind_n == "skip":
        conn.execute(
            """
            UPDATE user_tracks
            SET skip_count = skip_count + 1
            WHERE user_id = ? AND track_id = ?
            """,
            (user_id, track_id),
        )
    elif kind_n == "listen":
        if elapsed_sec is not None and float(elapsed_sec or 0) >= MIN_ELAPSED_SEC:
            elapsed = float(elapsed_sec)
            pts = (
                float(listen_points_value)
                if listen_points_value is not None
                else listen_points(elapsed, track_duration)
            )
            conn.execute(
                """
                UPDATE user_tracks
                SET best_listen_sec = MAX(best_listen_sec, ?),
                    best_listen_points = MAX(best_listen_points, ?)
                WHERE user_id = ? AND track_id = ?
                """,
                (elapsed, pts, user_id, track_id),
            )
        else:
            conn.execute(
                """
                UPDATE user_tracks
                SET listen_count = listen_count + 1
                WHERE user_id = ? AND track_id = ?
                """,
                (user_id, track_id),
            )
    elif kind_n == "download":
        conn.execute(
            """
            UPDATE user_tracks
            SET download_count = download_count + 1
            WHERE user_id = ? AND track_id = ?
            """,
            (user_id, track_id),
        )
    elif kind_n == "undownload":
        conn.execute(
            """
            UPDATE user_tracks
            SET download_count = MAX(0, download_count - 1)
            WHERE user_id = ? AND track_id = ?
            """,
            (user_id, track_id),
        )
    keys = store.keys_for_track(conn, track_id)
    return {
        "track_id": track_id,
        "keys": keys,
        "kind": kind_n,
        "pending_match": resolved.get("pending_match"),
    }


def compute_scores(conn: Any, track_ids: list[str]) -> dict[str, dict[str, Any]]:
    unique = [tid for tid in dict.fromkeys(track_ids) if tid]
    if not unique:
        return {}
    placeholders = ",".join("?" * len(unique))
    ut_rows = conn.execute(
        f"""
        SELECT user_id, track_id, play_count, skip_count, listen_count,
               download_count, best_listen_sec, best_listen_points
        FROM user_tracks
        WHERE track_id IN ({placeholders})
        """,
        unique,
    ).fetchall()
    dur_rows = conn.execute(
        f"""
        SELECT id, duration_sec
        FROM tracks
        WHERE id IN ({placeholders})
        """,
        unique,
    ).fetchall()
    durations = {str(row["id"]): row["duration_sec"] for row in dur_rows}

    actors: dict[str, dict[str, dict[str, float | int]]] = {}
    for row in ut_rows:
        tid = str(row["track_id"])
        uid = str(row["user_id"])
        actors.setdefault(tid, {})[uid] = {
            "play_count": _row_int(row, "play_count"),
            "skip_count": _row_int(row, "skip_count"),
            "listen_count": _row_int(row, "listen_count"),
            "download_count": _row_int(row, "download_count"),
            "best_listen_sec": _row_float(row, "best_listen_sec"),
            "best_listen_points": _row_float(row, "best_listen_points"),
        }

    out: dict[str, dict[str, Any]] = {}
    for tid in unique:
        users = actors.get(tid) or {}
        score = 0
        skip_users = 0
        listen_users = 0
        download_users = 0
        duration = durations.get(tid)
        for _uid, stats in users.items():
            play_count = int(stats.get("play_count") or 0)
            skip_count = int(stats.get("skip_count") or 0)
            listen_count = int(stats.get("listen_count") or 0)
            download_count = int(stats.get("download_count") or 0)
            best_listen_sec = float(stats.get("best_listen_sec") or 0)
            best_listen_points = float(stats.get("best_listen_points") or 0)
            user_score = user_contribution(
                play_count=play_count,
                best_listen_sec=best_listen_sec,
                best_listen_points=best_listen_points,
                duration_sec=duration,
                download_count=download_count,
                skip_count=skip_count,
                listen_count=listen_count,
            )
            score += user_score
            coerced = (
                coerce_stored_points(best_listen_points)
                if best_listen_points != 0
                else 0
            )
            if download_count > 0:
                download_users += 1
            elif coerced > POSITIVE_THRESHOLD or listen_count > 0:
                listen_users += 1
            elif coerced < NEGATIVE_THRESHOLD or (
                skip_count > 0 and listen_count <= 0 and best_listen_sec <= 0
            ):
                skip_users += 1
            elif best_listen_sec >= MIN_ELAPSED_SEC and best_listen_points == 0:
                pts = listen_points(best_listen_sec, duration)
                if pts > POSITIVE_THRESHOLD:
                    listen_users += 1
                elif pts < NEGATIVE_THRESHOLD:
                    skip_users += 1
        if not users:
            continue
        out[tid] = {
            "score": score,
            "users": len(users),
            "skips": skip_users,
            "listens": listen_users,
            "downloads": download_users,
            "keys": store.keys_for_track(conn, tid),
        }
    return out


def lookup_ratings(conn: Any, keys: list[str]) -> dict[str, dict[str, Any]]:
    parsed: list[tuple[str, str, str]] = []
    for raw in keys[:200]:
        pair = parse_local_key(raw)
        if not pair:
            continue
        parsed.append((str(raw), pair[0], pair[1]))
    if not parsed:
        return {}

    req_to_track: dict[str, str] = {}
    track_ids: list[str] = []
    for key, platform, external_id in parsed:
        ref = store._find_ref(conn, platform, external_id)
        if not ref:
            continue
        tid = str(ref["track_id"])
        req_to_track[key] = tid
        track_ids.append(tid)

    scores = compute_scores(conn, track_ids)
    out: dict[str, dict[str, Any]] = {}
    for key, tid in req_to_track.items():
        payload = scores.get(tid)
        if payload:
            out[key] = payload
    return out
