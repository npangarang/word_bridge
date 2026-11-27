# WordBridge - Multiplayer Word Battle

## Overview
2-8 player real-time word game where players compete to find words matching shared letter pairs.

## Quick Start
```bash
cd wordbridge
npm install
node server.js
# Open http://localhost:3000 in two browser tabs
```

## Project Structure

### Backend
- **`server.js`** - Node.js + Express + Socket.io server (manages rooms for 2-8 players)
  - Manages game rooms
  - Handles real-time game state
  - Validates words against dictionary
  - Runs 10-round matches with 10-second timer per round

- **`package.json`** - Dependencies (express, socket.io, compression)

### Frontend
- **`index.html`** - Single page app with multiple screens (lobby, waiting, ready, game, results, end)
- **`game.js`** - Socket.io client, handles UI updates and user input
- **`style.css`** - Styling (mostly kept from original)

### Tests
- **`tests/server*.test.js`** - Socket.IO server/gameplay/lifecycle tests (`node:test`)
- **`tests/ui/`** - Real-browser UI/input/viewport regressions via CDP
- **`tests/e2e/`** - Two-client browser lifecycle suites
- **`tests/helpers/`** - Shared browser and socket test clients

### Data
- **`word_lookup.json`** - Pre-computed lookup (~116K words, 601 S-L buckets)
- **`word_categories.json`** - Word-to-category mapping (noun/adjective/verb, countries, US states, US cities)
- **`build_lookup.js`** - Build script for generating dictionary data
- **`words_scowl70.txt`** - Source dictionary (SCOWL 70)
- **`countries.txt`** - Country name source data
- **`us_states.txt`** - US states data
- **`us_cities.txt`** - US cities data
- **`demonyms.txt`** - Curated country/region/ethnicity terms
- **`slurs_blacklist.txt`** - Offensive term filter list

## How to Play

1. **Create Room** - Enter name, click "Create Room", share 6-digit code
2. **Join Room** - Enter name + code, click "Join Room"
3. **Configure** - Host toggles word categories (noun, verb, adjective, adverb, countries) in the lobby
4. **Ready Up** - Players mark themselves ready once configured
5. **Start** - Host clicks "Start Game" when both connected
6. **Play** - 10 rounds, 10 seconds each:
   - See letter pair (e.g., A...T)
   - Use the on-screen keyboard (or a physical keyboard) to type a word starting with A and ending with T
   - Press **Submit Word** or Enter
7. **Winner** - After 10 rounds, highest score wins

## Game Rules

- **Word validation**: Must exist in dictionary, exact S-L match
- **Word categories**: Host toggles which categories are active (noun/adjective/verb, countries, US states, US cities)
- **Invalid word**: 0 points for that round
- **Speed bonus**: First valid submission gets +1 point
- **Demonyms accepted**: american, french, arab, etc.
- **Offensive terms filtered**: Slurs blacklist rejects inappropriate submissions
- **Disconnection**: A transient disconnect reserves the seat during grace; permanent departure removes the player and forfeits a running match

## Technical Details

### Room Management
- 6-character room codes (alphanumeric, uppercase)
- Per-tab opaque resume token: a refresh/transient reconnect reclaims the same player and seat during a state-dependent grace window (playing 15s, paused/lobby/finished 30s)
- Grace expiry removes the player, reassigns the host to a live player, and cleans empty rooms/timers
- Duplicate live tabs sharing a token are rejected (`RESUME_IN_USE`) without kicking the incumbent; explicit name entry starts a new player
- No persistent storage (rooms deleted when empty)

### Timing
- Server-side synchronized timer (10 seconds per round)
- Client displays countdown from server deadline
- Late submissions ignored (after timer expires)

### Word Validation
- Case-insensitive
- On-screen/hardware input restricted to letters and hyphen; 20-character cap
- Uses same word_lookup.json as server
- Q→Y special case handled (qu- prefix words)
- Filtered against slurs_blacklist.txt

### Word Entry
- Wordle-style on-screen keyboard plus Submit Word / Delete
- No editable element on the game screen, so mobile OS keyboards do not open
- Hardware keyboard, hardware Backspace/Delete, Enter and paste still work

### Word Categories
- Host toggles noun/adjective/verb, countries, US states and US cities in the room lobby
- Toggles sync to all players in real-time
- Untagged words always valid regardless of toggle state
- Server selects pairs only from active category combinations

### Player Profiles
- Players choose emoji avatars in profile editor
- Profiles persist in localStorage

### Emoji Reactions
- 8 emoji reactions available during gameplay (💨😂😱🔥👏😢💀🤯)

### Socket Events

**Client → Server:**
- `setName(name)` - Register or resume identity
- `createRoom` / `joinRoom({code})` - Create/join a room
- `readyUp` / `startGame` - Lobby readiness and host start
- `submitWord({word, matchId, round})` - Submit answer; server checks deadline and current round
- `leaveRoom` / `returnToLobby` - Permanent leave / return after a finished game
- `requestPlayAgain` - Vote for a rematch
- `updateCategories(categories)` - Host updates category toggles
- `setComfortMode({enabled})` - Sync comfort preference
- `sendReaction({emoji})` - Send an emoji reaction
- `challengePlayer` / `acceptChallenge` / `declineChallenge` / `cancelChallenge` - Direct challenges
- `requestOnlinePlayers` - Refresh the online roster

**Server → Client:**
- `nameConfirmed({playerId, name, resumeToken, resumed})` - Identity established/resumed
- `roomStateRestored(snapshot)` - Authoritative lobby/playing/paused/finished restore
- `roomCreated` / `roomJoined` / `roomLeft` - Room entry/exit acknowledgements
- `playerJoined` / `playerRejoined` / `playerLeft` / `opponentDisconnected` - Roster/lifecycle updates
- `roundStart({round, totalRounds, startLetter, endLetter, deadline, matchId, timeLeft})`
- `playerSubmitted({playerId, playerName})`
- `roundEnd({results, pair, round, totalRounds})`
- `gameEnd({players, rankings, winnerId, isTie, canPlayAgain})`
- `gameReset` / `playAgainVote` / `categoriesUpdated` / `comfortModeUpdated` / `playerLobbyReady`
- `onlinePlayers` / `reactionReceived` / `error({message})`

## Socket.io Client Usage
The client connects automatically via:
```html
<script src="/socket.io/socket.io.js"></script>
<script src="game.js"></script>
```

## Unique Styles
- Server reads `word_lookup.json` at startup via relative path
- Single-page app with screen-state machine (lobby→waiting→ready→game→results→end)
- Server-side synchronized timer (deadline passed to client)

## Commands
```bash
npm install           # Install dependencies
npm start             # Start server (node server.js)
npm test              # Server + browser UI + multiplayer e2e
npm run test:server   # node:test server suites
npm run test:ui       # Local Chromium UI regressions
npm run test:e2e      # Two-client browser lifecycle suites
node build_lookup.js  # Rebuild word_lookup.json from source (no npm script)
```
Tests need Node >= 22 and a local Chromium/Chrome; see `tests/README.md`.

## Deployment (Render)
- `render.yaml` included for one-click deploy
- Web service type, Node.js environment
- `npm install` build, `node server.js` start
- Free tier supported
