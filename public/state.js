/* =====================================================================
   state.js — the voice state machine (single source of truth for "what is the app doing")

   States
     idle       nothing happening; mic closed
     listening  mic open, waiting for / collecting the user's words
     thinking   utterance sent; waiting for the first LLM token / first audio
     speaking   assistant audio is playing (mic may be open for barge-in)

   Normal turn:   idle → listening → thinking → speaking → listening (re-arm) → …
   Barge-in:      speaking → listening
   Typed input:   idle → thinking → speaking → idle
   Any state can fall back to idle (Stop button, errors, mic blocked).

   The voice controls are a PRIORITY CHAIN (top → bottom), single source of truth:
     stopped   STOP engaged      — kills LLM + typed chat + voice; STOP glows red
     micMuted  MASTER MIC OFF    — hard cut of listening; independent of everything
     rearm     STREAMING         — voice chat + barge-in (requires armed)
     armed     VOICE CHAT        — turn-about mode: click the Orb to speak
     testMode  MIC TEST running  — log what the mic hears, never act on it

   Listening is allowed only when: armed && !micMuted && !stopped && !testMode
   (see canListen() in app.js — the ONE gate everything goes through).
   ===================================================================== */
'use strict';

const State = (() => {
  // Which transitions are expected. Unexpected ones are still applied but reported (helps spot bugs).
  const ALLOWED = {
    idle:      ['listening', 'thinking'],
    listening: ['idle', 'thinking'],
    thinking:  ['idle', 'listening', 'speaking'],
    speaking:  ['idle', 'listening', 'thinking'],
  };

  let current = 'idle';
  const subscribers = [];

  return {
    stopped: false,   // STOP top-dog state (default: released / normal)
    micMuted: false,  // MASTER MIC gate (default: MIC ON)
    armed: false,     // VOICE CHAT (default: OFF — user must click to enable STT)
    rearm: false,     // STREAMING (default: OFF — turn-about until enabled)
    testMode: false,

    get current() { return current; },
    is(...names) { return names.includes(current); },

    /** Move to a new state. `label` is optional display text, e.g. "Echo test…". */
    set(next, label) {
      const prev = current;
      const expected = prev === next || ALLOWED[prev].includes(next) || next === 'idle';
      current = next;
      subscribers.forEach(fn => fn(prev, next, label, expected));
    },

    /** Register fn(prev, next, label, expected) — called after every set(). */
    onChange(fn) { subscribers.push(fn); },
  };
})();