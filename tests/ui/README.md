# UI regression tests

Dependency-free browser checks for WordBridge's game input, animation and
viewport behavior. They use the real `index.html` / `style.css` / `game.js`
through a local static server, with a fake Socket.IO client so tests do not
need a running game server.

## Run

```bash
TMPDIR=/path/to/scratch CHROME_PATH=/usr/sbin/chromium node tests/ui/game-ui.test.js
```

`CHROME_PATH` is optional if Chromium/Chrome is at a common local path. The
harness can also reuse an existing Playwright browser cache; it never
downloads or installs a browser.

Browser profile temp directories follow `BROWSER_TMPDIR`, then `TMPDIR`, then
the platform default. Set one of those to a local scratch/cache directory to
keep Chromium profiles out of the system temp directory. No personal path is
hard-coded in the test files.

Requirements:

- Node >= 22 (the harness uses the built-in `WebSocket`)
- A local Chromium/Chrome binary

Screenshots are written to `screenshots/ui/` (gitignored). Override with:

```bash
UI_SCREENSHOT_DIR=/path/to/scratch/wordbridge-ui-shots node tests/ui/game-ui.test.js
```

## Coverage

- No editable input in the active game; on-screen keyboard, hyphen,
  backspace, submit and accessible labels/focus
- Real CDP mouse clicks and touch taps through hit-tested geometry, not only
  programmatic `element.click()`
- Mixed pointer + hardware input: after a real pointer key click, focus returns
  to the non-editable answer display; tap/click A, type R/T, press Enter once,
  and submit `art` without re-activating the last letter
- Native Tab/Space/Enter activation of a focused letter keeps focus on that
  button and activates it exactly once; programmatic/AT-style activation also
  keeps button focus
- Modifier shortcuts, IME composition and editable targets do not leak text
  into the answer
- Hardware typing, Delete/Backspace, Enter, the old 20-character cap, and
  existing minimum-length/dictionary validation
- Category-rejection recovery without losing the typed word
- Timer-expiry input lock
- Both letter tiles visible through the low-timer shake, at the instant the
  critical state starts during the tile entrance, and in Comfort Mode,
  reduced-motion and high-contrast modes
- Active-game viewport fit and full keyboard-stability checks with real 2- and
  8-player rosters across portrait, narrow, short and landscape viewports
- Lobby/help/results keep normal document scrolling
- Safe-area insets, `viewport-fit=cover`, and controls contained inside the
  safe-area content box
- Seven long-named disconnects in an 8-player game use a compact game-HUD
  notice, not the global fixed banner; bounds and center-point sampling prove
  no tile or keyboard control is visually covered, keyboard position stays
  fixed, and the full name list remains in the alert's accessible text.
  Covered in Comfort Mode at 320×568 and 568×320, normal and notched safe areas.
- All non-local browser requests are blocked; no page exceptions may occur

## Notes

- The fake socket makes UI states deterministic. Two-client Socket.IO/lobby
  lifecycle tests belong in a separate end-to-end lane.
- Real mobile OS keyboard opening is represented by the stronger UI contract:
  the game screen contains no editable element and round-start focus lands on
  a non-editable display.
