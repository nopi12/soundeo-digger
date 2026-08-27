#!/usr/bin/env python3
"""Smoke: metadata boost + uncertain modal payload + confirm/reject."""
import json
import urllib.request

BASE = "https://fervent-panini.93-90-203-17.plesk.page/digger-api"


def req(method, path, body=None, token=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    r = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r) as res:
        return json.loads(res.read().decode())


reg = req("POST", "/v1/register", {})
key = reg["api_key"]
print("user", reg["user_id"])

# Auto-merge with matching metadata
req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundeo",
                "externalId": "meta-auto-sd",
                "rawTitle": "Nova Pulse - Soft Horizon",
                "artist": "Nova Pulse",
                "title": "Soft Horizon",
                "durationSec": 372,
                "bpm": 124,
                "label": "Demo Label",
            }
        ]
    },
    token=key,
)
b = req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundcloud",
                "externalId": "nova-pulse/soft-horizons-premiere",
                "rawTitle": "label x - Nova Pulse - Soft Horizons | PREMIERE",
                "artist": "label x",
                "title": "Nova Pulse - Soft Horizons | PREMIERE",
                "durationSec": 374,
                "bpm": 124,
                "label": "Demo Label",
            }
        ]
    },
    token=key,
)
auto_pending = any((row or {}).get("pendingMatch") for row in b.get("results") or [])
print("auto merge keys", b.get("keys"), "pending?", auto_pending)

# Uncertain: same name, conflicting duration
reg_u = req("POST", "/v1/register", {})
key_u = reg_u["api_key"]
req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundeo",
                "externalId": "unc-sd",
                "artist": "Echo Bay",
                "title": "Glass House",
                "rawTitle": "Echo Bay - Glass House",
                "durationSec": 300,
                "bpm": 120,
            }
        ]
    },
    token=key_u,
)
u = req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundcloud",
                "externalId": "echo-bay/glass-house-live",
                "artist": "Echo Bay",
                "title": "Glass House",
                "rawTitle": "Echo Bay - Glass House (Live)",
                "durationSec": 480,
                "bpm": 120,
            }
        ]
    },
    token=key_u,
)
print("uncertain response", json.dumps(u, indent=2))
pending = None
for row in u.get("results") or []:
    if row.get("pendingMatch"):
        pending = row["pendingMatch"]
        break

if not pending:
    raise SystemExit("expected pendingMatch for duration conflict")

print("PENDING", pending["score"], pending["status"])
conf = req(
    "POST",
    "/v1/match/confirm",
    {
        "trackId": pending["trackId"],
        "candidateTrackId": pending["candidateTrackId"],
    },
    token=key_u,
)
print("confirmed keys", conf.get("keys"))

# Reject path
reg2 = req("POST", "/v1/register", {})
key2 = reg2["api_key"]
req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundeo",
                "externalId": "rej-sd",
                "artist": "Alpha",
                "title": "Night Drive",
                "rawTitle": "Alpha - Night Drive",
                "durationSec": 300,
            }
        ]
    },
    token=key2,
)
c = req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundcloud",
                "externalId": "someone/night-drive-long",
                "artist": "Alpha",
                "title": "Night Drive",
                "rawTitle": "Alpha - Night Drive",
                "durationSec": 520,
            }
        ]
    },
    token=key2,
)
pend2 = None
for row in c.get("results") or []:
    if row.get("pendingMatch"):
        pend2 = row["pendingMatch"]
        break
if not pend2:
    raise SystemExit("expected pending for reject case")
rej = req(
    "POST",
    "/v1/match/reject",
    {
        "trackId": pend2["trackId"],
        "candidateTrackId": pend2["candidateTrackId"],
    },
    token=key2,
)
print("rejected", rej)
d = req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundcloud",
                "externalId": "someone/night-drive-long",
                "artist": "Alpha",
                "title": "Night Drive",
                "rawTitle": "Alpha - Night Drive",
                "durationSec": 520,
            }
        ]
    },
    token=key2,
)
again = any((row or {}).get("pendingMatch") for row in d.get("results") or [])
print("pending after reject?", again)
if again:
    raise SystemExit("reject did not stick")
print("OK")
