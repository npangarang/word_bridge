'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGameServer } = require('../server');
const {
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

async function challenge(challenger, target) {
  challenger.client.emit('challengePlayer', { targetId: target.confirmed.playerId });
  const [received, sent] = await Promise.all([
    target.client.waitFor('challengeReceived', e => e.challengerId === challenger.confirmed.playerId),
    challenger.client.waitFor('challengeSent', e => e.targetId === target.confirmed.playerId)
  ]);
  assert.deepEqual(received.categories, sent.categories);
  return { received, sent };
}

test('accept revalidates both players and cleans up other challenges before entering a room', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');
  const c = await register(ctx, 'Carol');

  await challenge(a, b);
  await challenge(c, a);

  const cancelledForB = b.client.waitFor('challengeCancelled', e => e.challengerName === 'Alice');
  a.client.emit('acceptChallenge', c.confirmed.playerId);
  await cancelledForB;

  const [acceptedA, acceptedC] = await Promise.all([
    a.client.waitFor('challengeAccepted'),
    c.client.waitFor('challengeAccepted')
  ]);
  assert.equal(acceptedA.code, acceptedC.code);
  assert.equal(acceptedA.hostId, c.confirmed.playerId, 'challenger is host');
  assert.equal(acceptedA.maxPlayers, 2);
  assert.deepEqual(
    new Set(acceptedA.players.map(p => p.id)),
    new Set([a.confirmed.playerId, c.confirmed.playerId])
  );
  assert.equal(acceptedA.players.every(p => p.connected), true);

  const [roundA, roundC] = await Promise.all([
    a.client.waitFor('roundStart'),
    c.client.waitFor('roundStart')
  ]);
  assert.equal(roundA.matchId, roundC.matchId);
  assert.equal(roundA.round, 1);

  const state = ctx.instance.getState();
  assert.equal(state.rooms.length, 1);
  assert.equal(state.rooms[0].state, 'playing');
  assert.equal(state.challenges.length, 0);
  assert.equal(state.sessions.find(s => s.playerId === a.confirmed.playerId).roomCode, state.rooms[0].code);
  assert.equal(state.sessions.find(s => s.playerId === c.confirmed.playerId).roomCode, state.rooms[0].code);
  assert.equal(state.sessions.find(s => s.playerId === b.confirmed.playerId).roomCode, null);

  // Bob's notification was real, but his stale accept must not create a room.
  b.client.emit('acceptChallenge', a.confirmed.playerId);
  assert.equal(
    (await b.client.waitFor('error', e => e.message === 'No pending challenge from this player')).message,
    'No pending challenge from this player'
  );
  assert.equal(ctx.instance.getState().rooms.length, 1);
});

test('simultaneous accepts create exactly one consistent two-player room', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');
  const c = await register(ctx, 'Carol');

  await challenge(a, b);
  await challenge(c, a);

  // Race two legal accept paths: Alice accepts Carol while Bob accepts Alice.
  a.client.emit('acceptChallenge', c.confirmed.playerId);
  b.client.emit('acceptChallenge', a.confirmed.playerId);

  await waitUntil(() => {
    const state = ctx.instance.getState();
    return state.rooms.length === 1 && state.rooms[0].state === 'playing';
  }, { message: 'one challenge room to start' });

  const state = ctx.instance.getState();
  assert.equal(state.rooms.length, 1);
  assert.equal(state.challenges.length, 0);
  const room = state.rooms[0];
  const ids = room.players.map(p => p.id);
  assert.equal(ids.length, 2);
  assert.ok(ids.includes(a.confirmed.playerId), 'Alice is in exactly one room');
  assert.equal(ids.filter(id => id === b.confirmed.playerId).length + ids.filter(id => id === c.confirmed.playerId).length, 1);
  const loserId = ids.includes(b.confirmed.playerId) ? c.confirmed.playerId : b.confirmed.playerId;
  assert.equal(state.sessions.find(s => s.playerId === loserId).roomCode, null);
  for (const id of ids) {
    assert.equal(state.sessions.find(s => s.playerId === id).roomCode, room.code);
  }
  assert.equal(room.players.every(p => p.connected), true);
});

