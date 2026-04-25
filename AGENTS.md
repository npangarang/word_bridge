# WordBridge - Multiplayer Word Battle

## Overview
1v1 real-time word game where two players compete to find words matching shared letter pairs.

## Quick Start
```bash
cd /Users/neelpanging/Desktop/projects/guess_word
node server.js
# Open http://localhost:3000 in two browser tabs
```

## Project Structure

### Backend
- **`server.js`** - Node.js + Express + Socket.io server
  - Manages game rooms
  - Handles real-time game state
  - Validates words against dictionary
  - Runs 10-round matches with 10-second timer per round

- **`package.json`** - Dependencies (express, socket.io)

### Frontend
- **`index.html`** - Single page app with multiple screens (lobby, waiting, ready, game, results, end)
- **`game.js`** - Socket.io client, handles UI updates and user input
- **`style.css`** - Styling (mostly kept from original)

### Data
- **`word_lookup.json`** - Pre-computed lookup (359K words across 660 S-L buckets)
- **`build_lookup.js`** - Build script for word_lookup.json

## How to Play

1. **Create Room** - Enter name, click "Create Room", share 6-digit code
2. **Join Room** - Enter name + code, click "Join Room"
3. **Start** - Host clicks "Start Game" when both connected
4. **Play** - 10 rounds, 10 seconds each:
   - See letter pair (e.g., A...T)
   - Type a word starting with A and ending with T
   - Press Enter to submit
5. **Scoring** - Points = word length + 1 bonus for faster submission
6. **Results** - After each round, see both words and updated scores
7. **Winner** - After 10 rounds, highest score wins

## Game Rules

- **Word validation**: Must exist in dictionary, exact S-L match
- **Invalid word**: 0 points for that round
- **Speed bonus**: First valid submission gets +1 point
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

### Socket Events

**Client → Server:**
- `createRoom(name)` - Create new room
- `joinRoom({code, name})` - Join existing room
- `startGame()` - Host starts match
- `submitWord(word)` - Submit answer
- `leaveRoom()` - Leave current room
- `restartGame()` - Play again after game end

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

## Socket.io Client Usage
The client connects automatically via:
```html
<script src="/socket.io/socket.io.js"></script>
<script src="game.js"></script>
```

## File Cleanup
- `script.js` - Removed (replaced by `game.js`)
- `wordlist.txt` - Unused legacy file

## Anti-Patterns (THIS PROJECT)
- Frontend assets at root instead of `public/` directory
- `word_lookup.json` and `build_lookup.js` at root instead of `data/`/`scripts/`
- No tests directory - project lacks test scaffold
- No ESLint/Prettier config - no enforced code style
- `express.static(__dirname)` serves entire repo (security surface)

## Unique Styles
- Server reads `word_lookup.json` at startup via relative path
- Single-page app with screen-state machine (lobby→waiting→ready→game→results→end)
- Server-side synchronized timer (deadline passed to client)

## Commands
```bash
npm install     # Install dependencies
npm start       # Start server (node server.js)
node build_lookup.js  # Rebuild word_lookup.json from source
```

## Notes
- `words_full.,txt` has typo in filename (trailing comma)
- `style.css` referenced in index.html but must exist at same path
- Room codes are 6-char uppercase alphanumeric
- No persistent storage - rooms auto-cleanup when empty
- `Q→Y` special case: words starting with `qu-` treated as ending in `Y`