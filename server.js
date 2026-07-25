const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const compression = require('compression');

const app = express();
app.use(compression());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  }
});

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 10;
const PAUSE_TIME = 5;
const TOTAL_ROUNDS = 10;
const MAX_PLAYERS = 8;

const wordLookupRaw = JSON.parse(fs.readFileSync('./word_lookup.json', 'utf8'));
const wordLookup = {};
for (const key of Object.keys(wordLookupRaw)) {
  wordLookup[key] = new Set(wordLookupRaw[key]);
}

const wordCategories = JSON.parse(fs.readFileSync('./word_categories.json', 'utf8'));

const validCombinations = new Set();
for (const key of Object.keys(wordLookup)) {
  if (wordLookup[key] && wordLookup[key].size > 0) {
    validCombinations.add(key);
  }
}

const rooms = new Map();
const roomTimers = new Map();
const pauseTimers = new Map();
const onlinePlayers = new Map();
const disconnectTimers = new Map();
const challenges = new Map();
const CHALLENGE_TIMEOUT = 15000;

// ── Helpers ──────────────────────────────────────────

function clearRoomTimer(roomCode) {
  if (roomTimers.has(roomCode)) {
    clearTimeout(roomTimers.get(roomCode));
    roomTimers.delete(roomCode);
  }
}

function clearPauseTimer(roomCode) {
  if (pauseTimers.has(roomCode)) {
    clearTimeout(pauseTimers.get(roomCode));
    pauseTimers.delete(roomCode);
  }
}

function generateRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).substring(2, 8).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function getRandomPair(pairs) {
  const keys = Array.from(pairs || validCombinations);
  return keys[Math.floor(Math.random() * keys.length)];
}

function validateWord(word, startLetter, endLetter) {
  const w = word.toLowerCase();
  const s = startLetter.toLowerCase();
  const e = endLetter.toLowerCase();

  if (w.length < 3) return false;
  if (!w.startsWith(s) || !w.endsWith(e)) return false;
  if (w.includes('--')) return false;

  const key = s + e;
  const words = wordLookup[key];
  if (!words || !words.has(w)) return false;

  return true;
}

// Check if a word belongs to at least one enabled category.
// Only enforced when at least one category is disabled.
// Untagged words (no entry or empty array) are rejected — consistent with
// pair selection which ignores untagged words when determining which pairs to offer.
function wordMatchesCategories(word, room) {
  if (!room || !room.categories) return true;
  const hasActiveFilter = Object.keys(room.categories).some(k => room.categories[k] === false);
  if (!hasActiveFilter) return true;

  const w = word.toLowerCase();
  const wordCats = wordCategories[w];
  if (!wordCats || wordCats.length === 0) return false;
  return wordCats.some(cat => room.categories[cat]);
}

function getOnlinePlayersList() {
  const list = [];
  for (const [id, data] of onlinePlayers) {
    list.push({
      id,
      name: data.name,
      status: data.status
    });
  }
  return list;
}

function broadcastOnlinePlayers() {
  io.emit('onlinePlayers', getOnlinePlayersList());
}

function getPlayer(room, socketId) {
  return room.players.find(p => p.id === socketId);
}

function reassignHost(room) {
  if (room.players.length > 0) {
    room.host = room.players[0].id;
  }
}

function broadcastToRoom(roomCode, event, data) {
  io.to(roomCode).emit(event, data);
}

// ── Room Lifecycle ───────────────────────────────────

