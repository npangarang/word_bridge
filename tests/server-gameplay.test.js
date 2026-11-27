'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGameServer } = require('../server');
const WORD_LOOKUP = require('../word_lookup.json');
const WORD_CATEGORIES = require('../word_categories.json');
const {
  TestClient,
  ManualClock,
  delay,
  waitUntil,
  connectRegistered,
  resumeClient
} = require('./helpers/socket-client');

function createContext(t, options = {}) {
  const clock = new ManualClock();
  const instance = createGameServer({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    logger: null,
    ...options
  });
  const clients = new Set();
  const ctx = { instance, clock, clients, url: null, track(client) { clients.add(client); return client; } };

  t.after(async () => {
    for (const client of clients) {
      try { client.close(); } catch { /* ignore */ }
    }
    await instance.close();
  });

  ctx.start = async () => {
    const address = await instance.listen(0, '127.0.0.1');
    ctx.url = `http://127.0.0.1:${address.port}`;
    return ctx;
  };
  return ctx;
}

async function register(ctx, name) {
  const result = await connectRegistered(ctx.url, name);
  ctx.track(result.client);
  return result;
}

async function createAndJoin(ctx, host, guest) {
  host.client.emit('createRoom');
  const room = await host.client.waitFor('roomCreated');
  guest.client.emit('joinRoom', { code: room.code, name: guest.confirmed.name });
  await guest.client.waitFor('roomJoined');
  return room;
}

async function readyUp(client, playerId) {
  client.emit('readyUp');
  await client.waitFor('playerLobbyReady', data =>
    data.playerId !== undefined && (playerId === undefined || data.playerId === playerId)
  );
}

async function startThreePlayerMatch(ctx) {
  const host = await register(ctx, 'Alice');
  const second = await register(ctx, 'Bob');
  const third = await register(ctx, 'Carol');
  const room = await createAndJoin(ctx, host, second);

  third.client.emit('joinRoom', { code: room.code });
  await third.client.waitFor('roomJoined');

  await readyUp(host.client, host.confirmed.playerId);
  await readyUp(second.client, second.confirmed.playerId);
  await readyUp(third.client, third.confirmed.playerId);

  host.client.emit('startGame');
  const rounds = await Promise.all([
    host.client.waitFor('roundStart'),
    second.client.waitFor('roundStart'),
    third.client.waitFor('roundStart')
  ]);
  return { host, second, third, room, roundStart: rounds[0] };
}

async function finishSingleRoundGame(ctx, players) {
  ctx.clock.tick(10000);
  const ends = await Promise.all(players.map(p => p.client.waitFor('roundEnd')));
  assert.equal(ends.every(end => end.round === 1 && end.totalRounds === 1), true);
  ctx.clock.tick(5000);
  const gameEnds = await Promise.all(players.map(p => p.client.waitFor('gameEnd')));
  assert.equal(gameEnds.every(end => end.canPlayAgain === true), true);
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');
}

async function startMatch(ctx, hostName = 'Alice', guestName = 'Bob') {
  const host = await register(ctx, hostName);
  const guest = await register(ctx, guestName);
  const room = await createAndJoin(ctx, host, guest);

  await readyUp(host.client);
  await readyUp(guest.client);
  host.client.emit('startGame');
  const [hostRound, guestRound] = await Promise.all([
    host.client.waitFor('roundStart'),
    guest.client.waitFor('roundStart')
  ]);
  assert.equal(hostRound.matchId, guestRound.matchId);
  return { host, guest, room, roundStart: hostRound };
}

function pickWord(roundStart, { minLength = 4 } = {}) {
  const pair = `${roundStart.startLetter}${roundStart.endLetter}`.toLowerCase();
  const words = WORD_LOOKUP[pair] || [];
  const word = words.find(w => /^[a-z]+$/.test(w) && w.length >= minLength) || words[0];
  assert.ok(word, `dictionary word for ${pair}`);
  return word;
}

function invalidWord(roundStart) {
  const s = roundStart.startLetter.toLowerCase();
  const e = roundStart.endLetter.toLowerCase();
  const pair = s + e;
  let candidate = `${s}zzzzzz${e}`;
  while ((WORD_LOOKUP[pair] || []).includes(candidate)) candidate += 'z';
  return candidate;
}

function submit(client, word, roundStart) {
  client.emit('submitWord', {
    word,
    matchId: roundStart.matchId,
    round: roundStart.round
  });
}

