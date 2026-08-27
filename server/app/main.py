"""Digger listen API — FastAPI entrypoint."""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import db as store
from . import musicbrainz as mb
from . import rating as ratings

DB_PATH = Path(os.environ.get("DIGGER_DB_PATH", "/data/digger.db"))

app = FastAPI(title="Digger Listen API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@contextmanager
def get_conn():
    conn = store.connect(DB_PATH)
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.on_event("startup")
def on_startup() -> None:
    with get_conn() as conn:
        store.init_db(conn)


def require_user(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    api_key = authorization.split(" ", 1)[1].strip()
    with get_conn() as conn:
        user_id = store.get_user_by_api_key(conn, api_key)
    if not user_id:
        raise HTTPException(status_code=401, detail="invalid api key")
    return user_id


class PlayIn(BaseModel):
    platform: str
    external_id: str = Field(alias="externalId")
    raw_title: str = Field(default="", alias="rawTitle")
    artist: str = ""
    title: str = ""
    url: str = ""
    played_at: float | None = Field(default=None, alias="playedAt")
    duration_sec: float | None = Field(default=None, alias="durationSec")
    bpm: float | None = None
    label: str = ""
    musical_key: str = Field(default="", alias="musicalKey")

    model_config = {"populate_by_name": True}


class PlaysIn(BaseModel):
    plays: list[PlayIn]


class LinkIn(BaseModel):
    api_key: str = Field(alias="apiKey")

    model_config = {"populate_by_name": True}


class VerifyIn(BaseModel):
    artist: str = ""
    title: str = ""
    raw_title: str = Field(default="", alias="rawTitle")
    track_id: str | None = Field(default=None, alias="trackId")
    apply_canonical: bool = Field(default=False, alias="applyCanonical")

    model_config = {"populate_by_name": True}


class MatchDecisionIn(BaseModel):
    track_id: str = Field(alias="trackId")
    candidate_track_id: str = Field(alias="candidateTrackId")
    keep_track_id: str | None = Field(default=None, alias="keepTrackId")

    model_config = {"populate_by_name": True}


class ClientLogIn(BaseModel):
    level: str = "error"
    message: str
    source: str = ""
    platform: str = ""
    ext_version: str = Field(default="", alias="extVersion")
    stack: str = ""
    url: str = ""
    ts: float | None = None
    context: Any = None

    model_config = {"populate_by_name": True}


class ClientLogsIn(BaseModel):
    logs: list[ClientLogIn] = Field(default_factory=list)


class SignalIn(PlayIn):
    kind: str = "listen"
    elapsed_sec: float | None = Field(default=None, alias="elapsedSec")
    listen_points: float | None = Field(default=None, alias="listenPoints")


class SignalsIn(BaseModel):
    signals: list[SignalIn] = Field(default_factory=list)


class RatingsLookupIn(BaseModel):
    keys: list[str] = Field(default_factory=list)


@app.get("/health")
def health() -> dict[str, str]:
    return {"ok": "true", "service": "digger-listen"}


@app.post("/v1/admin/rematch")
def admin_rematch() -> dict[str, Any]:
    """One-shot duplicate merge after matcher upgrades."""
    with get_conn() as conn:
        result = store.rematch_all_tracks(conn)
    return {"ok": True, **result}


@app.post("/v1/verify")
def verify_track(body: VerifyIn) -> dict[str, Any]:
    result = mb.verify_track(
        artist=body.artist,
        title=body.title,
        raw_title=body.raw_title,
    )
    if body.track_id and result.get("ok"):
        hit = result.get("hit") or {}
        with get_conn() as conn:
            store.save_track_mb_verify(
                conn,
                body.track_id,
                recording_id=str(hit.get("recordingId") or ""),
                artist=str(hit.get("artist") or ""),
                title=str(hit.get("title") or ""),
                score=float(hit.get("localScore") or 0),
                apply_canonical=bool(body.apply_canonical and result.get("verified")),
            )
    return result


@app.post("/v1/admin/verify-wants")
def admin_verify_wants(limit: int = 10) -> dict[str, Any]:
    """Verify recent want-download tracks against MusicBrainz (rate-limited)."""
    results: list[dict[str, Any]] = []
    with get_conn() as conn:
        tracks = store.list_want_tracks_for_verify(conn, limit=limit)
    for row in tracks:
        verified = mb.verify_track(
            artist=row.get("artist") or "",
            title=row.get("title") or "",
            raw_title=row.get("raw_title") or "",
        )
        hit = verified.get("hit") or {}
        if verified.get("ok"):
            with get_conn() as conn:
                store.save_track_mb_verify(
                    conn,
                    str(row["id"]),
                    recording_id=str(hit.get("recordingId") or ""),
                    artist=str(hit.get("artist") or ""),
                    title=str(hit.get("title") or ""),
                    score=float(hit.get("localScore") or 0),
                    apply_canonical=False,
                )
        results.append(
            {
                "trackId": row["id"],
                "localArtist": row.get("artist"),
                "localTitle": row.get("title"),
                "verified": verified.get("verified"),
                "hit": hit or None,
                "error": verified.get("error"),
            }
        )
    return {"ok": True, "count": len(results), "results": results}


@app.post("/v1/register")
def register() -> dict[str, str]:
    with get_conn() as conn:
        return store.create_user(conn)


@app.post("/v1/link")
def link(body: LinkIn) -> dict[str, Any]:
    with get_conn() as conn:
        user_id = store.get_user_by_api_key(conn, body.api_key.strip())
    if not user_id:
        raise HTTPException(status_code=404, detail="unknown api key")
    return {"user_id": user_id, "api_key": body.api_key.strip()}


@app.get("/v1/plays/keys")
def get_play_keys(user_id: str = Depends(require_user)) -> dict[str, Any]:
    with get_conn() as conn:
        keys = store.user_play_keys(conn, user_id)
    return {"ok": True, "keys": keys, "count": len(keys)}


@app.post("/v1/plays")
def post_plays(
    body: PlaysIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    if not body.plays:
        return {"ok": True, "keys": [], "recorded": 0, "results": []}
    merged: set[str] = set()
    recorded = 0
    results: list[dict[str, Any]] = []
    with get_conn() as conn:
        for play in body.plays[:200]:
            platform = play.platform.strip().lower()
            external_id = play.external_id.strip()
            if not platform or not external_id:
                continue
            result = store.record_play(
                conn,
                user_id=user_id,
                platform=platform,
                external_id=external_id,
                raw_title=play.raw_title,
                artist=play.artist,
                title=play.title,
                url=play.url,
                played_at=play.played_at,
                duration_sec=play.duration_sec,
                bpm=play.bpm,
                label=play.label,
                musical_key=play.musical_key,
            )
            merged.update(result["keys"])
            recorded += 1
            pending = result.get("pending_match")
            if pending:
                pending = dict(pending)
                pending["trackId"] = result["track_id"]
                pending["sourceArtist"] = play.artist
                pending["sourceTitle"] = play.title or play.raw_title
                pending["sourcePlatform"] = platform
                pending["sourceDurationSec"] = play.duration_sec
                pending["sourceBpm"] = play.bpm
                pending["sourceLabel"] = play.label
            results.append(
                {
                    "trackId": result["track_id"],
                    "keys": result["keys"],
                    "pendingMatch": pending,
                }
            )
    return {
        "ok": True,
        "keys": sorted(merged),
        "recorded": recorded,
        "results": results,
    }


@app.delete("/v1/plays")
def delete_all_plays(user_id: str = Depends(require_user)) -> dict[str, Any]:
    with get_conn() as conn:
        store.clear_user_plays(conn, user_id)
    return {"ok": True}


@app.delete("/v1/plays/{platform}/{external_id:path}")
def delete_one_play(
    platform: str,
    external_id: str,
    user_id: str = Depends(require_user),
) -> dict[str, Any]:
    with get_conn() as conn:
        keys = store.remove_user_play(conn, user_id, platform, external_id)
    return {"ok": True, "removed_keys": keys}


@app.get("/v1/want-downloads/keys")
def get_want_keys(user_id: str = Depends(require_user)) -> dict[str, Any]:
    with get_conn() as conn:
        keys = store.user_want_keys(conn, user_id)
    return {"ok": True, "keys": keys, "count": len(keys)}


@app.get("/v1/want-downloads")
def get_want_downloads(user_id: str = Depends(require_user)) -> dict[str, Any]:
    with get_conn() as conn:
        entries = store.user_want_entries(conn, user_id)
        keys = store.user_want_keys(conn, user_id)
    return {
        "ok": True,
        "keys": keys,
        "count": len(keys),
        "wants": entries,
    }


@app.post("/v1/want-downloads")
def post_want_downloads(
    body: PlaysIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    if not body.plays:
        return {"ok": True, "keys": [], "recorded": 0, "results": []}
    merged: set[str] = set()
    recorded = 0
    results: list[dict[str, Any]] = []
    with get_conn() as conn:
        for play in body.plays[:200]:
            platform = play.platform.strip().lower()
            external_id = play.external_id.strip()
            if not platform or not external_id:
                continue
            result = store.set_want_download(
                conn,
                user_id=user_id,
                platform=platform,
                external_id=external_id,
                raw_title=play.raw_title,
                artist=play.artist,
                title=play.title,
                url=play.url,
                duration_sec=play.duration_sec,
                bpm=play.bpm,
                label=play.label,
                musical_key=play.musical_key,
            )
            merged.update(result["keys"])
            recorded += 1
            pending = result.get("pending_match")
            if pending:
                pending = dict(pending)
                pending["trackId"] = result["track_id"]
                pending["sourceArtist"] = play.artist
                pending["sourceTitle"] = play.title or play.raw_title
                pending["sourcePlatform"] = platform
                pending["sourceDurationSec"] = play.duration_sec
                pending["sourceBpm"] = play.bpm
                pending["sourceLabel"] = play.label
            results.append(
                {
                    "trackId": result["track_id"],
                    "keys": result["keys"],
                    "artist": result.get("artist") or play.artist or "",
                    "title": result.get("title") or play.title or "",
                    "pendingMatch": pending,
                }
            )
    return {
        "ok": True,
        "keys": sorted(merged),
        "recorded": recorded,
        "results": results,
    }


@app.delete("/v1/want-downloads")
def delete_all_wants(user_id: str = Depends(require_user)) -> dict[str, Any]:
    with get_conn() as conn:
        store.clear_want_downloads(conn, user_id)
    return {"ok": True}


@app.post("/v1/want-downloads/remove")
def remove_want(
    body: PlayIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    platform = body.platform.strip().lower()
    external_id = body.external_id.strip()
    if not platform or not external_id:
        raise HTTPException(status_code=400, detail="platform and externalId required")
    with get_conn() as conn:
        keys = store.remove_want_download(conn, user_id, platform, external_id)
    return {"ok": True, "removed_keys": keys}


@app.post("/v1/signals")
def post_signals(
    body: SignalsIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    if not body.signals:
        return {"ok": True, "recorded": 0, "keys": [], "results": []}
    merged: set[str] = set()
    recorded = 0
    results: list[dict[str, Any]] = []
    with get_conn() as conn:
        for item in body.signals[:200]:
            platform = item.platform.strip().lower()
            external_id = item.external_id.strip()
            kind = str(item.kind or "").strip().lower()
            if not platform or not external_id or kind not in ratings.SIGNAL_KINDS:
                continue
            try:
                result = ratings.record_signal(
                    conn,
                    user_id,
                    kind,
                    platform=platform,
                    external_id=external_id,
                    raw_title=item.raw_title,
                    artist=item.artist,
                    title=item.title,
                    url=item.url,
                    duration_sec=item.duration_sec,
                    bpm=item.bpm,
                    label=item.label,
                    musical_key=item.musical_key,
                    elapsed_sec=item.elapsed_sec,
                    listen_points_value=item.listen_points,
                )
            except ValueError:
                continue
            merged.update(result["keys"])
            recorded += 1
            results.append(
                {
                    "trackId": result["track_id"],
                    "keys": result["keys"],
                    "kind": result["kind"],
                    "pendingMatch": result.get("pending_match"),
                }
            )
    return {
        "ok": True,
        "recorded": recorded,
        "keys": sorted(merged),
        "results": results,
    }


@app.post("/v1/ratings/lookup")
def lookup_ratings(
    body: RatingsLookupIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    keys = [str(k) for k in (body.keys or []) if str(k).strip()]
    with get_conn() as conn:
        found = ratings.lookup_ratings(conn, keys)
    return {"ok": True, "ratings": found, "count": len(found)}


@app.post("/v1/match/confirm")
def match_confirm(
    body: MatchDecisionIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    keep = (body.keep_track_id or body.track_id or "").strip()
    other = body.candidate_track_id.strip()
    if keep == other:
        other = body.track_id.strip()
    if not keep or not other or keep == other:
        raise HTTPException(status_code=400, detail="two distinct track ids required")
    try:
        with get_conn() as conn:
            result = store.confirm_match(conn, keep, other)
    except ValueError as err:
        raise HTTPException(status_code=404, detail=str(err)) from err
    return {"ok": True, "trackId": result["track_id"], "keys": result["keys"]}


@app.post("/v1/match/reject")
def match_reject(
    body: MatchDecisionIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    a = body.track_id.strip()
    b = body.candidate_track_id.strip()
    if not a or not b or a == b:
        raise HTTPException(status_code=400, detail="two distinct track ids required")
    with get_conn() as conn:
        store.reject_match(conn, a, b, user_id=user_id)
    return {"ok": True}


@app.post("/v1/logs")
def post_client_logs(
    body: ClientLogsIn, user_id: str = Depends(require_user)
) -> dict[str, Any]:
    entries = [item.model_dump(by_alias=True) for item in (body.logs or [])[:100]]
    with get_conn() as conn:
        inserted = store.insert_client_logs(conn, user_id, entries)
    return {"ok": True, "inserted": inserted}


@app.get("/v1/admin/logs")
def admin_list_logs(
    limit: int = 50,
    level: str | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    with get_conn() as conn:
        rows = store.list_client_logs(
            conn, limit=limit, level=level, user_id=user_id
        )
    return {"ok": True, "count": len(rows), "logs": rows}
