# tweakNOTES — HUD UI refactor (Large pass, tracked here)

Working log for the L.A.R.S HUD refactor. This pass is intentionally incremental because
several items touch overlapping panel HTML + the JS that drives the panel values. Each item
below is a discrete, reviewable unit. Mark `[x]` as it lands.

Reference: panels live in `public/hud/index.html`; panel value JS in the inline HUD script
(and `app.js`/`state.js` for voice-side values). Panels currently numbered 01–10.

---

## 1. Branding: JARVIS / Jarvis / J.A.R.V.I.S → LARS / Lars / L.A.R.S ✅ (mostly done)

Mechanical sweep — all occurrences are in `public/hud/index.html`:

- [x] `<title>JARVIS</title>` → `<title>LARS</title>`
- [x] `apple-mobile-web-app-title` `JARVIS` → `LARS` (browser-tab / favicon-era label)
- [x] `addMsg("sys","Jarvis HUD online…")` → "Lars HUD online…"
- [x] header `<h1>J.A.R.V.I.S</h1>` → `L.A.R.S`
- [x] boot `<div id="bootLogo">J.A.R.V.I.S</div>` → `L.A.R.S`
- [x] SESSION panel "jarvis-main" / "jarvis:user:main" → "lars-main" / "lars:user:main"

Note: the CSS class `.msg.jarvis` (assistant bubble) must keep its NAME (it's a class, not
visible text) — rename is cosmetic only if we like, low priority.

## 2. Panels we can drop: SKILLS (08) + MACHINES (07) ✅ (removed)

Per user: Lars is kept lightweight (the `skills` toolset is disabled in the profile) and we
don't host a cluster — these two panels were placeholders from jarvis_ai with no real feed.
Remove their `<div class="panel">` blocks and renumber remaining panels.

## 3. Combine TURN METRICS (03) + SESSION (05) → one "LARS SESSION" panel

Take `Tokens today` + `Turns today` out of MODELS LOADOUT (06) and fold in. Goal: one section
that shows:
- Profile connected → `lars`
- Turns this session
- Tokens used (and remaining vs context cap)
- Token context cap (Cerebras `gpt-oss-120b` = **130k**; Hermes GLM = 200k?)
- Time-to-first-speech on the last turn
- Anything else useful for the active session

**Context-cap warning at 80%:** because Cerebras gpt-oss-120b is only ~130k context, when the
session's tokens hit ~80% of cap we must warn loudly and the operator decides: `/compact` the
session or hand over to a fresh `session.create`. (Hermes supports session compaction — the
"/compact" flow — and we can `session.create` a new id and re-prime it.)

> **Needs a data source.** Token count per turn can come from the Hermes `:9119` RPC (usage on
> `prompt.submit` result / `message.complete`) or an app-side tally in `server.js`. Not yet wired.
> Open: does Hermes expose per-session token usage over the RPC? Confirm before building.

## 4. MODELS LOADOUT (06) — simplify to our own stack, self-explanatory

