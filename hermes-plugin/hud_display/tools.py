"""Handlers: POST to the lars-pocket-app /api/summon broadcast."""
import json
import os
import urllib.request

# Loopback URL of the lars-pocket-app server (port 1122). Override via env if
# the UI runs elsewhere. The UI owns auth on loopback, so the token is optional
# hardening for when the summon endpoint is ever exposed beyond localhost.
SUMMON_URL = os.environ.get("LARS_SUMMON_URL", "http://127.0.0.1:1122/api/summon")


def _post(payload: dict) -> str:
    token = os.environ.get("LARS_HUD_TOKEN", "")
    req = urllib.request.Request(
        SUMMON_URL, data=json.dumps(payload).encode(), method="POST",
        headers={"Content-Type": "application/json", "X-Lars-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            res = json.loads(r.read().decode())
    except Exception as e:
        return json.dumps({"error": f"HUD unreachable: {e}"})
    sent = res.get("sent_to", 0)
    if sent == 0:
        return json.dumps({"warning": "No HUD screens are currently open; nothing was displayed."})
    return json.dumps({"ok": True, "displayed_on_screens": sent,
                       **{k: payload.get(k) for k in ("title", "media") if k in payload}})


def hud_display(args: dict, **kwargs) -> str:
    src = (args.get("src") or "").strip()
    if not src.startswith(("http://", "https://")):
        return json.dumps({"error": "src must be a full http(s) URL"})
    return _post({
        "media": args.get("media", "iframe"),
        "src": src,
        "title": (args.get("title") or "INCOMING FEED")[:48],
        "position": args.get("position", "center"),
    })


def hud_dismiss(args: dict, **kwargs) -> str:
    return _post({"action": "dismiss"})