test('lobby capacity, readiness, reconnect gate, and start all use the stable roster', async (t) => {
  const ctx = await createContext(t, { maxPlayers: 2 }).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');
  const c = await register(ctx, 'Carol');

  a.client.emit('createRoom');
  const room = await a.client.waitFor('roomCreated');

  a.client.emit('startGame');
  assert.equal((await a.client.waitFor('error', e => e.message === 'Need at least 2 players')).message, 'Need at least 2 players');

  b.client.emit('joinRoom', { code: room.code });
  await b.client.waitFor('roomJoined');

  c.client.emit('joinRoom', { code: room.code });
  assert.equal((await c.client.waitFor('error', e => e.message === 'Room is full')).message, 'Room is full');
  assert.equal(ctx.instance.getState().rooms[0].players.length, 2);

  a.client.emit('startGame');
  assert.equal(
    (await a.client.waitFor('error', e => e.message === 'All players must be ready')).message,
    'All players must be ready'
  );

  await readyUp(b.client);
  await readyUp(a.client);

  await b.client.disconnect();
  await a.client.waitFor('opponentDisconnected', e => e.playerId === b.confirmed.playerId);
  a.client.emit('startGame');
  assert.equal(
    (await a.client.waitFor('error', e => e.message === 'Waiting for all players to reconnect')).message,
    'Waiting for all players to reconnect'
  );

  const resumed = await resumeClient(ctx.url, b.confirmed.resumeToken);
  ctx.track(resumed.client);
  assert.equal(resumed.snapshot.state, 'lobby');
  assert.equal(resumed.snapshot.players.find(p => p.id === b.confirmed.playerId).ready, true);
  assert.equal(resumed.snapshot.players.find(p => p.id === b.confirmed.playerId).connected, true);
  await a.client.waitFor('playerRejoined', e => e.playerId === b.confirmed.playerId);

  a.client.emit('startGame');
  const [hostRound, guestRound] = await Promise.all([
    a.client.waitFor('roundStart'),
    resumed.client.waitFor('roundStart')
  ]);
  assert.equal(hostRound.round, 1);
  assert.equal(hostRound.totalRounds, 10);
  assert.equal(hostRound.timeLeft, 10);
  assert.equal(hostRound.matchId, guestRound.matchId);
  assert.equal(ctx.instance.getState().rooms[0].state, 'playing');
});

