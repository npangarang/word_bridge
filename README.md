# WordBridge

A real-time multiplayer word game where 2-8 players compete to find words matching shared letter pairs.

![WordBridge UI](assets/screenshot.png)

## Quick Start

```bash
npm install
npm start
```

Then open **http://localhost:3000** in two browser tabs.

## How to Play

1. Enter your name and click **Enter Lobby**
2. Create a room or join with a 6-character room code from a friend
3. Both players ready up, host clicks **Start Game**
4. 10 rounds, 10 seconds each: see a letter pair (e.g., A...T)
5. Use the on-screen keyboard (or type on a physical keyboard) to build a word starting with **A** and ending with **T** (e.g., "about")
6. Press **Submit Word** or Enter — fastest valid word gets +1 bonus
7. After each round, see both words and updated scores
8. Highest total after 10 rounds wins

## Game Rules

- **Word validation**: Must exist in dictionary, exact S-L match
- **Invalid word**: 0 points for that round
- **Speed bonus**: First valid submission gets +1 point
- **Word categories**: Host can toggle noun/adjective/verb words, countries, US states and US cities
- **Dictionary**: ~116K words from SCOWL 70, with curated demonyms (american, french, arab)
- **Offensive terms**: Filtered out
- **Disconnection**: A transient disconnect reserves the seat during a short grace window; a permanent departure can forfeit the match

## Project Structure

```
├── server.js              # Node.js + Express + Socket.io server
├── game.js                # Client-side Socket.io logic
├── index.html             # Single-page app with screen state machine
├── style.css              # Retro arcade styling
├── word_lookup.json       # Pre-computed word lookup (601 S-L buckets)
├── word_categories.json   # Word-to-category mapping
├── build_lookup.js        # Build script for dictionary data
├── tests/                 # Server, browser-UI and multi-client e2e suites
├── words_scowl70.txt      # Source dictionary (SCOWL 70)
├── package.json           # Dependencies
└── assets/                # Screenshots and assets
```

## Deployment

### Render (Recommended)

1. Create a free account at [render.com](https://render.com)
2. Connect your GitHub repository
3. Create a new **Web Service** — Render auto-detects `render.yaml`
4. Deploys automatically on push to `master`

Or use the [Render CLI](https://render.com/docs/cli):

```bash
npm install -g @render/cli
render login
render deploy
```

### Cloudflare Tunnel (Quick Alternative)

```bash
# Install cloudflared if needed
brew install cloudflared

# Run tunnel (temporary URL)
cloudflared tunnel --url http://localhost:3000
```

### Ngrok (Quick Alternative)

```bash
# Install ngrok if needed
brew install ngrok

# Run tunnel (requires account)
ngrok http 3000
```

### LocalTunnel (Quick Alternative)

```bash
npx localtunnel --port 3000
```

## Architecture

- **Server**: Express + Socket.io, manages game rooms for 2-8 players
- **Client**: Single-page app with screen-state machine (name → lobby → room lobby → game → results → game end)
- **Input**: Wordle-style on-screen keyboard with submit/backspace; no native text field, so mobile OS keyboards do not open. Hardware keyboards and paste still work
- **Viewport**: The active game is a fixed dynamic-viewport grid; lobby/help/results keep normal document scrolling
- **Sessions**: Per-tab resume token. A refresh or transient reconnect reclaims the same player/seat; grace expiry removes the player and reassigns the host. A second live tab sharing a token is rejected without kicking the incumbent
- **Dictionary**: Pre-computed S-L pair lookup (~116K words, 601 active buckets)
- **Categories**: Noun/adjective/verb, countries, US states, US cities — host-configurable
- **Timing**: Server-synchronized timer (10 seconds per round, 5-second pause between rounds)
- **Profiles**: Player profiles with emoji avatars

## Tests

```bash
npm test              # server + browser UI + multiplayer e2e
npm run test:server   # node:test Socket.IO server suites
npm run test:ui       # local Chromium UI regressions
npm run test:e2e      # two-client browser lifecycle suites
```

Tests need Node >= 22 and a local Chromium/Chrome (`CHROME_PATH` if not auto-detected). They install nothing and make no external requests. See `tests/README.md`.

## Socket Events

See `AGENTS.md` for full socket event documentation.

## License

MIT — see [LICENSE](LICENSE)