function removePlayerFromRoom(socketId, roomCode, reason) {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Cancel any pending disconnect cleanup for this socket (explicit leave)
  if (disconnectTimers.has(socketId)) {
    clearTimeout(disconnectTimers.get(socketId));
    disconnectTimers.delete(socketId);
  }

  const wasHost = room.host === socketId;

  // Remove player from room
  room.players = room.players.filter(p => p.id !== socketId);

  if (room.players.length === 0) {
    // Room empty — clean up
    clearRoomTimer(roomCode);
    clearPauseTimer(roomCode);
    rooms.delete(roomCode);
    return;
  }

  // Reassign host if the host left
  if (wasHost) {
    reassignHost(room);
  }

  // Clear play-again votes when a player leaves
  if (room.playAgainVotes) {
    room.playAgainVotes.delete(socketId);
    broadcastToRoom(roomCode, 'playAgainVote', {
      voteCount: room.playAgainVotes.size,
      playerCount: room.players.length,
      votedId: null
    });
  }

  // If only 1 player remains and game is active, auto-end it
  if (room.players.length === 1 && room.state === 'playing') {
    const remaining = room.players[0];
    clearRoomTimer(roomCode);
    clearPauseTimer(roomCode);
    room.state = 'finished';

    // Restore player status
    const onlinePlayer = onlinePlayers.get(remaining.id);
    if (onlinePlayer) {
      onlinePlayer.status = 'online';
      onlinePlayer.roomCode = null;
    }

    broadcastToRoom(roomCode, 'gameEnd', {
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      rankings: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      topPlayers: [{ id: remaining.id, name: remaining.name, score: remaining.score }],
      isTie: false,
      winnerId: remaining.id,
      forfeit: true
    });
    rooms.delete(roomCode);
  } else {
    // Notify remaining players
    broadcastToRoom(roomCode, 'playerLeft', {
      playerId: socketId,
      players: room.players,
      hostId: room.host
    });
  }
}

// ── Round / Game Functions ───────────────────────────

function startRoundTimer(roomCode) {
  clearRoomTimer(roomCode);

  const timer = setTimeout(() => {
    roomTimers.delete(roomCode);
    endRound(roomCode);
  }, ROUND_TIME * 1000);

  roomTimers.set(roomCode, timer);
}

function endRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.state !== 'playing') return;

  clearRoomTimer(roomCode);

  // Collect all submissions (stored directly on player objects)
  const validSubmissions = room.players
    .filter(p => p.submission && p.submission.isValid)
    .map(p => p.submission);

  // Find first valid submitter (lowest timeTaken)
  const firstSubmitter = validSubmissions.length > 0
    ? validSubmissions.reduce((a, b) => a.timeTaken < b.timeTaken ? a : b)
    : null;

  // Calculate results
  const results = room.players.map(p => {
    const sub = p.submission;
    let roundPoints = 0;
    let bonus = 0;

    if (sub && sub.isValid) {
      roundPoints = sub.word.length;
      if (sub === firstSubmitter) {
        bonus = 1;
        roundPoints += 1;
      }
    }

    p.score += roundPoints;

    return {
      playerId: p.id,
      name: p.name,
      word: sub && !sub.isValid ? `(${sub.word})` : (sub ? sub.word : '(no submission)'),
      isValid: sub ? sub.isValid : false,
      timeTaken: sub ? sub.timeTaken : null,
      points: roundPoints,
      bonus,
      totalScore: p.score
    };
  });

  // Always provide examples for the round's letter pair — must respect category filter
  let examples = null;
  if (room.currentPair) {
    const pairWords = wordLookup[room.currentPair];
    if (pairWords) {
      const hasActiveFilter = room.categories && Object.keys(room.categories).some(k => room.categories[k] === false);
      if (hasActiveFilter) {
        // Only show words explicitly matching an active category — skip untagged
        examples = [...pairWords].filter(w => {
          const wordCats = wordCategories[w];
          return wordCats && wordCats.length > 0 && wordCats.some(cat => room.categories[cat]);
        }).slice(0, 5);
      } else {
        examples = [...pairWords].slice(0, 5);
      }
    }
  }

  broadcastToRoom(roomCode, 'roundEnd', {
    results,
    pair: room.currentPair,
    round: room.currentRound,
    totalRounds: TOTAL_ROUNDS,
    examples
  });

  // Reset submissions for next round and pause state
  room.players.forEach(p => { p.submission = null; });
  room.state = 'paused';

  // After final round → end game after pause (same as between rounds)
  if (room.currentRound >= TOTAL_ROUNDS) {
    clearPauseTimer(roomCode);
    const pauseTimer = setTimeout(() => {
      pauseTimers.delete(roomCode);
      endGame(roomCode);
    }, PAUSE_TIME * 1000);
    pauseTimers.set(roomCode, pauseTimer);
    return;
  }

  // Auto-advance after pause
  clearPauseTimer(roomCode);
  const pauseTimer = setTimeout(() => {
    pauseTimers.delete(roomCode);
    startNextRound(roomCode);
  }, PAUSE_TIME * 1000);
  pauseTimers.set(roomCode, pauseTimer);
}

function startNextRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.currentRound++;
  room.currentPair = getRandomPair(room.categoryPairs);
  room.roundStartTime = Date.now();
  room.state = 'playing';

  broadcastToRoom(roomCode, 'roundStart', {
    round: room.currentRound,
    totalRounds: TOTAL_ROUNDS,
    startLetter: room.currentPair[0].toUpperCase(),
    endLetter: room.currentPair[1].toUpperCase(),
    timeLeft: ROUND_TIME,
    deadline: room.roundStartTime + ROUND_TIME * 1000
  });

  startRoundTimer(roomCode);
}

function endGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  clearRoomTimer(roomCode);
  clearPauseTimer(roomCode);
  room.state = 'finished';
  room.playAgainVotes = new Set();

  // Rankings
  const maxScore = Math.max(...room.players.map(p => p.score));
  const topPlayers = room.players.filter(p => p.score === maxScore);
  const isTie = topPlayers.length > 1;

  broadcastToRoom(roomCode, 'gameEnd', {
    players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    rankings: [...room.players].sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score })),
    topPlayers: topPlayers.map(p => ({ id: p.id, name: p.name, score: p.score })),
    isTie,
    winnerId: isTie ? null : topPlayers[0].id
  });

  broadcastOnlinePlayers();
}

function forceStartGame(roomCode) {
  const room = rooms.get(roomCode);
  if (!room || room.state !== 'lobby') return;

  // Compute category-filtered valid pairs (same logic as startGame handler)
  const hasActiveFilter = room.categories && Object.keys(room.categories).some(k => room.categories[k] === false);
  if (hasActiveFilter) {
    const categoryPairs = new Set();
    for (const key of validCombinations) {
      const words = wordLookup[key];
      for (const word of words) {
        const wordCats = wordCategories[word];
        if (wordCats && wordCats.length > 0 && wordCats.some(cat => room.categories[cat])) {
          categoryPairs.add(key);
          break;
        }
      }
    }
    if (categoryPairs.size === 0) {
      // Fallback: use all pairs if no matches (shouldn't normally happen with default categories)
      room.categoryPairs = null;
    } else {
      room.categoryPairs = categoryPairs;
    }
  } else {
    room.categoryPairs = null;
  }

  room.players.forEach(p => {
    p.score = 0;
    p.ready = false;
    p.submission = null;
  });
  room.currentRound = 1;
  room.currentPair = getRandomPair(room.categoryPairs);
  room.roundStartTime = Date.now();
  room.state = 'playing';

  broadcastToRoom(roomCode, 'roundStart', {
    round: room.currentRound,
    totalRounds: TOTAL_ROUNDS,
    startLetter: room.currentPair[0].toUpperCase(),
    endLetter: room.currentPair[1].toUpperCase(),
    timeLeft: ROUND_TIME,
    deadline: room.roundStartTime + ROUND_TIME * 1000
  });

  startRoundTimer(roomCode);
  console.log(`Challenge game started in room ${roomCode}`);
}