test('a target that entered a room cannot later accept a stale challenge', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  await challenge(a, b);
  const declinedForA = a.client.waitFor('challengeDeclined', e => e.targetName === 'Bob');
  b.client.emit('createRoom');
  const room = await b.client.waitFor('roomCreated');
  await declinedForA;

  b.client.emit('acceptChallenge', a.confirmed.playerId);
  const error = await b.client.waitFor('error', e =>
    e.message === 'No pending challenge from this player' || e.message === 'You are already in a room'
  );
  assert.ok(error.message);

  const state = ctx.instance.getState();
  assert.equal(state.rooms.length, 1);
  assert.equal(state.rooms[0].code, room.code);
  assert.equal(state.sessions.find(s => s.playerId === a.confirmed.playerId).roomCode, null);
});

test('a challenger that entered another room cannot be accepted later', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  await challenge(a, b);
  const cancelledForB = b.client.waitFor('challengeCancelled', e => e.challengerName === 'Alice');
  a.client.emit('createRoom');
  const room = await a.client.waitFor('roomCreated');
  await cancelledForB;

  b.client.emit('acceptChallenge', a.confirmed.playerId);
  assert.equal(
    (await b.client.waitFor('error', e => e.message === 'No pending challenge from this player')).message,
    'No pending challenge from this player'
  );

  const state = ctx.instance.getState();
  assert.equal(state.rooms.length, 1);
  assert.equal(state.rooms[0].code, room.code);
  assert.equal(state.sessions.find(s => s.playerId === b.confirmed.playerId).roomCode, null);
});

test('challenge sends reject a transiently offline target and work after resume', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  await b.client.disconnect();
  await waitUntil(() => ctx.instance.getState().sessions.find(s => s.playerId === b.confirmed.playerId).connected === false, {
    message: 'Bob offline'
  });

  a.client.emit('challengePlayer', { targetId: b.confirmed.playerId });
  assert.equal(
    (await a.client.waitFor('error', e => e.message === 'Player is not online')).message,
    'Player is not online'
  );
  assert.equal(ctx.instance.getState().challenges.length, 0);

  const resumed = await resumeClient(ctx.url, b.confirmed.resumeToken);
  ctx.track(resumed.client);
  a.client.emit('challengePlayer', { targetId: b.confirmed.playerId });
  const received = await resumed.client.waitFor('challengeReceived', e => e.challengerId === a.confirmed.playerId);
  assert.equal(received.challengerName, 'Alice');

  a.client.emit('cancelChallenge', b.confirmed.playerId);
  const cancelled = await resumed.client.waitFor('challengeCancelled', e => e.challengerName === 'Alice');
  assert.equal(cancelled.challengerName, 'Alice');
  assert.equal(ctx.instance.getState().challenges.length, 0);
});

test('challenge timeout expires against the captured challenge', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  await challenge(a, b);
  assert.equal(ctx.instance.getState().challenges.length, 1);

  ctx.clock.tick(15000);
  const [expiredA, expiredB] = await Promise.all([
    a.client.waitFor('challengeExpired'),
    b.client.waitFor('challengeExpired')
  ]);
  assert.equal(expiredA.targetId, b.confirmed.playerId);
  assert.equal(expiredA.targetName, 'Bob');
  assert.deepEqual(expiredB, {});
  assert.equal(ctx.instance.getState().challenges.length, 0);
});

