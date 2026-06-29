const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['polling', 'websocket'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000
});

const PORT = process.env.PORT || 3000;
const ROUND_TIME = 10;
const PAUSE_TIME = 3;
const TOTAL_ROUNDS = 10;
const MAX_PLAYERS = 8;

const wordLookupRaw = JSON.parse(fs.readFileSync('./word_lookup.json', 'utf8'));
const wordLookup = {};
for (const key of Object.keys(wordLookupRaw)) {
  wordLookup[key] = new Set(wordLookupRaw[key]);
}

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

function getRandomPair() {
  const keys = Array.from(validCombinations);
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
  return words ? words.has(w) : false;
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

  // Examples if nobody got a valid word
  let examples = null;
  if (validSubmissions.length === 0 && room.currentPair) {
    const pairWords = wordLookup[room.currentPair];
    examples = pairWords ? [...pairWords].slice(0, 5) : null;
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

  // After final round → end game
  if (room.currentRound >= TOTAL_ROUNDS) {
    endGame(roomCode);
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
  room.currentPair = getRandomPair();
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

// ── Socket Handlers ──────────────────────────────────

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // ── Lobby / Name ──────────────────────────────────

  socket.on('setName', (name) => {
    if (!name || name.trim().length === 0) {
      socket.emit('error', { message: 'Please enter a name' });
      return;
    }

    const cleanName = name.trim().substring(0, 20);
    onlinePlayers.set(socket.id, {
      name: cleanName,
      status: 'online',
      roomCode: null
    });

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
      maxPlayers: MAX_PLAYERS
    };

    rooms.set(roomCode, room);
    player.status = 'in_room';
    player.roomCode = roomCode;
    socket.join(roomCode);

    socket.emit('roomCreated', {
      code: roomCode,
      players: room.players,
      hostId: room.host,
      maxPlayers: room.maxPlayers
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
    socket.join(roomCode);

    socket.emit('roomJoined', {
      code: roomCode,
      players: room.players,
      hostId: room.host,
      maxPlayers: room.maxPlayers
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

    // Reset for new game
    room.players.forEach(p => {
      p.score = 0;
      p.ready = false;
      p.submission = null;
    });
    room.currentRound = 1;
    room.currentPair = getRandomPair();
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
    const player = onlinePlayers.get(socket.id);
    if (!player || !player.roomCode) return;
    const roomCode = player.roomCode;

    player.status = 'online';
    player.roomCode = null;
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

    const isValid = validateWord(word, room.currentPair[0], room.currentPair[1]);
    const submissionTime = Date.now();
    const timeTaken = (submissionTime - room.roundStartTime) / 1000;

    roomPlayer.submission = {
      word: word.toLowerCase(),
      isValid,
      timeTaken,
      points: isValid ? word.length : 0
    };

    broadcastToRoom(player.roomCode, 'playerSubmitted', {
      playerId: socket.id,
      playerName: roomPlayer.name
    });
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

  // ── Post-Game ─────────────────────────────────────

  socket.on('restartGame', () => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData || !playerData.roomCode) return;
    const room = rooms.get(playerData.roomCode);
    if (!room) return;

    if (socket.id !== room.host) {
      socket.emit('error', { message: 'Only the host can restart' });
      return;
    }

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
      hostId: room.host
    });
  });

  socket.on('returnToLobby', handlePlayerLeaveRoom);

  // ── Disconnect ────────────────────────────────────

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const player = onlinePlayers.get(socket.id);
    if (player && player.roomCode) {
      removePlayerFromRoom(socket.id, player.roomCode, 'disconnect');
      player.status = 'online';
      player.roomCode = null;
    }
    onlinePlayers.delete(socket.id);
    broadcastOnlinePlayers();
  });
});

// ── Express Routes ───────────────────────────────────

app.get('/health', (req, res) => res.status(200).send('ok'));

app.use(express.static(__dirname));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));

app.get('/word_lookup.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'word_lookup.json'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`LAN access: http://<your-LAN-IP>:${PORT}`);
});
