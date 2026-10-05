# BUILDREADME — lars-pocket-app

The plan to replace the LiveKit voice leg of **lars15** with the proven **browser
voice pipeline** from the pocket-tts app, wired straight into the **Hermes profile
RPC websocket** — no LiveKit, no `:8642` REST API needed. All locally researched
against the installed Hermes v0.21.5 source on this machine (2026-09-24).

---

## 1. What we are building

A single FastAPI/Express app — **lars-pocket-app** — that gives the user a
**lars15-style HUD** (as a UI *template only*) with the **pocket-tts browser voice
stack** (mic on/off, re-arm, barge-in, semi-streaming chat, Pocket TTS), where the
**conversation runs on a REAL live Lars Hermes session** via the
`hermes serve` JSON-RPC/WebSocket gateway.

**Scope: streamline hard — voice chat to Lars FIRST.** The local-resource
cosmetic panels (Models Loadout, Voice Link, Turn Metrics, Diagnostics) and the
Kanban/Dashboard iframes are **NOT wired in for v1** — render them as static
placeholders in the stolen lars15 UI so the layout looks right, then the user
fines-tunes the UI after the voice works. lars15's own typing box is kept.

Pipeline (browser-driven, no SFU / agent worker):

```
Chrome (armed mic, barge-in)
  │  Web Speech STT → transcript
  ▼
[ lars-pocket-app server ]  /api/chat (streaming)
  │  connects to Hermes WS:  /api/console?profile=lars  (+ ticket)
  ▼
Hermes profile `lars` (live session) → streamed reply deltas (JSON WS frames)
  ▼
[ server ] sentence-chunk the reply
  ▼
POST /api/tts {text} → Pocket TTS (uvx pocket-tts serve) → chunked WAV
  ▼
Web Audio gapless playback (mic re-opens = barge-in)
```

---

## 2. Repos / projects involved