test('active submission, scores, deadline, and identity survive a refresh; words stay private', async (t) => {
  const ctx = await createContext(t, { totalRounds: 3 }).start();
  const { host: a, guest: b, roundStart: round1 } = await startMatch(ctx);

  const word1 = pickWord(round1);
  submit(a.client, word1, round1);
  submit(b.client, word1, round1);
  const [end1] = await Promise.all([
    a.client.waitFor('roundEnd'),
    b.client.waitFor('roundEnd')
  ]);
  assert.equal(end1.round, 1);
  const scoreA = end1.results.find(r => r.playerId === a.confirmed.playerId).totalScore;
  const scoreB = end1.results.find(r => r.playerId === b.confirmed.playerId).totalScore;
  assert.ok(scoreA > 0 && scoreB > 0);

  // Comfort enabled during the pause changes the next round's duration, not
  // the already-finished round.
  a.client.emit('setComfortMode', { enabled: true });
  await b.client.waitFor('comfortModeUpdated', e => e.playerId === a.confirmed.playerId && e.comfortMode === true);
  ctx.clock.tick(5000);

  const [round2A, round2B] = await Promise.all([
    a.client.waitFor('roundStart'),
    b.client.waitFor('roundStart')
  ]);
  assert.equal(round2A.round, 2);
  assert.equal(round2A.timeLeft, 15);
  assert.equal(round2B.timeLeft, 15);

  ctx.clock.tick(1000);
  a.client.emit('setComfortMode', { enabled: false });
  await b.client.waitFor('comfortModeUpdated', e => e.playerId === a.confirmed.playerId && e.comfortMode === false);
  // Toggling comfort during the round must not move the immutable deadline.
  assert.equal(ctx.instance.getState().rooms[0].roundDeadline, round2A.deadline);
  assert.equal(ctx.instance.getState().rooms[0].roundStart.deadline, round2A.deadline);

  const word2 = pickWord(round2A);
  const eventIndexBeforeSubmit = b.client._events.length;
  const submittedCountBefore = b.client._events.filter(
    e => e.event === 'playerSubmitted' && e.data.playerId === a.confirmed.playerId
  ).length;
  submit(a.client, word2, round2A);
  await waitUntil(() => b.client._events.filter(
    e => e.event === 'playerSubmitted' && e.data.playerId === a.confirmed.playerId
  ).length > submittedCountBefore, { message: 'guest received host playerSubmitted' });
  const newGuestEvents = JSON.stringify(b.client._events.slice(eventIndexBeforeSubmit));
  assert.equal(newGuestEvents.includes(word2), false, 'opponent never receives the raw active submission word');

  await a.client.disconnect();
  await waitUntil(() => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false, {
    message: 'host disconnect processed'
  });
  const resumed = await resumeClient(ctx.url, a.confirmed.resumeToken);
  ctx.track(resumed.client);
  await b.client.waitFor('playerRejoined', e => e.playerId === a.confirmed.playerId);

  assert.equal(resumed.snapshot.code, ctx.instance.getState().rooms[0].code);
  assert.equal(resumed.snapshot.state, 'playing');
  assert.equal(resumed.snapshot.matchId, round2A.matchId);
  assert.equal(resumed.snapshot.roundStart.round, 2);
  assert.equal(resumed.snapshot.roundStart.timeLeft, 15);
  assert.equal(resumed.snapshot.roundStart.deadline, round2A.deadline);
  assert.equal(resumed.snapshot.ownSubmission.word, word2);
  assert.equal(resumed.snapshot.ownSubmission.isValid, true);
  assert.equal(resumed.snapshot.players.find(p => p.id === a.confirmed.playerId).score, scoreA);
  assert.equal(resumed.snapshot.players.find(p => p.id === b.confirmed.playerId).score, scoreB);
  assert.equal(resumed.snapshot.players.find(p => p.id === a.confirmed.playerId).submitted, true);
  assert.equal(resumed.snapshot.players.find(p => p.id === b.confirmed.playerId).submitted, false);

  // Public room diagnostic contains flags, never submission objects/words.
  const publicPlayers = ctx.instance.getState().rooms[0].players;
  assert.equal(JSON.stringify(publicPlayers).includes(word2), false);
});

test('paused and finished snapshots cache round data, votes, and rematch reset', async (t) => {
  const ctx = await createContext(t, { totalRounds: 1 }).start();
  const { host: a, guest: b } = await startMatch(ctx);

  ctx.clock.tick(10000);
  const [end1] = await Promise.all([
    a.client.waitFor('roundEnd'),
    b.client.waitFor('roundEnd')
  ]);
  assert.equal(end1.round, 1);
  const pausedDeadline = ctx.instance.getState().rooms[0].pauseDeadline;
  assert.equal(pausedDeadline, ctx.clock.now() + 5000);

  await a.client.disconnect();
  await waitUntil(() => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false, {
    message: 'paused disconnect processed'
  });
  const pausedResume = await resumeClient(ctx.url, a.confirmed.resumeToken);
  ctx.track(pausedResume.client);
  assert.equal(pausedResume.snapshot.state, 'paused');
  assert.equal(pausedResume.snapshot.pauseDeadline, pausedDeadline);
  assert.equal(pausedResume.snapshot.lastRoundEnd.round, 1);
  assert.equal(pausedResume.snapshot.lastRoundEnd.results.length, 2);
  assert.equal(pausedResume.snapshot.ownSubmission, null);
  assert.deepEqual(pausedResume.snapshot.playAgainVoterIds, []);
  assert.equal(pausedResume.snapshot.roundStart.deadline, pausedDeadline - 5000);

  ctx.clock.tick(5000);
  const [gameEndA, gameEndB] = await Promise.all([
    pausedResume.client.waitFor('gameEnd'),
    b.client.waitFor('gameEnd')
  ]);
  assert.equal(gameEndA.canPlayAgain, true);
  assert.deepEqual(gameEndA, gameEndB);
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');

  pausedResume.client.emit('requestPlayAgain');
  const vote = await b.client.waitFor('playAgainVote', v => v.voteCount === 1);
  assert.equal(vote.playerCount, 2);
  assert.deepEqual(vote.voterIds, [a.confirmed.playerId]);

  await b.client.disconnect();
  await waitUntil(() => ctx.instance.getState().sessions.find(s => s.playerId === b.confirmed.playerId).connected === false, {
    message: 'finished disconnect processed'
  });
  const finishedResume = await resumeClient(ctx.url, b.confirmed.resumeToken);
  ctx.track(finishedResume.client);
  assert.equal(finishedResume.snapshot.state, 'finished');
  assert.equal(finishedResume.snapshot.gameEnd.canPlayAgain, true);
  assert.deepEqual(finishedResume.snapshot.playAgainVoterIds, [a.confirmed.playerId]);
  assert.ok(finishedResume.snapshot.lastRoundEnd);

  finishedResume.client.emit('requestPlayAgain');
  const [resetA, resetB] = await Promise.all([
    pausedResume.client.waitFor('gameReset'),
    finishedResume.client.waitFor('gameReset')
  ]);
  assert.deepEqual(resetA, resetB);
  assert.equal(resetA.code, ctx.instance.getState().rooms[0].code);
  assert.equal(ctx.instance.getState().rooms[0].state, 'lobby');
  assert.equal(ctx.instance.getState().rooms[0].matchId, null);
  assert.equal(ctx.instance.getState().rooms[0].players.every(p => p.score === 0 && p.ready === false), true);
});

