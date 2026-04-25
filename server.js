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

const PORT = 3000;
const ROUND_TIME = 10;
const PAUSE_TIME = 3;
const TOTAL_ROUNDS = 10;
const CHALLENGE_TIMEOUT = 30;

const wordLookup = JSON.parse(fs.readFileSync('./word_lookup.json', 'utf8'));

const validCombinations = new Set();
for (const key of Object.keys(wordLookup)) {
  if (wordLookup[key] && wordLookup[key].length > 0) {
    validCombinations.add(key);
  }
}

const rooms = new Map();
const roomTimers = new Map();
const onlinePlayers = new Map();
const pendingChallenges = new Map();

function clearRoomTimer(roomCode) {
  if (roomTimers.has(roomCode)) {
    clearTimeout(roomTimers.get(roomCode));
    roomTimers.delete(roomCode);
  }
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
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
  const words = wordLookup[key] || [];
  return words.includes(w);
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

function cleanupPlayer(socketId) {
  const player = onlinePlayers.get(socketId);
  if (player) {
    if (player.roomCode) {
      const room = rooms.get(player.roomCode);
      if (room) {
        room.players = room.players.filter(p => p.id !== socketId);
        if (room.players.length === 0) {
          clearRoomTimer(player.roomCode);
          rooms.delete(player.roomCode);
        } else {
          io.to(player.roomCode).emit('opponentLeft');
          clearRoomTimer(player.roomCode);
          rooms.delete(player.roomCode);
        }
      }
    }
    onlinePlayers.delete(socketId);
  }

  for (const [challengeId, challenge] of pendingChallenges) {
    if (challenge.fromId === socketId || challenge.toId === socketId) {
      const otherId = challenge.fromId === socketId ? challenge.toId : challenge.fromId;
      const otherPlayer = onlinePlayers.get(otherId);
      if (otherPlayer) {
        otherPlayer.status = 'online';
      }
      if (challenge.timeout) {
        clearTimeout(challenge.timeout);
      }
      pendingChallenges.delete(challengeId);
      if (otherId) {
        io.to(otherId).emit('challengeEnded');
      }
    }
  }

  broadcastOnlinePlayers();
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  let currentRoom = null;

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

  socket.on('sendChallenge', (targetId) => {
    const player = onlinePlayers.get(socket.id);
    const target = onlinePlayers.get(targetId);

    if (!player || !target) {
      socket.emit('error', { message: 'Player not found' });
      return;
    }

    if (target.status !== 'online') {
      socket.emit('error', { message: 'Player is not available' });
      return;
    }

    if (player.status !== 'online') {
      socket.emit('error', { message: 'You are not available' });
      return;
    }

    if (targetId === socket.id) {
      socket.emit('error', { message: 'Cannot challenge yourself' });
      return;
    }

    for (const [id, challenge] of pendingChallenges) {
      if (challenge.fromId === socket.id || challenge.toId === socketId) {
        socket.emit('error', { message: 'You already have a pending challenge' });
        return;
      }
    }

    const challengeId = generateRoomCode();
    const timeout = setTimeout(() => {
      const challenge = pendingChallenges.get(challengeId);
      if (challenge) {
        const otherId = challenge.fromId === socket.id ? challenge.toId : challenge.fromId;
        const otherPlayer = onlinePlayers.get(otherId);
        if (otherPlayer) {
          otherPlayer.status = 'online';
        }
        pendingChallenges.delete(challengeId);
        io.to(socket.id).emit('challengeTimeout');
        io.to(otherId).emit('challengeEnded');
        broadcastOnlinePlayers();
      }
    }, CHALLENGE_TIMEOUT * 1000);

    const challenge = {
      id: challengeId,
      fromId: socket.id,
      fromName: player.name,
      toId: targetId,
      toName: target.name,
      timeout,
      createdAt: Date.now()
    };

    pendingChallenges.set(challengeId, challenge);
    player.status = 'challenging';
    target.status = 'challenged';

    io.to(targetId).emit('challengeReceived', {
      challengeId,
      challengerId: socket.id,
      challengerName: player.name
    });

    io.to(socket.id).emit('challengeSent', {
      challengeId,
      targetId,
      targetName: target.name
    });

    broadcastOnlinePlayers();
    console.log(`${player.name} challenged ${target.name}`);
  });

  socket.on('acceptChallenge', (challengeId) => {
    const challenge = pendingChallenges.get(challengeId);
    if (!challenge) {
      socket.emit('error', { message: 'Challenge not found' });
      return;
    }

    if (socket.id !== challenge.toId) {
      socket.emit('error', { message: 'Not your challenge' });
      return;
    }

    clearTimeout(challenge.timeout);
    pendingChallenges.delete(challengeId);

    const challenger = onlinePlayers.get(challenge.fromId);
    const challenged = onlinePlayers.get(challenge.toId);

    if (!challenger || !challenged) {
      socket.emit('error', { message: 'Player no longer available' });
      return;
    }

    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: challenge.fromId,
      players: [
        { id: challenge.fromId, name: challenge.fromName, score: 0, submitted: false, word: null, ready: false },
        { id: challenge.toId, name: challenge.toName, score: 0, submitted: false, word: null, ready: false }
      ],
      state: 'playing',
      currentRound: 1,
      currentPair: getRandomPair(),
      roundStartTime: Date.now(),
      submissions: {}
    };

    rooms.set(roomCode, room);
    challenger.status = 'in_game';
    challenger.roomCode = roomCode;
    challenged.status = 'in_game';
    challenged.roomCode = roomCode;

    const challengerSocket = io.sockets.sockets.get(challenge.fromId);
    const challengedSocket = io.sockets.sockets.get(challenge.toId);
    if (challengerSocket) challengerSocket.join(roomCode);
    if (challengedSocket) challengedSocket.join(roomCode);

    io.to(challenge.fromId).emit('gameStart', {
      roomCode,
      isHost: true,
      players: room.players,
      round: room.currentRound,
      totalRounds: TOTAL_ROUNDS,
      startLetter: room.currentPair[0].toUpperCase(),
      endLetter: room.currentPair[1].toUpperCase(),
      deadline: room.roundStartTime + ROUND_TIME * 1000
    });

    io.to(challenge.toId).emit('gameStart', {
      roomCode,
      isHost: false,
      players: room.players,
      round: room.currentRound,
      totalRounds: TOTAL_ROUNDS,
      startLetter: room.currentPair[0].toUpperCase(),
      endLetter: room.currentPair[1].toUpperCase(),
      deadline: room.roundStartTime + ROUND_TIME * 1000
    });

    startRoundTimer(roomCode);
    broadcastOnlinePlayers();
    console.log(`Game started: ${roomCode} - ${challenge.fromName} vs ${challenge.toName}`);
  });

  socket.on('declineChallenge', (challengeId) => {
    const challenge = pendingChallenges.get(challengeId);
    if (!challenge) return;

    if (socket.id !== challenge.toId) return;

    clearTimeout(challenge.timeout);

    const challenger = onlinePlayers.get(challenge.fromId);
    const challenged = onlinePlayers.get(challenge.toId);

    if (challenger) challenger.status = 'online';
    if (challenged) challenged.status = 'online';

    pendingChallenges.delete(challengeId);

    io.to(challenge.fromId).emit('challengeDeclined', {
      challengerName: challenge.toName
    });

    broadcastOnlinePlayers();
    console.log(`${challenge.toName} declined ${challenge.fromName}'s challenge`);
  });

  socket.on('cancelChallenge', (challengeId) => {
    const challenge = pendingChallenges.get(challengeId);
    if (!challenge) return;

    if (socket.id !== challenge.fromId) return;

    clearTimeout(challenge.timeout);

    const challenger = onlinePlayers.get(challenge.fromId);
    const challenged = onlinePlayers.get(challenge.toId);

    if (challenger) challenger.status = 'online';
    if (challenged) challenged.status = 'online';

    pendingChallenges.delete(challengeId);

    io.to(challenge.toId).emit('challengeEnded');

    broadcastOnlinePlayers();
  });

  socket.on('submitWord', (word) => {
    const player = onlinePlayers.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.state !== 'playing') return;

    const roomCode = player.roomCode;

    const playerInRoom = room.players.find(p => p.id === socket.id);
    if (!playerInRoom || playerInRoom.submitted) return;

    const isValid = validateWord(word, room.currentPair[0], room.currentPair[1]);

    const submissionTime = Date.now();
    const timeTaken = (submissionTime - room.roundStartTime) / 1000;

    room.submissions[socket.id] = {
      word: word.toLowerCase(),
      isValid,
      timeTaken,
      points: isValid ? word.length : 0
    };

    playerInRoom.submitted = true;
    playerInRoom.word = word.toLowerCase();

    io.to(roomCode).emit('playerSubmitted', { playerId: socket.id });

    checkRoundComplete(roomCode);
  });

  socket.on('playerReady', () => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData || !playerData.roomCode) return;
    const roomCode = playerData.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    if (room.state === 'waiting') {
      player.lobbyReady = true;
      io.to(roomCode).emit('playerLobbyReady', { playerId: socket.id });

      if (room.players.every(p => p.lobbyReady)) {
        room.players.forEach(p => p.lobbyReady = false);
        room.state = 'playing';
        room.currentRound = 1;
        room.currentPair = getRandomPair();
        room.roundStartTime = Date.now();

        io.to(roomCode).emit('roundStart', {
          round: room.currentRound,
          totalRounds: TOTAL_ROUNDS,
          startLetter: room.currentPair[0].toUpperCase(),
          endLetter: room.currentPair[1].toUpperCase(),
          timeLeft: ROUND_TIME,
          deadline: room.roundStartTime + ROUND_TIME * 1000
        });

        startRoundTimer(roomCode);
      }
    } else if (room.state === 'waiting_for_ready') {
      player.ready = true;
      io.to(roomCode).emit('playerReady', { playerId: socket.id });

      if (room.players.every(p => p.ready)) {
        room.players.forEach(p => p.ready = false);
        startNextRound(roomCode);
      }
    }
  });

  socket.on('leaveRoom', () => {
    const playerData = onlinePlayers.get(socket.id);
    const roomCode = playerData?.roomCode;
    handleLeave(socket, roomCode);
  });

  socket.on('restartGame', () => {
    const playerData = onlinePlayers.get(socket.id);
    if (!playerData || !playerData.roomCode) return;
    const roomCode = playerData.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;

    for (const p of room.players) {
      p.score = 0;
      p.submitted = false;
      p.word = null;
      p.ready = false;
      p.lobbyReady = false;
    }
    room.currentRound = 0;
    room.currentPair = null;
    room.state = 'waiting';
    room.submissions = {};

    io.to(roomCode).emit('gameReset', { players: room.players });
  });

  socket.on('returnToLobby', () => {
    const playerData = onlinePlayers.get(socket.id);
    const roomCode = playerData?.roomCode;
    handleLeave(socket, roomCode);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    cleanupPlayer(socket.id);
  });
});