| Repo / dir | Role | Status |
|---|---|---|
| `C:\Users\Admin\lars15` | Current Lars web app. **LiveKit voice leg is broken/miswired** (browser targets dead `ws://127.0.0.1:7880` while config = cloud; session id doesn't transfer). Text side + HUD panels + Hermes bridge code are good and portable. | Old; source of ideas/HUD/plugin |
| `C:\Users\Admin\lars-pocket-tts` | Original standalone pocket-tts harness (owns `public/` frontend: armed mic, barge-in, semi-streaming, TTS). GitHub `AxiomLC/lars-pocket-tts`. **Working browser stack but raw Groq brain and no live Hermes session.** | Old; source of voice frontend. Superseded |
| `C:\lars-pocket-app` | **THIS project.** Fresh build = lars15 HUD stylings/panels + pocket-tts voice frontend + Hermes WS brain. | New |
| `~/.hermes` / `AppData\Local\hermes\hermes-agent` | Installed Hermes v0.21.5. Runs `hermes serve` (WS gateway, default :9119) and `hermes gateway run` (REST API, :8642). Profile `lars` lives here. | Runtime dependency (already installed) |

---

## 3. Architecture of the old app — what we are DELETING vs KEEPING

### lars15 (LiveKit leg) — DELETE
- `server/agent_worker.py` — LiveKit agent worker (dead skill mode, session id mismatch).
- `voice_token` / `set_livekit` / LiveKit imports / `:8642`-only wiring.
- Any HUD code that points at `ws://127.0.0.1:7880` or the LiveKit cloud WS.
- The broken `voice link error: could not establish signal connection` retry loop.

### lars15 — KEEP (steal)
- `server/hud/index.html` — the dark sci-fi HUD styling + layout. Used as a **template**.
- Cohort of cosmetic panels (Models Loadout / Voice Link / Turn Metrics / Diagnostics): **NOT wired for v1, placeholder-only**.
- The **typing box** in the HUD — keep it working (sends the same text to Hermes as the voice does).
- `hermes-plugin/hud_display` — Hermes-side tool for HUD summons. **Out of scope for v1** (see Phase 3).

> **OLD REPS ARE READ-ONLY**: `AxiomLC/lars-pocket-tts` is a **working beta — DO NOT touch**. We borrow its `public/` voice frontend pattern only. (A prior accidental deprecation-push to it was fully reverted to commit `37b80de`.)

### UI controls (from the pocket-tts app)
- **Mic button (on/off)** for voice chat — toggle starts/stops the conversation mic.
- **"re-arm" button** next to the mic — explicitly re-open the mic after a turn / to keep talking, as in the pocket-tts app.

### pocket-tts app — KEEP (this is the working voice core)
- `public/index.html`, `public/app.js`, `public/state.js`, `public/style.css`
- Armed-mic, barge-in (`speaking → listening` on interrupt), sentence-chunked streaming TTS, echo defence — **all browser-side and already proven working.**

---

## 4. THE KEY INSIGHT — connect straight to `hermes serve` WS, bypass :8642

Researched from Hermes v0.21.5 source (`hermes_cli/web_routers/chat_ws.py`,
`hermes_cli/web_server_chat.py`, `hermes_cli/dashboard_auth/ws_tickets.py`,
`hermes_cli/dashboard_auth/routes.py`).

**`hermes serve` help (verbatim):**
> Run the Hermes backend server — the JSON-RPC/WebSocket gateway the desktop app and remote clients connect to.

- Default port **9119** (or `--port 0` = OS auto-assign).
- **Separate** from `:8642` (REST API server started by `hermes gateway run`). For a profile chat connection you do **not** need `:8642`.

### WS route table on `hermes serve`
| Route | Type | Purpose |
|---|---|---|
| `/api/console` | WS | **In-process curated console/profile chat**, JSON frames, `?profile=` |
| `/api/pty` | WS | PTY terminal chat — **needs WSL2 on Windows** (chat_ws.py says so explicitly) |
| `/api/ws` | WS | Gateway sidecar |
| `/api/pub`, `/api/events` | WS | Publish + event sidecars (tool events, HUD summons) |
| `POST /api/auth/ws-ticket` | HTTP | Issue a single-use WS upgrade ticket (gated auth mode) |

### The connect recipe (target: `/api/console`)
1. (Gated mode) `POST /api/auth/ws-ticket` → returns a **single-use ticket**,
   30 s TTL (`ws_tickets.py: mint_ticket` — 32 random bytes, base64url).
2. `ws://127.0.0.1:9119/api/console?profile=lars&ticket=<ticket>`
   (or no ticket on loopback/insecure auth mode — see §5).
3. Exchange JSON frames; profile `lars` is preselected; state is on the **same
   profile RPC** the desktop uses, so **session state transfers by construction.**

### The auth gates (why you must handle tickets/origin)
`_ws_gate()` (chat_ws.py) closes with distinct codes before accept:
- **4404** `embedded chat disabled` — `_DASHBOARD_EMBEDDED_CHAT_ENABLED` must be on.
- **4401** `auth: <reason>` — bad/missing ticket/credential.
- **4403** `host/origin mismatch` — browser `Origin` must match the allowed host.
- **4408** client not allowed.
`_ws_auth_mode()` returns `gated` (auth_required) | `insecure` (non-loopback bind) | `loopback`. On a **loopback** default bind it is `loopback`; if `auth_required` is set you must mint+send a ticket.

---

## 5. Online doc proof — Web UIs using the Hermes WS gateway

The same `/api/console` + `/api/auth/ws-ticket` machinery is already consumed by
Hermes' own **bundled dashboard SPA** (`hermes_cli/web_dist/assets/api-xvjTxPQj.js`
contains `getWsTicket()` and the WS open logic) and the **Electron desktop GUI** —
both "Web UI talking to Hermes AI over WS". We replicate that exact client
contract. Key online references to cite in the plan:

- Hermes Agent docs / repo upstream — "desktop app and remote clients connect to" the `serve` JSON-RPC/WS gateway (CLI help, mirrored in docs).
- `hermes serve --help` output (this machine) — authoritative for the WS gateway.
- Hermes source: `chat_ws.py`, `ws_tickets.py`, `dashboard_auth/routes.py` — the ticket→WS handshake the dashboard uses.
- `jestlane/RealtimeSTT`, OpenAI Web Speech API docs — for the STT half (browser mic) that pocket-tts already uses.