test('category mismatch is retryable and never stored as a submission', async (t) => {
  const ctx = await createContext(t, { totalRounds: 1 }).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');
  const room = await createAndJoin(ctx, a, b);

  a.client.emit('updateCategories', {
    noun_adj_verb: false,
    countries: false,
    us_states: true,
    us_cities: false
  });
  await b.client.waitFor('categoriesUpdated', e => e.categories.us_states === true);

  await readyUp(a.client);
  await readyUp(b.client);
  a.client.emit('startGame');
  const [round] = await Promise.all([
    a.client.waitFor('roundStart'),
    b.client.waitFor('roundStart')
  ]);

  const pair = `${round.startLetter}${round.endLetter}`.toLowerCase();
  const words = WORD_LOOKUP[pair] || [];
  const matching = words.find(w => /^[a-z]{3,20}$/.test(w) && (WORD_CATEGORIES[w] || []).includes('us_states'));
  const nonMatching = words.find(w => /^[a-z]{3,20}$/.test(w) && !(WORD_CATEGORIES[w] || []).includes('us_states'));
  assert.ok(matching, `state word for ${pair}`);
  assert.ok(nonMatching, `non-state dictionary word for ${pair}`);

  submit(a.client, nonMatching, round);
  const mismatch = await a.client.waitFor('error', e => e.code === 'category_mismatch');
  assert.equal(mismatch.code, 'category_mismatch');
  assert.equal(ctx.instance.getState().rooms[0].players.find(p => p.id === a.confirmed.playerId).submitted, false);

  // The rejection did not consume the one submission slot.
  submit(a.client, matching, round);
  await b.client.waitFor('playerSubmitted', e => e.playerId === a.confirmed.playerId);
  submit(b.client, matching, round);

  const [end] = await Promise.all([
    a.client.waitFor('roundEnd'),
    b.client.waitFor('roundEnd')
  ]);
  const resultA = end.results.find(r => r.playerId === a.confirmed.playerId);
  assert.equal(resultA.isValid, true);
  assert.equal(resultA.word, matching);
  assert.ok(resultA.points > 0);
});

test('invalid dictionary word is recorded for zero and cannot be retried', async (t) => {
  const ctx = await createContext(t, { totalRounds: 1 }).start();
  const { host: a, guest: b, roundStart } = await startMatch(ctx);

  const bad = invalidWord(roundStart);
  const good = pickWord(roundStart);
  submit(a.client, bad, roundStart);
  await b.client.waitFor('playerSubmitted', e => e.playerId === a.confirmed.playerId);

  await a.client.disconnect();
  await waitUntil(() => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false, {
    message: 'invalid-submit disconnect processed'
  });
  const resumed = await resumeClient(ctx.url, a.confirmed.resumeToken);
  ctx.track(resumed.client);
  assert.equal(resumed.snapshot.ownSubmission.word, bad);
  assert.equal(resumed.snapshot.ownSubmission.isValid, false);
  assert.equal(resumed.snapshot.ownSubmission.points, 0);

  // Already submitted: a second (valid) attempt must not replace the record.
  submit(resumed.client, good, roundStart);
  await delay(60);
  assert.equal(b.client.hasEvent('playerSubmitted', e => e.playerId === a.confirmed.playerId), false);

  submit(b.client, good, roundStart);
  const [roundEnd] = await Promise.all([
    resumed.client.waitFor('roundEnd'),
    b.client.waitFor('roundEnd')
  ]);
  const resultA = roundEnd.results.find(r => r.playerId === a.confirmed.playerId);
  assert.equal(resultA.isValid, false);
  assert.equal(resultA.points, 0);
  assert.equal(resultA.word, `(${bad})`);
});

