#!/usr/bin/env python3
"""Smoke-test improved matcher + rematch existing NUAH duplicates."""
import json
import sys
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


# Unit-ish check inside container is better; here API rematch + new user wants
print("rematch", req("POST", "/v1/admin/rematch", {}))

reg = req("POST", "/v1/register", {})
key = reg["api_key"]
out = req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundeo",
                "externalId": "test-nuah-sd",
                "rawTitle": "NUAH - Natural Behaviour (Original Mix)",
                "artist": "NUAH",
                "title": "Natural Behaviour",
            },
            {
                "platform": "soundcloud",
                "externalId": "/tipping-point-music/nuah-natural-behavior-test",
                "rawTitle": "tipping point music - NUAH - Natural Behavior | PREMIERE",
                "artist": "tipping point music",
                "title": "NUAH - Natural Behavior | PREMIERE",
            },
        ]
    },
    token=key,
)
print("want", out)
keys = out.get("keys") or []
# Both platform keys should map to same canonical => response includes both
assert "test-nuah-sd" in keys or any(k.endswith("test-nuah-sd") for k in keys), keys
assert any("nuah-natural-behavior-test" in k for k in keys), keys
assert len(keys) >= 2, keys
print("OK matched to one track with keys:", keys)
