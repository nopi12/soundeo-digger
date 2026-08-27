"""MusicBrainz recording lookup for track name verification."""

from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any

from .match import normalize_text, parse_track_variants, pair_score, similarity

MB_BASE = "https://musicbrainz.org/ws/2/recording"
USER_AGENT = "DiggerListenAPI/1.0 ( https://fervent-panini.93-90-203-17.plesk.page/digger-api/ ; digger-listen )"
MIN_INTERVAL_SEC = 1.1
VERIFY_ACCEPT_SCORE = 0.82

_last_request_at = 0.0


@dataclass
class MbHit:
    recording_id: str
    artist: str
    title: str
    score: int
    local_score: float
    length_ms: int | None
    first_release_date: str
    url: str


def _throttle() -> None:
    global _last_request_at
    now = time.time()
    wait = MIN_INTERVAL_SEC - (now - _last_request_at)
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.time()


def _escape_lucene(value: str) -> str:
    specials = r'+-&|!(){}[]^"~*?:\/'
    out = []
    for ch in value:
        if ch in specials:
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def _artist_from_credit(rec: dict[str, Any]) -> str:
    credits = rec.get("artist-credit") or []
    parts: list[str] = []
    for item in credits:
        name = str(item.get("name") or "").strip()
        if not name and isinstance(item.get("artist"), dict):
            name = str(item["artist"].get("name") or "").strip()
        joinphrase = str(item.get("joinphrase") or "")
        if name:
            parts.append(name + joinphrase)
    return "".join(parts).strip()


def search_recordings(artist: str, title: str, limit: int = 5) -> list[dict[str, Any]]:
    artist = str(artist or "").strip()
    title = str(title or "").strip()
    if not title:
        return []

    if artist:
        query = f'recording:"{_escape_lucene(title)}" AND artist:"{_escape_lucene(artist)}"'
    else:
        query = f'recording:"{_escape_lucene(title)}"'

    params = urllib.parse.urlencode(
        {"query": query, "fmt": "json", "limit": str(max(1, min(limit, 10)))}
    )
    url = f"{MB_BASE}?{params}"
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
        method="GET",
    )
    _throttle()
    with urllib.request.urlopen(req, timeout=20) as res:
        payload = json.loads(res.read().decode("utf-8"))
    recordings = payload.get("recordings")
    return recordings if isinstance(recordings, list) else []


def verify_track(
    artist: str = "",
    title: str = "",
    raw_title: str = "",
) -> dict[str, Any]:
    variants = parse_track_variants(raw_title=raw_title, artist=artist, title=title)
    primary = variants[0] if variants else None
    tried: list[dict[str, str]] = []
    best: MbHit | None = None

    queries: list[tuple[str, str]] = []
    for variant in variants[:3]:
        if variant.title:
            queries.append((variant.artist, variant.title))
    if artist and title:
        queries.insert(0, (artist, title))

    # de-dupe queries
    seen_q: set[tuple[str, str]] = set()
    unique_queries: list[tuple[str, str]] = []
    for a, t in queries:
        key = (a.lower(), t.lower())
        if key in seen_q or not t:
            continue
        seen_q.add(key)
        unique_queries.append((a, t))

    for q_artist, q_title in unique_queries[:3]:
        tried.append({"artist": q_artist, "title": q_title})
        try:
            recordings = search_recordings(q_artist, q_title, limit=5)
        except Exception as err:  # noqa: BLE001 - surface to API
            return {
                "ok": False,
                "verified": False,
                "error": str(err),
                "input": {
                    "artist": artist,
                    "title": title,
                    "rawTitle": raw_title,
                    "parsed": {
                        "artist": primary.artist if primary else "",
                        "title": primary.title if primary else "",
                    },
                },
                "tried": tried,
                "hit": None,
                "candidates": [],
            }

        for rec in recordings:
            mb_artist = _artist_from_credit(rec)
            mb_title = str(rec.get("title") or "").strip()
            mb_id = str(rec.get("id") or "").strip()
            if not mb_id or not mb_title:
                continue

            mb_artist_n = normalize_text(mb_artist)
            mb_title_n = normalize_text(mb_title)
            local = 0.0
            for variant in variants:
                local = max(
                    local,
                    pair_score(
                        variant.artist_norm,
                        variant.title_norm,
                        mb_artist_n,
                        mb_title_n,
                    ),
                )
                if not variant.artist_norm or not mb_artist_n:
                    local = max(local, similarity(variant.title_norm, mb_title_n) * 0.95)

            mb_score = int(rec.get("score") or 0)
            hit = MbHit(
                recording_id=mb_id,
                artist=mb_artist,
                title=mb_title,
                score=mb_score,
                local_score=local,
                length_ms=int(rec["length"]) if rec.get("length") else None,
                first_release_date=str(rec.get("first-release-date") or ""),
                url=f"https://musicbrainz.org/recording/{mb_id}",
            )
            if best is None or hit.local_score > best.local_score or (
                hit.local_score == best.local_score and hit.score > best.score
            ):
                best = hit

        if best and best.local_score >= VERIFY_ACCEPT_SCORE:
            break

    verified = bool(best and best.local_score >= VERIFY_ACCEPT_SCORE)
    return {
        "ok": True,
        "verified": verified,
        "input": {
            "artist": artist,
            "title": title,
            "rawTitle": raw_title,
            "parsed": {
                "artist": primary.artist if primary else "",
                "title": primary.title if primary else "",
                "artistNorm": primary.artist_norm if primary else "",
                "titleNorm": primary.title_norm if primary else "",
            },
        },
        "tried": tried,
        "hit": None
        if not best
        else {
            "recordingId": best.recording_id,
            "artist": best.artist,
            "title": best.title,
            "mbScore": best.score,
            "localScore": round(best.local_score, 3),
            "lengthMs": best.length_ms,
            "firstReleaseDate": best.first_release_date,
            "url": best.url,
        },
        "threshold": VERIFY_ACCEPT_SCORE,
    }