test('stale match/round objects, legacy strings, and late submissions are rejected', async (t) => {
  const ctx = await createContext(t, { totalRounds: 1 }).start();
  const { host: a, roundStart } = await startMatch(ctx);
  const word = pickWord(roundStart);

  a.client.emit('submitWord', { word, matchId: 'not-this-match', round: roundStart.round });
  assert.equal((await a.client.waitFor('error', e => e.code === 'stale_submission')).code, 'stale_submission');

  a.client.emit('submitWord', { word, matchId: roundStart.matchId, round: roundStart.round + 1 });
  assert.equal((await a.client.waitFor('error', e => e.code === 'stale_submission')).code, 'stale_submission');

  a.client.emit('submitWord', word);
  assert.equal((await a.client.waitFor('error', e => e.code === 'invalid_submission')).code, 'invalid_submission');

  assert.equal(ctx.instance.getState().rooms[0].players.every(p => p.submitted === false), true);

  // Move the wall clock exactly to the deadline without firing the round timer,
  // simulating a delayed timer callback. The handler must still reject.
  ctx.clock.current = roundStart.deadline;
  a.client.emit('submitWord', { word, matchId: roundStart.matchId, round: roundStart.round });
  assert.equal((await a.client.waitFor('error', e => e.code === 'round_expired')).code, 'round_expired');
  assert.equal(ctx.instance.getState().rooms[0].players.every(p => p.submitted === false), true);

  ctx.clock.tick(0);
  await a.client.waitFor('roundEnd');
  assert.equal(ctx.instance.getState().rooms[0].state, 'paused');
});

test('paused explicit departure forfeits, caches the outcome, and schedules no next round', async (t) => {
  const ctx = await createContext(t, { totalRounds: 2 }).start();
  const { host: a, guest: b } = await startMatch(ctx);

  ctx.clock.tick(10000);
  await Promise.all([
    a.client.waitFor('roundEnd'),
    b.client.waitFor('roundEnd')
  ]);
  assert.equal(ctx.instance.getState().rooms[0].state, 'paused');

  a.client.emit('leaveRoom');
  await a.client.waitFor('roomLeft');
  const end = await b.client.waitFor('gameEnd');
  assert.equal(end.forfeit, true);
  assert.equal(end.canPlayAgain, false);
  assert.equal(end.winnerId, b.confirmed.playerId);
  assert.equal(end.players.length, 1);
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');
  assert.equal(ctx.instance.getState().rooms[0].hostId, b.confirmed.playerId);
  assert.equal(ctx.instance.getState().rooms[0].players.length, 1);
  assert.equal(ctx.clock.pendingCount(), 0, 'round and pause timers are both cleared');

  ctx.clock.tick(20000);
  assert.equal(b.client.hasEvent('roundStart'), false, 'no next round was scheduled after the pause forfeit');

  b.client.emit('leaveRoom');
  await b.client.waitFor('roomLeft');
  assert.equal(ctx.instance.getState().rooms.length, 0);
  assert.equal(ctx.instance.getState().sessions.every(s => s.roomCode === null), true);
});

test('paused transient departure forfeits at expiry and invalidates its token', async (t) => {
  const ctx = await createContext(t, {
    totalRounds: 2,
    grace: { paused: 1000 }
  }).start();
  const { host: a, guest: b } = await startMatch(ctx);

  ctx.clock.tick(10000);
  await Promise.all([
    a.client.waitFor('roundEnd'),
    b.client.waitFor('roundEnd')
  ]);
  assert.equal(ctx.instance.getState().rooms[0].state, 'paused');

  await b.client.disconnect();
  const disconnected = await a.client.waitFor('opponentDisconnected', e => e.playerId === b.confirmed.playerId);
  assert.equal(disconnected.players.find(p => p.id === b.confirmed.playerId).connected, false);
  assert.equal(
    ctx.instance.getState().sessions.find(s => s.playerId === b.confirmed.playerId).disconnectDeadline,
    ctx.clock.now() + 1000
  );

  ctx.clock.tick(1000);
  const end = await a.client.waitFor('gameEnd');
  assert.equal(end.forfeit, true);
  assert.equal(end.canPlayAgain, false);
  assert.equal(end.winnerId, a.confirmed.playerId);
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');
  assert.equal(ctx.instance.getState().rooms[0].players.length, 1);
  assert.equal(ctx.clock.pendingCount(), 0);

  const expired = await TestClient.connectExpectError(ctx.url, {
    auth: { resumeToken: b.confirmed.resumeToken }
  });
  assert.equal(expired.code, 'SESSION_EXPIRED');

  ctx.clock.tick(20000);
  assert.equal(a.client.hasEvent('roundStart'), false, 'pause timer was cleared by the forfeit');
});

