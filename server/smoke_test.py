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
print("user", reg["user_id"])

out = req(
    "POST",
    "/v1/plays",
    {
        "plays": [
            {
                "platform": "soundeo",
                "externalId": "111",
                "rawTitle": "Jebby Jay - One Day [Maneki Neko]",
                "artist": "Jebby Jay",
                "title": "One Day",
            },
            {
                "platform": "soundcloud",
                "externalId": "/jebby-jay/one-day",
                "rawTitle": "Jebby Jay - One Day",
                "artist": "Jebby Jay",
                "title": "One Day",
            },
            {
                "platform": "soundcloud",
                "externalId": "/other/one-day-jebby",
                "rawTitle": "One Day - Jebby Jay (Original Mix)",
                "artist": "Jebby Jay",
                "title": "One Day",
            },
        ]
    },
    token=key,
)
print("recorded", out)
keys = req("GET", "/v1/plays/keys", token=key)
print("keys", keys)
assert keys["count"] >= 2, keys
print("OK")
