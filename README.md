# lars-pocket-app

A **two-way voice assistant for Lars** — streaming, sentence-chunked voice chat with a live
Hermes `lars` profile, plus a full-screen **HUD / Holo Panels** Lars drives by voice (web pages,
YouTube videos, images, iframed Hermes views). Zero runtime dependencies (`node:http` only).

> **Beta v1.8** — voice to Hermes Lars with the top-down priority-chain voice controls
> (STOP → MIC → STREAMING → VOICE CHAT) and the HUD as primary UI.

---

## What it is

Talk to Lars (or type). Lars replies out loud, sentence by sentence, chunked and played as it
arrives. Because streaming is "the whole game", replies are spoken as they stream and you can
barge in mid-reply when STREAMING is on.

Two UIs on the same server:

- **`/hud/`** — primary UI: full-screen HUD with Holo Panels (summoned by voice), VIEWS
  (kanban / dashboard / chat iframed from Hermes `:9119`), and the voice panel.
- **`/`** — the original lightweight voice page (pre-HUD baseline, still served and working).

**Voice controls — top-down priority chain (top wins):**

| Control | What it does |
|---|---|
| **STOP** | Top dog: kills the running reply + typed chat, turns voice off; glows red; press again to release (voice stays off until re-enabled manually) |
| **MIC: ON/OFF** | Hard mic cut — status chip, input level and MIC TEST go dead when OFF; MIC ON is the only way back |
| **STREAMING** | Mic stays live during Lars's reply → talk over him (barge-in); needs VOICE CHAT on |
| **VOICE CHAT** | Turnabout mode: click the ring (or Space) to talk, click again or wait 2 s to send |
| **Ring / Space** | Visual + push-to-talk only — never flips a switch itself |

## Stack & ports

| Port | Service | Role | Must be up |
|---|---|---|---|
| **1122** | This app (`server.js`) | Serves UI + HUD; proxy for chat & TTS | yes (`start.bat`/`npm start`) |
| **1133** | Pocket TTS (`uvx pocket-tts serve`) | Text → speech (`alba`), semi-streaming chunked WAV | yes (auto-started if down) |
| **9119** | Hermes **dashboard** | The live Lars session via JSON-RPC WebSocket (`/api/ws`); app auto-discovers session token from its page | **yes — the #1 outage cause** (see `HowToDebug.md`) |
| 8642 | Hermes gateway API server (`hermes gateway run`) | Hermes-side OpenAI-compatible server; **this app does NOT use it** | no |

- **STT (you → Lars):** in-browser **Web Speech API** (Chrome) — no server, no key.
- **Brain:** the Hermes `lars` profile (default) via `:9119`; a direct-**Cerebras** `gpt-oss-120b`
  scaffold is wired behind the same SSE shape for A/B latency (`BRAIN=cerebras`).
- **TTS (Lars → you):** **Pocket TTS** on `:1133`, streamed through `/api/tts` as chunked WAV,
  played gapless with Web Audio.

```
Chrome (Web Speech STT; ring = push-to-talk; barge-in when STREAMING on)
  │  Web Speech STT → transcript
  ▼
[ lars-pocket-app :1122 ]  POST /api/chat (OpenAI-SSE shape)
  │  Hermes leg: /api/ws JSON-RPC → session.create → prompt.submit → message.delta
  ▼
Hermes live `lars` session (dashboard :9119) → SSE → cleanSpokenText → sentence-chunker
  ▼
POST /api/tts {text} → Pocket TTS (:1133) → chunked WAV → Web Audio gapless playback
```

---

## Setup

### Prerequisites
- **Node.js** (v18+; built/tested on v23), **uvx** (for Pocket TTS).
- **Hermes running with the `:9119` dashboard up** (the app auto-connects to it and
  auto-discovers the session token from the dashboard page). The Hermes **desktop app alone
  is not enough** — it serves its backend on a *random* port; the app needs the dedicated
  `:9119` dashboard process. See `HowToDebug.md` §9 for the exact restart commands.
- A browser with a working mic (Chrome recommended).

> **No Hermes component autostarts at login on this machine** (the only Startup-folder VBS is
> named `Hermes_Dashboard.vbs.disabled` — inactive). After a reboot, relaunch the `:9119`
> dashboard first (exact command: `HowToDebug.md` §9.1) and the gateway if needed (`§9.3`).

### 1. Environment
Copy `.env` (gitignored; only `PORT` is strictly required — everything else has sane defaults):
```env
PORT=1122
ENV=dev                           # informational
BRAIN=hermes                      # hermes (default) | cerebras
HERMES_PROFILE=lars

# TTS / voice
POCKET_URL=http://localhost:1133/tts
POCKET_CMD=uvx pocket-tts serve --port 1133   # auto-starts TTS if it is down
# POCKET_VOICE=alba               # bare name → Pocket's built-in voice (a URL = cloned voice)

# Cerebras leg — only for BRAIN=cerebras
# CEREBRAS_API_KEY=...
# CEREBRAS_MODEL=gpt-oss-120b
# CEREBRAS_URL=https://api.cerebras.ai/v1
# SYSTEM_PROMPT=                  # brain prompt override
# HISTORY_TURNS=6                 # turns kept for cerebras context
# MAX_TOKENS=...

# Only needed if :9119 ever moves:
# HERMES_WS_ORIGIN=http://127.0.0.1:9119
```