test('finished-room quorum resets exactly once after a nonvoter leaves', async (t) => {
  const ctx = await createContext(t, { totalRounds: 1 }).start();
  const { host: a, second: b, third: c } = await startThreePlayerMatch(ctx);
  await finishSingleRoundGame(ctx, [a, b, c]);

  a.client.emit('requestPlayAgain');
  await a.client.waitFor('playAgainVote', v => v.voteCount === 1);
  b.client.emit('requestPlayAgain');
  await b.client.waitFor('playAgainVote', v => v.voteCount === 2 && v.playerCount === 3);
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');

  const voteAfterRemoval = a.client.waitFor('playAgainVote', v =>
    v.playerCount === 2 && v.voteCount === 2 && v.votedId === null
  );
  const resetA = a.client.waitFor('gameReset');
  const resetB = b.client.waitFor('gameReset');
  c.client.emit('leaveRoom');
  await c.client.waitFor('roomLeft');

  const vote = await voteAfterRemoval;
  assert.deepEqual(new Set(vote.voterIds), new Set([a.confirmed.playerId, b.confirmed.playerId]));
  const [resetForA, resetForB] = await Promise.all([resetA, resetB]);
  assert.deepEqual(resetForA, resetForB);
  assert.equal(ctx.instance.getState().rooms[0].state, 'lobby');
  assert.equal(ctx.instance.getState().rooms[0].players.length, 2);
  assert.equal(ctx.instance.getState().rooms[0].matchId, null);

  // Deterministic event barrier: any duplicate gameReset would arrive before
  // the requestOnlinePlayers response on the same socket.
  a.client.emit('requestOnlinePlayers');
  await a.client.waitFor('onlinePlayers');
  assert.equal(a.client._events.filter(e => e.event === 'gameReset').length, 1);
});

test('finished-room quorum resets after a nonvoter expires', async (t) => {
  const ctx = await createContext(t, {
    totalRounds: 1,
    grace: { finished: 1000 }
  }).start();
  const { host: a, second: b, third: c } = await startThreePlayerMatch(ctx);
  await finishSingleRoundGame(ctx, [a, b, c]);

  a.client.emit('requestPlayAgain');
  await a.client.waitFor('playAgainVote', v => v.voteCount === 1);
  b.client.emit('requestPlayAgain');
  await b.client.waitFor('playAgainVote', v => v.voteCount === 2 && v.playerCount === 3);

  await c.client.disconnect();
  await waitUntil(
    () => ctx.instance.getState().sessions.find(s => s.playerId === c.confirmed.playerId).connected === false,
    { message: 'nonvoter disconnect processed' }
  );
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');

  const voteAfterRemoval = a.client.waitFor('playAgainVote', v =>
    v.playerCount === 2 && v.voteCount === 2 && v.votedId === null
  );
  const resetA = a.client.waitFor('gameReset');
  ctx.clock.tick(1000);

  await voteAfterRemoval;
  await resetA;
  assert.equal(ctx.instance.getState().rooms[0].state, 'lobby');
  assert.equal(ctx.instance.getState().rooms[0].players.length, 2);
  assert.equal(ctx.instance.getState().sessions.some(s => s.playerId === c.confirmed.playerId), false);
  a.client.emit('requestOnlinePlayers');
  await a.client.waitFor('onlinePlayers');
  assert.equal(a.client._events.filter(e => e.event === 'gameReset').length, 1);
});

