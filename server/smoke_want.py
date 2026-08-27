#!/usr/bin/env python3
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
out = req(
    "POST",
    "/v1/want-downloads",
    {
        "plays": [
            {
                "platform": "soundcloud",
                "externalId": "/artist/track-one",
                "rawTitle": "Artist - Track One",
                "artist": "Artist",
                "title": "Track One",
            }
        ]
    },
    token=key,
)
print("want", out)
keys = req("GET", "/v1/want-downloads/keys", token=key)
print("keys", keys)
assert keys["count"] == 1
req(
    "POST",
    "/v1/want-downloads/remove",
    {"platform": "soundcloud", "externalId": "/artist/track-one"},
    token=key,
)
keys2 = req("GET", "/v1/want-downloads/keys", token=key)
print("after delete", keys2)
assert keys2["count"] == 0
print("OK")
