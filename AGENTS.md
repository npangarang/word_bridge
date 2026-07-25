# WordBridge - Multiplayer Word Battle

## Overview
2-8 player real-time word game where players compete to find words matching shared letter pairs.

## Quick Start
```bash
cd word_bridge
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

### Data
- **`word_lookup.json`** - Pre-computed lookup (~116K words, 601 S-L buckets)
- **`word_categories.json`** - Word-to-category mapping (noun, verb, adjective, adverb, country)
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
   - Type a word starting with A and ending with T
   - Press Enter to submit
7. **Winner** - After 10 rounds, highest score wins

## Game Rules

- **Word validation**: Must exist in dictionary, exact S-L match
- **Word categories**: Host toggles which categories are active (noun, verb, adjective, adverb, countries)
- **Invalid word**: 0 points for that round
- **Speed bonus**: First valid submission gets +1 point
- **Demonyms accepted**: american, french, arab, etc.
- **Offensive terms filtered**: Slurs blacklist rejects inappropriate submissions
- **Disconnection**: Opponent wins by forfeit

## Technical Details

### Room Management
- 6-character room codes (alphanumeric, uppercase)
- Auto-cleanup on player disconnect
- No persistent storage (rooms deleted when empty)

### Timing
- Server-side synchronized timer (10 seconds per round)
- Client displays countdown from server deadline
- Late submissions ignored (after timer expires)

### Word Validation
- Case-insensitive
- Uses same word_lookup.json as server
- Q→Y special case handled (qu- prefix words)
- Filtered against slurs_blacklist.txt

### Word Categories
- Host toggles categories (noun, verb, adjective, adverb, countries) in room lobby
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
- `createRoom(name)` - Create new room
- `joinRoom({code, name})` - Join existing room
- `startGame()` - Host starts match
- `submitWord(word)` - Submit answer
- `leaveRoom()` - Leave current room
- `restartGame()` - Play again after game end
- `updateCategories(categories)` - Host updates word category toggles
- `updateProfile(profile)` - Player updates their profile
- `sendReaction({emoji})` - Send emoji reaction

**Server → Client:**
- `roomCreated({code, isHost, players})` - Room created successfully
- `roomJoined({code, isHost, players})` - Joined room successfully
- `playerJoined({players})` - Another player joined
- `playerLeft({players})` - Player left waiting room
- `roundStart({round, totalRounds, startLetter, endLetter, deadline})` - New round
- `playerSubmitted({playerId})` - Opponent submitted
- `roundEnd({results, pair, round, totalRounds})` - Round complete
- `gameEnd({players, winner, isTie})` - Game over
- `opponentLeft` - Opponent disconnected
- `gameReset({players})` - Game reset for replay
- `error({message})` - Error occurred
- `categoriesUpdated({categories})` - Categories changed by host
- `reactionReceived({playerId, emoji})` - Emoji reaction received

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
npm install     # Install dependencies
npm start       # Start server (node server.js)
node build_lookup.js  # Rebuild word_lookup.json from source (no npm script)
```

## Deployment (Render)
- `render.yaml` included for one-click deploy
- Web service type, Node.js environment
- `npm install` build, `node server.js` start
- Free tier supported