test('finished-room quorum resets when reconnect clears the last connectivity blocker', async (t) => {
  const ctx = await createContext(t, { totalRounds: 1 }).start();
  const { host: a, second: b, third: c } = await startThreePlayerMatch(ctx);
  await finishSingleRoundGame(ctx, [a, b, c]);

  a.client.emit('requestPlayAgain');
  await a.client.waitFor('playAgainVote', v => v.voteCount === 1);
  b.client.emit('requestPlayAgain');
  await b.client.waitFor('playAgainVote', v => v.voteCount === 2 && v.playerCount === 3);

  await b.client.disconnect();
  await waitUntil(
    () => ctx.instance.getState().sessions.find(s => s.playerId === b.confirmed.playerId).connected === false,
    { message: 'voter disconnect processed' }
  );

  c.client.emit('leaveRoom');
  await c.client.waitFor('roomLeft');
  const voteAfterRemoval = await a.client.waitFor('playAgainVote', v =>
    v.playerCount === 2 && v.voteCount === 2 && v.votedId === null
  );
  assert.deepEqual(new Set(voteAfterRemoval.voterIds), new Set([a.confirmed.playerId, b.confirmed.playerId]));
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');
  assert.equal(a.client.hasEvent('gameReset'), false, 'quorum must wait for the disconnected voter');

  const resetA = a.client.waitFor('gameReset');
  const resumed = await resumeClient(ctx.url, b.confirmed.resumeToken);
  ctx.track(resumed.client);
  const resetB = await resumed.client.waitFor('gameReset');
  await resetA;
  assert.equal(ctx.instance.getState().rooms[0].state, 'lobby');
  assert.equal(ctx.instance.getState().rooms[0].players.length, 2);
  assert.equal(ctx.instance.getState().sessions.find(s => s.playerId === b.confirmed.playerId).connected, true);
  assert.equal(resetB.players.length, 2);
  a.client.emit('requestOnlinePlayers');
  await a.client.waitFor('onlinePlayers');
  assert.equal(a.client._events.filter(e => e.event === 'gameReset').length, 1);
});

test('finished-room quorum never resets with fewer than two remaining', async (t) => {
  const ctx = await createContext(t, { totalRounds: 1 }).start();
  const { host: a, second: b, third: c } = await startThreePlayerMatch(ctx);
  await finishSingleRoundGame(ctx, [a, b, c]);

  a.client.emit('requestPlayAgain');
  await a.client.waitFor('playAgainVote', v => v.voteCount === 1);

  c.client.emit('leaveRoom');
  await c.client.waitFor('roomLeft');
  const voteAfterFirstLeave = await a.client.waitFor('playAgainVote', v =>
    v.playerCount === 2 && v.voteCount === 1 && v.votedId === null
  );
  assert.equal(voteAfterFirstLeave.playerCount, 2);
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');

  b.client.emit('leaveRoom');
  await b.client.waitFor('roomLeft');
  await a.client.waitFor('playAgainVote', v => v.playerCount === 1 && v.voteCount === 1 && v.votedId === null);
  assert.equal(ctx.instance.getState().rooms[0].state, 'finished');
  assert.equal(ctx.instance.getState().rooms[0].players.length, 1);

  a.client.emit('requestOnlinePlayers');
  await a.client.waitFor('onlinePlayers');
  assert.equal(a.client._events.filter(e => e.event === 'gameReset').length, 0);
});

test('host reassignment after permanent departure prefers a live player', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');
  const c = await register(ctx, 'Carol');

  a.client.emit('createRoom');
  const room = await a.client.waitFor('roomCreated');
  b.client.emit('joinRoom', { code: room.code });
  await b.client.waitFor('roomJoined');
  c.client.emit('joinRoom', { code: room.code });
  await c.client.waitFor('roomJoined');

  await b.client.disconnect();
  await a.client.waitFor('opponentDisconnected', e => e.playerId === b.confirmed.playerId);

  a.client.emit('leaveRoom');
  await a.client.waitFor('roomLeft');
  const left = await c.client.waitFor('playerLeft', e => e.playerId === a.confirmed.playerId);
  assert.equal(left.hostId, c.confirmed.playerId);
  assert.equal(ctx.instance.getState().rooms[0].hostId, c.confirmed.playerId);
  assert.equal(ctx.instance.getState().rooms[0].players.find(p => p.id === b.confirmed.playerId).connected, false);
  assert.equal(ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).roomCode, null);

  const resumed = await resumeClient(ctx.url, b.confirmed.resumeToken);
  ctx.track(resumed.client);
  await c.client.waitFor('playerRejoined', e => e.playerId === b.confirmed.playerId);
  assert.equal(ctx.instance.getState().rooms[0].hostId, c.confirmed.playerId);
});
