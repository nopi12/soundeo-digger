"""SQLite persistence for digger listen API."""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from .match import (
    ParsedTrack,
    classify_match,
    combined_match_score,
    durations_conflict,
    near_miss_score,
    normalize_label,
    parse_artist_title,
    parse_track_variants,
    pair_score,
)

DEFAULT_DB_PATH = Path("/data/digger.db")


def connect(db_path: Path | str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          api_key_hash TEXT NOT NULL UNIQUE,
          created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          artist TEXT NOT NULL DEFAULT '',
          title TEXT NOT NULL DEFAULT '',
          artist_norm TEXT NOT NULL DEFAULT '',
          title_norm TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_artist_norm
          ON tracks(artist_norm);
        CREATE INDEX IF NOT EXISTS idx_tracks_title_norm
          ON tracks(title_norm);
        CREATE INDEX IF NOT EXISTS idx_tracks_artist_title
          ON tracks(artist_norm, title_norm);

        CREATE TABLE IF NOT EXISTS track_refs (
          id TEXT PRIMARY KEY,
          track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          platform TEXT NOT NULL,
          external_id TEXT NOT NULL,
          raw_title TEXT NOT NULL DEFAULT '',
          url TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          UNIQUE(platform, external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_track_refs_track
          ON track_refs(track_id);

        CREATE TABLE IF NOT EXISTS play_events (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          platform TEXT NOT NULL,
          external_id TEXT NOT NULL,
          played_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_play_events_user_time
          ON play_events(user_id, played_at DESC);

        CREATE TABLE IF NOT EXISTS user_tracks (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          play_count INTEGER NOT NULL DEFAULT 0,
          first_played_at REAL NOT NULL,
          last_played_at REAL NOT NULL,
          PRIMARY KEY (user_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_tracks_user_last
          ON user_tracks(user_id, last_played_at DESC);

        CREATE TABLE IF NOT EXISTS want_downloads (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
          created_at REAL NOT NULL,
          PRIMARY KEY (user_id, track_id)
        );
        CREATE INDEX IF NOT EXISTS idx_want_downloads_user
          ON want_downloads(user_id, created_at DESC);

        CREATE TABLE IF NOT EXISTS match_rejections (
          track_id_a TEXT NOT NULL,
          track_id_b TEXT NOT NULL,
          user_id TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          PRIMARY KEY (track_id_a, track_id_b)
        );

        CREATE TABLE IF NOT EXISTS client_logs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL DEFAULT '',
          created_at REAL NOT NULL,
          client_ts REAL NOT NULL DEFAULT 0,
          level TEXT NOT NULL DEFAULT 'error',
          source TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT '',
          ext_version TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL DEFAULT '',
          stack TEXT NOT NULL DEFAULT '',
          url TEXT NOT NULL DEFAULT '',
          context_json TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_client_logs_created
          ON client_logs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_client_logs_user
          ON client_logs(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_client_logs_level
          ON client_logs(level, created_at DESC);
        """
    )
    _ensure_column(conn, "tracks", "mb_recording_id", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "tracks", "mb_artist", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "tracks", "mb_title", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "tracks", "mb_score", "REAL NOT NULL DEFAULT 0")
    _ensure_column(conn, "tracks", "mb_verified_at", "REAL NOT NULL DEFAULT 0")
    _ensure_column(conn, "tracks", "duration_sec", "REAL NOT NULL DEFAULT 0")
    _ensure_column(conn, "tracks", "bpm", "REAL NOT NULL DEFAULT 0")
    _ensure_column(conn, "tracks", "label", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "tracks", "label_norm", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "tracks", "musical_key", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "track_refs", "duration_sec", "REAL NOT NULL DEFAULT 0")
    _ensure_column(conn, "track_refs", "bpm", "REAL NOT NULL DEFAULT 0")
    _ensure_column(conn, "track_refs", "label", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "track_refs", "musical_key", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "user_tracks", "skip_count", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "user_tracks", "listen_count", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "user_tracks", "download_count", "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(conn, "user_tracks", "best_listen_sec", "REAL NOT NULL DEFAULT 0")
    _ensure_column(conn, "user_tracks", "best_listen_points", "REAL NOT NULL DEFAULT 0")
    conn.commit()


def _ensure_column(
    conn: sqlite3.Connection, table: str, column: str, decl: str
) -> None:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    existing = {str(r[1]) for r in rows}
    if column not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


def save_track_mb_verify(
    conn: sqlite3.Connection,
    track_id: str,
    *,
    recording_id: str = "",
    artist: str = "",
    title: str = "",
    score: float = 0.0,
    apply_canonical: bool = False,
) -> None:
    now = time.time()
    if apply_canonical and artist and title:
        from .match import normalize_text

        conn.execute(
            """
            UPDATE tracks
            SET mb_recording_id = ?,
                mb_artist = ?,
                mb_title = ?,
                mb_score = ?,
                mb_verified_at = ?,
                artist = ?,
                title = ?,
                artist_norm = ?,
                title_norm = ?
            WHERE id = ?
            """,
            (
                recording_id,
                artist,
                title,
                float(score),
                now,
                artist,
                title,
                normalize_text(artist),
                normalize_text(title),
                track_id,
            ),
        )
    else:
        conn.execute(
            """
            UPDATE tracks
            SET mb_recording_id = ?,
                mb_artist = ?,
                mb_title = ?,
                mb_score = ?,
                mb_verified_at = ?
            WHERE id = ?
            """,
            (recording_id, artist, title, float(score), now, track_id),
        )


def list_want_tracks_for_verify(conn: sqlite3.Connection, limit: int = 20) -> list[dict]:
    rows = conn.execute(
        """
        SELECT t.id, t.artist, t.title, t.mb_recording_id, t.mb_artist, t.mb_title, t.mb_score,
               (SELECT r.raw_title FROM track_refs r WHERE r.track_id = t.id LIMIT 1) as raw_title
        FROM want_downloads wd
        JOIN tracks t ON t.id = wd.track_id
        GROUP BY t.id
        ORDER BY MAX(wd.created_at) DESC
        LIMIT ?
        """,
        (max(1, min(limit, 50)),),
    ).fetchall()
    return [dict(r) for r in rows]


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()


def create_user(conn: sqlite3.Connection) -> dict[str, str]:
    user_id = str(uuid.uuid4())
    api_key = secrets.token_urlsafe(32)
    now = time.time()
    conn.execute(
        "INSERT INTO users (id, api_key_hash, created_at) VALUES (?, ?, ?)",
        (user_id, hash_api_key(api_key), now),
    )
    conn.commit()
    return {"user_id": user_id, "api_key": api_key}


def get_user_by_api_key(conn: sqlite3.Connection, api_key: str) -> str | None:
    if not api_key:
        return None
    row = conn.execute(
        "SELECT id FROM users WHERE api_key_hash = ?",
        (hash_api_key(api_key),),
    ).fetchone()
    return str(row["id"]) if row else None


def _play_key(platform: str, external_id: str) -> str:
    platform = str(platform or "").strip().lower()
    external_id = str(external_id or "").strip()
    if platform == "soundcloud":
        if not external_id.startswith("sc:"):
            return "sc:" + external_id
        return external_id
    return external_id


def _find_ref(
    conn: sqlite3.Connection, platform: str, external_id: str
) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM track_refs WHERE platform = ? AND external_id = ?",
        (platform, external_id),
    ).fetchone()


def _create_track(
    conn: sqlite3.Connection,
    parsed: ParsedTrack,
    *,
    duration_sec: float = 0,
    bpm: float = 0,
    label: str = "",
    musical_key: str = "",
) -> str:
    track_id = str(uuid.uuid4())
    label_clean = str(label or "").strip()
    conn.execute(
        """
        INSERT INTO tracks (
          id, artist, title, artist_norm, title_norm, created_at,
          duration_sec, bpm, label, label_norm, musical_key
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            track_id,
            parsed.artist,
            parsed.title,
            parsed.artist_norm,
            parsed.title_norm,
            time.time(),
            float(duration_sec or 0),
            float(bpm or 0),
            label_clean,
            normalize_label(label_clean),
            str(musical_key or "").strip(),
        ),
    )
    return track_id


def _coerce_meta(
    duration_sec: float | int | None = None,
    bpm: float | int | None = None,
    label: str | None = None,
    musical_key: str | None = None,
) -> dict[str, Any]:
    dur = float(duration_sec or 0)
    if not (0 < dur < 36000):
        dur = 0.0
    bpm_n = float(bpm or 0)
    if not (40 < bpm_n < 400):
        bpm_n = 0.0
    return {
        "duration_sec": dur,
        "bpm": bpm_n,
        "label": str(label or "").strip()[:200],
        "musical_key": str(musical_key or "").strip()[:32],
    }


def _apply_track_meta(
    conn: sqlite3.Connection,
    track_id: str,
    *,
    duration_sec: float = 0,
    bpm: float = 0,
    label: str = "",
    musical_key: str = "",
) -> None:
    row = conn.execute(
        "SELECT duration_sec, bpm, label, musical_key FROM tracks WHERE id = ?",
        (track_id,),
    ).fetchone()
    if not row:
        return
    next_dur = float(row["duration_sec"] or 0)
    next_bpm = float(row["bpm"] or 0)
    next_label = str(row["label"] or "")
    next_key = str(row["musical_key"] or "")
    if duration_sec and duration_sec > 0:
        if next_dur <= 0:
            next_dur = float(duration_sec)
        elif abs(next_dur - float(duration_sec)) <= 8:
            next_dur = (next_dur + float(duration_sec)) / 2.0
    if bpm and bpm > 0 and next_bpm <= 0:
        next_bpm = float(bpm)
    if label and not next_label:
        next_label = label
    if musical_key and not next_key:
        next_key = musical_key
    conn.execute(
        """
        UPDATE tracks
        SET duration_sec = ?, bpm = ?, label = ?, label_norm = ?, musical_key = ?
        WHERE id = ?
        """,
        (
            next_dur,
            next_bpm,
            next_label,
            normalize_label(next_label),
            next_key,
            track_id,
        ),
    )


def _attach_ref(
    conn: sqlite3.Connection,
    track_id: str,
    platform: str,
    external_id: str,
    raw_title: str,
    url: str,
    *,
    duration_sec: float = 0,
    bpm: float = 0,
    label: str = "",
    musical_key: str = "",
) -> None:
    existing = _find_ref(conn, platform, external_id)
    if existing:
        if existing["track_id"] != track_id:
            # Prefer keeping earliest canonical; still OK to leave as-is.
            return
        conn.execute(
            """
            UPDATE track_refs
            SET raw_title = CASE WHEN ? != '' THEN ? ELSE raw_title END,
                url = CASE WHEN ? != '' THEN ? ELSE url END,
                duration_sec = CASE WHEN ? > 0 THEN ? ELSE duration_sec END,
                bpm = CASE WHEN ? > 0 THEN ? ELSE bpm END,
                label = CASE WHEN ? != '' THEN ? ELSE label END,
                musical_key = CASE WHEN ? != '' THEN ? ELSE musical_key END
            WHERE id = ?
            """,
            (
                raw_title,
                raw_title,
                url,
                url,
                duration_sec,
                duration_sec,
                bpm,
                bpm,
                label,
                label,
                musical_key,
                musical_key,
                existing["id"],
            ),
        )
        return
    conn.execute(
        """
        INSERT INTO track_refs
          (id, track_id, platform, external_id, raw_title, url, created_at,
           duration_sec, bpm, label, musical_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(uuid.uuid4()),
            track_id,
            platform,
            external_id,
            raw_title,
            url,
            time.time(),
            float(duration_sec or 0),
            float(bpm or 0),
            label or "",
            musical_key or "",
        ),
    )


def _pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a <= b else (b, a)


def is_match_rejected(
    conn: sqlite3.Connection, track_id_a: str, track_id_b: str
) -> bool:
    a, b = _pair_key(track_id_a, track_id_b)
    row = conn.execute(
        "SELECT 1 FROM match_rejections WHERE track_id_a = ? AND track_id_b = ?",
        (a, b),
    ).fetchone()
    return bool(row)


def reject_match(
    conn: sqlite3.Connection,
    track_id_a: str,
    track_id_b: str,
    user_id: str = "",
) -> None:
    if not track_id_a or not track_id_b or track_id_a == track_id_b:
        return
    a, b = _pair_key(track_id_a, track_id_b)
    conn.execute(
        """
        INSERT OR IGNORE INTO match_rejections
          (track_id_a, track_id_b, user_id, created_at)
        VALUES (?, ?, ?, ?)
        """,
        (a, b, user_id or "", time.time()),
    )


def confirm_match(
    conn: sqlite3.Connection,
    keep_track_id: str,
    other_track_id: str,
) -> dict[str, Any]:
    if not keep_track_id or not other_track_id:
        raise ValueError("track ids required")
    if keep_track_id == other_track_id:
        return {"track_id": keep_track_id, "keys": keys_for_track(conn, keep_track_id)}
    keep = conn.execute("SELECT id FROM tracks WHERE id = ?", (keep_track_id,)).fetchone()
    other = conn.execute("SELECT id FROM tracks WHERE id = ?", (other_track_id,)).fetchone()
    if not keep or not other:
        raise ValueError("unknown track")
    merge_tracks(conn, keep_track_id, other_track_id)
    # Drop any rejection for this pair after explicit confirm
    a, b = _pair_key(keep_track_id, other_track_id)
    conn.execute(
        "DELETE FROM match_rejections WHERE track_id_a = ? AND track_id_b = ?",
        (a, b),
    )
    return {"track_id": keep_track_id, "keys": keys_for_track(conn, keep_track_id)}


def _candidate_payload(
    conn: sqlite3.Connection,
    track_id: str,
    score: float,
    status: str,
) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT id, artist, title, duration_sec, bpm, label, musical_key
        FROM tracks WHERE id = ?
        """,
        (track_id,),
    ).fetchone()
    if not row:
        return None
    return {
        "status": status,
        "score": round(float(score), 4),
        "candidateTrackId": str(row["id"]),
        "candidateArtist": row["artist"] or "",
        "candidateTitle": row["title"] or "",
        "candidateDurationSec": float(row["duration_sec"] or 0) or None,
        "candidateBpm": float(row["bpm"] or 0) or None,
        "candidateLabel": row["label"] or "",
        "candidateMusicalKey": row["musical_key"] or "",
        "candidateKeys": keys_for_track(conn, track_id),
    }


def resolve_track(
    conn: sqlite3.Connection,
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
) -> dict[str, Any]:
    platform = str(platform or "").strip().lower()
    external_id = str(external_id or "").strip()
    if not platform or not external_id:
        raise ValueError("platform and external_id required")

    meta = _coerce_meta(duration_sec, bpm, label, musical_key)
    variants = parse_track_variants(raw_title=raw_title, artist=artist, title=title)
    parsed = variants[0] if variants else parse_artist_title(
        raw_title=raw_title, artist=artist, title=title
    )
    pending_match: dict[str, Any] | None = None

    ref = _find_ref(conn, platform, external_id)
    if ref:
        track_id = str(ref["track_id"])
        if parsed.artist_norm and parsed.title_norm:
            conn.execute(
                """
                UPDATE tracks
                SET artist = ?, title = ?, artist_norm = ?, title_norm = ?
                WHERE id = ?
                """,
                (
                    parsed.artist,
                    parsed.title,
                    parsed.artist_norm,
                    parsed.title_norm,
                    track_id,
                ),
            )
        _apply_track_meta(conn, track_id, **meta)
        other_id, other_variant, score, status = find_best_existing_track(
            conn,
            variants,
            exclude_id=track_id,
            duration_sec=meta["duration_sec"],
            bpm=meta["bpm"],
            label=meta["label"],
        )
        if other_id and status == "auto":
            keep, drop = other_id, track_id
            other = conn.execute(
                "SELECT artist_norm FROM tracks WHERE id = ?", (other_id,)
            ).fetchone()
            if (
                other
                and parsed.artist_norm
                and other["artist_norm"]
                and len(parsed.artist_norm) < len(str(other["artist_norm"]))
            ):
                keep, drop = track_id, other_id
            if keep != drop:
                merge_tracks(conn, keep, drop)
                track_id = keep
                if other_variant and keep == other_id:
                    parsed = other_variant
        elif other_id and status == "uncertain":
            pending_match = _candidate_payload(conn, other_id, score, "uncertain")
        _attach_ref(
            conn,
            track_id,
            platform,
            external_id,
            raw_title or parsed.raw,
            url,
            **meta,
        )
        return {"track_id": track_id, "pending_match": pending_match}

    match_id, match_variant, score, status = find_best_existing_track(
        conn,
        variants,
        duration_sec=meta["duration_sec"],
        bpm=meta["bpm"],
        label=meta["label"],
    )
    if match_id and status == "auto":
        track_id = match_id
        if match_variant:
            parsed = match_variant
        _apply_track_meta(conn, track_id, **meta)
    else:
        track_id = _create_track(conn, parsed, **meta)
        if match_id and status == "uncertain":
            pending_match = _candidate_payload(conn, match_id, score, "uncertain")

    _attach_ref(
        conn,
        track_id,
        platform,
        external_id,
        raw_title or parsed.raw,
        url,
        **meta,
    )
    return {"track_id": track_id, "pending_match": pending_match}


def normalize_hint(value: str) -> str:
    return str(value or "").lower()


def find_best_existing_track(
    conn: sqlite3.Connection,
    variants: list[ParsedTrack],
    exclude_id: str | None = None,
    *,
    duration_sec: float = 0,
    bpm: float = 0,
    label: str = "",
) -> tuple[str | None, ParsedTrack | None, float, str]:
    if not variants:
        return None, None, 0.0, "none"

    for variant in variants:
        if not variant.artist_norm or not variant.title_norm:
            continue
        exact = conn.execute(
            """
            SELECT id, duration_sec, bpm, label FROM tracks
            WHERE artist_norm = ? AND title_norm = ?
            LIMIT 1
            """,
            (variant.artist_norm, variant.title_norm),
        ).fetchone()
        if exact and str(exact["id"]) != exclude_id:
            if exclude_id and is_match_rejected(conn, exclude_id, str(exact["id"])):
                continue
            score = combined_match_score(
                1.0,
                duration_a=duration_sec,
                duration_b=exact["duration_sec"],
                bpm_a=bpm,
                bpm_b=exact["bpm"],
                label_a=label,
                label_b=exact["label"],
            )
            conflict = durations_conflict(duration_sec, exact["duration_sec"])
            status = classify_match(score, duration_conflict=conflict)
            # Exact name should almost always auto-merge unless duration conflicts hard
            if status == "none":
                status = "uncertain"
            return str(exact["id"]), variant, score, status

    title_norms = [v.title_norm for v in variants if v.title_norm]
    artist_norms = [v.artist_norm for v in variants if v.artist_norm]
    clauses: list[str] = []
    params: list[Any] = []
    for tn in title_norms[:4]:
        clauses.append("title_norm = ?")
        params.append(tn)
        if len(tn) >= 6:
            clauses.append("title_norm LIKE ?")
            params.append("%" + tn + "%")
    for an in artist_norms[:4]:
        clauses.append("artist_norm = ?")
        params.append(an)
    if not clauses:
        return None, None, 0.0, "none"

    sql = (
        "SELECT id, artist_norm, title_norm, duration_sec, bpm, label FROM tracks WHERE ("
        + " OR ".join(clauses)
        + ")"
    )
    if exclude_id:
        sql += " AND id != ?"
        params.append(exclude_id)
    sql += " LIMIT 150"
    candidates = conn.execute(sql, params).fetchall()

    best_id = None
    best_score = 0.0
    best_variant = variants[0]
    best_status = "none"
    for cand in candidates:
        cand_id = str(cand["id"])
        if exclude_id and is_match_rejected(conn, exclude_id, cand_id):
            continue
        for variant in variants:
            name_score = pair_score(
                variant.artist_norm,
                variant.title_norm,
                cand["artist_norm"],
                cand["title_norm"],
            )
            score = combined_match_score(
                name_score,
                duration_a=duration_sec,
                duration_b=cand["duration_sec"],
                bpm_a=bpm,
                bpm_b=cand["bpm"],
                label_a=label,
                label_b=cand["label"],
            )
            if score <= 0:
                score = near_miss_score(
                    variant.title_norm,
                    cand["title_norm"],
                    variant.artist_norm,
                    cand["artist_norm"],
                    duration_a=duration_sec,
                    duration_b=cand["duration_sec"],
                    bpm_a=bpm,
                    bpm_b=cand["bpm"],
                    label_a=label,
                    label_b=cand["label"],
                )
            conflict = durations_conflict(duration_sec, cand["duration_sec"])
            status = classify_match(score, duration_conflict=conflict)
            if score > best_score:
                best_score = score
                best_id = cand_id
                best_variant = variant
                best_status = status
    if best_id and best_status != "none":
        return best_id, best_variant, best_score, best_status
    return None, None, 0.0, "none"


def merge_tracks(conn: sqlite3.Connection, keep_id: str, drop_id: str) -> None:
    if keep_id == drop_id:
        return
    # Move refs
    refs = conn.execute(
        "SELECT id, platform, external_id FROM track_refs WHERE track_id = ?",
        (drop_id,),
    ).fetchall()
    for ref in refs:
        existing = _find_ref(conn, ref["platform"], ref["external_id"])
        if existing and str(existing["track_id"]) == keep_id:
            conn.execute("DELETE FROM track_refs WHERE id = ?", (ref["id"],))
        else:
            conn.execute(
                "UPDATE track_refs SET track_id = ? WHERE id = ?",
                (keep_id, ref["id"]),
            )

    # Merge wants
    wants = conn.execute(
        "SELECT user_id, created_at FROM want_downloads WHERE track_id = ?",
        (drop_id,),
    ).fetchall()
    for row in wants:
        kept = conn.execute(
            "SELECT 1 FROM want_downloads WHERE user_id = ? AND track_id = ?",
            (row["user_id"], keep_id),
        ).fetchone()
        if kept:
            conn.execute(
                "DELETE FROM want_downloads WHERE user_id = ? AND track_id = ?",
                (row["user_id"], drop_id),
            )
        else:
            conn.execute(
                "UPDATE want_downloads SET track_id = ? WHERE user_id = ? AND track_id = ?",
                (keep_id, row["user_id"], drop_id),
            )

    # Merge user_tracks stats
    stats = conn.execute(
        "SELECT * FROM user_tracks WHERE track_id = ?",
        (drop_id,),
    ).fetchall()
    for row in stats:
        kept = conn.execute(
            """
            SELECT play_count, first_played_at, last_played_at,
                   skip_count, listen_count, download_count, best_listen_sec,
                   best_listen_points
            FROM user_tracks WHERE user_id = ? AND track_id = ?
            """,
            (row["user_id"], keep_id),
        ).fetchone()
        if kept:
            conn.execute(
                """
                UPDATE user_tracks
                SET play_count = ?,
                    first_played_at = ?,
                    last_played_at = ?,
                    skip_count = ?,
                    listen_count = ?,
                    download_count = ?,
                    best_listen_sec = ?,
                    best_listen_points = ?
                WHERE user_id = ? AND track_id = ?
                """,
                (
                    int(kept["play_count"]) + int(row["play_count"]),
                    min(float(kept["first_played_at"]), float(row["first_played_at"])),
                    max(float(kept["last_played_at"]), float(row["last_played_at"])),
                    int(kept["skip_count"] or 0) + int(row["skip_count"] or 0),
                    int(kept["listen_count"] or 0) + int(row["listen_count"] or 0),
                    int(kept["download_count"] or 0) + int(row["download_count"] or 0),
                    max(
                        float(kept["best_listen_sec"] or 0),
                        float(row["best_listen_sec"] or 0),
                    ),
                    max(
                        float(kept["best_listen_points"] or 0),
                        float(row["best_listen_points"] or 0),
                    ),
                    row["user_id"],
                    keep_id,
                ),
            )
            conn.execute(
                "DELETE FROM user_tracks WHERE user_id = ? AND track_id = ?",
                (row["user_id"], drop_id),
            )
        else:
            conn.execute(
                "UPDATE user_tracks SET track_id = ? WHERE user_id = ? AND track_id = ?",
                (keep_id, row["user_id"], drop_id),
            )

    conn.execute(
        "UPDATE play_events SET track_id = ? WHERE track_id = ?",
        (keep_id, drop_id),
    )
    conn.execute("DELETE FROM tracks WHERE id = ?", (drop_id,))


def rematch_all_tracks(conn: sqlite3.Connection) -> dict[str, int]:
    """Re-parse track metadata and merge duplicates that now match."""
    rows = conn.execute(
        """
        SELECT t.id, t.artist, t.title, t.duration_sec, t.bpm, t.label,
               (SELECT r.raw_title FROM track_refs r WHERE r.track_id = t.id LIMIT 1) as raw_title
        FROM tracks t
        """
    ).fetchall()
    updated = 0
    merged = 0
    for row in rows:
        track_id = str(row["id"])
        still = conn.execute("SELECT 1 FROM tracks WHERE id = ?", (track_id,)).fetchone()
        if not still:
            continue
        variants = parse_track_variants(
            raw_title=row["raw_title"] or "",
            artist=row["artist"] or "",
            title=row["title"] or "",
        )
        if not variants:
            continue
        best = variants[0]
        if best.artist_norm and best.title_norm:
            conn.execute(
                """
                UPDATE tracks
                SET artist = ?, title = ?, artist_norm = ?, title_norm = ?
                WHERE id = ?
                """,
                (
                    best.artist,
                    best.title,
                    best.artist_norm,
                    best.title_norm,
                    track_id,
                ),
            )
            updated += 1

        other_id, other_variant, score, status = find_best_existing_track(
            conn,
            variants,
            exclude_id=track_id,
            duration_sec=float(row["duration_sec"] or 0),
            bpm=float(row["bpm"] or 0),
            label=str(row["label"] or ""),
        )
        if other_id and status == "auto":
            # Keep the track that already has the cleaner NUAH-style artist if possible
            keep = other_id
            drop = track_id
            other = conn.execute(
                "SELECT artist_norm, title_norm FROM tracks WHERE id = ?",
                (other_id,),
            ).fetchone()
            if other and best.artist_norm and other["artist_norm"]:
                if len(best.artist_norm) < len(other["artist_norm"]):
                    keep, drop = track_id, other_id
                    if other_variant:
                        conn.execute(
                            """
                            UPDATE tracks
                            SET artist = ?, title = ?, artist_norm = ?, title_norm = ?
                            WHERE id = ?
                            """,
                            (
                                best.artist,
                                best.title,
                                best.artist_norm,
                                best.title_norm,
                                keep,
                            ),
                        )
            merge_tracks(conn, keep, drop)
            merged += 1
    return {"updated": updated, "merged": merged}


def record_play(
    conn: sqlite3.Connection,
    user_id: str,
    platform: str,
    external_id: str,
    raw_title: str = "",
    artist: str = "",
    title: str = "",
    url: str = "",
    played_at: float | None = None,
    duration_sec: float | int | None = None,
    bpm: float | int | None = None,
    label: str | None = None,
    musical_key: str | None = None,
) -> dict[str, Any]:
    resolved = resolve_track(
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
    ts = float(played_at) if played_at else time.time()
    conn.execute(
        """
        INSERT INTO play_events
          (id, user_id, track_id, platform, external_id, played_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (str(uuid.uuid4()), user_id, track_id, platform, external_id, ts),
    )
    existing = conn.execute(
        "SELECT play_count FROM user_tracks WHERE user_id = ? AND track_id = ?",
        (user_id, track_id),
    ).fetchone()
    if existing:
        conn.execute(
            """
            UPDATE user_tracks
            SET play_count = play_count + 1, last_played_at = ?
            WHERE user_id = ? AND track_id = ?
            """,
            (ts, user_id, track_id),
        )
    else:
        conn.execute(
            """
            INSERT INTO user_tracks
              (user_id, track_id, play_count, first_played_at, last_played_at)
            VALUES (?, ?, 1, ?, ?)
            """,
            (user_id, track_id, ts, ts),
        )
    keys = keys_for_track(conn, track_id)
    return {
        "track_id": track_id,
        "keys": keys,
        "pending_match": resolved.get("pending_match"),
    }


def keys_for_track(conn: sqlite3.Connection, track_id: str) -> list[str]:
    rows = conn.execute(
        "SELECT platform, external_id FROM track_refs WHERE track_id = ?",
        (track_id,),
    ).fetchall()
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        key = _play_key(row["platform"], row["external_id"])
        if key and key not in seen:
            seen.add(key)
            out.append(key)
    return out


def user_play_keys(conn: sqlite3.Connection, user_id: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT r.platform, r.external_id
        FROM user_tracks ut
        JOIN track_refs r ON r.track_id = ut.track_id
        WHERE ut.user_id = ?
        """,
        (user_id,),
    ).fetchall()
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        key = _play_key(row["platform"], row["external_id"])
        if key and key not in seen:
            seen.add(key)
            out.append(key)
    return out


def remove_user_play(
    conn: sqlite3.Connection, user_id: str, platform: str, external_id: str
) -> list[str]:
    ref = _find_ref(conn, platform, external_id)
    if not ref:
        return []
    track_id = str(ref["track_id"])
    conn.execute(
        "DELETE FROM user_tracks WHERE user_id = ? AND track_id = ?",
        (user_id, track_id),
    )
    conn.execute(
        "DELETE FROM play_events WHERE user_id = ? AND track_id = ?",
        (user_id, track_id),
    )
    return keys_for_track(conn, track_id)


def clear_user_plays(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute("DELETE FROM play_events WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM user_tracks WHERE user_id = ?", (user_id,))


def set_want_download(
    conn: sqlite3.Connection,
    user_id: str,
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
) -> dict[str, Any]:
    resolved = resolve_track(
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
    now = time.time()
    existing = conn.execute(
        "SELECT 1 FROM want_downloads WHERE user_id = ? AND track_id = ?",
        (user_id, track_id),
    ).fetchone()
    if not existing:
        conn.execute(
            """
            INSERT INTO want_downloads (user_id, track_id, created_at)
            VALUES (?, ?, ?)
            """,
            (user_id, track_id, now),
        )
    track = conn.execute(
        "SELECT artist, title FROM tracks WHERE id = ?", (track_id,)
    ).fetchone()
    return {
        "track_id": track_id,
        "keys": keys_for_track(conn, track_id),
        "pending_match": resolved.get("pending_match"),
        "artist": (track["artist"] if track else "") or "",
        "title": (track["title"] if track else "") or "",
    }


def remove_want_download(
    conn: sqlite3.Connection, user_id: str, platform: str, external_id: str
) -> list[str]:
    ref = _find_ref(conn, platform, external_id)
    if not ref:
        return []
    track_id = str(ref["track_id"])
    conn.execute(
        "DELETE FROM want_downloads WHERE user_id = ? AND track_id = ?",
        (user_id, track_id),
    )
    return keys_for_track(conn, track_id)


def clear_want_downloads(conn: sqlite3.Connection, user_id: str) -> None:
    conn.execute("DELETE FROM want_downloads WHERE user_id = ?", (user_id,))


def user_want_keys(conn: sqlite3.Connection, user_id: str) -> list[str]:
    rows = conn.execute(
        """
        SELECT DISTINCT r.platform, r.external_id
        FROM want_downloads wd
        JOIN track_refs r ON r.track_id = wd.track_id
        WHERE wd.user_id = ?
        """,
        (user_id,),
    ).fetchall()
    out: list[str] = []
    seen: set[str] = set()
    for row in rows:
        key = _play_key(row["platform"], row["external_id"])
        if key and key not in seen:
            seen.add(key)
            out.append(key)
    return out


def user_want_entries(conn: sqlite3.Connection, user_id: str) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT t.id, t.artist, t.title, wd.created_at
        FROM want_downloads wd
        JOIN tracks t ON t.id = wd.track_id
        WHERE wd.user_id = ?
        ORDER BY wd.created_at DESC
        """,
        (user_id,),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        track_id = str(row["id"])
        out.append(
            {
                "trackId": track_id,
                "artist": row["artist"] or "",
                "title": row["title"] or "",
                "keys": keys_for_track(conn, track_id),
                "createdAt": float(row["created_at"] or 0),
            }
        )
    return out


def insert_client_logs(
    conn: sqlite3.Connection,
    user_id: str,
    entries: list[dict[str, Any]],
) -> int:
    import json

    now = time.time()
    inserted = 0
    for raw in entries[:100]:
        if not isinstance(raw, dict):
            continue
        level = str(raw.get("level") or "error").strip().lower()[:16]
        if level not in ("error", "warn", "info", "debug"):
            level = "error"
        message = str(raw.get("message") or "").strip()[:1000]
        if not message:
            continue
        context = raw.get("context")
        if context is None:
            context_json = ""
        else:
            try:
                context_json = json.dumps(context, ensure_ascii=False)[:4000]
            except Exception:
                context_json = str(context)[:4000]
        client_ts = float(raw.get("ts") or raw.get("clientTs") or 0) or now
        conn.execute(
            """
            INSERT INTO client_logs (
              id, user_id, created_at, client_ts, level, source, platform,
              ext_version, message, stack, url, context_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                user_id or "",
                now,
                client_ts,
                level,
                str(raw.get("source") or "")[:64],
                str(raw.get("platform") or "")[:32],
                str(raw.get("extVersion") or raw.get("ext_version") or "")[:32],
                message,
                str(raw.get("stack") or "")[:4000],
                str(raw.get("url") or "")[:500],
                context_json,
            ),
        )
        inserted += 1
    # Keep table bounded
    conn.execute(
        """
        DELETE FROM client_logs
        WHERE id IN (
          SELECT id FROM client_logs
          ORDER BY created_at DESC
          LIMIT -1 OFFSET 5000
        )
        """
    )
    return inserted


def list_client_logs(
    conn: sqlite3.Connection,
    *,
    limit: int = 50,
    level: str | None = None,
    user_id: str | None = None,
) -> list[dict[str, Any]]:
    import json

    clauses: list[str] = []
    params: list[Any] = []
    if level:
        clauses.append("level = ?")
        params.append(level.strip().lower())
    if user_id:
        clauses.append("user_id = ?")
        params.append(user_id)
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"""
        SELECT id, user_id, created_at, client_ts, level, source, platform,
               ext_version, message, stack, url, context_json
        FROM client_logs
        {where}
        ORDER BY created_at DESC
        LIMIT ?
        """,
        (*params, max(1, min(int(limit or 50), 200))),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        context = None
        raw_ctx = row["context_json"] or ""
        if raw_ctx:
            try:
                context = json.loads(raw_ctx)
            except Exception:
                context = raw_ctx
        out.append(
            {
                "id": row["id"],
                "userId": row["user_id"],
                "createdAt": row["created_at"],
                "clientTs": row["client_ts"],
                "level": row["level"],
                "source": row["source"],
                "platform": row["platform"],
                "extVersion": row["ext_version"],
                "message": row["message"],
                "stack": row["stack"],
                "url": row["url"],
                "context": context,
            }
        )
    return out