Current panel is jarvis_ai's (lists `hermes-agent`, `whisper base.en`, `ElevenLabs Flash v2.5`,
`claude-haiku-4-5` — NONE match our real stack). Replace with OUR loadout:
- Brain: Hermes `lars` profile (or Cerebras `gpt-oss-120b` when BRAIN=cerebras)
- STT: browser Web Speech API (no model, no key)
- TTS: Pocket TTS `alba` (built-in)
- Remove 11Labs quota + `uCostRow` (we don't use ElevenLabs)
- Move `Tokens today`/`Turns today` out to the combined §3 panel.

## 5. DIAGNOSTICS (09) — small CPU/RAM for Hermes.exe only

User wants a tiny status for **Hermes.exe CPU + RAM** (not the whole machine), refreshed on a
short interval (~5s). Prefer a built-in path over a new server:

- **Best option (no new component):** the jarvis_ai repo showed `psutil` in a Hermes **dashboard
  plugin** (`plugin_api.py` exposes `/stats` returning `cpu_percent` + `ram_mb` for the Hermes
  process). Hermes already mounts plugin API routes — check if a `lars` dashboard plugin exists
  on this install that serves `/stats`; if so, the HUD just fetches it. Ref: the bundled
  `desktop-plugins/lars/.../dashboard/plugin_api.py` already has a `stats()` route (CPU/RAM for
  Hermes.exe) — reuse that endpoint.
- Fallback: a tiny `/api/machine` route on our own `server.js` using `os` + a `tasklist/psutil`
  call filtered to `Hermes.exe`.

## 6. General
- Renumber panels 01–N after removals + merges.
- Keep `VIEWS` (04) and `AUTOMATIONS`/`AGENT ACTIVITY` as-is unless user says otherwise.
- `.num` suffix labels (01,02…) must match the new panel order.

## 7. Voice control scheme v2 — priority chain (uncommitted, needs eyeball test)

Rewrote the voice controls as an explicit top-down priority chain, with large
explainer comments in `app.js` (section "THE VOICE PRIORITY CHAIN") so the logic
follows in one read:

| Rank | Control | State flag | Behavior |
|---|---|---|---|
| 1 | **STOP** (top dog) | `State.stopped` | Engage: kills in-flight LLM + blocks typed chat; voice chat & streaming OFF; STOP glows red; ring dead. Release: STOP normal again, typed chat works; **voice/streaming stay OFF until re-enabled manually** (no auto-resume). Default: released. |
| 2 | **MASTER MIC** (new `#micSw`, right of MIC TEST) | `State.micMuted` | Hard cut of LISTENING only: also stops the hardware stream. Voice chat/streaming keep their green glows. MIC ON is the only way hearing returns. **No special ring label** (user decision — ring keeps mode text while dead). Default: ON. |
| 3 | **STREAMING** | `State.rearm` | Needs voice chat ON. ON = mic live immediately + through reply (barge-in), ring says "I'M LISTENING". OFF = mic only for Orb talk sessions; open streaming session drops to rest (an in-progress push-to-talk is left alone). Default: OFF. |
| 4 | **VOICE CHAT** | `State.armed` | Turnabout master: ON = ring becomes push-to-talk (click to start, click again or 2 s timeout to send), hint "CLICK RING TO SPEAK". OFF = cuts listening only — Lars's reply + typed chat untouched. Voice OFF forces streaming OFF. Default: OFF (first click enables Google STT). |

- **Orb/Space = visual + push-to-talk ONLY** (`orbPress()` in app.js — single owner;
  Space bound once in app.js, HUD ring onclick calls it). It never flips any flag;
  dead in streaming mode / mic-off / STOP / voice-off.
- Single listening gate: `canListen()` — every recognizer open/restart/re-arm path
  goes through it (incl. Chrome session-end restart, post-reply re-arm, error paths).
- `stopListening(keepArmed)` — outer gates (mic/streaming/test) cut audio without
  touching voice-chat state.
- MIC TEST no longer clears streaming, resumes streaming listen after test, restores
  hardware-cut if MIC was off; resets ring label.
- Files: `public/state.js` (new flags + defaults), `public/app.js` (chain logic),
  `public/hud/index.html` (buttons + voiceHint bridge).
- Validated: `node --check` on both JS files + both inline HUD scripts; wiring greps.
  **Pending: user eyeball test in browser.**
- **MIC gate wiring (user rule: MIC on/off rules the whole mic circuit):** MIC OFF now
  cuts the `Microphone` chip (`MIC OFF` + red dot, gate-reported not hardware), forces
  the Input Level bar to rest in `meterSync()`, and blocks **MIC TEST** (chip shows
  red `MIC OFF`) — it never implicitly unmutes. Toggling MIC back ON resets the test
  chip to `—`. Ring label stays mode-text per earlier decision (no special MIC label).
- **Cosmetics (round 2):** voice row buttons `.xs` = same font as MIC TEST/MIC ON-OFF
  (10px) but slightly bigger boxes (6px/16px vs 2px/8px), `space-between` row → left/right
  justified with centre gap; ring hints shortened (`VOICE CHAT OFF`, `CHAT SESSION STOPPED`)
  and center-aligned (`text-align:center`).

---

## Open questions (blockers to resolve before building)
- Q1: Hermes RPC — can we read per-session token usage / context bytes over `:9119`? (Drives §3.)
- Q2: Does a dashboard plugin `/stats` route already exist + is it reachable? (Drives §5.)
- Q3: Confirm the Cerebras context cap (130k?) and whether the Hermes side reports it.
