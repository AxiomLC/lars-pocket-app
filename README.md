# lars-pocket-app

A **two-way voice assistant for Lars** — an always-on, streaming-voice chat that talks to a live
Hermes `lars` profile and can drive an on-screen **HUD / Holo Panels** (web pages, YouTube videos,
images) by voice command. Built on top of a proven **semi-streaming voice + barge-in** chassis.

> **Beta v1.5** — working streaming voice to Hermes Lars, with a HUD-enabled UI (Holo Panels).

---

## What it is

You talk to Lars with a mic on (or type); Lars answers out loud, streaming sentence-by-sentence.
Because voice latency is the whole game, the brain is a **fast streaming model** and replies are
**chunked and played as they arrive** (not after the full reply).

Lars also controls a full-screen **HUD** at `/hud/`:
- **Holo Panels** — floating panels Lars summons by voice to show a web page, a YouTube video, an
  image, or the Hermes dashboard/kanban on screen.
- **VIEWS** — quick-jump iframes (KANBAN / HERMES DASHBOARD / CHAT) from the Hermes `:9119` server.

---

## The stack & ports

| Port | Service | Role |
|---|---|---|
| **1122** | This app (`server.js`, `node:http`) | Serves the UI + HUD, proxies chat & TTS |
| **1133** | Pocket TTS (`uvx pocket-tts serve`) | Text → speech (built-in `alba` voice); **semi-streaming chunked WAV** |
| **9119** | Hermes (`hermes dashboard`/serve) | The live Lars profile session via JSON-RPC WebSocket (`/api/ws`) |

- **STT (you→Lars):** in-browser **Web Speech API** — no server, no key.
- **Brain:** the **Hermes `lars` profile** (default) via `:9119`; a direct-**Cerebras** `gpt-oss-120b`
  scaffold is wired (same SSE shape) for an A/B latency path.
- **TTS (Lars→you):** **Pocket TTS** on `:1133`, streamed through our `/api/tts` proxy as chunked WAV,
  played gapless with **Web Audio**.
- **Voice UX:** armed mic (on/off), **re-arm button**, **barge-in**, sentence-chunked playback, typed
  chat. Zero external runtime dependencies (`node:http` only).

```
Chrome (armed mic, barge-in, re-arm)
  │  Web Speech STT → transcript
  ▼
[ lars-pocket-app :1122 ]  POST /api/chat (OpenAI-SSE)
  │  Hermes leg: /api/ws JSON-RPC → session.create → prompt.submit → message.delta
  ▼
Hermes live `lars` session → SSE → sentence-chunker
  ▼
POST /api/tts {text} → Pocket TTS (:1133) → chunked WAV → Web Audio gapless playback
```

---

## Where it came from

This project reuses two things:

1. **The voice chassis — `AxiomLC/lars-pocket-tts`** (`C:\Users\Admin\lars-pocket-tts`, **read-only**).
   That repo proved the **semi-streaming chat** pattern: sentence-chunked TTS playback, an armed mic,
   and **barge-in** (speak mid-answer to interrupt). Its `app.js` / `state.js` voice engine is loaded
   **verbatim** into the HUD — zero regression risk.

2. **The HUD UI — `eadmin2/jarvis_ai`** (local copy `C:\Users\Admin\lars13`, **copy-source only**).
   The full-screen HUD (`server/hud/index.html`) and the `hermes-plugin/hud_display` (Holo Panel
   summon tools) are ours, adapted to point at **our** loopback `/api/summon` instead of the original's
   TLS proxy. We ported the **UI**, not jarvis_ai's voice/audio stack.

> Both upstream repos are intentionally **read-only / never pushed-to**. All new work lives here.

---

## Setup

### Prerequisites
- **Node.js** (v18+; built/tested on v23), **uvx** (for Pocket TTS).
- **Hermes** running with a `lars` profile, and its **`:9119` dashboard/gateway up**.
  - The app auto-connects to `:9119` (auto-discovers the session token from the dashboard page).
- A browser with a working mic (Chrome recommended).

### 1. Environment
Copy `.env` (it is gitignored; a sample layout follows — only `PORT` is strictly required):
```env
PORT=1122
BRAIN=hermes                 # hermes (default) | cerebras
HERMES_PROFILE=lars
# CEREBRAS_API_KEY=          # only for BRAIN=cerebras
# CEREBRAS_MODEL=gpt-oss-120b
POCKET_URL=http://localhost:1133/tts
POCKET_VOICE=alba            # bare name → Pocket's built-in voice
```

> **Web search:** for Lars to find real video/page URLs, Hermes needs a working search backend.
> Set `TAVILY_API_KEY` in Hermes' `.env` (global `...\hermes\.env` or the `lars` profile's). Without
> one, Hermes' keyless Firecrawl tier often `403`s and Lars can't supply a real URL.

### 2. Hermes side — enable the HUD (Holo Panel) tools (one-time)
The `hud_display` plugin (in `hermes-plugin/hud_display/`) gives Lars the `hud_display` /
`hud_dismiss` tools that summon panels. It lives in the **`lars` profile home** (profile settings
override global Hermes):
1. Copy `hermes-plugin/hud_display/` → `<hermes>\profiles\lars\plugins\hud_display\`
2. Add `- hud_display` to `plugins.enabled` in `<hermes>\profiles\lars\config.yaml`
3. **Restart the `:9119` dashboard** (`hermes` process, not just the desktop app) so it registers the
   `hud` toolset, and start a **new** Lars session.

> Full, verified profile-setup + tool-deploy steps: see `buildREADME.md` §6A.

### 3. Run
```cmd
:: one-shot: starts Pocket TTS if down, runs the UI, opens the browser
start.bat

:: or manually
uvx pocket-tts serve --port 1133
npm start                     # → http://localhost:1122
```

### 4. Check it
- Open `http://localhost:1122/` — the original voice page.
- Open `http://localhost:1122/hud/` — the HUD (primary UI). Click the ring / Space to talk.
- Say: *"pull up the kanban on screen"*, *"find a video of Hikaru playing chess and play it in the
  HUD"*, *"open Wikipedia on screen"*.

---

## Files

| Path | Purpose |
|---|---|
| `server.js` | `node:http` server: UI static, `/api/chat` (Hermes/Cerebras SSE), `/api/tts` proxy, `/api/summon` + `/events` HUD broadcast, `/api/embed` iframe proxy |
| `public/` | `index.html` (voice page), `app.js` + `state.js` (voice engine), `hud/index.html` (HUD) |
| `hermes-plugin/hud_display/` | Hermes plugin giving Lars `hud_display` / `hud_dismiss` tools |
| `start.bat` | Launcher: Pocket TTS + UI + browser (never touches Hermes) |
| `buildREADME.md` | Detailed, authoritative tech/build guide |

---

## Notes & limitations
- **External pages** frame through the `/api/embed` strip-proxy; a few sites still refuse via JS, and
  heavy SPA/login pages won't fully render.
- Lars's tool-call narration is filtered out of the spoken stream (only real answers are spoken).
- `:8642` (Hermes optional OpenAI API server) is **off / not used** by this app.