### 2. Hermes side — `hud_display` plugin (one-time, for Holo Panels)
The `hud_display` / `hud_dismiss` tools live in `hermes-plugin/hud_display/` and must be
deployed into the **`lars` profile home** (profile settings override global Hermes):
1. Copy `hermes-plugin/hud_display/` → `<hermes>\profiles\lars\plugins\hud_display\` (overwrite)
2. Add `- hud_display` to `plugins.enabled` in `<hermes>\profiles\lars\config.yaml`
3. **Restart the `:9119` dashboard process** (not just the desktop app) and start a **new**
   Lars session — the dashboard caches its tool registry at startup.

> **It is a hand-copied plugin, not a live link.** `hermes-plugin/hud_display/` here is the
> *source*; Hermes runs its own separate copy in the profile's `plugins\hud_display\`. There is
> **no symlink and no auto-sync** — editing this repo's folder changes nothing over there.
> On **every** plugin update you must re-copy (overwrite) + restart the dashboard + start a new
> Lars session. (The two copies were verified byte-identical on 2026-10-28 — exactly because a
> hand-copy was done, not because anything wires them together.)

### 3. Run
```cmd
start.bat          :: one-shot: starts Pocket TTS if down, runs the UI on :1122, opens browser
:: or manually:
uvx pocket-tts serve --port 1133
npm start          :: → http://localhost:1122
```

### 4. Check it
- `curl http://127.0.0.1:1133/health` → Pocket TTS OK
- `curl http://localhost:1122/api/config` → shows brain / profile / pocketUp / hermesUrl
- `curl -s http://127.0.0.1:9119/ | grep __HERMES_SESSION_TOKEN` → dashboard has the token page
- Open `http://localhost:1122/hud/` — click **VOICE CHAT**, then the ring / Space, and talk.
- Say: *"pull up the kanban on screen"*, *"find a video of Hikaru playing chess and play it in
  the HUD"*, *"open Wikipedia on screen"*.

---

## Files

| Path | Purpose |
|---|---|
| `server.js` | `node:http` server: UI static, `/api/chat` (Hermes/Cerebras SSE), `/api/tts` proxy, `/api/summon` + `/events` HUD broadcast, `/api/embed` iframe strip-proxy, `/api/config`, `/api/log` mirror |
| `public/` | `index.html` (legacy voice page), `app.js` + `state.js` (voice engine), `hud/index.html` (HUD) |
| `hermes-plugin/hud_display/` | Hermes **tool plugin** (the HUD's command side — gives Lars `hud_display` / `hud_dismiss`). Must be **hand-copied** to `profiles\lars\plugins\hud_display\` + dashboard restart on every update (not live-linked — see §2) |
| `start.bat` | Launcher: Pocket TTS (if down) + UI + browser — never touches Hermes |
| `HowToDebug.md` | **Debug manual for future AI/humans**: log map, CLI kit, failure modes, Windows/Chrome watch-outs |

---

## Notes & limitations
- **`:9119` is the #1 outage cause.** The desktop app's backend binds a *random* port
  (`hermes serve --port 0`); the dedicated `:9119` dashboard is a separate process started at
  login (VBS) and does **not** auto-return on a Hermes-only restart. Symptom: `empty reply from
  LLM`. Everything you need is in `HowToDebug.md`.
- **External pages** frame through the `/api/embed` strip-proxy (removes `X-Frame-Options`/CSP);
  a few sites still refuse via JS, and heavy SPA/login pages won't fully render. YouTube keeps
  its native `/embed/` form.
- Lars's tool-call narration / `<HUD DISPLAY>` tags / URLs are filtered out of the spoken stream
  (`cleanSpokenText()`) — only real answers are heard.
- `:8642` (Hermes optional OpenAI API server) is **not used** by this app.
- `lars-pocket-tts` and `lars13` (jarvis_ai) are external reference repos — **read-only**.
- **One persistent Lars session.** The app creates and holds a single Hermes session on your
  `lars` profile (`session.create`; the id is cached across turns), so the conversation **continues
  turn to turn and is a real Hermes session** — you can open Hermes desktop/dashboard → **Sessions**
  and view (or continue) the full chat log there. While the app is holding it, opening that same
  session in the Hermes UI can cause Hermes to reclaim it (`ws_orphan_reap`); the app then silently
  starts a fresh session, and the old log stays viewable in Hermes.
- **STT fallback:** STT is the browser's Web Speech API (no local STT in this app); if that ever
  fails, the local engine is sherpa-onnx / faster-whisper (optionally Moonshine) — already present on
  this machine in the separate Lars voice module (`desktop-plugins\lars\voice\`, see HowToDebug.md
  §6.3), but a different machine would have to install those dependencies itself.