// ── Socket Handlers ──────────────────────────────────

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id, socket.recovered ? '(recovered)' : '(new)');

  // Handle reconnection recovery
  if (socket.recovered && socket.data.playerName) {
    // Cancel any pending disconnect cleanup
    if (disconnectTimers.has(socket.id)) {
      clearTimeout(disconnectTimers.get(socket.id));
      disconnectTimers.delete(socket.id);
    }

    const previousRoomCode = socket.data.roomCode || null;
    const previousStatus = socket.data.status || 'online';

    // Restore onlinePlayers entry
    onlinePlayers.set(socket.id, {
      name: socket.data.playerName,
      status: previousStatus,
      roomCode: previousRoomCode
    });

    // If they were in a room that still exists, restore them
    if (previousRoomCode && rooms.has(previousRoomCode)) {
      const room = rooms.get(previousRoomCode);
      if (room) {
        // If player was removed during disconnect — re-add them
        if (!room.players.find(p => p.id === socket.id)) {
          room.players.push({
            id: socket.id,
            name: socket.data.playerName,
            score: 0,
            ready: false,
            submission: null
          });
        }
        // Always notify the room so opponent's UI clears disconnect banner
        broadcastToRoom(previousRoomCode, 'playerRejoined', {
          playerId: socket.id,
          players: room.players,
          hostId: room.host
        });
        // Also notify the reconnected player about the room they're in
        socket.emit('roomStateRestored', {
          code: previousRoomCode,
          players: room.players,
          hostId: room.host,
          maxPlayers: room.maxPlayers,
          categories: room.categories,
          state: room.state
        });
      }
    }

    socket.emit('nameConfirmed', { playerId: socket.id, name: socket.data.playerName });
    broadcastOnlinePlayers();
    console.log(`${socket.data.playerName} reconnected`);
  }

  // ── Lobby / Name ──────────────────────────────────

  socket.on('setName', (name) => {
    if (!name || name.trim().length === 0) {
      socket.emit('error', { message: 'Please enter a name' });
      return;
    }

    const cleanName = name.trim().substring(0, 20);

    // Cancel any pending disconnect cleanup
    if (disconnectTimers.has(socket.id)) {
      clearTimeout(disconnectTimers.get(socket.id));
      disconnectTimers.delete(socket.id);
    }

    // Preserve existing room state if already restored by connection recovery
    const existing = onlinePlayers.get(socket.id);
    const existingRoomCode = (existing && existing.roomCode) || null;
    const existingStatus = existingRoomCode ? 'in_room' : 'online';

    onlinePlayers.set(socket.id, {
      name: cleanName,
      status: existingStatus,
      roomCode: existingRoomCode
    });

    // Store on socket.data for reconnection recovery — don't overwrite room state
    socket.data.playerName = cleanName;
    if (!existingRoomCode) {
      socket.data.status = 'online';
      socket.data.roomCode = null;
    }

    socket.emit('nameConfirmed', { playerId: socket.id, name: cleanName });
    broadcastOnlinePlayers();
    console.log(`${cleanName} joined the lobby`);
  });

  socket.on('editName', (name) => {
    const player = onlinePlayers.get(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Not in lobby' });
      return;
    }

    const cleanName = name.trim().substring(0, 20);
    player.name = cleanName;
    socket.data.playerName = cleanName;
    socket.emit('nameConfirmed', { playerId: socket.id, name: cleanName });
    broadcastOnlinePlayers();
  });

  socket.on('requestOnlinePlayers', () => {
    socket.emit('onlinePlayers', getOnlinePlayersList());
  });

  // ── Room Management ───────────────────────────────

  socket.on('createRoom', (name) => {
    const player = onlinePlayers.get(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Set your name first' });
      return;
    }
    if (player.roomCode) {
      socket.emit('error', { message: 'Already in a room' });
      return;
    }

    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: socket.id,
      players: [
        { id: socket.id, name: player.name, score: 0, ready: false, submission: null }
      ],
      state: 'lobby',
      currentRound: 0,
      currentPair: null,
      roundStartTime: 0,
      maxPlayers: MAX_PLAYERS,
      categories: { noun_adj_verb: true, countries: true, us_states: true, us_cities: true },
      categoryPairs: null
    };

    rooms.set(roomCode, room);
    player.status = 'in_room';
    player.roomCode = roomCode;
    socket.data.status = 'in_room';
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    socket.emit('roomCreated', {
      code: roomCode,
      players: room.players,
      hostId: room.host,
      maxPlayers: room.maxPlayers,
      categories: room.categories
    });

    broadcastOnlinePlayers();
    console.log(`Room created: ${roomCode} by ${player.name}`);
  });

  socket.on('joinRoom', (data) => {
    const { code, name } = data || {};
    if (!code) {
      socket.emit('error', { message: 'Room code required' });
      return;
    }

    const player = onlinePlayers.get(socket.id);
    if (!player) {
      socket.emit('error', { message: 'Set your name first' });
      return;
    }
    if (player.roomCode) {
      socket.emit('error', { message: 'Already in a room' });
      return;
    }

    const roomCode = code.toUpperCase();
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }
    if (room.players.length >= room.maxPlayers) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    if (room.players.some(p => p.id === socket.id)) {
      socket.emit('error', { message: 'Already in this room' });
      return;
    }

    room.players.push({
      id: socket.id,
      name: player.name,
      score: 0,
      ready: false,
      submission: null
    });

    player.status = 'in_room';
    player.roomCode = roomCode;
    socket.data.status = 'in_room';
    socket.data.roomCode = roomCode;
    socket.join(roomCode);

    socket.emit('roomJoined', {
      code: roomCode,
      players: room.players,
      hostId: room.host,
      maxPlayers: room.maxPlayers,
      categories: room.categories
    });

    // Notify others
    const newPlayer = room.players[room.players.length - 1];
    socket.to(roomCode).emit('playerJoined', {
      player: { id: newPlayer.id, name: newPlayer.name, ready: newPlayer.ready }
    });

    broadcastOnlinePlayers();
    console.log(`${player.name} joined room ${roomCode}`);
  });

  socket.on('readyUp', () => {
    const player = onlinePlayers.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.state !== 'lobby') return;

    const roomPlayer = getPlayer(room, socket.id);
    if (!roomPlayer) return;

    roomPlayer.ready = true;

    broadcastToRoom(player.roomCode, 'playerLobbyReady', {
      playerId: socket.id
    });
  });

  socket.on('updateCategories', (categories) => {
    const player = onlinePlayers.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.state !== 'lobby') return;
    if (socket.id !== room.host) {
      socket.emit('error', { message: 'Only the host can change categories' });
      return;
    }

    // Validate shape: must be object with all expected boolean keys
    const ALLOWED_CATEGORIES = ['noun_adj_verb', 'countries', 'us_states', 'us_cities'];
    const isValid = categories
      && typeof categories === 'object'
      && ALLOWED_CATEGORIES.every(k => typeof categories[k] === 'boolean');
    if (!isValid) {
      socket.emit('error', { message: 'Invalid categories' });
      return;
    }
    room.categories = { ...categories };

    broadcastToRoom(player.roomCode, 'categoriesUpdated', {
      categories: room.categories
    });
  });

  socket.on('startGame', () => {
    const player = onlinePlayers.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room) return;

    if (socket.id !== room.host) {
      socket.emit('error', { message: 'Only the host can start the game' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    if (room.players.length < 2) {
      socket.emit('error', { message: 'Need at least 2 players' });
      return;
    }
    if (!room.players.every(p => p.ready)) {
      socket.emit('error', { message: 'All players must be ready' });
      return;
    }

    // Compute category-filtered valid pairs
    const categoryPairs = new Set();
    const hasActiveFilter = Object.keys(room.categories).some(k => room.categories[k] === false);

    if (hasActiveFilter) {
      for (const key of validCombinations) {
        const words = wordLookup[key];
        for (const word of words) {
          const wordCats = wordCategories[word];
          // Only include pair if at least one word matches an active category.
          // Untagged words alone do NOT qualify a pair (they also fail submission validation).
          if (wordCats && wordCats.length > 0 && wordCats.some(cat => room.categories[cat])) {
            categoryPairs.add(key);
            break;
          }
        }
      }

      if (categoryPairs.size === 0) {
        socket.emit('error', { message: 'No words match the selected categories. Enable more categories.' });
        return;
      }

      room.categoryPairs = categoryPairs;
    } else {
      room.categoryPairs = null;
    }

    // Reset for new game
    room.players.forEach(p => {
      p.score = 0;
      p.ready = false;
      p.submission = null;
    });
    room.currentRound = 1;
    room.currentPair = getRandomPair(room.categoryPairs);
    room.roundStartTime = Date.now();
    room.state = 'playing';

    broadcastToRoom(player.roomCode, 'roundStart', {
      round: room.currentRound,
      totalRounds: TOTAL_ROUNDS,
      startLetter: room.currentPair[0].toUpperCase(),
      endLetter: room.currentPair[1].toUpperCase(),
      timeLeft: ROUND_TIME,
      deadline: room.roundStartTime + ROUND_TIME * 1000
    });

    startRoundTimer(player.roomCode);
    console.log(`Game started in room ${player.roomCode} with ${room.players.length} players`);
  });

  function handlePlayerLeaveRoom() {
    // Cancel any pending disconnect cleanup
    if (disconnectTimers.has(socket.id)) {
      clearTimeout(disconnectTimers.get(socket.id));
      disconnectTimers.delete(socket.id);
    }

    // Clean up any pending challenges involving this player
    cleanupChallengesForPlayer(socket.id);

    const player = onlinePlayers.get(socket.id);
    if (!player || !player.roomCode) return;
    const roomCode = player.roomCode;

    player.status = 'online';
    player.roomCode = null;
    socket.data.status = 'online';
    socket.data.roomCode = null;
    socket.leave(roomCode);

    removePlayerFromRoom(socket.id, roomCode, 'leave');
    socket.emit('roomLeft');
    broadcastOnlinePlayers();
  }

  socket.on('leaveRoom', handlePlayerLeaveRoom);

  // ── Gameplay ──────────────────────────────────────

  socket.on('submitWord', (word) => {
    const player = onlinePlayers.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.state !== 'playing') return;

    const roomPlayer = getPlayer(room, socket.id);
    if (!roomPlayer || roomPlayer.submission) return; // already submitted

    // Check basic word validity (letters, dictionary)
    const basicValid = validateWord(word, room.currentPair[0], room.currentPair[1]);

    if (!basicValid) {
      // Invalid word — record as submission with 0 points, player can't retry
      const submissionTime = Date.now();
      const timeTaken = (submissionTime - room.roundStartTime) / 1000;
      roomPlayer.submission = {
        word: word.toLowerCase(),
        isValid: false,
        timeTaken,
        points: 0
      };
      broadcastToRoom(player.roomCode, 'playerSubmitted', {
        playerId: socket.id,
        playerName: roomPlayer.name
      });
      const allSubmitted = room.players.every(p => p.submission !== null);
      if (allSubmitted) endRound(player.roomCode);
      return;
    }

    // Category filter check — reject outright if word doesn't match
    if (!wordMatchesCategories(word, room)) {
      socket.emit('error', { message: 'Word does not match the selected categories', code: 'category_mismatch' });
      return;
    }

    // Valid word — record submission with points
    const submissionTime = Date.now();
    const timeTaken = (submissionTime - room.roundStartTime) / 1000;
    roomPlayer.submission = {
      word: word.toLowerCase(),
      isValid: true,
      timeTaken,
      points: word.length
    };

    broadcastToRoom(player.roomCode, 'playerSubmitted', {
      playerId: socket.id,
      playerName: roomPlayer.name
    });

    // Auto-end round if all players have submitted
    const allSubmitted = room.players.every(p => p.submission !== null);
    if (allSubmitted) {
      endRound(player.roomCode);
    }
  });

  socket.on('sendReaction', (emoji) => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData || !playerData.roomCode) return;
    const roomCode = playerData.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    socket.to(roomCode).emit('reactionReceived', {
      emoji,
      fromId: socket.id
    });
  });

  // ── Challenge System ───────────────────────────────

  function cleanupChallengesForPlayer(socketId) {
    // If this player is the target of a challenge, expire it
    if (challenges.has(socketId)) {
      const ch = challenges.get(socketId);
      clearTimeout(ch.timer);
      io.to(ch.challengerId).emit('challengeDeclined', {
        targetName: onlinePlayers.get(socketId)?.name || 'Player'
      });
      challenges.delete(socketId);
    }

    // If this player is the challenger, cancel their pending challenges
    for (const [targetId, ch] of challenges) {
      if (ch.challengerId === socketId) {
        clearTimeout(ch.timer);
        io.to(targetId).emit('challengeCancelled', {
          challengerName: onlinePlayers.get(socketId)?.name || 'Player'
        });
        challenges.delete(targetId);
      }
    }
  }

  socket.on('challengePlayer', (data) => {
    const { targetId, categories: challengeCategories } = (data && typeof data === 'object') ? data : { targetId: data };

    const challenger = onlinePlayers.get(socket.id);
    if (!challenger) {
      socket.emit('error', { message: 'Set your name first' });
      return;
    }
    if (challenger.roomCode) {
      socket.emit('error', { message: 'You are already in a game' });
      return;
    }

    const target = onlinePlayers.get(targetId);
    if (!target) {
      socket.emit('error', { message: 'Player not found' });
      return;
    }
    if (target.roomCode) {
      socket.emit('error', { message: 'Player is already in a game' });
      return;
    }
    if (targetId === socket.id) {
      socket.emit('error', { message: 'Cannot challenge yourself' });
      return;
    }

    // Check if target already has a pending challenge
    if (challenges.has(targetId)) {
      socket.emit('error', { message: 'Player already has a pending challenge' });
      return;
    }

    // Check if challenger already has a pending outgoing challenge
    for (const [tId, ch] of challenges) {
      if (ch.challengerId === socket.id) {
        socket.emit('error', { message: 'You already have a pending challenge' });
        return;
      }
    }

    // Validate and default categories
    const ALLOWED_CATS = ['noun_adj_verb', 'countries', 'us_states', 'us_cities'];
    const categories = {};
    if (challengeCategories && typeof challengeCategories === 'object') {
      for (const cat of ALLOWED_CATS) {
        categories[cat] = challengeCategories[cat] !== false; // default true
      }
    } else {
      for (const cat of ALLOWED_CATS) {
        categories[cat] = true;
      }
    }

    // Create challenge with timeout
    const timer = setTimeout(() => {
      challenges.delete(targetId);
      io.to(socket.id).emit('challengeExpired', { targetId, targetName: target.name });
      io.to(targetId).emit('challengeExpired', {});
    }, CHALLENGE_TIMEOUT);

    challenges.set(targetId, {
      challengerId: socket.id,
      challengerName: challenger.name,
      targetName: target.name,
      categories,
      timer
    });

    io.to(targetId).emit('challengeReceived', {
      challengerId: socket.id,
      challengerName: challenger.name,
      categories
    });

    socket.emit('challengeSent', {
      targetId,
      targetName: target.name,
      categories
    });
  });

  socket.on('acceptChallenge', (challengerId) => {
    const target = onlinePlayers.get(socket.id);
    if (!target) return;

    const challenge = challenges.get(socket.id);
    if (!challenge || challenge.challengerId !== challengerId) {
      socket.emit('error', { message: 'No pending challenge from this player' });
      return;
    }

    const challenger = onlinePlayers.get(challengerId);
    if (!challenger || challenger.roomCode) {
      clearTimeout(challenge.timer);
      challenges.delete(socket.id);
      socket.emit('error', { message: 'Challenger is no longer available' });
      return;
    }

    // Clear timeout
    clearTimeout(challenge.timer);
    challenges.delete(socket.id);

    // Create room
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: challengerId,
      players: [
        { id: challengerId, name: challenger.name, score: 0, ready: false, submission: null },
        { id: socket.id, name: target.name, score: 0, ready: false, submission: null }
      ],
      state: 'lobby',
      currentRound: 0,
      currentPair: null,
      roundStartTime: 0,
      maxPlayers: 2,
      categories: challenge.categories || { noun_adj_verb: true, countries: true, us_states: true, us_cities: true },
      categoryPairs: null
    };

    rooms.set(roomCode, room);

    // Update both players
    challenger.status = 'in_room';
    challenger.roomCode = roomCode;
    target.status = 'in_room';
    target.roomCode = roomCode;

    // Get sockets and join room
    const challengerSocket = io.sockets.sockets.get(challengerId);
    const targetSocket = io.sockets.sockets.get(socket.id);

    if (challengerSocket) {
      challengerSocket.join(roomCode);
      challengerSocket.data.status = 'in_room';
      challengerSocket.data.roomCode = roomCode;
    }
    if (targetSocket) {
      targetSocket.join(roomCode);
      targetSocket.data.status = 'in_room';
      targetSocket.data.roomCode = roomCode;
    }

    // Notify both about the room
    broadcastToRoom(roomCode, 'challengeAccepted', {
      roomCode,
      players: room.players,
      hostId: room.host,
      categories: room.categories
    });

    broadcastOnlinePlayers();

    // Start game immediately
    forceStartGame(roomCode);
    console.log(`Challenge game started: ${challenger.name} vs ${target.name} in room ${roomCode}`);
  });

  socket.on('declineChallenge', (challengerId) => {
    const challenge = challenges.get(socket.id);
    if (!challenge || challenge.challengerId !== challengerId) return;

    clearTimeout(challenge.timer);
    challenges.delete(socket.id);

    io.to(challengerId).emit('challengeDeclined', {
      targetName: onlinePlayers.get(socket.id)?.name || 'Player'
    });
  });

  socket.on('cancelChallenge', (targetId) => {
    const challenge = challenges.get(targetId);
    if (!challenge || challenge.challengerId !== socket.id) return;

    clearTimeout(challenge.timer);
    challenges.delete(targetId);

    io.to(targetId).emit('challengeCancelled', {
      challengerName: onlinePlayers.get(socket.id)?.name || 'Player'
    });

    socket.emit('challengeCancelled', { targetId });
  });

  // ── Post-Game ─────────────────────────────────────

  socket.on('requestPlayAgain', () => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData || !playerData.roomCode) return;
    const room = rooms.get(playerData.roomCode);
    if (!room || room.state !== 'finished') return;

    if (!room.playAgainVotes) {
      room.playAgainVotes = new Set();
    }

    room.playAgainVotes.add(socket.id);
    const voteCount = room.playAgainVotes.size;
    const playerCount = room.players.length;

    // Notify room of current vote status
    broadcastToRoom(playerData.roomCode, 'playAgainVote', {
      voteCount,
      playerCount,
      votedId: socket.id
    });

    // When everyone agrees, restart the game
    if (voteCount >= playerCount) {
      room.playAgainVotes.clear();
      room.players.forEach(p => {
        p.score = 0;
        p.ready = false;
        p.submission = null;
      });
      room.currentRound = 0;
      room.currentPair = null;
      room.state = 'lobby';
      clearRoomTimer(playerData.roomCode);
      clearPauseTimer(playerData.roomCode);

      broadcastToRoom(playerData.roomCode, 'gameReset', {
        players: room.players,
        hostId: room.host,
        categories: room.categories
      });
    }
  });

  socket.on('returnToLobby', handlePlayerLeaveRoom);

  // ── Disconnect ────────────────────────────────────

  socket.on('disconnect', (reason) => {
    console.log('Player disconnected:', socket.id, reason);
    const player = onlinePlayers.get(socket.id);

    // Clean up any pending challenges
    cleanupChallengesForPlayer(socket.id);

    if (player) {
      // Mark as disconnected but DON'T remove from room or onlinePlayers immediately
      player.status = 'disconnected';
      if (socket.data.status) socket.data.status = 'disconnected';
      broadcastOnlinePlayers();

      // Set a delayed cleanup timer
      if (player.roomCode) {
        // Cancel any existing timer for this socket
        if (disconnectTimers.has(socket.id)) {
          clearTimeout(disconnectTimers.get(socket.id));
        }

        // Check if in active game — use shorter grace period + notify opponent
        const room = rooms.get(player.roomCode);
        const isPlaying = room && room.state === 'playing';
        const gracePeriod = isPlaying ? 15000 : 30000;

        if (isPlaying) {
          // Immediately notify remaining players that opponent disconnected
          broadcastToRoom(player.roomCode, 'opponentDisconnected', {
            playerId: socket.id,
            playerName: player.name
          });
        }

        const timer = setTimeout(() => {
          disconnectTimers.delete(socket.id);
          const p = onlinePlayers.get(socket.id);
          // Only clean up if the player is still marked as disconnected (not reconnected)
          if (p && p.status === 'disconnected') {
            removePlayerFromRoom(socket.id, p.roomCode, 'disconnect');
            onlinePlayers.delete(socket.id);
            broadcastOnlinePlayers();
          }
        }, gracePeriod);

        disconnectTimers.set(socket.id, timer);
      } else {
        // No room — clean up after a shorter delay
        const timer = setTimeout(() => {
          disconnectTimers.delete(socket.id);
          const p = onlinePlayers.get(socket.id);
          if (p && p.status === 'disconnected') {
            onlinePlayers.delete(socket.id);
            broadcastOnlinePlayers();
          }
        }, 15000);

        disconnectTimers.set(socket.id, timer);
      }
    }
  });
});

// ── Express Routes ───────────────────────────────────

app.get('/health', (req, res) => res.status(200).send('ok'));

app.use(express.static(__dirname));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));

app.get('/word_lookup.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'word_lookup.json'));
});

app.get('/word_categories.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'word_categories.json'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`LAN access: http://<your-LAN-IP>:${PORT}`);
});
