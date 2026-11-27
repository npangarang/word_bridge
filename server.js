'use strict';

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const compression = require('compression');

const PORT = process.env.PORT || 3000;

const ROUND_TIME = 10;
const COMFORT_ROUND_TIME = 15;
const PAUSE_TIME = 5;
const TOTAL_ROUNDS = 10;
const MAX_PLAYERS = 8;
const CHALLENGE_TIMEOUT = 15000;
const NAME_MAX_LENGTH = 20;
// The client keyboard caps input at 20 characters. Anything beyond that is a
// malformed protocol payload, not a dictionary miss.
const WORD_MAX_LENGTH = 20;

const ALLOWED_CATEGORIES = ['noun_adj_verb', 'countries', 'us_states', 'us_cities'];
const DEFAULT_CATEGORIES = {
  noun_adj_verb: true,
  countries: true,
  us_states: true,
  us_cities: true
};
const DEFAULT_GRACE = {
  playing: 15000,
  paused: 15000,
  lobby: 30000,
  finished: 30000,
  noRoom: 15000
};

// ── Dictionary data (shared read-only by every server instance) ───────────

const wordLookupRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'word_lookup.json'), 'utf8'));
const wordLookup = {};
for (const key of Object.keys(wordLookupRaw)) {
  wordLookup[key] = new Set(wordLookupRaw[key]);
}

const wordCategories = JSON.parse(fs.readFileSync(path.join(__dirname, 'word_categories.json'), 'utf8'));

const validCombinations = new Set();
for (const key of Object.keys(wordLookup)) {
  if (wordLookup[key] && wordLookup[key].size > 0) {
    validCombinations.add(key);
  }
}

// Category selection has only 16 possible signatures. Building these pair
// sets is the most expensive startup action, so cache them across rooms and
// server instances.
const categoryPairCache = new Map();

function hasActiveCategoryFilter(categories) {
  return !!categories && ALLOWED_CATEGORIES.some(k => categories[k] === false);
}

function getCategoryPairs(categories) {
  if (!hasActiveCategoryFilter(categories)) return null;

  const cacheKey = ALLOWED_CATEGORIES
    .map(k => (categories[k] === false ? '0' : '1'))
    .join('');
  if (categoryPairCache.has(cacheKey)) return categoryPairCache.get(cacheKey);

  const pairs = new Set();
  for (const pair of validCombinations) {
    const words = wordLookup[pair];
    for (const word of words) {
      const cats = wordCategories[word];
      if (cats && cats.length > 0 && cats.some(cat => categories[cat] === true)) {
        pairs.add(pair);
        break;
      }
    }
  }
  categoryPairCache.set(cacheKey, pairs);
  return pairs;
}

