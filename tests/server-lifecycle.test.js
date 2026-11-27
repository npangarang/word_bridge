'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createGameServer } = require('../server');
const {
  TestClient,
  ManualClock,
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
  const ctx = {
    instance,
    clock,
    clients,
    url: null,
    track(client) {
      clients.add(client);
      return client;
    }
  };

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

async function abortPollingResume(url, resumeToken) {
  const handshake = await fetch(`${url}/socket.io/?EIO=4&transport=polling&t=${Date.now()}`);
  assert.equal(handshake.status, 200);
  const handshakeBody = await handshake.text();
  assert.equal(handshakeBody[0], '0', 'Engine.IO handshake should open with an open packet');
  const { sid } = JSON.parse(handshakeBody.slice(1));
  assert.ok(sid);

  // A batched Engine.IO payload: Socket.IO namespace CONNECT (with auth),
  // immediately followed by an Engine.IO CLOSE. Socket.IO can discard the
  // namespace connection without ever emitting app-level connection/disconnect.
  const payload = '40' + JSON.stringify({ resumeToken }) + '\x1e1';
  const post = await fetch(
    `${url}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: payload
    }
  );
  assert.equal(post.status, 200);
  await post.text();

  // Observable network barrier: the engine must be gone before state is read.
  const drain = await fetch(
    `${url}/socket.io/?EIO=4&transport=polling&sid=${encodeURIComponent(sid)}&t=${Date.now()}`
  );
  assert.equal(drain.status, 400);
  await drain.text();
}

test('default rules and native recovery settings are preserved', async (t) => {
  const instance = createGameServer({ logger: null });
  t.after(() => instance.close());

  assert.deepEqual(instance.rules, {
    roundTime: 10,
    comfortRoundTime: 15,
    pauseTime: 5,
    totalRounds: 10,
    maxPlayers: 8,
    challengeTimeout: 15000
  });
  assert.deepEqual(instance.grace, {
    playing: 15000,
    paused: 15000,
    lobby: 30000,
    finished: 30000,
    noRoom: 15000
  });
  assert.equal(instance.io.opts.connectionStateRecovery, undefined);
});

test('setName is idempotent and unknown tokens never mint players', async (t) => {
  const ctx = await createContext(t).start();
  const client = await TestClient.connect(ctx.url);
  ctx.track(client);

  client.emit('setName', '   ');
  assert.equal((await client.waitFor('error', e => e.message === 'Please enter a name')).message, 'Please enter a name');
  assert.equal(ctx.instance.getState().sessions.length, 0);

  client.emit('setName', 'Alice');
  const first = await client.waitFor('nameConfirmed', e => e.name === 'Alice');
  await client.waitFor('roomStateRestored');

  client.emit('setName', 'Alice');
  const second = await client.waitFor('nameConfirmed', e => e.name === 'Alice');
  assert.equal(second.playerId, first.playerId);
  assert.equal(second.resumeToken, first.resumeToken);
  assert.equal(ctx.instance.getState().sessions.length, 1);

  client.emit('requestOnlinePlayers');
  const online = await client.waitFor('onlinePlayers');
  assert.deepEqual(online.map(p => p.id), [first.playerId]);

  const unknown = await TestClient.connectExpectError(ctx.url, {
    auth: { resumeToken: 'definitely-not-a-session-token' }
  });
  assert.equal(unknown.code, 'SESSION_EXPIRED');
  assert.equal(ctx.instance.getState().sessions.length, 1);
});

test('same display names remain independent stable players', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Sam');
  const b = await register(ctx, 'Sam');

  assert.notEqual(a.confirmed.playerId, b.confirmed.playerId);
  assert.notEqual(a.confirmed.resumeToken, b.confirmed.resumeToken);
  assert.equal(a.confirmed.resumed, false);
  assert.equal(a.snapshot.state, 'online');
  assert.equal(a.snapshot.code, null);

  a.client.emit('createRoom');
  b.client.emit('createRoom');
  const roomA = await a.client.waitFor('roomCreated');
  const roomB = await b.client.waitFor('roomCreated');

  assert.notEqual(roomA.code, roomB.code);
  assert.equal(roomA.hostId, a.confirmed.playerId);
  assert.equal(roomB.hostId, b.confirmed.playerId);

  b.client.emit('requestOnlinePlayers');
  const online = await b.client.waitFor('onlinePlayers');
  const sams = online.filter(p => p.name === 'Sam');
  assert.equal(sams.length, 2);
  assert.deepEqual(new Set(sams.map(p => p.id)), new Set([a.confirmed.playerId, b.confirmed.playerId]));
});

test('a live resume token is rejected without kicking or minting a player', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');

  const error = await TestClient.connectExpectError(ctx.url, {
    auth: { resumeToken: a.confirmed.resumeToken }
  });
  assert.equal(error.code, 'RESUME_IN_USE');
  assert.equal(error.data.retryAfterMs, 1000);

  assert.equal(ctx.instance.getState().sessions.length, 1);
  assert.equal(ctx.instance.getState().sessions[0].connected, true);

  // The original live tab is untouched.
  a.client.emit('requestOnlinePlayers');
  const online = await a.client.waitFor('onlinePlayers');
  assert.deepEqual(online.map(p => p.id), [a.confirmed.playerId]);
});

test('refresh resumes the same identity and seat without a duplicate', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  a.client.emit('createRoom');
  const created = await a.client.waitFor('roomCreated');
  b.client.emit('joinRoom', { code: created.code, name: 'Bob' });
  await b.client.waitFor('roomJoined');

  await a.client.disconnect();
  await waitUntil(() => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false, {
    message: 'Alice disconnect processed'
  });

  const resumed = await resumeClient(ctx.url, a.confirmed.resumeToken);
  ctx.track(resumed.client);

  assert.equal(resumed.confirmed.playerId, a.confirmed.playerId);
  assert.equal(resumed.confirmed.resumeToken, a.confirmed.resumeToken);
  assert.equal(resumed.confirmed.resumed, true);
  assert.equal(resumed.snapshot.code, created.code);
  assert.equal(resumed.snapshot.state, 'lobby');
  assert.equal(resumed.snapshot.hostId, a.confirmed.playerId);
  assert.equal(resumed.snapshot.players.length, 2);
  assert.deepEqual(
    new Set(resumed.snapshot.players.map(p => p.id)),
    new Set([a.confirmed.playerId, b.confirmed.playerId])
  );
  assert.equal(resumed.snapshot.players.filter(p => p.name === 'Alice').length, 1);
  assert.equal(resumed.snapshot.players.every(p => p.connected), true);

  resumed.client.emit('requestOnlinePlayers');
  const online = await resumed.client.waitFor('onlinePlayers');
  assert.equal(online.filter(p => p.name === 'Alice').length, 1);
  assert.equal(online.some(p => p.id === a.confirmed.playerId && p.status === 'in_room'), true);
});

test('refresh racing the old transport close retries cleanly without a duplicate', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  a.client.emit('createRoom');
  const room = await a.client.waitFor('roomCreated');

  // Close the old transport abruptly (no client disconnect packet) and try to
  // resume in the same turn: the server may still consider the old transport
  // live. Either outcome is valid, but a retry must reuse the same seat.
  a.client.socket.io.engine.close();

  let resumed = null;
  try {
    const client = await TestClient.connect(ctx.url, {
      auth: { resumeToken: a.confirmed.resumeToken }
    });
    ctx.track(client);
    const confirmed = await client.waitFor('nameConfirmed');
    const snapshot = await client.waitFor('roomStateRestored');
    resumed = { client, confirmed, snapshot };
  } catch (error) {
    assert.match(error.message, /RESUME_IN_USE/);
    await waitUntil(
      () => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false,
      { message: 'old transport close processed' }
    );
    resumed = await resumeClient(ctx.url, a.confirmed.resumeToken);
    ctx.track(resumed.client);
  }

  assert.equal(resumed.confirmed.playerId, a.confirmed.playerId);
  assert.equal(resumed.confirmed.resumed, true);
  assert.equal(resumed.snapshot.code, room.code);
  assert.equal(resumed.snapshot.players.length, 1);
  assert.equal(ctx.instance.getState().sessions.length, 1);
  assert.equal(ctx.instance.getState().sessions[0].connected, true);
});

test('aborted polling resume releases its claim and preserves the grace deadline', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  await a.client.disconnect();
  await waitUntil(
    () => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false,
    { message: 'Alice disconnect processed' }
  );

  const before = ctx.instance.getState();
  const originalDeadline = before.sessions.find(s => s.playerId === a.confirmed.playerId).disconnectDeadline;
  assert.ok(originalDeadline > ctx.clock.now());
  assert.equal(before.timerCounts.disconnect, 1);

  await abortPollingResume(ctx.url, a.confirmed.resumeToken);

  const after = ctx.instance.getState();
  const session = after.sessions.find(s => s.playerId === a.confirmed.playerId);
  assert.equal(session.connected, false, 'aborted namespace connect must not be reported live');
  assert.equal(session.disconnectDeadline, originalDeadline, 'original grace deadline is preserved');
  assert.equal(after.timerCounts.disconnect, 1, 'original expiry timer remains armed');

  const resumed = await resumeClient(ctx.url, a.confirmed.resumeToken);
  ctx.track(resumed.client);
  assert.equal(resumed.confirmed.playerId, a.confirmed.playerId);
  assert.equal(resumed.confirmed.resumed, true);
  assert.equal(ctx.instance.getState().sessions.length, 1);
  assert.equal(ctx.instance.getState().sessions[0].connected, true);
});

test('aborted polling claim cannot extend grace past the original deadline', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  await a.client.disconnect();
  await waitUntil(
    () => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false,
    { message: 'Alice disconnect processed' }
  );
  const deadline = ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).disconnectDeadline;

  await abortPollingResume(ctx.url, a.confirmed.resumeToken);

  // Move directly to the original boundary without firing the expiry callback;
  // the middleware/claim checks must still reject.
  ctx.clock.current = deadline;
  const error = await TestClient.connectExpectError(ctx.url, {
    auth: { resumeToken: a.confirmed.resumeToken }
  });
  assert.equal(error.code, 'SESSION_EXPIRED');
  assert.equal(ctx.instance.getState().sessions.length, 0);
  assert.equal(ctx.instance.getState().timerCounts.disconnect, 0);
  assert.equal(ctx.instance.getState().timerCounts.totalScheduled, 0);
});

test('aborted polling claim leaves the original expiry timer effective', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  await a.client.disconnect();
  await waitUntil(
    () => ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).connected === false,
    { message: 'Alice disconnect processed' }
  );
  const deadline = ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId).disconnectDeadline;

  await abortPollingResume(ctx.url, a.confirmed.resumeToken);
  assert.equal(ctx.instance.getState().sessions[0].pending, false);
  assert.equal(ctx.instance.getState().timerCounts.disconnect, 1);

  ctx.clock.tick(deadline - ctx.clock.now());
  assert.equal(ctx.instance.getState().sessions.length, 0);
  assert.equal(ctx.instance.getState().timerCounts.disconnect, 0);
  assert.equal(ctx.instance.getState().timerCounts.totalScheduled, 0);

  const error = await TestClient.connectExpectError(ctx.url, {
    auth: { resumeToken: a.confirmed.resumeToken }
  });
  assert.equal(error.code, 'SESSION_EXPIRED');
});

test('competing resumes have exactly one winner and one retryable loser', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  await a.client.disconnect();

  const attempts = await Promise.all([
    TestClient.connect(ctx.url, { auth: { resumeToken: a.confirmed.resumeToken } })
      .then(client => ({ ok: true, client }))
      .catch(error => ({ ok: false, message: error.message })),
    TestClient.connect(ctx.url, { auth: { resumeToken: a.confirmed.resumeToken } })
      .then(client => ({ ok: true, client }))
      .catch(error => ({ ok: false, message: error.message }))
  ]);

  const winners = attempts.filter(attempt => attempt.ok);
  const losers = attempts.filter(attempt => !attempt.ok);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.match(losers[0].message, /RESUME_IN_USE/);

  ctx.track(winners[0].client);
  const confirmed = await winners[0].client.waitFor('nameConfirmed');
  assert.equal(confirmed.playerId, a.confirmed.playerId);
  assert.equal(confirmed.resumed, true);

  const state = ctx.instance.getState();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].connected, true);
});

test('expired deadline is enforced even before the timer callback runs', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  await a.client.disconnect();

  const session = ctx.instance.getState().sessions.find(s => s.playerId === a.confirmed.playerId);
  assert.equal(session.connected, false);
  assert.ok(session.disconnectDeadline > ctx.clock.now());

  // Move wall clock to the boundary without executing the expiry callback.
  ctx.clock.current = session.disconnectDeadline;

  const error = await TestClient.connectExpectError(ctx.url, {
    auth: { resumeToken: a.confirmed.resumeToken }
  });
  assert.equal(error.code, 'SESSION_EXPIRED');
  assert.equal(ctx.instance.getState().sessions.length, 0);
});

test('reconnecting just before expiry survives a delayed old callback', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  await a.client.disconnect();

  const deadline = ctx.instance.getState().sessions[0].disconnectDeadline;
  ctx.clock.current = deadline - 1;

  const resumed = await resumeClient(ctx.url, a.confirmed.resumeToken);
  ctx.track(resumed.client);
  assert.equal(resumed.confirmed.playerId, a.confirmed.playerId);

  // Run any old expiry timer at the boundary. The generation/deadline guard
  // must leave the rebound session connected.
  ctx.clock.tick(1);
  assert.equal(ctx.instance.getState().sessions[0].connected, true);

  resumed.client.emit('requestOnlinePlayers');
  const online = await resumed.client.waitFor('onlinePlayers');
  assert.equal(online.length, 1);
});

test('transient disconnect reserves the seat and hides the player from the global roster', async (t) => {
  const ctx = await createContext(t).start();
  const a = await register(ctx, 'Alice');
  const b = await register(ctx, 'Bob');

  a.client.emit('createRoom');
  const created = await a.client.waitFor('roomCreated');
  b.client.emit('joinRoom', { code: created.code });
  await b.client.waitFor('roomJoined');

  await b.client.disconnect();
  const disconnected = await a.client.waitFor('opponentDisconnected');
  assert.equal(disconnected.playerId, b.confirmed.playerId);
  assert.equal(disconnected.players.length, 2);
  const seat = disconnected.players.find(p => p.id === b.confirmed.playerId);
  assert.equal(seat.connected, false);
  assert.equal(disconnected.hostId, a.confirmed.playerId);

  a.client.emit('requestOnlinePlayers');
  const online = await a.client.waitFor('onlinePlayers');
  assert.equal(online.some(p => p.id === b.confirmed.playerId), false);

  const state = ctx.instance.getState();
  assert.equal(state.rooms[0].players.length, 2);
  assert.equal(state.rooms[0].players.find(p => p.id === b.confirmed.playerId).connected, false);
  assert.equal(state.sessions.find(s => s.playerId === b.confirmed.playerId).roomCode, created.code);

  const resumed = await resumeClient(ctx.url, b.confirmed.resumeToken);
  ctx.track(resumed.client);
  const rejoined = await a.client.waitFor('playerRejoined');
  assert.deepEqual(
    new Set(rejoined.players.filter(p => p.connected).map(p => p.id)),
    new Set([a.confirmed.playerId, b.confirmed.playerId])
  );
  assert.equal(rejoined.players.find(p => p.id === b.confirmed.playerId).connected, true);

  resumed.client.emit('requestOnlinePlayers');
  const onlineAgain = await resumed.client.waitFor('onlinePlayers');
  assert.equal(onlineAgain.length, 2);
});

test('multi-factory instances are isolated and close clears app timers', async (t) => {
  const ctxA = await createContext(t).start();
  const ctxB = await createContext(t).start();

  const a = await register(ctxA, 'Alice');
  const b = await register(ctxB, 'Alice');
  assert.notEqual(a.confirmed.playerId, b.confirmed.playerId);

  a.client.emit('createRoom');
  await a.client.waitFor('roomCreated');

  // Schedule a session-expiry timer, then close. close() must cancel it before
  // touching sockets.
  await a.client.disconnect();
  assert.ok(ctxA.clock.pendingCount() > 0);
  await ctxA.instance.close();
  assert.equal(ctxA.clock.pendingCount(), 0);
  assert.equal(ctxA.instance.getState().shuttingDown, true);

  // The other factory is unaffected.
  b.client.emit('requestOnlinePlayers');
  const online = await b.client.waitFor('onlinePlayers');
  assert.equal(online.length, 1);
  assert.equal(online[0].id, b.confirmed.playerId);
});
