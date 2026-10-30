"""Tool schemas for the Jarvis HUD display plugin.

The description is what makes the agent USE the tool — keep it forceful.
Lesson learned: prose in SOUL.md cannot out-compete an attractive tool schema
(the model kept opening pages in its own invisible browser); a real tool with
an explicit description wins immediately.
"""

HUD_DISPLAY = {
    "name": "hud_display",
    "description": (
        "Record the user's screen action. CALL THIS TOOL FIRST, BEFORE ANY OTHER TOOL, "
        "whenever the user asks to show, display, pull up, open, put, or play anything on "
        "screen ('show me', 'pull up', 'open', 'find and show', 'find a video of'). "
        "Bundle a web search + this tool in ONE turn: search for the URL, then call "
        "hud_display with the result. Do NOT reply with words before calling this tool; "
        "call it, then confirm in one short sentence. YouTube video URLs embed as playable "
        "video (media=video). For a webpage or the Hermes views use media=iframe. "
        "Fixed targets: Hermes kanban board = http://127.0.0.1:9119/kanban ; "
        "Hermes dashboard = http://127.0.0.1:9119/ ."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "media": {
                "type": "string",
                "enum": ["video", "iframe", "image"],
                "description": "video = YouTube or direct video URL; iframe = any webpage; image = image URL",
            },
            "src": {"type": "string", "description": "Full URL of the video, page, or image"},
            "title": {"type": "string", "description": "Short panel title, e.g. 'ARC REACTOR EXPLAINED'"},
            "position": {
                "type": "string",
                "enum": ["center", "left", "right"],
                "description": "Default center (one large panel). Use left/right ONLY when showing multiple panels at once. The Hermes kanban/dashboard views open as a full window regardless of this value.",
            },
        },
        "required": ["media", "src", "title"],
    },
}

HUD_DISMISS = {
    "name": "hud_dismiss",
    "description": "Close/clear/dismiss whatever is on the user's screen (HUD panels, the viewer, the Hermes dashboard). CALL THIS TOOL whenever the user says to close, clear, dismiss, remove, or hide something on screen ('close it', 'close that', 'close the panel', 'clear the screen'). Call it on the FIRST such request — do not reply in words first and do not ask for confirmation.",
    "parameters": {"type": "object", "properties": {}},
}