function getRandomPair(pairs) {
  const keys = pairs && pairs.size ? Array.from(pairs) : Array.from(validCombinations);
  if (keys.length === 0) return null;
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

function wordMatchesCategories(word, categories) {
  if (!categories) return true;
  if (!hasActiveCategoryFilter(categories)) return true;

  const w = word.toLowerCase();
  const wordCats = wordCategories[w];
  if (!wordCats || wordCats.length === 0) return false;
  return wordCats.some(cat => categories[cat] === true);
}

function sanitizeCategories(input) {
  const categories = {};
  for (const cat of ALLOWED_CATEGORIES) {
    categories[cat] = !input || typeof input !== 'object' ? true : input[cat] !== false;
  }
  return categories;
}

function isValidCategoryShape(input) {
  return !!input
    && typeof input === 'object'
    && ALLOWED_CATEGORIES.every(k => typeof input[k] === 'boolean');
}

function pickAllowedCategories(input) {
  const categories = {};
  for (const key of ALLOWED_CATEGORIES) categories[key] = input[key] === true;
  return categories;
}

// ── Factory ───────────────────────────────────────────────────────────────

function createGameServer(options = {}) {
  const rules = {
    roundTime: Number.isFinite(options.roundTime) ? options.roundTime : ROUND_TIME,
    comfortRoundTime: Number.isFinite(options.comfortRoundTime) ? options.comfortRoundTime : COMFORT_ROUND_TIME,
    pauseTime: Number.isFinite(options.pauseTime) ? options.pauseTime : PAUSE_TIME,
    totalRounds: Number.isInteger(options.totalRounds) ? options.totalRounds : TOTAL_ROUNDS,
    maxPlayers: Number.isInteger(options.maxPlayers) ? options.maxPlayers : MAX_PLAYERS,
    challengeTimeout: Number.isFinite(options.challengeTimeout) ? options.challengeTimeout : CHALLENGE_TIMEOUT
  };
  const grace = { ...DEFAULT_GRACE, ...(options.grace || {}) };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setAppTimeout = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const clearAppTimeout = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const randomId = typeof options.randomId === 'function' ? options.randomId : () => crypto.randomUUID();
  const randomToken = typeof options.randomToken === 'function'
    ? options.randomToken
    : () => crypto.randomBytes(32).toString('base64url');
  const logger = options.logger === null ? null : (options.logger || console);

  const app = express();
  app.use(compression());
  const server = http.createServer(app);
  // Native Socket.IO connection-state recovery is intentionally disabled. It
  // keys sessions by ephemeral socket ids and bypasses middleware; WordBridge
  // uses its own stable playerId + secret resumeToken handshake instead.
  const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['polling', 'websocket'],
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000
  });

  const rooms = new Map();
  const sessions = new Map();       // playerId -> session record
  const tokenIndex = new Map();     // resumeToken -> playerId
  const challenges = new Map();     // targetId -> challenge record

  const roomTimers = new Map();     // roomCode -> timer
  const pauseTimers = new Map();    // roomCode -> timer
  const disconnectTimers = new Map(); // playerId -> timer
  const allApplicationTimers = new Set();

  let shuttingDown = false;
  let closePromise = null;
  let listenPromise = null;

  function log(...args) {
    if (logger && typeof logger.log === 'function') logger.log(...args);
  }

  // All application timers flow through here so close() can cancel them before
  // touching sockets, and tests can inject fake timers without affecting
  // Socket.IO's own network timers.
  function scheduleTimer(fn, delayMs) {
    const timer = setAppTimeout(() => {
      allApplicationTimers.delete(timer);
      if (!shuttingDown) fn();
    }, Math.max(0, delayMs));
    allApplicationTimers.add(timer);
    return timer;
  }

  function cancelTimer(timer) {
    if (timer === null || timer === undefined) return;
    clearAppTimeout(timer);
    allApplicationTimers.delete(timer);
  }

  // ── Public-safe projections ───────────────────────────────────────────

  function isSessionConnected(playerId) {
    const session = sessions.get(playerId);
    return !!session && session.connected;
  }

  function projectRoomPlayer(player) {
    return {
      id: player.id,
      name: player.name,
      score: player.score,
      ready: !!player.ready,
      comfortMode: !!player.comfortMode,
      connected: isSessionConnected(player.id),
      submitted: !!player.submission
    };
  }

  function projectRoomPlayers(room) {
    return room.players.map(projectRoomPlayer);
  }

  function getOnlinePlayersList() {
    const list = [];
    for (const session of sessions.values()) {
      if (!session.connected) continue;
      list.push({
        id: session.playerId,
        name: session.name,
        status: session.roomCode && rooms.has(session.roomCode) ? 'in_room' : 'online'
      });
    }
    return list;
  }

  function broadcastOnlinePlayers() {
    io.emit('onlinePlayers', getOnlinePlayersList());
  }

  function getRoomPlayer(room, playerId) {
    return room.players.find(p => p.id === playerId);
  }

  // Effective round duration for a room: max preference, comfort wins. This is
  // only read when a round starts; the active round's deadline is immutable.
  function getRoomRoundTime(room) {
    if (!room || room.players.length === 0) return rules.roundTime;
    let duration = rules.roundTime;
    for (const p of room.players) {
      if (p.comfortMode && rules.comfortRoundTime > duration) duration = rules.comfortRoundTime;
    }
    return duration;
  }

  function canStartAnotherGame(room) {
    return !!room
      && room.players.length >= 2
      && room.players.every(p => isSessionConnected(p.id));
  }

  function withCanPlayAgain(gameEnd, room) {
    if (!gameEnd) return null;
    return { ...gameEnd, canPlayAgain: canStartAnotherGame(room) };
  }

  function buildSnapshot(session) {
    const empty = {
      code: null,
      state: 'online',
      hostId: null,
      maxPlayers: null,
      categories: null,
      players: [],
      matchId: null,
      roundStart: null,
      ownSubmission: null,
      lastRoundEnd: null,
      gameEnd: null,
      pauseDeadline: null,
      playAgainVoterIds: [],
      serverNow: now()
    };

    if (!session.roomCode) return empty;
    const room = rooms.get(session.roomCode);
    if (!room) {
      session.roomCode = null;
      return empty;
    }
    if (!getRoomPlayer(room, session.playerId)) {
      session.roomCode = null;
      return empty;
    }

    const me = getRoomPlayer(room, session.playerId);
    return {
      code: room.code,
      state: room.state,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      categories: { ...room.categories },
      players: projectRoomPlayers(room),
      matchId: room.matchId || null,
      roundStart: room.lastRoundStart ? { ...room.lastRoundStart } : null,
      ownSubmission: me.submission ? { ...me.submission } : null,
      lastRoundEnd: room.lastRoundEnd || null,
      gameEnd: room.gameEnd ? withCanPlayAgain(room.gameEnd, room) : null,
      pauseDeadline: room.pauseDeadline === undefined ? null : room.pauseDeadline,
      playAgainVoterIds: room.playAgainVotes ? [...room.playAgainVotes] : [],
      serverNow: now()
    };
  }

  function emitRoomState(session) {
    const socket = currentSocket(session);
    if (socket) socket.emit('roomStateRestored', buildSnapshot(session));
  }

  // ── Session / transport binding ──────────────────────────────────────

  function currentSocket(session) {
    if (!session || !session.socketId) return null;
    const socket = io.sockets.sockets.get(session.socketId);
    if (!socket || !socket.connected) return null;
    return socket;
  }

  function emitToPlayer(playerId, event, data) {
    const session = sessions.get(playerId);
    if (!session || !session.connected) return false;
    const socket = currentSocket(session);
    if (!socket) return false;
    socket.emit(event, data);
    return true;
  }

  function getActiveSession(socket) {
    const playerId = socket.data.playerId;
    if (!playerId) return null;
    const session = sessions.get(playerId);
    if (!session) return null;
    if (!session.connected || session.socketId !== socket.id) return null;
    return session;
  }

  function isStaleSocket(socket) {
    return !!socket.data.playerId && !getActiveSession(socket);
  }

  function createSession(name) {
    const playerId = randomId();
    let resumeToken = randomToken();
    while (tokenIndex.has(resumeToken)) resumeToken = randomToken();

    const session = {
      playerId,
      resumeToken,
      name,
      connected: true,
      socketId: null,
      roomCode: null,
      comfortMode: false,
      generation: 0,
      disconnectDeadline: null,
      pendingClaim: null
    };
    sessions.set(playerId, session);
    tokenIndex.set(resumeToken, playerId);
    return session;
  }

  function bindSessionToSocket(session, socket) {
    clearSessionExpiryTimer(session);
    session.connected = true;
    session.socketId = socket.id;
    session.disconnectDeadline = null;
    session.pendingClaim = null;
    session.generation += 1;
    socket.data.playerId = session.playerId;
    socket.data.resumeToken = session.resumeToken;
  }

  function removeClaimCloseListener(claim) {
    const socket = claim && claim.socket;
    if (!socket || !socket.conn || typeof socket.conn.off !== 'function') return;
    if (claim.onEngineClose) socket.conn.off('close', claim.onEngineClose);
  }

  function reserveResumeClaim(session, socket) {
    // Reserve the disconnected record synchronously for competing resumes, but
    // do not report it live or clear the original grace deadline until the
    // namespace connection actually completes.
    const claim = {
      playerId: session.playerId,
      socketId: socket.id,
      generation: session.generation,
      deadline: session.disconnectDeadline,
      committed: false,
      released: false,
      socket,
      onEngineClose: null
    };

    session.pendingClaim = claim;
    socket.data.playerId = session.playerId;
    socket.data.resumeToken = session.resumeToken;
    socket.data.resumeClaim = claim;

    const onEngineClose = () => {
      releaseResumeClaim(claim);
    };
    claim.onEngineClose = onEngineClose;
    if (socket.conn && typeof socket.conn.once === 'function') {
      socket.conn.once('close', onEngineClose);
    }
    return claim;
  }

  function releaseResumeClaim(claim) {
    if (!claim || claim.committed || claim.released) return false;
    const session = sessions.get(claim.playerId);
    if (!session || session.pendingClaim !== claim) return false;
    if (session.connected) return false;

    claim.released = true;
    session.pendingClaim = null;
    removeClaimCloseListener(claim);
    if (claim.socket && claim.socket.data) claim.socket.data.resumeClaim = null;

    if (session.generation !== claim.generation) {
      if (claim.deadline !== null && now() >= claim.deadline) expireSession(session);
      return false;
    }
    if (claim.deadline !== null && now() >= claim.deadline) {
      expireSession(session);
    }
    return true;
  }

  function commitResumeClaim(socket) {
    const claim = socket.data.resumeClaim;
    if (!claim) return getActiveSession(socket);

    const session = sessions.get(claim.playerId);
    if (!session || session.pendingClaim !== claim || claim.committed || claim.released) {
      socket.data.resumeClaim = null;
      return null;
    }
    if (session.connected) {
      session.pendingClaim = null;
      claim.released = true;
      socket.data.resumeClaim = null;
      removeClaimCloseListener(claim);
      return null;
    }
    if (session.generation !== claim.generation
      || session.disconnectDeadline !== claim.deadline
      || !socket.connected
      || !socket.conn
      || socket.conn.readyState !== 'open') {
      releaseResumeClaim(claim);
      socket.data.resumeClaim = null;
      return null;
    }
    if (claim.deadline !== null && now() >= claim.deadline) {
      // The handshake consumed the remaining grace. Never extend it.
      session.pendingClaim = null;
      claim.released = true;
      socket.data.resumeClaim = null;
      removeClaimCloseListener(claim);
      expireSession(session);
      return null;
    }

    claim.committed = true;
    session.pendingClaim = null;
    socket.data.resumeClaim = null;
    removeClaimCloseListener(claim);

    clearSessionExpiryTimer(session);
    session.connected = true;
    session.socketId = socket.id;
    session.disconnectDeadline = null;
    session.generation += 1;
    socket.data.playerId = session.playerId;
    socket.data.resumeToken = session.resumeToken;
    return session;
  }

  function clearSessionExpiryTimer(session) {
    const timer = disconnectTimers.get(session.playerId);
    if (timer !== undefined) {
      cancelTimer(timer);
      disconnectTimers.delete(session.playerId);
    }
  }

  function scheduleSessionExpiry(session, deadline) {
    clearSessionExpiryTimer(session);
    const playerId = session.playerId;
    const generation = session.generation;
    const timer = scheduleTimer(() => {
      if (disconnectTimers.get(playerId) === timer) disconnectTimers.delete(playerId);
      if (shuttingDown) return;
      const current = sessions.get(playerId);
      // Capture record + deadline + generation: a reconnect or a newer
      // disconnect must make this callback a no-op.
      if (current !== session) return;
      if (current.connected) return;
      if (current.generation !== generation) return;
      if (current.disconnectDeadline !== deadline) return;

      const currentTime = now();
      if (currentTime < deadline) {
        scheduleSessionExpiry(current, deadline);
        return;
      }
      expireSession(current);
    }, Math.max(0, deadline - now()));
    disconnectTimers.set(playerId, timer);
  }

  function invalidateSessionToken(session) {
    if (tokenIndex.get(session.resumeToken) === session.playerId) {
      tokenIndex.delete(session.resumeToken);
    }
  }

  function expireSession(session) {
    if (!session || session.connected) return;
    if (session.disconnectDeadline !== null && now() < session.disconnectDeadline) return;

    if (session.pendingClaim) {
      const claim = session.pendingClaim;
      claim.released = true;
      removeClaimCloseListener(claim);
      if (claim.socket && claim.socket.data) claim.socket.data.resumeClaim = null;
      session.pendingClaim = null;
    }
    clearSessionExpiryTimer(session);
    invalidateSessionToken(session);
    sessions.delete(session.playerId);

    if (session.roomCode) {
      permanentlyRemovePlayerFromRoom(session, 'disconnect');
    }
    session.connected = false;
    session.socketId = null;
    broadcastOnlinePlayers();
  }

  // ── Room lifecycle ───────────────────────────────────────────────────

  function clearRoomTimer(roomCode) {
    const timer = roomTimers.get(roomCode);
    if (timer !== undefined) {
      cancelTimer(timer);
      roomTimers.delete(roomCode);
    }
  }

  function clearPauseTimer(roomCode) {
    const timer = pauseTimers.get(roomCode);
    if (timer !== undefined) {
      cancelTimer(timer);
      pauseTimers.delete(roomCode);
    }
  }

  function clearRoomTimers(room) {
    clearRoomTimer(room.code);
    clearPauseTimer(room.code);
    room.pauseDeadline = null;
  }

  function deleteRoom(room) {
    clearRoomTimers(room);
    for (const player of room.players) {
      const session = sessions.get(player.id);
      if (session && session.roomCode === room.code) session.roomCode = null;
    }
    rooms.delete(room.code);
  }

  function reassignHost(room) {
    if (room.players.length === 0) {
      room.hostId = null;
      return;
    }
    if (room.hostId && room.players.some(p => p.id === room.hostId)) return;

    const livePlayer = room.players.find(p => isSessionConnected(p.id));
    room.hostId = (livePlayer || room.players[0]).id;
  }

  function broadcastRoomRoster(room, event, extra = {}) {
    io.to(room.code).emit(event, {
      ...extra,
      players: projectRoomPlayers(room),
      hostId: room.hostId
    });
  }

  function buildGameEndPayload(room, extra = {}) {
    const maxScore = room.players.length ? Math.max(...room.players.map(p => p.score)) : 0;
    const topPlayers = room.players.filter(p => p.score === maxScore);
    const isTie = topPlayers.length > 1;
    return {
      players: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
      rankings: [...room.players]
        .sort((a, b) => b.score - a.score)
        .map(p => ({ id: p.id, name: p.name, score: p.score })),
      topPlayers: topPlayers.map(p => ({ id: p.id, name: p.name, score: p.score })),
      isTie,
      winnerId: isTie ? null : (topPlayers[0] ? topPlayers[0].id : null),
      ...extra
    };
  }

  function finishForfeit(room) {
    if (room.players.length !== 1) return;
    clearRoomTimers(room);
    const remaining = room.players[0];
    room.state = 'finished';
    room.playAgainVotes = new Set();
    room.currentPair = null;
    room.hostId = remaining.id;
    room.players.forEach(p => { p.submission = null; });
    room.gameEnd = buildGameEndPayload(room, { forfeit: true });

    const payload = withCanPlayAgain(room.gameEnd, room);
    io.to(room.code).emit('gameEnd', payload);
    broadcastOnlinePlayers();
    log(`Room ${room.code} finished by forfeit; winner ${remaining.name}`);
  }

  function broadcastPlayAgainVotes(room) {
    if (!room || room.state !== 'finished') return;
    if (!room.playAgainVotes) room.playAgainVotes = new Set();
    io.to(room.code).emit('playAgainVote', {
      voteCount: room.playAgainVotes.size,
      playerCount: room.players.length,
      votedId: null,
      voterIds: [...room.playAgainVotes]
    });
  }

  function resetFinishedRoomForRematch(room) {
    clearRoomTimers(room);
    room.playAgainVotes = new Set();
    room.players.forEach(p => {
      p.score = 0;
      p.ready = false;
      p.submission = null;
    });
    room.currentRound = 0;
    room.currentPair = null;
    room.matchId = null;
    room.roundStartTime = 0;
    room.roundDurationMs = 0;
    room.roundDeadline = null;
    room.lastRoundStart = null;
    room.lastRoundEnd = null;
    room.gameEnd = null;
    room.pauseDeadline = null;
    room.state = 'lobby';

    io.to(room.code).emit('gameReset', {
      code: room.code,
      players: projectRoomPlayers(room),
      hostId: room.hostId,
      categories: { ...room.categories },
      maxPlayers: room.maxPlayers
    });
    broadcastOnlinePlayers();
  }

  function maybeResetFinishedRoom(room) {
    if (!room || room.state !== 'finished') return false;
    if (room.players.length < 2) return false;
    if (!room.players.every(p => isSessionConnected(p.id))) return false;
    if (!room.playAgainVotes) room.playAgainVotes = new Set();
    if (!room.players.every(p => room.playAgainVotes.has(p.id))) return false;
    resetFinishedRoomForRematch(room);
    return true;
  }

  function permanentlyRemovePlayerFromRoom(session, reason) {
    const roomCode = session.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    session.roomCode = null;
    if (!room) return;

    const wasHost = room.hostId === session.playerId;
    room.players = room.players.filter(p => p.id !== session.playerId);
    if (room.playAgainVotes) room.playAgainVotes.delete(session.playerId);

    if (room.players.length === 0) {
      deleteRoom(room);
      return;
    }

    if (wasHost) reassignHost(room);

    if ((room.state === 'playing' || room.state === 'paused') && room.players.length === 1) {
      // Paused departures forfeit exactly like playing departures. Clearing
      // the pause timer here guarantees no next round is scheduled.
      finishForfeit(room);
      return;
    }

    if (room.state === 'finished') broadcastPlayAgainVotes(room);
    broadcastRoomRoster(room, 'playerLeft', { playerId: session.playerId, reason });
    if (room.state === 'finished') maybeResetFinishedRoom(room);
  }

  function detachSocketFromSession(session, socket) {
    // Only the transport currently bound to this record may change it. A late
    // disconnect from an old tab must not disturb a rebound session.
    if (!session || session.socketId !== socket.id) return false;
    session.connected = false;
    session.socketId = null;
    session.generation += 1;
    return true;
  }

  function beginDisconnect(session) {
    clearSessionExpiryTimer(session);

    const room = session.roomCode ? rooms.get(session.roomCode) : null;
    let graceMs = grace.noRoom;
    if (room) {
      if (room.state === 'playing') graceMs = grace.playing;
      else if (room.state === 'paused') graceMs = grace.paused;
      else if (room.state === 'lobby') graceMs = grace.lobby;
      else if (room.state === 'finished') graceMs = grace.finished;
    }

    session.disconnectDeadline = now() + graceMs;
    scheduleSessionExpiry(session, session.disconnectDeadline);

    if (room) {
      socketToRoom(session.playerId, room, 'opponentDisconnected', {
        playerId: session.playerId,
        playerName: session.name
      });
    }
    broadcastOnlinePlayers();
  }

  function socketToRoom(playerId, room, event, extra = {}) {
    // The disconnected player's socket is usually already out of the adapter
    // room, so this reaches exactly the other connected members.
    io.to(room.code).emit(event, {
      ...extra,
      players: projectRoomPlayers(room),
      hostId: room.hostId
    });
  }

  // ── Round / match ───────────────────────────────────────────────────

  function roundStartPayload(room) {
    return {
      round: room.currentRound,
      totalRounds: rules.totalRounds,
      startLetter: room.currentPair[0].toUpperCase(),
      endLetter: room.currentPair[1].toUpperCase(),
      timeLeft: room.roundDurationMs / 1000,
      deadline: room.roundDeadline,
      matchId: room.matchId
    };
  }

  function broadcastRoundStart(room) {
    room.lastRoundStart = roundStartPayload(room);
    io.to(room.code).emit('roundStart', room.lastRoundStart);
  }

  function scheduleRoundTimer(room, delayOverride) {
    clearRoomTimer(room.code);
    const code = room.code;
    const matchId = room.matchId;
    const round = room.currentRound;
    const delay = delayOverride === undefined
      ? Math.max(0, room.roundDeadline - now())
      : Math.max(0, delayOverride);

    const timer = scheduleTimer(() => {
      if (roomTimers.get(code) === timer) roomTimers.delete(code);
      if (shuttingDown) return;
      const current = rooms.get(code);
      if (current !== room) return;
      if (current.state !== 'playing' || current.matchId !== matchId || current.currentRound !== round) return;

      const remaining = current.roundDeadline - now();
      if (remaining > 0) {
        scheduleRoundTimer(current, remaining);
        return;
      }
      endRound(code);
    }, delay);

    roomTimers.set(code, timer);
  }

  function startNextRound(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'paused') return;
    clearPauseTimer(roomCode);
    room.pauseDeadline = null;

    room.currentRound += 1;
    room.currentPair = getRandomPair(room.categoryPairs);
    room.roundStartTime = now();
    room.roundDurationMs = getRoomRoundTime(room) * 1000;
    room.roundDeadline = room.roundStartTime + room.roundDurationMs;
    room.state = 'playing';

    broadcastRoundStart(room);
    scheduleRoundTimer(room);
  }

  function schedulePauseTimer(room) {
    clearPauseTimer(room.code);
    const code = room.code;
    const matchId = room.matchId;
    const round = room.currentRound;
    const deadline = room.pauseDeadline;

    const timer = scheduleTimer(() => {
      if (pauseTimers.get(code) === timer) pauseTimers.delete(code);
      if (shuttingDown) return;
      const current = rooms.get(code);
      if (current !== room) return;
      if (current.state !== 'paused' || current.matchId !== matchId || current.currentRound !== round) return;
      if (current.pauseDeadline !== deadline) return;

      const remaining = current.pauseDeadline - now();
      if (remaining > 0) {
        schedulePauseTimer(current);
        return;
      }

      if (current.currentRound >= rules.totalRounds) endGame(code);
      else startNextRound(code);
    }, Math.max(0, deadline - now()));

    pauseTimers.set(code, timer);
  }

  function endRound(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'playing') return;

    clearRoomTimer(roomCode);

    const validSubmissions = room.players
      .filter(p => p.submission && p.submission.isValid)
      .map(p => p.submission);
    const firstSubmitter = validSubmissions.length > 0
      ? validSubmissions.reduce((a, b) => (a.timeTaken < b.timeTaken ? a : b))
      : null;

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

    let examples = null;
    if (room.currentPair) {
      const pairWords = wordLookup[room.currentPair];
      if (pairWords) {
        if (hasActiveCategoryFilter(room.categories)) {
          examples = [...pairWords].filter(w => {
            const cats = wordCategories[w];
            return cats && cats.length > 0 && cats.some(cat => room.categories[cat] === true);
          }).slice(0, 5);
        } else {
          examples = [...pairWords].slice(0, 5);
        }
      }
    }

    const payload = {
      results,
      pair: room.currentPair,
      round: room.currentRound,
      totalRounds: rules.totalRounds,
      examples
    };
    room.lastRoundEnd = payload;
    io.to(roomCode).emit('roundEnd', payload);

    room.players.forEach(p => { p.submission = null; });
    room.state = 'paused';
    room.pauseDeadline = now() + rules.pauseTime * 1000;
    schedulePauseTimer(room);
  }

  function endGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return;
    clearRoomTimers(room);
    room.state = 'finished';
    room.playAgainVotes = new Set();
    room.gameEnd = buildGameEndPayload(room);
    io.to(roomCode).emit('gameEnd', withCanPlayAgain(room.gameEnd, room));
    broadcastOnlinePlayers();
  }

  function beginMatch(room) {
    room.matchId = randomId();
    room.currentRound = 1;
    room.currentPair = getRandomPair(room.categoryPairs);
    if (!room.currentPair) return false;

    room.players.forEach(p => {
      p.score = 0;
      p.ready = false;
      p.submission = null;
    });

    room.roundStartTime = now();
    room.roundDurationMs = getRoomRoundTime(room) * 1000;
    room.roundDeadline = room.roundStartTime + room.roundDurationMs;
    room.state = 'playing';
    room.pauseDeadline = null;
    room.playAgainVotes = new Set();
    room.lastRoundEnd = null;
    room.gameEnd = null;

    broadcastRoundStart(room);
    scheduleRoundTimer(room);
    return true;
  }

  function forceStartGame(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || room.state !== 'lobby') return false;

    const categoryPairs = getCategoryPairs(room.categories);
    room.categoryPairs = categoryPairs && categoryPairs.size ? categoryPairs : null;
    if (!beginMatch(room)) return false;
    log(`Challenge game started in room ${roomCode}`);
    return true;
  }

  // ── Challenges ──────────────────────────────────────────────────────

  function getPlayerName(playerId) {
    const session = sessions.get(playerId);
    return session ? session.name : 'Player';
  }

  function expireChallenge(targetId, challenge) {
    if (!challenge || challenges.get(targetId) !== challenge) return false;
    cancelTimer(challenge.timer);
    challenges.delete(targetId);
    emitToPlayer(challenge.challengerId, 'challengeExpired', {
      targetId,
      targetName: challenge.targetName
    });
    emitToPlayer(targetId, 'challengeExpired', {});
    return true;
  }

  function cleanupChallengesForPlayer(playerId, notify = true) {
    const incoming = challenges.get(playerId);
    if (incoming) {
      cancelTimer(incoming.timer);
      challenges.delete(playerId);
      if (notify) {
        emitToPlayer(incoming.challengerId, 'challengeDeclined', {
          targetName: getPlayerName(playerId)
        });
      }
    }

    for (const [targetId, challenge] of [...challenges.entries()]) {
      if (challenge.challengerId !== playerId) continue;
      cancelTimer(challenge.timer);
      challenges.delete(targetId);
      if (notify) {
        emitToPlayer(targetId, 'challengeCancelled', {
          challengerName: getPlayerName(playerId)
        });
      }
    }
  }

  function enterRoomCleanup(playerId) {
    cleanupChallengesForPlayer(playerId, true);
  }

  function roomHasCapacity(room) {
    return room.players.length < room.maxPlayers;
  }

  function addPlayerToRoom(room, session) {
    room.players.push({
      id: session.playerId,
      name: session.name,
      score: 0,
      ready: false,
      submission: null,
      comfortMode: !!session.comfortMode
    });
    session.roomCode = room.code;
  }

  function joinSocketToRoom(socket, room) {
    if (!socket || !socket.connected) return;
    socket.join(room.code);
  }

  // ── Name handling ───────────────────────────────────────────────────

  function cleanName(name) {
    if (typeof name !== 'string') return null;
    const cleaned = name.trim().substring(0, NAME_MAX_LENGTH);
    return cleaned.length > 0 ? cleaned : null;
  }

  function updatePlayerName(session, name) {
    session.name = name;
    const room = session.roomCode ? rooms.get(session.roomCode) : null;
    if (!room) return;
    const player = getRoomPlayer(room, session.playerId);
    if (player) player.name = name;
  }

  function emitNameConfirmed(session, socket, resumed) {
    socket.emit('nameConfirmed', {
      playerId: session.playerId,
      name: session.name,
      resumeToken: session.resumeToken,
      resumed
    });
  }

  function broadcastNameUpdate(session) {
    const room = session.roomCode ? rooms.get(session.roomCode) : null;
    if (room) {
      broadcastRoomRoster(room, 'playerUpdated', { playerId: session.playerId });
    }
    broadcastOnlinePlayers();
  }

  // ── Socket.IO middleware: token resume is bound synchronously ─────────

  io.use((socket, next) => {
    if (shuttingDown) {
      const error = new Error('Server shutting down');
      error.data = { code: 'SERVER_SHUTTING_DOWN' };
      next(error);
      return;
    }

    const auth = socket.handshake.auth || {};
    const token = auth.resumeToken;
    if (token === undefined || token === null || token === '') {
      next();
      return;
    }
    if (typeof token !== 'string') {
      const error = new Error('Session expired');
      error.data = { code: 'SESSION_EXPIRED' };
      next(error);
      return;
    }

    const playerId = tokenIndex.get(token);
    const session = playerId ? sessions.get(playerId) : null;

    if (!session) {
      const error = new Error('Session expired');
      error.data = { code: 'SESSION_EXPIRED' };
      next(error);
      return;
    }

    if (session.connected) {
      // A live tab owns this token. Never kick it and never mint a second
      // player; ask the newcomer to retry after the old transport is reaped.
      const error = new Error('Session resume already in use');
      error.data = { code: 'RESUME_IN_USE', retryAfterMs: 1000 };
      next(error);
      return;
    }

    if (session.pendingClaim) {
      if (session.disconnectDeadline !== null && now() >= session.disconnectDeadline) {
        // An expired in-flight claim must not lock the token forever.
        expireSession(session);
        const error = new Error('Session expired');
        error.data = { code: 'SESSION_EXPIRED' };
        next(error);
        return;
      }
      const error = new Error('Session resume already in use');
      error.data = { code: 'RESUME_IN_USE', retryAfterMs: 1000 };
      next(error);
      return;
    }

    if (session.disconnectDeadline !== null && now() >= session.disconnectDeadline) {
      // A delayed timer callback must not keep an expired token alive.
      expireSession(session);
      const error = new Error('Session expired');
      error.data = { code: 'SESSION_EXPIRED' };
      next(error);
      return;
    }

    if (!socket.conn || socket.conn.readyState !== 'open') {
      // The transport was already closed while this namespace packet was being
      // processed. Do not reserve a claim on a dead transport.
      const error = new Error('Session resume already in use');
      error.data = { code: 'RESUME_IN_USE', retryAfterMs: 1000 };
      next(error);
      return;
    }

    // Reserve synchronously so competing resumes see the claim, but only mark
    // the session live after the namespace connection commits.
    reserveResumeClaim(session, socket);
    socket.data.resumed = true;
    next();
  });

  // ── Connection handler ─────────────────────────────────────────────

  io.on('connection', (socket) => {
    logger && logger.log && logger.log('Player connected:', socket.id, socket.data.resumed ? '(resumed)' : '(new)');

    // Every mutating handler begins with this guard. A stale transport whose
    // token was rebound elsewhere can never mutate the new session.
    function activeOrNull() {
      if (isStaleSocket(socket)) return null;
      return getActiveSession(socket);
    }

    // ── Name / lobby ────────────────────────────────────────────────

    socket.on('setName', (name) => {
      if (isStaleSocket(socket)) return;

      const cleaned = cleanName(name);
      if (!cleaned) {
        socket.emit('error', { message: 'Please enter a name' });
        return;
      }

      let session = getActiveSession(socket);
      let resumed = false;
      if (!session) {
        session = createSession(cleaned);
        bindSessionToSocket(session, socket);
        resumed = false;
      } else {
        // Repeated setName on the same live connection is idempotent: same
        // public id and same resume token, no second player is created.
        resumed = !!socket.data.resumed;
        updatePlayerName(session, cleaned);
        if (session.roomCode) broadcastNameUpdate(session);
      }

      emitNameConfirmed(session, socket, resumed);
      // Authoritative state follows nameConfirmed for a valid registration,
      // even when the player is not in a room.
      emitRoomState(session);
      broadcastOnlinePlayers();
      log(`${session.name} joined the lobby`);
      socket.data.resumed = false;
    });

    socket.on('editName', (name) => {
      const session = activeOrNull();
      if (!session) return;
      const cleaned = cleanName(name);
      if (!cleaned) {
        socket.emit('error', { message: 'Please enter a name' });
        return;
      }
      updatePlayerName(session, cleaned);
      emitNameConfirmed(session, socket, false);
      broadcastNameUpdate(session);
    });

    socket.on('requestOnlinePlayers', () => {
      socket.emit('onlinePlayers', getOnlinePlayersList());
    });

    // ── Room management ────────────────────────────────────────────

    function leaveRoomInternal(session, socket) {
      const roomCode = session.roomCode;
      if (!roomCode) {
        enterRoomCleanup(session.playerId);
        socket.emit('roomLeft');
        return;
      }
      const room = rooms.get(roomCode);
      enterRoomCleanup(session.playerId);
      clearSessionExpiryTimer(session);

      socket.leave(roomCode);
      session.roomCode = null;

      if (!room) {
        socket.emit('roomLeft');
        broadcastOnlinePlayers();
        return;
      }

      const wasHost = room.hostId === session.playerId;
      room.players = room.players.filter(p => p.id !== session.playerId);
      if (room.playAgainVotes) room.playAgainVotes.delete(session.playerId);

      if (room.players.length === 0) {
        deleteRoom(room);
        socket.emit('roomLeft');
        broadcastOnlinePlayers();
        return;
      }

      if (wasHost) reassignHost(room);

      if ((room.state === 'playing' || room.state === 'paused') && room.players.length === 1) {
        finishForfeit(room);
      } else {
        if (room.state === 'finished') broadcastPlayAgainVotes(room);
        broadcastRoomRoster(room, 'playerLeft', {
          playerId: session.playerId,
          reason: 'leave'
        });
        if (room.state === 'finished') maybeResetFinishedRoom(room);
      }

      socket.emit('roomLeft');
      broadcastOnlinePlayers();
    }

    socket.on('createRoom', () => {
      const session = activeOrNull();
      if (!session) {
        if (!socket.data.playerId) socket.emit('error', { message: 'Set your name first' });
        return;
      }
      if (session.roomCode) {
        socket.emit('error', { message: 'Already in a room' });
        return;
      }

      enterRoomCleanup(session.playerId);

      let code;
      do {
        code = crypto.randomBytes(3).toString('hex').toUpperCase().substring(0, 6);
      } while (rooms.has(code));

      const room = {
        code,
        hostId: session.playerId,
        players: [],
        state: 'lobby',
        currentRound: 0,
        currentPair: null,
        roundStartTime: 0,
        roundDurationMs: 0,
        roundDeadline: null,
        maxPlayers: rules.maxPlayers,
        categories: { ...DEFAULT_CATEGORIES },
        categoryPairs: null,
        matchId: null,
        lastRoundStart: null,
        lastRoundEnd: null,
        gameEnd: null,
        pauseDeadline: null,
        playAgainVotes: new Set()
      };
      addPlayerToRoom(room, session);
      rooms.set(code, room);
      joinSocketToRoom(socket, room);

      socket.emit('roomCreated', {
        code,
        players: projectRoomPlayers(room),
        hostId: room.hostId,
        maxPlayers: room.maxPlayers,
        categories: { ...room.categories },
        matchId: room.matchId
      });
      broadcastOnlinePlayers();
      log(`Room created: ${code} by ${session.name}`);
    });

    socket.on('joinRoom', (data) => {
      const session = activeOrNull();
      if (!session) {
        if (!socket.data.playerId) socket.emit('error', { message: 'Set your name first' });
        return;
      }
      const { code } = data || {};
      if (!code || typeof code !== 'string') {
        socket.emit('error', { message: 'Room code required' });
        return;
      }
      if (session.roomCode) {
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
      if (!roomHasCapacity(room)) {
        socket.emit('error', { message: 'Room is full' });
        return;
      }
      if (getRoomPlayer(room, session.playerId)) {
        socket.emit('error', { message: 'Already in this room' });
        return;
      }

      enterRoomCleanup(session.playerId);
      addPlayerToRoom(room, session);
      joinSocketToRoom(socket, room);

      socket.emit('roomJoined', {
        code: room.code,
        players: projectRoomPlayers(room),
        hostId: room.hostId,
        maxPlayers: room.maxPlayers,
        categories: { ...room.categories },
        matchId: room.matchId
      });

      const newPlayer = getRoomPlayer(room, session.playerId);
      socket.to(room.code).emit('playerJoined', {
        player: projectRoomPlayer(newPlayer),
        players: projectRoomPlayers(room),
        hostId: room.hostId
      });
      broadcastOnlinePlayers();
      log(`${session.name} joined room ${room.code}`);
    });

    socket.on('readyUp', () => {
      const session = activeOrNull();
      if (!session || !session.roomCode) return;
      const room = rooms.get(session.roomCode);
      if (!room || room.state !== 'lobby') return;
      const player = getRoomPlayer(room, session.playerId);
      if (!player) return;
      player.ready = true;
      io.to(room.code).emit('playerLobbyReady', { playerId: session.playerId });
    });

    socket.on('updateCategories', (categories) => {
      const session = activeOrNull();
      if (!session || !session.roomCode) return;
      const room = rooms.get(session.roomCode);
      if (!room || room.state !== 'lobby') return;
      if (room.hostId !== session.playerId) {
        socket.emit('error', { message: 'Only the host can change categories' });
        return;
      }
      if (!isValidCategoryShape(categories)) {
        socket.emit('error', { message: 'Invalid categories' });
        return;
      }
      room.categories = pickAllowedCategories(categories);
      room.categoryPairs = null;
      io.to(room.code).emit('categoriesUpdated', { categories: { ...room.categories } });
    });

    socket.on('setComfortMode', (data) => {
      const session = activeOrNull();
      if (!session) return;
      const payload = (data && typeof data === 'object') ? data : { enabled: data };
      if (typeof payload.enabled !== 'boolean') {
        socket.emit('error', { message: 'Invalid comfortMode value' });
        return;
      }

      session.comfortMode = payload.enabled;
      const room = session.roomCode ? rooms.get(session.roomCode) : null;
      if (room) {
        const player = getRoomPlayer(room, session.playerId);
        if (player) player.comfortMode = payload.enabled;
        // Deliberately does NOT touch room.roundDeadline/roundStartStart:
        // comfort changes apply to the next round only.
        io.to(room.code).emit('comfortModeUpdated', {
          playerId: session.playerId,
          comfortMode: payload.enabled
        });
      }
    });

    socket.on('startGame', () => {
      const session = activeOrNull();
      if (!session || !session.roomCode) return;
      const room = rooms.get(session.roomCode);
      if (!room) return;

      if (room.hostId !== session.playerId) {
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
      if (!room.players.every(p => isSessionConnected(p.id))) {
        socket.emit('error', { message: 'Waiting for all players to reconnect' });
        return;
      }
      if (!room.players.every(p => p.ready)) {
        socket.emit('error', { message: 'All players must be ready' });
        return;
      }

      const categoryPairs = getCategoryPairs(room.categories);
      if (categoryPairs && categoryPairs.size === 0) {
        socket.emit('error', { message: 'No words match the selected categories. Enable more categories.' });
        return;
      }
      room.categoryPairs = categoryPairs;

      if (!beginMatch(room)) {
        socket.emit('error', { message: 'Could not start the game' });
        return;
      }
      log(`Game started in room ${room.code} with ${room.players.length} players`);
    });

    socket.on('leaveRoom', () => {
      const session = activeOrNull();
      if (!session) return;
      leaveRoomInternal(session, socket);
    });

    socket.on('returnToLobby', () => {
      const session = activeOrNull();
      if (!session) return;
      leaveRoomInternal(session, socket);
    });

    // ── Gameplay ───────────────────────────────────────────────────

    socket.on('submitWord', (data) => {
      const session = activeOrNull();
      if (!session || !session.roomCode) return;
      const room = rooms.get(session.roomCode);
      if (!room || room.state !== 'playing') return;

      // Strict object payload. The client controls this protocol; a stale
      // round/match object is rejected rather than silently applied.
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        socket.emit('error', { message: 'Invalid submission', code: 'invalid_submission' });
        return;
      }
      const { word, matchId, round } = data;
      if (typeof word !== 'string' || word.length === 0 || word.length > WORD_MAX_LENGTH) {
        socket.emit('error', { message: 'Invalid submission', code: 'invalid_submission' });
        return;
      }
      if (typeof matchId !== 'string' || !Number.isInteger(round)) {
        socket.emit('error', { message: 'Invalid submission', code: 'invalid_submission' });
        return;
      }
      if (matchId !== room.matchId || round !== room.currentRound) {
        socket.emit('error', { message: 'This round is no longer active', code: 'stale_submission' });
        return;
      }
      if (room.roundDeadline === null || now() >= room.roundDeadline) {
        socket.emit('error', { message: 'Round time has expired', code: 'round_expired' });
        return;
      }

      const roomPlayer = getRoomPlayer(room, session.playerId);
      if (!roomPlayer || roomPlayer.submission) return; // already submitted

      const basicValid = validateWord(word, room.currentPair[0], room.currentPair[1]);
      if (!basicValid) {
        // Preserve the existing rule: a dictionary miss is recorded once for
        // zero points and cannot be retried.
        const submissionTime = now();
        const timeTaken = (submissionTime - room.roundStartTime) / 1000;
        roomPlayer.submission = {
          word: word.toLowerCase(),
          isValid: false,
          timeTaken,
          points: 0
        };
        io.to(room.code).emit('playerSubmitted', {
          playerId: session.playerId,
          playerName: roomPlayer.name
        });
        if (room.players.every(p => p.submission !== null)) endRound(room.code);
        return;
      }

      // Category mismatch is a retryable rejection: no submission is stored.
      if (!wordMatchesCategories(word, room.categories)) {
        socket.emit('error', {
          message: 'Word does not match the selected categories',
          code: 'category_mismatch'
        });
        return;
      }

      const submissionTime = now();
      const timeTaken = (submissionTime - room.roundStartTime) / 1000;
      roomPlayer.submission = {
        word: word.toLowerCase(),
        isValid: true,
        timeTaken,
        points: word.length
      };

      io.to(room.code).emit('playerSubmitted', {
        playerId: session.playerId,
        playerName: roomPlayer.name
      });

      if (room.players.every(p => p.submission !== null)) endRound(room.code);
    });

    socket.on('sendReaction', (emoji) => {
      const session = activeOrNull();
      if (!session || !session.roomCode) return;
      const room = rooms.get(session.roomCode);
      if (!room) return;
      socket.to(room.code).emit('reactionReceived', {
        emoji,
        fromId: session.playerId
      });
    });

    // ── Challenges ─────────────────────────────────────────────────

    socket.on('challengePlayer', (data) => {
      const challenger = activeOrNull();
      if (!challenger) {
        if (!socket.data.playerId) socket.emit('error', { message: 'Set your name first' });
        return;
      }
      if (challenger.roomCode) {
        socket.emit('error', { message: 'You are already in a game' });
        return;
      }

      const targetId = data && typeof data === 'object' ? data.targetId : data;
      if (typeof targetId !== 'string' || targetId.length === 0) {
        socket.emit('error', { message: 'Player not found' });
        return;
      }
      if (targetId === challenger.playerId) {
        socket.emit('error', { message: 'Cannot challenge yourself' });
        return;
      }

      const targetSession = sessions.get(targetId);
      if (!targetSession || !targetSession.connected || !currentSocket(targetSession)) {
        socket.emit('error', { message: 'Player is not online' });
        return;
      }
      if (targetSession.roomCode) {
        socket.emit('error', { message: 'Player is already in a game' });
        return;
      }

      if (challenges.has(targetId)) {
        socket.emit('error', { message: 'Player already has a pending challenge' });
        return;
      }
      for (const challenge of challenges.values()) {
        if (challenge.challengerId === challenger.playerId) {
          socket.emit('error', { message: 'You already have a pending challenge' });
          return;
        }
      }

      const challengeCategories = sanitizeCategories(
        data && typeof data === 'object' ? data.categories : null
      );

      const challenge = {
        challengerId: challenger.playerId,
        challengerName: challenger.name,
        targetName: targetSession.name,
        categories: challengeCategories,
        expiresAt: now() + rules.challengeTimeout,
        timer: null
      };

      challenge.timer = scheduleTimer(() => {
        expireChallenge(targetId, challenge);
      }, rules.challengeTimeout);

      challenges.set(targetId, challenge);

      emitToPlayer(targetId, 'challengeReceived', {
        challengerId: challenger.playerId,
        challengerName: challenger.name,
        categories: challengeCategories
      });
      socket.emit('challengeSent', {
        targetId,
        targetName: targetSession.name,
        categories: challengeCategories
      });
    });

    socket.on('acceptChallenge', (challengerId) => {
      const target = activeOrNull();
      if (!target) return;
      if (target.roomCode) {
        socket.emit('error', { message: 'You are already in a room' });
        return;
      }
      if (typeof challengerId !== 'string') {
        socket.emit('error', { message: 'No pending challenge from this player' });
        return;
      }

      const challenge = challenges.get(target.playerId);
      if (!challenge || challenge.challengerId !== challengerId) {
        socket.emit('error', { message: 'No pending challenge from this player' });
        return;
      }

      if (now() >= challenge.expiresAt) {
        // Timer callbacks may be delayed; the absolute deadline is still final.
        expireChallenge(target.playerId, challenge);
        return;
      }

      const challenger = sessions.get(challengerId);
      // Revalidate both sides against live transports and roomlessness at the
      // accept boundary, not just when the challenge was created.
      if (!challenger || !challenger.connected || !currentSocket(challenger) || challenger.roomCode) {
        cancelTimer(challenge.timer);
        challenges.delete(target.playerId);
        socket.emit('error', { message: 'Challenger is no longer available' });
        return;
      }

      cancelTimer(challenge.timer);
      challenges.delete(target.playerId);
      // Any other pending challenge involving either participant is stale once
      // they enter a room.
      cleanupChallengesForPlayer(challengerId, true);
      cleanupChallengesForPlayer(target.playerId, true);

      let code;
      do {
        code = crypto.randomBytes(3).toString('hex').toUpperCase().substring(0, 6);
      } while (rooms.has(code));

      const room = {
        code,
        hostId: challenger.playerId,
        players: [],
        state: 'lobby',
        currentRound: 0,
        currentPair: null,
        roundStartTime: 0,
        roundDurationMs: 0,
        roundDeadline: null,
        maxPlayers: 2,
        categories: { ...(challenge.categories || DEFAULT_CATEGORIES) },
        categoryPairs: null,
        matchId: null,
        lastRoundStart: null,
        lastRoundEnd: null,
        gameEnd: null,
        pauseDeadline: null,
        playAgainVotes: new Set()
      };
      addPlayerToRoom(room, challenger);
      addPlayerToRoom(room, target);
      rooms.set(room.code, room);

      const challengerSocket = currentSocket(challenger);
      joinSocketToRoom(challengerSocket, room);
      joinSocketToRoom(socket, room);

      io.to(room.code).emit('challengeAccepted', {
        roomCode: room.code,
        code: room.code,
        players: projectRoomPlayers(room),
        hostId: room.hostId,
        maxPlayers: room.maxPlayers,
        categories: { ...room.categories }
      });
      broadcastOnlinePlayers();

      forceStartGame(room.code);
      log(`Challenge game started: ${challenger.name} vs ${target.name} in room ${room.code}`);
    });

    socket.on('declineChallenge', (challengerId) => {
      const target = activeOrNull();
      if (!target) return;
      const challenge = challenges.get(target.playerId);
      if (!challenge || challenge.challengerId !== challengerId) return;
      cancelTimer(challenge.timer);
      challenges.delete(target.playerId);
      emitToPlayer(challengerId, 'challengeDeclined', {
        targetName: target.name
      });
    });

    socket.on('cancelChallenge', (targetId) => {
      const challenger = activeOrNull();
      if (!challenger) return;
      const challenge = challenges.get(targetId);
      if (!challenge || challenge.challengerId !== challenger.playerId) return;
      cancelTimer(challenge.timer);
      challenges.delete(targetId);
      emitToPlayer(targetId, 'challengeCancelled', {
        challengerName: challenger.name
      });
      socket.emit('challengeCancelled', { targetId });
    });

    // ── Post-game ──────────────────────────────────────────────────

    socket.on('requestPlayAgain', () => {
      const session = activeOrNull();
      if (!session || !session.roomCode) return;
      const room = rooms.get(session.roomCode);
      if (!room || room.state !== 'finished') return;

      if (room.players.length < 2 || !room.players.every(p => isSessionConnected(p.id))) {
        socket.emit('error', { message: 'Waiting for all players to reconnect' });
        return;
      }
      if (!room.playAgainVotes) room.playAgainVotes = new Set();

      room.playAgainVotes.add(session.playerId);
      io.to(room.code).emit('playAgainVote', {
        voteCount: room.playAgainVotes.size,
        playerCount: room.players.length,
        votedId: session.playerId,
        voterIds: [...room.playAgainVotes]
      });

      maybeResetFinishedRoom(room);
    });

    // ── Disconnect ─────────────────────────────────────────────────

    socket.on('disconnect', (reason) => {
      if (shuttingDown) return;
      const playerId = socket.data.playerId;
      if (!playerId) return;
      const session = sessions.get(playerId);
      if (!session) return;

      // Stale disconnect from an old transport: ignore completely.
      if (!detachSocketFromSession(session, socket)) return;

      log('Player disconnected:', socket.id, reason, session.name);
      cleanupChallengesForPlayer(session.playerId, true);
      beginDisconnect(session);
    });

    // Resume path: middleware reserved a claim; commit it only once this
    // namespace connection actually exists on an open transport.
    let resumedSession = getActiveSession(socket);
    if (!resumedSession && socket.data.resumeClaim) {
      resumedSession = commitResumeClaim(socket);
      if (!resumedSession) {
        socket.disconnect(true);
        return;
      }
    } else if (!resumedSession && socket.data.playerId) {
      // The claim expired/was released between middleware and namespace
      // completion. Do not leave an authenticated-looking ghost connection.
      socket.disconnect(true);
      return;
    }
    if (resumedSession) {
      const room = resumedSession.roomCode ? rooms.get(resumedSession.roomCode) : null;
      if (room) {
        if (getRoomPlayer(room, resumedSession.playerId)) {
          joinSocketToRoom(socket, room);
          socket.to(room.code).emit('playerRejoined', {
            playerId: resumedSession.playerId,
            players: projectRoomPlayers(room),
            hostId: room.hostId
          });
        } else {
          resumedSession.roomCode = null;
        }
      }

      emitNameConfirmed(resumedSession, socket, true);
      emitRoomState(resumedSession);
      if (room && room.state === 'finished') {
        // Connectivity may have been the last blocker for an already-voted
        // rematch; report the current counts and resolve quorum once.
        broadcastPlayAgainVotes(room);
        maybeResetFinishedRoom(room);
      }
      broadcastOnlinePlayers();
      log(`${resumedSession.name} resumed session ${resumedSession.playerId}`);
    }
  });

  // ── HTTP routes ─────────────────────────────────────────────────────

  app.get('/health', (req, res) => res.status(200).send('ok'));

  app.use(express.static(__dirname));
  app.use('/sounds', express.static(path.join(__dirname, 'sounds')));

  app.get('/word_lookup.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'word_lookup.json'));
  });

  app.get('/word_categories.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'word_categories.json'));
  });

  // ── Test-facing diagnostic (read-only copies, no secret tokens) ─────

  function getState() {
    return {
      shuttingDown,
      sessions: [...sessions.values()].map(s => ({
        playerId: s.playerId,
        name: s.name,
        connected: s.connected,
        pending: !!s.pendingClaim,
        roomCode: s.roomCode,
        comfortMode: s.comfortMode,
        disconnectDeadline: s.disconnectDeadline
      })),
      rooms: [...rooms.values()].map(room => ({
        code: room.code,
        state: room.state,
        hostId: room.hostId,
        maxPlayers: room.maxPlayers,
        categories: { ...room.categories },
        players: projectRoomPlayers(room),
        matchId: room.matchId,
        currentRound: room.currentRound,
        roundDeadline: room.roundDeadline,
        roundStart: room.lastRoundStart ? { ...room.lastRoundStart } : null,
        lastRoundEnd: room.lastRoundEnd,
        gameEnd: room.gameEnd ? withCanPlayAgain(room.gameEnd, room) : null,
        pauseDeadline: room.pauseDeadline,
        playAgainVoterIds: room.playAgainVotes ? [...room.playAgainVotes] : []
      })),
      challenges: [...challenges.entries()].map(([targetId, challenge]) => ({
        targetId,
        challengerId: challenge.challengerId,
        expiresAt: challenge.expiresAt
      })),
      onlinePlayers: getOnlinePlayersList(),
      timerCounts: {
        room: roomTimers.size,
        pause: pauseTimers.size,
        disconnect: disconnectTimers.size,
        totalScheduled: allApplicationTimers.size
      }
    };
  }

  function listen(port = options.port === undefined ? 0 : options.port, host = options.host || '127.0.0.1') {
    if (listenPromise) return listenPromise;
    listenPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address());
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    return listenPromise;
  }

  function close() {
    if (closePromise) return closePromise;
    shuttingDown = true;

    // Timers before sockets: disconnect handlers see shuttingDown and no-op.
    for (const timer of allApplicationTimers) clearAppTimeout(timer);
    allApplicationTimers.clear();
    roomTimers.clear();
    pauseTimers.clear();
    disconnectTimers.clear();
    for (const challenge of challenges.values()) {
      // Timers already cleared above; this just drops references.
      challenge.timer = null;
    }
    challenges.clear();

    closePromise = new Promise(resolve => {
      io.close(() => resolve());
    });
    return closePromise;
  }

  return {
    app,
    server,
    io,
    listen,
    close,
    rules: { ...rules },
    grace: { ...grace },
    getState,
    getDebugState: getState
  };
}

// ── Production entrypoint ───────────────────────────────────────────────

if (require.main === module) {
  const instance = createGameServer();
  instance.listen(PORT, '0.0.0.0').then(() => {
    const address = instance.server.address();
    const port = address && typeof address === 'object' ? address.port : PORT;
    console.log(`Server running on http://localhost:${port}`);
    console.log('LAN access: http://<your-LAN-IP>:' + port);
  }).catch(error => {
    console.error('Failed to start server:', error);
    process.exitCode = 1;
  });
}

module.exports = { createGameServer };