test('accept at the exact challenge deadline expires both sides without a room', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');
  await challenge(a, b);

  // Jump to the absolute deadline without firing the timeout callback. Accept
  // must still reject/expire the captured challenge.
  ctx.clock.current = ctx.clock.now() + ctx.instance.rules.challengeTimeout;
  const expiredForA = a.client.waitFor('challengeExpired');
  const expiredForB = b.client.waitFor('challengeExpired');
  b.client.emit('acceptChallenge', a.confirmed.playerId);

  const [forA, forB] = await Promise.all([expiredForA, expiredForB]);
  assert.equal(forA.targetId, b.confirmed.playerId);
  assert.equal(forA.targetName, 'Bob');
  assert.deepEqual(forB, {});

  const state = ctx.instance.getState();
  assert.equal(state.challenges.length, 0);
  assert.equal(state.rooms.length, 0);
  assert.equal(state.sessions.find(s => s.playerId === b.confirmed.playerId).roomCode, null);
  assert.equal(state.sessions.find(s => s.playerId === a.confirmed.playerId).roomCode, null);
  assert.equal(state.timerCounts.totalScheduled, 0);
});

test('a stale challenge timeout cannot cancel a later challenge', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');
  await challenge(a, b);

  // Boundary acceptance expires the first record while its timer is still
  // scheduled in the fake clock.
  const firstDeadline = ctx.clock.now() + ctx.instance.rules.challengeTimeout;
  ctx.clock.current = firstDeadline;
  const firstExpiredA = a.client.waitFor('challengeExpired');
  const firstExpiredB = b.client.waitFor('challengeExpired');
  b.client.emit('acceptChallenge', a.confirmed.playerId);
  await Promise.all([firstExpiredA, firstExpiredB]);
  assert.equal(ctx.instance.getState().challenges.length, 0);

  // A new challenge starts with a later deadline. Let the old deadline pass:
  // an uncleared stale callback must not delete the new captured record.
  await challenge(a, b);
  const second = ctx.instance.getState().challenges[0];
  assert.equal(second.targetId, b.confirmed.playerId);
  assert.equal(second.expiresAt, firstDeadline + ctx.instance.rules.challengeTimeout);
  ctx.clock.tick(ctx.instance.rules.challengeTimeout - 1);
  assert.equal(ctx.instance.getState().challenges.length, 1);
  assert.equal(ctx.instance.getState().challenges[0].targetId, b.confirmed.playerId);

  const acceptedForA = a.client.waitFor('challengeAccepted');
  const acceptedForB = b.client.waitFor('challengeAccepted');
  b.client.emit('acceptChallenge', a.confirmed.playerId);
  const [acceptedA, acceptedB] = await Promise.all([acceptedForA, acceptedForB]);
  assert.equal(acceptedA.code, acceptedB.code);
  assert.equal(ctx.instance.getState().rooms.length, 1);
  assert.equal(ctx.instance.getState().rooms[0].state, 'playing');
  assert.equal(ctx.instance.getState().challenges.length, 0);
});

test('disconnect cancels a pending challenge and invalidates its timer', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  await challenge(a, b);
  await b.client.disconnect();
  const declined = await a.client.waitFor('challengeDeclined', e => e.targetName === 'Bob');
  assert.equal(declined.targetName, 'Bob');
  assert.equal(ctx.instance.getState().challenges.length, 0);

  // The old 15s timer must not emit a second expiry event later.
  ctx.clock.tick(15000);
  assert.equal(a.client.hasEvent('challengeExpired'), false);
  assert.equal(ctx.instance.getState().challenges.length, 0);
});

test('challenge cancellation after a target resume targets its current socket', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  await b.client.disconnect();
  const resumed = await resumeClient(ctx.url, b.confirmed.resumeToken);
  ctx.track(resumed.client);

  await challenge(a, { ...b, client: resumed.client });
  a.client.emit('cancelChallenge', b.confirmed.playerId);
  const cancelled = await resumed.client.waitFor('challengeCancelled', e => e.challengerName === 'Alice');
  assert.equal(cancelled.challengerName, 'Alice');
  await delay(30);
  assert.equal(ctx.instance.getState().challenges.length, 0);
});