function handleLeave(socket, roomCode) {
  if (!roomCode) return;

  const room = rooms.get(roomCode);
  if (!room) return;

  clearRoomTimer(roomCode);

  for (const p of room.players) {
    const onlinePlayer = onlinePlayers.get(p.id);
    if (onlinePlayer) {
      onlinePlayer.status = 'online';
      onlinePlayer.roomCode = null;
    }
  }

  room.players = room.players.filter(p => p.id !== socket.id);

  if (room.players.length === 0) {
    rooms.delete(roomCode);
  } else {
    io.to(roomCode).emit('opponentLeft');
    rooms.delete(roomCode);
  }

  socket.leave(roomCode);
  broadcastOnlinePlayers();
}

function startRoundTimer(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  clearRoomTimer(roomCode);

  const timer = setTimeout(() => {
    roomTimers.delete(roomCode);
    checkRoundComplete(roomCode, true);
  }, ROUND_TIME * 1000);

  roomTimers.set(roomCode, timer);
}

function checkRoundComplete(roomCode, force = false) {
  const room = rooms.get(roomCode);
  if (!room || room.state !== 'playing') return;

  const allValidAndSubmitted = room.players.every(p =>
    p.submitted && room.submissions[p.id]?.isValid === true
  );

  if (force || allValidAndSubmitted) {
    endRound(roomCode);
  }
}

function endRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  clearRoomTimer(roomCode);

  const submissions = Object.values(room.submissions);
  const validSubmissions = submissions.filter(s => s.isValid);
  const firstSubmitter = validSubmissions.length > 0
    ? validSubmissions.reduce((a, b) => a.timeTaken < b.timeTaken ? a : b)
    : null;

  const results = room.players.map(p => {
    const sub = room.submissions[p.id];
    let points = 0;
    let bonus = 0;

    if (sub && sub.isValid) {
      points = sub.word.length;
      if (sub === firstSubmitter) {
        bonus = 1;
        points += 1;
      }
    }

    p.score += points;

    return {
      playerId: p.id,
      word: sub && !sub.isValid ? `(${sub.word})` : (p.word || '(no submission)'),
      isValid: sub?.isValid || false,
      timeTaken: sub?.timeTaken || null,
      points,
      bonus,
      totalScore: p.score
    };
  });

  let examples = null;
  if (validSubmissions.length === 0 && room.currentPair) {
    const pairWords = wordLookup[room.currentPair] || [];
    examples = pairWords.slice(0, 5);
  }

  io.to(roomCode).emit('roundEnd', {
    results,
    pair: room.currentPair,
    round: room.currentRound,
    totalRounds: TOTAL_ROUNDS,
    examples
  });

  room.players.forEach(p => {
    p.submitted = false;
    p.word = null;
    p.ready = false;
  });
  room.submissions = {};
  room.state = 'waiting_for_ready';

  io.to(roomCode).emit('waitingForReady');
}

function startNextRound(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.currentRound++;

  if (room.currentRound > TOTAL_ROUNDS) {
    endGame(roomCode);
    return;
  }

  room.currentPair = getRandomPair();
  room.roundStartTime = Date.now();
  room.state = 'playing';

  io.to(roomCode).emit('roundStart', {
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
  room.state = 'finished';

  const winner = room.players.reduce((a, b) => a.score > b.score ? a : b);
  const isTie = room.players[0].score === room.players[1].score;

  for (const p of room.players) {
    const onlinePlayer = onlinePlayers.get(p.id);
    if (onlinePlayer) {
      onlinePlayer.status = 'online';
    }
  }

  io.to(roomCode).emit('gameEnd', {
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      score: p.score
    })),
    winner: isTie ? null : winner.id,
    isTie
  });

  broadcastOnlinePlayers();
}

app.use(express.static(__dirname));
app.use('/sounds', express.static(path.join(__dirname, 'sounds')));

app.get('/word_lookup.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'word_lookup.json'));
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Open this URL in two browser tabs to test multiplayer');
});