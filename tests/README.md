# WordBridge test suites

Three local lanes, runnable offline with Node >= 22 and a local
Chromium/Chrome. The tests install nothing; the server lanes use the declared
production runtime modules already required by the app.

| Command | What it covers |
| --- | --- |
| `npm run test:server` | Real Socket.IO server unit/integration tests (`tests/server*.test.js`) using `node:test` and the lightweight client in `tests/helpers/socket-client.js`. |
| `npm run test:ui` | Deterministic browser input/layout/animation regressions against a fake Socket.IO client (`tests/ui/game-ui.test.js`). |
| `npm run test:e2e` | Multiple real browser clients against a real game server, covering refresh/reconnect/lifecycle behavior (`tests/e2e/multiplayer.test.js`). |
| `npm test` | Runs all three lanes in order. |

No test dependency is installed or downloaded. The server lanes require the
production runtime modules (`socket.io`, `express`, `compression`); point
`NODE_PATH` at an existing local `node_modules` tree:

```bash
export NODE_PATH='/path/to/node_modules:/another/node_modules'
npm test
```

The offline environment used during development resolves:

- `socket.io` 4.8.3
- `express` 4.22.2 (`package-lock.json` pins 4.22.1; no registry access is
  available to reconcile that lock/runtime difference)
- `compression` 1.8.1

Server tests use the Socket.IO client bundle shipped inside the declared
`socket.io` package (`socket.io/client-dist/socket.io.js`) over Node >= 22's
native WebSocket. There is no undeclared `socket.io-client` dev dependency.

## Requirements

- Node >= 22 (the browser harness and server test client use the built-in
  WHATWG `WebSocket`).
- A local Chromium/Chrome. Set `CHROME_PATH` when it is not in a common path:
  ```bash
  CHROME_PATH=/usr/sbin/chromium npm run test:ui
  ```
  The harness can also reuse an existing Playwright browser cache; it never
  downloads a browser.
- The app's production `engines.node` remains `>=18`; only tests require 22+.

## End-to-end behavior (`tests/e2e/multiplayer.test.js`)

`tests/helpers/browser.js` provides the CDP browser harness. The e2e suite
serves the real app from the real game server (not the fake socket) and covers:

- Two pages entering the same display name independently; roster identity is
  by stable player id, never by name.
- Host and non-host lobby reloads preserving host, readiness, room code and
  player id without duplicate roster entries.
- Invite links (`/?room=CODE`) auto-joining exactly once only after the roomless
  restore snapshot, and not re-joining on reload.
- Stale resume tokens (`SESSION_EXPIRED`) being cleared once with an explicit
  message, never auto-creating a player or recreating the old room.
- Duplicate live-tab tokens (`RESUME_IN_USE`) retaining the token, not kicking
  the incumbent, showing the explicit "PLAY AS NEW PLAYER" name-screen action,
  retrying in bounded fashion after the owning tab closes to resume the same
  identity, and only creating a second player after an explicit name entry.
- Browser offline/online events while the transport remains live: commands are
  blocked while offline, then resume with the same player id/readiness without
  requiring a new snapshot or replaying stale commands.
- Session-storage failures: a same-page reconnect still resumes with the
  in-memory token when `sessionStorage` get/set/remove throw. A full page reload
  cannot resume without persistent storage (there is nowhere to read the token
  from), which is expected and documented.
- A stored `comfortMode: false` preference re-syncing after reconnect so a
  server session cannot keep a stale comfort round duration.
- Paused round restore (results/score), active round restore (same pair,
  absolute deadline, original duration, submission word, locked input, score),
  and transient transport recovery with the same player id and no duplicate.
- Finished-game restore of play-again votes, `canPlayAgain: false` hiding the
  dead rematch action, and host-departure forfeit state surviving a refresh.

The suite prefers the exported `createGameServer` factory (using test-only rule
overrides for shorter rounds) and falls back to spawning `server.js` with
`PORT=<ephemeral>` when the factory is unavailable. It never contacts a
registry or non-local URL; the browser harness blocks external requests.

Real browser input is validated as object payloads:

```js
socket.emit('submitWord', { word, matchId, round });
```

## UI regressions (`tests/ui/game-ui.test.js`)

The fake-socket fixture drives the same authoritative flow as production:
`nameConfirmed`, then a `roomStateRestored` snapshot containing the active
`roundStart`/`matchId`. Submit assertions check the full
`{ word, matchId, round }` object. Shipped checks remain as documented in
`tests/ui/README.md`: on-screen and hardware typing, validation, timer expiry,
critical/Comfort/reduced-motion/high-contrast tiles (including the critical
onset during the tile entrance), viewport and safe-area fit with real 2- and
8-player rosters, and offline request blocking. Screenshots go to
`screenshots/ui/` (gitignored); override with `UI_SCREENSHOT_DIR`.

## Server tests (`tests/server*.test.js`)

Server tests use `createGameServer` with an injected manual clock to exercise
session resume, token expiry, identity/roster semantics, forfeits, timers and
room lifecycle deterministically. They are owned by the server lane; the
aggregate `npm test` treats them as the first gate.