(Because Hermes is a private/local package, the best proofs are the CLI help text
and the on-disk source listed above — not external blog posts. Link the GitHub
`AxiomLC/lars-pocket-tts` README's working pipeline as the demo of the browser stack.)

---

## 6. CONFIRMED BUILD ORDER (confident, validated)

Do in this order. Each step ends runnable/testable.

**Phase 0 — Scaffold (this repo)**
1. Init git in `C:\lars-pocket-app` (fresh repo; force-push later to mark old history deprecated).
2. `package.json` (`type: module`, `start: node --env-file=.env server.js`), `.gitignore` (`.env`, `node_modules/`, `logs/`), `.env` + `.env.example` (PORT, Hermes URL, POCKET_*).

**Phase 1 — Port the working browser voice core**
3. Copy `public/{index.html,app.js,state.js,style.css}` from `lars-pocket-tts` into `lars-pocket-app/public/`.
4. Copy a minimal `server.js` that re-serves `/api/config`, `/api/tts` (→ Pocket), `/api/chat` (→ **new Hermes WS brain**), static `public/`. Reuse pocket-tts `server.js` skeleton, minus Groq.

**Phase 2 — The Hermes WS brain (the critical new code)**
5. Write a small Hermes WS client in `server.js`:
   - mint ticket via `POST /api/auth/ws-ticket` (if gated),
   - open `/api/console?profile=lars`,
   - recv JSON frames → translate `text`-type deltas into the OpenAI-style SSE shape `app.js` already parses (`data: {choices:[{delta:{content}}]}`),
   - re-open/re-auth on drop (single-use ticket ⇒ re-mint per connection).
6. Test headless: a tiny script opens the WS and sends a prompt; confirm a Lars reply streams back (this proves live-session transfer before UI wiring).

**V1 acceptance = voice chat to a LIVE Lars session round-trips** (speak → Lars replies aloud, state on the real Hermes session, barge-in works). Everything cosmetic comes after.

**Phase 3 — HUD skin from lars15 + placeholders (streamlined)**
7. Port lars15 `server/hud/index.html` styling into this app's `public/`; mount the pocket-tts voice panel (mic on/off + re-arm) and keep the typing box.
8. Render the cosmetic panels (**Models Loadout, Voice Link, Turn Metrics, Diagnostics**) as **static placeholders** — no data wiring, no `:8642` proxy, no psutil. (Defer actual feeds to a later tuning pass the user drives.)
9. **Defer** `hud_display` / `/api/summon` / Kanban / `:9119` iframe wiring entirely — out of v1 scope until voice chat is proven.

**Phase 4 — LLM speed lever (later)**
10. Because the frontend speaks OpenAI-style SSE, the LLM brain is swappable. To use **Cerebras gpt-oss-120b**, either route Hermes' profile to a Cerebras upstream, or bypass Hermes with a direct Cerebras chat-completions call — swap URL/key/model in the `/api/chat` adapter only. No UI change.

**Phase 5 — Cleanup (do NOT touch old repos)**
11. Delete/leave inert the LiveKit worker + `:7880`/cloud WS wiring *inside this app's own code*. **Do not modify or re-push `AxiomLC/lars-pocket-tts`** (working beta).

---

## 7. Open questions to confirm at build time (not blockers)
- **Auth mode of your running `hermes serve`:** is it `loopback` (no ticket) or `gated` (ticket required)? Check the server log first line / `app.state.auth_required`. Handles both.
- **Is `hermes serve` actually bound?** Earlier `netstat` showed only `:8642` (gateway run), **not** `:9119`. So we must **start `hermes serve`** (or use `--port 0` and read the printed port) — the desktop/GUI normally owns 9119, so coordinate (use a separate port, e.g. `hermes serve --port 8643`).
- **Profile name** — confirm it is `lars` (server15.yaml `profile_session: lars`).
- **PTY vs console:** we use `/api/console` (not `/api/pty`, which needs WSL2 on Windows).
- **Pocket TTS port** — currently `:1133` (or whatever your other app used, e.g. `:8000`); nothing was listening on either last check; the app auto-starts its own via `uvx pocket-tts serve`.

---

## 8. Quick reference — useful commands

```cmd
:: start the Hermes WS gateway (separate port, avoid clashing with GUI 9119)
hermes serve --port 8643

:: start Pocket TTS (if not already running)
uvx pocket-tts serve --port 1133

:: run this app
cd C:\lars-pocket-app
npm start        # node --env-file=.env server.js

:: sanity
netstat -ano | findstr :8643 :1133 :PORT
curl http://127.0.0.1:8643/health            # hermes ws gateway (http probe)
curl http://127.0.0.1:1133/health            # pocket tts
curl http://localhost:PORT/api/config        # this app
```

---

## 9. Status tracker
- [x] Phase 0 — scaffold repo + git + build doc (done)
- [ ] Phase 1 — port pocket-tts voice frontend (mic on/off, re-arm) + server
- [ ] Phase 2 — Hermes WS brain (`/api/console` + ticket) — **critical path**
- [ ] Phase 3 — HUD skins/panels + `hud_display`/`/api/summon` re-wiring
- [ ] Phase 4 — Cerebras LLM lever (later)
- [ ] Phase 5 — deprecate LiveKit path
