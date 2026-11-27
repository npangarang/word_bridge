'use strict';

/**
 * Real two-client browser lifecycle tests for WordBridge.
 *
 * - Uses the real Express/Socket.IO server and the real client bundle.
 * - Uses the dependency-free CDP harness in tests/helpers/browser.js.
 * - Requires Node >= 22 and a local Chromium/Chrome (CHROME_PATH optional).
 *
 * Runtime dependencies are resolved through NODE_PATH when running offline:
 *   NODE_PATH=... node tests/e2e/multiplayer.test.js
 *
 * The server is started as a child on an ephemeral port (or through an
 * exported createGameServer factory when server.js exposes one safely).
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { Browser } = require('../helpers/browser');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER_PATH = path.join(ROOT, 'server.js');
const LOOKUP = JSON.parse(fs.readFileSync(path.join(ROOT, 'word_lookup.json'), 'utf8'));
const TEST_TIMEOUT = 20000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function assertRuntimeDependencies() {
  try {
    require.resolve('socket.io');
    require.resolve('express');
    require.resolve('compression');
  } catch (error) {
    throw new Error(
      'Server runtime dependencies are not resolvable. Run with the documented NODE_PATH, e.g. ' +
      "NODE_PATH='/path/to/node_modules:/another/node_modules' node tests/e2e/multiplayer.test.js. " +
      `Original error: ${error.message}`
    );
  }
}

/**
 * Load an exported createGameServer only when server.js is safe to require
 * (i.e. it guards its CLI listener with require.main === module). This avoids
 * starting a second listener as a require side effect.
 */
function loadServerFactory() {
  let source;
  try {
    source = fs.readFileSync(SERVER_PATH, 'utf8');
  } catch {
    return null;
  }
  if (!/module\.exports/.test(source)) return null;
  if (!/require\.main\s*===\s*module/.test(source)) return null;
  try {
    const mod = require(SERVER_PATH);
    if (typeof mod === 'function') return mod;
    if (mod && typeof mod.createGameServer === 'function') return mod.createGameServer;
  } catch {
    return null;
  }
  return null;
}

function waitForExit(child, timeout = 4000) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, timeout);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForHealth(origin, child, logs, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (child && child.exitCode !== null) {
      throw new Error(`Game server exited before becoming ready (${child.exitCode}).\n${logs.stderr.slice(-3000)}`);
    }
    try {
      const response = await fetch(origin + '/health');
      if (response.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for game server at ${origin}.\n${logs.stderr.slice(-3000)}`);
}

async function startWithFactory(factory) {
  // The game server factory accepts test-oriented rule overrides. Shorter
  // rounds/pauses keep this two-client suite fast while still exercising the
  // same production code paths.
  const result = await factory({
    port: 0,
    host: '127.0.0.1',
    roundTime: 15,
    comfortRoundTime: 15,
    pauseTime: 4,
    totalRounds: 3,
    logger: null
  });
  if (!result) throw new Error('createGameServer returned no result');

  let httpServer = null;
  let io = null;
  let explicitClose = null;
  let origin = result.origin || result.url || null;

  if (result.server && typeof result.server.listen === 'function') {
    httpServer = result.server;
  } else if (result.httpServer && typeof result.httpServer.listen === 'function') {
    httpServer = result.httpServer;
  } else if (typeof result.listen === 'function' && typeof result.once === 'function') {
    httpServer = result;
  }
  io = result.io || null;
  if (typeof result.close === 'function') explicitClose = () => result.close();

  if (httpServer && !httpServer.listening) {
    if (typeof result.listen === 'function' && result.server === httpServer) {
      await result.listen(0, '127.0.0.1');
    } else {
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
      });
    }
  }
  if (!origin && httpServer) {
    origin = `http://127.0.0.1:${httpServer.address().port}`;
  }
  if (!origin && typeof result.port === 'number' && result.port > 0) {
    origin = `http://127.0.0.1:${result.port}`;
  }
  if (!origin) throw new Error('Could not determine createGameServer origin');

  await waitForHealth(origin, null, { stderr: '' });

  return {
    origin,
    close: async () => {
      if (explicitClose) {
        await explicitClose();
        return;
      }
      if (io && typeof io.close === 'function') {
        await new Promise(resolve => {
          try {
            io.close(resolve);
          } catch {
            resolve();
          }
        });
      }
      if (httpServer) {
        await new Promise(resolve => {
          try {
            httpServer.close(resolve);
          } catch {
            resolve();
          }
        });
      }
    }
  };
}

async function startChildServer() {
  const port = await getFreePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = { stdout: '', stderr: '' };
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { logs.stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { logs.stderr += chunk.toString(); });

  await waitForHealth(origin, child, logs);

  return {
    origin,
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await waitForExit(child);
    }
  };
}

async function startGameServer() {
  assertRuntimeDependencies();
  const factory = loadServerFactory();
  if (factory) {
    try {
      return await startWithFactory(factory);
    } catch (error) {
      console.log(`factory server start failed, falling back to child process: ${error.message}`);
    }
  }
  return startChildServer();
}

// ── Browser/page helpers ─────────────────────────────

async function openClient(browser, origin, { url = '/', name = null, initScripts = [] } = {}) {
  const page = await browser.newPage({ width: 390, height: 844, origin, initScripts });
  page.defaultTimeout = TEST_TIMEOUT;
  await page.goto(origin + url);
  await page.waitForFunction(
    () => document.getElementById('wordDisplay') &&
      typeof socket !== 'undefined' &&
      typeof myPlayerId !== 'undefined',
    [],
    TEST_TIMEOUT
  );
  await page.waitForFunction(
    () => typeof wordLookupClient !== 'undefined' && Object.keys(wordLookupClient).length > 0,
    [],
    TEST_TIMEOUT
  );
  if (name !== null) await enterName(page, name);
  return page;
}

async function enterName(page, name) {
  await page.evaluate(value => {
    document.getElementById('playerNameInput').value = value;
    document.getElementById('enterLobbyBtn').click();
  }, name);
  await page.waitForFunction(() => typeof myPlayerId !== 'undefined' && !!myPlayerId, [], TEST_TIMEOUT);
  await page.waitForFunction(
    () => {
      try { return !!sessionStorage.getItem('wb_resume_token'); } catch { return false; }
    },
    [],
    TEST_TIMEOUT
  );
  // Invite links may move directly from the online lobby to the room lobby
  // while this check polls, so accept either settled lobby screen here.
  await page.waitForFunction(
    () => {
      const active = document.querySelector('.screen.active');
      return !!active && (active.id === 'lobbyScreen' || active.id === 'roomLobbyScreen');
    },
    [],
    TEST_TIMEOUT
  );
}

async function waitForScreen(page, screenId, timeout = TEST_TIMEOUT) {
  await page.waitForFunction(
    id => {
      const active = document.querySelector('.screen.active');
      return !!active && active.id === id;
    },
    [screenId],
    timeout
  );
}

async function waitForRound(page, round, timeout = TEST_TIMEOUT) {
  await page.waitForFunction(
    expected => typeof currentRound !== 'undefined' &&
      currentRound === expected &&
      !!roundDeadline &&
      document.getElementById('gameScreen').classList.contains('active'),
    [round],
    timeout
  );
}

async function waitForResult(page, round, timeout = TEST_TIMEOUT) {
  await page.waitForFunction(
    expected => document.querySelector('.screen.active')?.id === 'resultScreen' &&
      document.getElementById('resultRound').textContent === String(expected),
    [round],
    timeout
  );
}

async function waitForEnd(page, timeout = TEST_TIMEOUT) {
  await waitForScreen(page, 'endScreen', timeout);
  await page.waitForFunction(
    () => (document.getElementById('finalRankings').innerHTML || '').length > 0,
    [],
    timeout
  );
}

async function waitForLobby(page, timeout = TEST_TIMEOUT) {
  await waitForScreen(page, 'roomLobbyScreen', timeout);
}

async function readClient(page) {
  return page.evaluate(() => ({
    screen: document.querySelector('.screen.active')?.id || null,
    playerId: myPlayerId,
    name: myName,
    code: myRoomCode,
    hostId: roomHostId,
    isHost,
    players: (players || []).map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      ready: !!player.ready,
      connected: player.connected !== false,
      submitted: !!player.submitted
    })),
    round: currentRound,
    totalRounds,
    start: currentStartLetter,
    end: currentEndLetter,
    deadline: roundDeadline,
    roundDuration: currentRoundDuration,
    matchId: currentMatchId,
    submitted,
    word: currentWord,
    roundScores: { ...roundScores },
    playAgainVoted: typeof playAgainVoted !== 'undefined' ? playAgainVoted : null,
    finishedCanPlayAgain: finishedGameEnd ? finishedGameEnd.canPlayAgain : null,
    finishedVoterIds: typeof finishedVoterIds !== 'undefined' ? [...finishedVoterIds] : [],
    playAgain: (() => {
      const button = document.getElementById('playAgainBtn');
      return {
        display: button.style.display,
        disabled: button.disabled,
        text: button.textContent
      };
    })(),
    resultText: document.getElementById('resultCards').textContent,
    wordDisplay: document.getElementById('wordDisplayValue').textContent,
    keyboardDisabled: [...document.querySelectorAll('#gameKeyboard .word-key')].every(key => key.disabled)
  }));
}

function findWord(startLetter, endLetter) {
  const key = (startLetter + endLetter).toLowerCase();
  const candidates = LOOKUP[key] || [];
  const word = candidates.find(candidate => /^[a-z-]{3,20}$/.test(candidate));
  if (!word) throw new Error(`No keyboard-typeable word found for pair ${key.toUpperCase()}`);
  return word;
}

async function submitWord(page, word) {
  await page.waitForFunction(
    () => typeof isWordInputOpen === 'function' && isWordInputOpen(),
    [],
    TEST_TIMEOUT
  );
  for (const character of word) {
    await page.press(character);
  }
  await page.press('Enter');
  await page.waitForFunction(() => submitted === true, [], 5000);
}

async function reload(page) {
  // Preserve the current URL (including an invite ?room= parameter) so a
  // reload actually exercises invite/lifecycle idempotence instead of a plain
  // navigation to the root.
  const currentUrl = await page.evaluate(() => location.href);
  await page.goto(currentUrl);
  await page.waitForFunction(
    () => document.getElementById('wordDisplay') &&
      typeof socket !== 'undefined' &&
      typeof myPlayerId !== 'undefined',
    [],
    TEST_TIMEOUT
  );
}

async function createRoom(page) {
  await page.click('#createRoomBtn');
  await waitForLobby(page);
  const state = await readClient(page);
  assert.ok(state.code, 'room code should be set after roomCreated');
  return state.code;
}

async function joinRoom(page, code) {
  await page.evaluate(roomCode => {
    document.getElementById('joinRoomInput').value = roomCode;
    document.getElementById('joinRoomBtn').click();
  }, code);
  await waitForLobby(page);
}

async function markReady(page) {
  await page.click('#readyUpLobbyBtn');
  await page.waitForFunction(
    () => (players || []).some(player => player.id === myPlayerId && player.ready),
    [],
    TEST_TIMEOUT
  );
}

async function startGame(hostPage) {
  // Wait for every authoritative ready update to reach the host, not just the
  // guest's optimistic local ready state.
  await hostPage.waitForFunction(
    () => {
      const button = document.getElementById('startGameBtn');
      return !!button && button.style.display !== 'none' && !button.disabled;
    },
    [],
    TEST_TIMEOUT
  );
  await hostPage.click('#startGameBtn');
  try {
    await waitForRound(hostPage, 1);
  } catch (error) {
    const state = await readClient(hostPage);
    console.log('DEBUG startGame state:', JSON.stringify(state));
    console.log('DEBUG startGame pageErrors:', JSON.stringify(hostPage.pageErrors));
    throw error;
  }
}

function seedResumeTokenScript(token) {
  return `(() => {
    try { sessionStorage.setItem('wb_resume_token', ${JSON.stringify(token)}); } catch (e) {}
  })()`;
}

const BLOCK_SESSION_STORAGE_INIT = `(() => {
  const proto = Storage.prototype;
  const originalGet = proto.getItem;
  const originalSet = proto.setItem;
  const originalRemove = proto.removeItem;
  const guard = original => function (key) {
    if (this === window.sessionStorage) {
      throw new DOMException('sessionStorage disabled for test', 'SecurityError');
    }
    return original.call(this, key);
  };
  proto.getItem = guard(originalGet);
  proto.setItem = guard(originalSet);
  proto.removeItem = guard(originalRemove);
})()`;

// Test-only: engine.io closes its transport on browser "offline" for
// non-localhost origins. Drop the module-level offline forwarder so this test
// can model the suspected bug: the app sees offline/online while the transport
// itself never disconnects. The app's own listener is registered later.
const KEEP_ENGINE_OPEN_ON_OFFLINE_INIT = `(() => {
  const original = window.addEventListener.bind(window);
  let droppedEngineForwarder = false;
  window.addEventListener = function (type, listener, options) {
    if (type === 'offline' && !droppedEngineForwarder) {
      droppedEngineForwarder = true;
      return;
    }
    return original(type, listener, options);
  };
})()`;

function assertUniquePlayerIds(players, label) {
  const ids = players.map(player => player.id);
  assert.deepEqual(
    [...new Set(ids)].sort(),
    [...ids].sort(),
    `${label}: roster contains duplicate player ids: ${JSON.stringify(players)}`
  );
}

// ── Tests ────────────────────────────────────────────

async function run() {
  const server = await startGameServer();
  const browser = await Browser.launch();
  const results = [];

  async function test(name, fn) {
    try {
      await fn();
      results.push({ ok: true, name });
      console.log(`PASS  ${name}`);
    } catch (error) {
      results.push({ ok: false, name, error });
      console.log(`FAIL  ${name}\n      ${error.stack || error.message}`);
    }
  }

  try {
    await test('same-name pages stay distinct through lobby reloads (host, readiness intact)', async () => {
      const alice = await openClient(browser, server.origin, { name: 'SameName' });
      const bob = await openClient(browser, server.origin, { name: 'SameName' });
      try {
        const initialA = await readClient(alice);
        const initialB = await readClient(bob);
        assert.notEqual(initialA.playerId, initialB.playerId, 'two tabs must not share a server player id');
        assert.equal(initialA.name, 'SameName');
        assert.equal(initialB.name, 'SameName');

        const code = await createRoom(alice);
        await joinRoom(bob, code);
        await markReady(bob);

        let hostState = await readClient(alice);
        let guestState = await readClient(bob);
        assert.equal(hostState.players.length, 2, 'room should contain both same-named players');
        assert.equal(guestState.players.length, 2);
        assertUniquePlayerIds(hostState.players, 'same-name room');
        assert.equal(hostState.players.filter(player => player.name === 'SameName').length, 2,
          'display names must not be deduplicated by name');

        const hostId = hostState.hostId;
        const guestId = guestState.playerId;
        assert.equal(hostId, hostState.playerId);
        assert.equal(guestState.isHost, false);

        // Guest reload: token must resume the same player, readiness and host.
        const guestToken = await bob.evaluate(() => sessionStorage.getItem('wb_resume_token'));
        assert.ok(guestToken, 'guest should hold a resume token');
        await reload(bob);
        await waitForLobby(bob);
        await bob.waitForFunction(
          expected => typeof myPlayerId !== 'undefined' && myPlayerId === expected,
          [guestId],
          TEST_TIMEOUT
        );
        guestState = await readClient(bob);
        assert.equal(guestState.playerId, guestId, 'guest playerId must survive reload');
        assert.equal(guestState.code, code);
        assert.equal(guestState.hostId, hostId, 'host must stay host while guest reloads');
        assert.equal(guestState.isHost, false);
        assert.equal(guestState.players.length, 2, 'reload must not create a duplicate player');
        assertUniquePlayerIds(guestState.players, 'guest reload');
        assert.equal(
          guestState.players.find(player => player.id === guestId)?.ready,
          true,
          'guest readiness must survive reload'
        );
        assert.equal(
          await bob.evaluate(() => sessionStorage.getItem('wb_resume_token')),
          guestToken,
          'the same resume token should be retained'
        );

        // Host reload: host remains host, guest readiness stays authoritative.
        await reload(alice);
        await waitForLobby(alice);
        await alice.waitForFunction(
          expected => typeof myPlayerId !== 'undefined' && myPlayerId === expected,
          [hostId],
          TEST_TIMEOUT
        );
        hostState = await readClient(alice);
        guestState = await readClient(bob);
        assert.equal(hostState.playerId, hostId, 'host playerId must survive reload');
        assert.equal(hostState.hostId, hostId, 'host must remain host after reload');
        assert.equal(hostState.isHost, true);
        assert.equal(hostState.players.length, 2);
        assertUniquePlayerIds(hostState.players, 'host reload');
        assert.equal(guestState.players.length, 2, 'guest must not see a duplicate host');
        assert.equal(
          guestState.players.find(player => player.id === guestId)?.ready,
          true,
          'guest readiness must remain true in the room'
        );
      } finally {
        await alice.close();
        await bob.close();
      }
    });

    await test('invite URL auto-joins once after restore and does not duplicate on reload', async () => {
      const host = await openClient(browser, server.origin, { name: 'InviteHost' });
      let invitee = null;
      try {
        const code = await createRoom(host);
        invitee = await openClient(browser, server.origin, { url: `/?room=${encodeURIComponent(code)}` });
        await enterName(invitee, 'Invitee');
        await waitForLobby(invitee);
        await invitee.waitForFunction(
          expected => myRoomCode === expected,
          [code],
          TEST_TIMEOUT
        );

        let inviteState = await readClient(invitee);
        assert.equal(inviteState.code, code, 'invite should join the linked room');
        assert.equal(inviteState.players.length, 2);
        assert.equal(inviteState.players.filter(player => player.id === inviteState.playerId).length, 1);
        assert.equal(inviteState.players.filter(player => player.name === 'Invitee').length, 1);
        assert.equal(await invitee.evaluate(() => autoJoinRoomCode), null,
          'auto-join request should be consumed exactly once');

        const inviteId = inviteState.playerId;
        await reload(invitee);
        await waitForLobby(invitee);
        inviteState = await readClient(invitee);
        assert.equal(inviteState.playerId, inviteId, 'invitee id must survive reload');
        assert.equal(inviteState.code, code);
        assert.equal(inviteState.players.length, 2, 'reload must not auto-join twice');
        assert.equal(inviteState.players.filter(player => player.name === 'Invitee').length, 1);
        assertUniquePlayerIds(inviteState.players, 'invite reload');
      } finally {
        if (invitee) await invitee.close();
        await host.close();
      }
    });

    await test('stale resume token clears once, explains expiry, and registers fresh only on explicit name', async () => {
      const staleToken = 'e2e-stale-token-not-in-the-server';
      const page = await openClient(browser, server.origin, {
        initScripts: [seedResumeTokenScript(staleToken)]
      });
      try {
        await waitForScreen(page, 'nameScreen');
        await page.waitForFunction(
          () => {
            try { return sessionStorage.getItem('wb_resume_token') === null; } catch { return false; }
          },
          [],
          TEST_TIMEOUT
        );
        await page.waitForFunction(
          () => document.getElementById('nameError').textContent.length > 0,
          [],
          TEST_TIMEOUT
        );
        const expired = await readClient(page);
        assert.equal(expired.playerId, null, 'a stale token must not create a player automatically');
        assert.match(
          await page.evaluate(() => document.getElementById('nameError').textContent),
          /session expired|expired/i,
          'the user should be told the session expired'
        );

        await enterName(page, 'RecoveredUser');
        const fresh = await readClient(page);
        assert.ok(fresh.playerId, 'explicit name entry should register a fresh session');
        assert.equal(fresh.screen, 'lobbyScreen');
        const freshToken = await page.evaluate(() => sessionStorage.getItem('wb_resume_token'));
        assert.ok(freshToken);
        assert.notEqual(freshToken, staleToken);

        const freshId = fresh.playerId;
        // The initial page was opened with a persistent init script that seeds
        // the stale token on every navigation. Add a later override so the
        // reload exercises the fresh token instead of the deliberately stale one.
        await page.addInitScript(seedResumeTokenScript(freshToken));
        await reload(page);
        await waitForScreen(page, 'lobbyScreen');
        assert.equal((await readClient(page)).playerId, freshId, 'the fresh session should resume normally');
      } finally {
        await page.close();
      }
    });

    await test('duplicate live tab is rejected without kicking the incumbent or auto-registering', async () => {
      const incumbent = await openClient(browser, server.origin, { name: 'TokenOwner' });
      let duplicate = null;
      try {
        const code = await createRoom(incumbent);
        const incumbentState = await readClient(incumbent);
        const token = await incumbent.evaluate(() => sessionStorage.getItem('wb_resume_token'));
        assert.ok(token);

        duplicate = await openClient(browser, server.origin, {
          initScripts: [seedResumeTokenScript(token)]
        });
        await waitForScreen(duplicate, 'nameScreen');
        await duplicate.waitForFunction(
          () => document.getElementById('nameError').textContent.length > 0,
          [],
          TEST_TIMEOUT
        );
        const rejected = await readClient(duplicate);
        assert.equal(rejected.playerId, null, 'RESUME_IN_USE must not auto-register a duplicate');
        assert.match(
          await duplicate.evaluate(() => document.getElementById('nameError').textContent),
          /another tab/i,
          'the duplicate tab needs an explicit explanation'
        );
        const conflictButton = await duplicate.evaluate(() => {
          const button = document.getElementById('enterLobbyBtn');
          return { text: button.textContent, aria: button.getAttribute('aria-label') };
        });
        assert.equal(conflictButton.text, 'PLAY AS NEW PLAYER', 'conflict CTA must be explicit');
        assert.equal(conflictButton.aria, 'PLAY AS NEW PLAYER', 'accessible conflict CTA copy must match');
        assert.equal(
          await duplicate.evaluate(() => sessionStorage.getItem('wb_resume_token')),
          token,
          'RESUME_IN_USE must retain the token for bounded retries'
        );

        const stillIncumbent = await readClient(incumbent);
        assert.equal(stillIncumbent.playerId, incumbentState.playerId, 'incumbent identity must survive');
        assert.equal(stillIncumbent.code, code, 'incumbent room must not be disturbed');
        assert.equal(stillIncumbent.hostId, incumbentState.playerId, 'incumbent must stay host');
        assert.equal(stillIncumbent.players.length, 1, 'a rejected duplicate must not enter the room');
        assert.equal(
          await incumbent.evaluate(() => socket.connected),
          true,
          'incumbent transport must not be kicked'
        );

        // Entering a name in the warned tab is the explicit "play as a new
        // player" choice: the old token is dropped and a new session is made.
        await enterName(duplicate, 'SecondTab');
        const second = await readClient(duplicate);
        assert.ok(second.playerId);
        assert.notEqual(second.playerId, incumbentState.playerId, 'new tab must get a new player id');
        assert.equal(second.code, null, 'new tab must not be placed into the incumbent room');
        const secondToken = await duplicate.evaluate(() => sessionStorage.getItem('wb_resume_token'));
        assert.ok(secondToken);
        assert.notEqual(secondToken, token);
        const restoredButton = await duplicate.evaluate(() => {
          const button = document.getElementById('enterLobbyBtn');
          return { text: button.textContent, aria: button.getAttribute('aria-label') };
        });
        assert.equal(restoredButton.text, 'ENTER LOBBY', 'CTA label must be restored after conflict resolution');
        assert.equal(restoredButton.aria, 'ENTER LOBBY');

        await incumbent.waitForTimeout(600);
        const after = await readClient(incumbent);
        assert.equal(after.playerId, incumbentState.playerId, 'incumbent must remain untouched');
        assert.equal(after.code, code);
        assert.equal(after.players.length, 1, 'incumbent room roster must stay untouched');
        assert.equal(await incumbent.evaluate(() => socket.connected), true);
        assert.deepEqual(incumbent.pageErrors, []);
        assert.deepEqual(duplicate.pageErrors, []);
      } finally {
        if (duplicate) await duplicate.close();
        await incumbent.close();
      }
    });

    await test('RESUME_IN_USE retries resume the same identity after the owning tab closes', async () => {
      const incumbent = await openClient(browser, server.origin, { name: 'RetryOwner' });
      const incumbentState = await readClient(incumbent);
      const code = await createRoom(incumbent);
      const token = await incumbent.evaluate(() => sessionStorage.getItem('wb_resume_token'));
      let retrying = null;
      try {
        retrying = await openClient(browser, server.origin, {
          initScripts: [seedResumeTokenScript(token)]
        });
        await waitForScreen(retrying, 'nameScreen');
        await retrying.waitForFunction(
          () => document.getElementById('nameError').textContent.length > 0,
          [],
          TEST_TIMEOUT
        );
        assert.equal((await readClient(retrying)).playerId, null);

        // Free the token by closing the owning tab; the bounded retry loop
        // must then resume the same stable player and room seat.
        await incumbent.close();
        await retrying.waitForFunction(
          id => typeof myPlayerId !== 'undefined' && myPlayerId === id,
          [incumbentState.playerId],
          15000
        );
        await waitForLobby(retrying);
        const resumed = await readClient(retrying);
        assert.equal(resumed.playerId, incumbentState.playerId, 'retry must resume the incumbent id');
        assert.equal(resumed.code, code, 'retry must resume the reserved room seat');
        assert.equal(resumed.players.length, 1, 'retry must not duplicate the room seat');
        assert.equal(resumed.hostId, incumbentState.playerId, 'retry must restore host ownership');
        const resumedButton = await retrying.evaluate(() => {
          const button = document.getElementById('enterLobbyBtn');
          return { text: button.textContent, aria: button.getAttribute('aria-label') };
        });
        assert.equal(resumedButton.text, 'ENTER LOBBY', 'automatic retry success must restore the CTA');
        assert.equal(resumedButton.aria, 'ENTER LOBBY');
        assert.equal(
          await retrying.evaluate(() => sessionStorage.getItem('wb_resume_token')),
          token,
          'retry must not mint or replace the token'
        );
        assert.deepEqual(retrying.pageErrors, []);
      } finally {
        if (retrying) await retrying.close();
        await incumbent.close().catch(() => {});
      }
    });

    await test('offline/online while the transport stays connected does not permanently disable commands', async () => {
      const host = await openClient(browser, server.origin, { name: 'OfflineHost' });
      const guest = await openClient(browser, server.origin, {
        name: 'OfflineGuest',
        initScripts: [KEEP_ENGINE_OPEN_ON_OFFLINE_INIT]
      });
      try {
        const code = await createRoom(host);
        await joinRoom(guest, code);
        const guestId = (await readClient(guest)).playerId;

        await guest.evaluate(() => {
          window.dispatchEvent(new Event('offline'));
          window.dispatchEvent(new Event('online'));
        });
        await guest.waitForTimeout(100);

        assert.equal(await guest.evaluate(() => socket.connected), true,
          'browser offline/online events must not force a transport disconnect');
        assert.equal((await readClient(guest)).playerId, guestId);
        assert.equal(await guest.evaluate(() => authoritativeReady), true,
          'a still-live socket must not stay stuck without an authoritative restore');

        await guest.click('#readyUpLobbyBtn');
        await host.waitForFunction(
          id => (players || []).some(player => player.id === id && player.ready),
          [guestId],
          5000
        );
      } finally {
        await host.close();
        await guest.close();
      }
    });

    await test('same-page reconnect resumes identity when sessionStorage is blocked', async () => {
      const page = await openClient(browser, server.origin, {
        initScripts: [BLOCK_SESSION_STORAGE_INIT]
      });
      try {
        await page.evaluate(() => {
          document.getElementById('playerNameInput').value = 'MemoryTokenUser';
          document.getElementById('enterLobbyBtn').click();
        });
        await page.waitForFunction(
          () => typeof myPlayerId !== 'undefined' && !!myPlayerId &&
            document.querySelector('.screen.active')?.id === 'lobbyScreen',
          [],
          TEST_TIMEOUT
        );
        const idBefore = (await readClient(page)).playerId;

        await page.evaluate(() => { socket.disconnect(); });
        await page.waitForFunction(() => !socket.connected, [], 5000);
        await page.evaluate(() => { socket.connect(); });
        await page.waitForFunction(
          () => socket.connected && authoritativeReady,
          [],
          TEST_TIMEOUT
        );

        await page.click('#createRoomBtn');
        await waitForLobby(page, 5000);
        const state = await readClient(page);
        assert.equal(state.playerId, idBefore, 'same-page reconnect must keep the stable player id');
        assert.ok(state.code, 'the resumed session must still be able to create a room');
      } finally {
        await page.close();
      }
    });

    await test('a stored comfort=false preference re-syncs after reconnect', async () => {
      const page = await openClient(browser, server.origin, { name: 'ComfortSync' });
      try {
        await createRoom(page);
        await page.evaluate(() => setComfortMode(true));
        await page.waitForFunction(
          () => (players || []).some(player => player.id === myPlayerId && player.comfortMode),
          [],
          5000
        );

        await page.evaluate(() => { socket.disconnect(); });
        await page.waitForFunction(() => !socket.connected, [], 5000);
        await page.evaluate(() => setComfortMode(false));
        assert.equal(await page.evaluate(() => comfortPrefs.enabled), false);
        await page.evaluate(() => { socket.connect(); });
        await page.waitForFunction(
          () => socket.connected && authoritativeReady,
          [],
          TEST_TIMEOUT
        );
        await page.waitForFunction(
          () => {
            const me = (players || []).find(player => player.id === myPlayerId);
            return !!me && me.comfortMode === false;
          },
          [],
          5000
        );
      } finally {
        await page.close();
      }
    });

    await test('final-pause guest reconnect restores rematch availability and preserves votes', async () => {
      const host = await openClient(browser, server.origin, { name: 'FinalPauseHost' });
      const guest = await openClient(browser, server.origin, { name: 'FinalPauseGuest' });
      try {
        const code = await createRoom(host);
        await joinRoom(guest, code);
        await Promise.all([markReady(host), markReady(guest)]);
        await Promise.all([startGame(host), waitForRound(guest, 1)]);

        const guestId = (await readClient(guest)).playerId;
        const hostId = (await readClient(host)).playerId;
        const totalRounds = (await readClient(host)).totalRounds;
        for (let round = 1; round <= totalRounds; round += 1) {
          await Promise.all([waitForRound(host, round), waitForRound(guest, round)]);
          const state = await readClient(host);
          const word = findWord(state.start, state.end);
          await Promise.all([submitWord(host, word), submitWord(guest, word)]);
          await Promise.all([waitForResult(host, round), waitForResult(guest, round)]);
          if (round < totalRounds) {
            await Promise.all([waitForRound(host, round + 1), waitForRound(guest, round + 1)]);
          }
        }

        // Final pause: the guest is disconnected when the server ends the
        // match, so the continuously connected host is told canPlayAgain=false.
        await guest.evaluate(() => { socket.disconnect(); });
        await waitForEnd(host, 15000);
        let hostButton = (await readClient(host)).playAgain;
        assert.equal(hostButton.display, 'none', 'rematch must stay hidden while the guest is absent');
        assert.equal(hostButton.disabled, true);
        assert.equal((await readClient(host)).finishedCanPlayAgain, false,
          'host must receive the disconnected canPlayAgain=false finish');

        // Guest resumes within the finished grace window and receives a
        // recomputed canPlayAgain=true snapshot. The host must reconcile its
        // finished members without reloading or re-running gameEnd rendering.
        await guest.evaluate(() => { socket.connect(); });
        await waitForEnd(guest, 15000);
        await host.waitForFunction(
          id => {
            const player = (players || []).find(item => item.id === id);
            const button = document.getElementById('playAgainBtn');
            return !!player && player.connected !== false &&
              !!button && button.style.display !== 'none';
          },
          [guestId],
          10000
        );

        hostButton = (await readClient(host)).playAgain;
        assert.equal(hostButton.display, 'inline-block');
        assert.equal(hostButton.disabled, false, 'host rematch must become usable without refresh');
        assert.match(hostButton.text, /PLAY AGAIN/);
        assert.equal((await readClient(guest)).playAgain.disabled, false, 'resumed guest can vote too');

        // Host votes, then the guest drops/rejoins again: the host's own vote
        // must survive the finished-state availability reconciliation.
        await host.click('#playAgainBtn');
        await host.waitForFunction(() => playAgainVoted === true, [], 5000);
        assert.deepEqual((await readClient(host)).finishedVoterIds, [hostId],
          'host vote must be recorded authoritatively');
        await guest.evaluate(() => { socket.disconnect(); });
        await host.waitForFunction(
          () => document.getElementById('playAgainBtn').style.display === 'none',
          [],
          10000
        );
        await guest.evaluate(() => { socket.connect(); });
        await waitForEnd(guest, 15000);
        await host.waitForFunction(
          () => {
            const button = document.getElementById('playAgainBtn');
            return button.style.display !== 'none' && button.disabled &&
              /READY/i.test(button.textContent);
          },
          [],
          10000
        );
        const guestAfterRejoin = await readClient(guest);
        assert.equal(guestAfterRejoin.playAgainVoted, false, 'guest own vote must not be fabricated');
        assert.equal(guestAfterRejoin.playAgain.disabled, false);
        assert.deepEqual(guestAfterRejoin.finishedVoterIds, [hostId],
          'resumed guest snapshot must retain the host vote');
        assert.deepEqual((await readClient(host)).finishedVoterIds, [hostId],
          'host membership reconciliation must preserve its vote id');

        await guest.click('#playAgainBtn');
        await Promise.all([waitForLobby(host), waitForLobby(guest)]);
        assert.equal((await readClient(host)).round, 0, 'unanimous votes reset exactly once to the lobby');
      } finally {
        await host.close();
        await guest.close();
      }
    });

    await test('challenge UI starts a real game, accepts input, and resumes after reconnect', async () => {
      const alice = await openClient(browser, server.origin, { name: 'ChallengeAlice' });
      const bob = await openClient(browser, server.origin, { name: 'ChallengeBob' });
      try {
        const bobId = (await readClient(bob)).playerId;
        await alice.waitForFunction(
          id => !!document.querySelector(`#onlinePlayers .challenge-btn[data-player-id="${id}"]`),
          [bobId],
          TEST_TIMEOUT
        );
        await alice.evaluate(id => {
          document.querySelector(`#onlinePlayers .challenge-btn[data-player-id="${id}"]`).click();
        }, bobId);
        await alice.waitForFunction(
          () => document.getElementById('challengeModal').classList.contains('active'),
          [],
          TEST_TIMEOUT
        );

        // Exercise the category input explicitly with all modes enabled.
        await alice.evaluate(() => {
          document.querySelectorAll('#challengeModalCats .category-toggle-sm').forEach(button => {
            if (button.getAttribute('aria-pressed') !== 'true') button.click();
          });
          const pressed = [...document.querySelectorAll('#challengeModalCats .category-toggle-sm')]
            .map(button => button.getAttribute('aria-pressed'));
          if (pressed.length !== 4 || pressed.some(value => value !== 'true')) {
            throw new Error('expected explicit all-modes challenge categories');
          }
        });
        await alice.click('#sendChallengeBtn');

        await bob.waitForFunction(
          () => document.getElementById('challengeModal').classList.contains('active'),
          [],
          TEST_TIMEOUT
        );
        await bob.click('#acceptChallengeBtn');
        await Promise.all([waitForRound(alice, 1), waitForRound(bob, 1)]);

        const aliceGame = await readClient(alice);
        const bobGame = await readClient(bob);
        assert.ok(aliceGame.matchId, 'challenge match must expose a match id');
        assert.equal(aliceGame.players.length, 2);
        assert.equal(bobGame.players.length, 2);
        assert.equal(aliceGame.code, bobGame.code);
        assert.equal(await alice.evaluate(() => isWordInputOpen()), true);

        const round1 = await readClient(alice);
        const word1 = findWord(round1.start, round1.end);
        await Promise.all([submitWord(alice, word1), submitWord(bob, word1)]);
        await Promise.all([waitForResult(alice, 1), waitForResult(bob, 1)]);

        await Promise.all([waitForRound(alice, 2), waitForRound(bob, 2)]);
        const beforeReconnect = await readClient(bob);
        await reload(bob);
        await waitForRound(bob, 2);
        const restored = await readClient(bob);
        assert.equal(restored.playerId, bobId, 'challenge reconnect must keep the stable player id');
        assert.equal(restored.code, aliceGame.code);
        assert.equal(restored.start, beforeReconnect.start);
        assert.equal(restored.end, beforeReconnect.end);
        assert.equal(restored.deadline, beforeReconnect.deadline);
        assert.equal(restored.players.length, 2);
        assert.equal(await bob.evaluate(() => isWordInputOpen()), true,
          'challenge input must be usable after reconnect');
        const word2 = findWord(restored.start, restored.end);
        await submitWord(bob, word2);
        assert.equal((await readClient(bob)).submitted, true,
          'challenge input must submit after reconnect');
      } finally {
        await alice.close();
        await bob.close();
      }
    });

    await test('full game: paused/active restore, transient transport recovery, votes and forfeit', async () => {
      const host = await openClient(browser, server.origin, { name: 'HostLifecycle' });
      const guest = await openClient(browser, server.origin, { name: 'GuestLifecycle' });
      try {
        const code = await createRoom(host);
        await joinRoom(guest, code);
        await markReady(host);
        await markReady(guest);
        await Promise.all([startGame(host), waitForRound(guest, 1)]);

        const hostId = (await readClient(host)).playerId;
        const guestId = (await readClient(guest)).playerId;

        // Round 1: both submit, then restore the guest while the round is paused.
        const round1 = await readClient(guest);
        const totalRounds = round1.totalRounds;
        const word1 = findWord(round1.start, round1.end);
        await Promise.all([submitWord(host, word1), submitWord(guest, word1)]);
        await Promise.all([waitForResult(host, 1), waitForResult(guest, 1)]);
        const afterRound1 = await readClient(guest);
        const scoreAfterRound1 = afterRound1.players.find(player => player.id === guestId)?.score || 0;
        assert.ok(scoreAfterRound1 > 0, 'guest should have a positive score after round 1');

        await reload(guest);
        await waitForResult(guest, 1);
        const pausedRestore = await readClient(guest);
        assert.equal(pausedRestore.playerId, guestId);
        assert.equal(pausedRestore.round, 1);
        assert.ok(pausedRestore.resultText.includes(word1), 'paused snapshot must restore round results');
        assert.equal(
          pausedRestore.players.find(player => player.id === guestId)?.score,
          scoreAfterRound1,
          'paused snapshot must restore the running score'
        );
        assert.ok(pausedRestore.roundScores.me >= scoreAfterRound1);
        assert.equal(pausedRestore.code, code);

        // Round 2: guest submits and refreshes mid-round; host finishes the round afterwards.
        await Promise.all([waitForRound(host, 2), waitForRound(guest, 2)]);
        const round2 = await readClient(guest);
        const word2 = findWord(round2.start, round2.end);
        await submitWord(guest, word2);
        const beforeActiveReload = await readClient(guest);
        await reload(guest);
        await waitForRound(guest, 2);
        const activeRestore = await readClient(guest);
        assert.equal(activeRestore.playerId, guestId, 'active refresh must preserve player id');
        assert.equal(activeRestore.round, 2);
        assert.equal(activeRestore.start, beforeActiveReload.start, 'pair start letter must be restored');
        assert.equal(activeRestore.end, beforeActiveReload.end, 'pair end letter must be restored');
        assert.equal(activeRestore.deadline, beforeActiveReload.deadline, 'absolute deadline must be restored');
        assert.equal(
          activeRestore.roundDuration,
          beforeActiveReload.roundDuration,
          'original round duration must not shrink on restore'
        );
        assert.ok(
          activeRestore.deadline - Date.now() <= activeRestore.roundDuration,
          'restored deadline must fit inside the original round duration'
        );
        assert.equal(activeRestore.matchId, beforeActiveReload.matchId, 'matchId must be restored');
        assert.equal(activeRestore.submitted, true, 'own submission must be restored');
        assert.equal(activeRestore.word, word2.toUpperCase(), 'submitted word must be restored');
        assert.equal(activeRestore.keyboardDisabled, true, 'restored submission must keep input locked');
        assert.equal(
          activeRestore.players.find(player => player.id === guestId)?.score,
          scoreAfterRound1,
          'active restore must preserve the score from the previous round'
        );
        assertUniquePlayerIds(activeRestore.players, 'active restore');
        assert.equal(activeRestore.players.length, 2, 'active refresh must not duplicate the player');

        await submitWord(host, word2);
        await Promise.all([waitForResult(host, 2), waitForResult(guest, 2)]);

        // Round 3: drop the transport and let Socket.IO reconnect with the same identity.
        await Promise.all([waitForRound(host, 3), waitForRound(guest, 3)]);
        const beforeDrop = await readClient(guest);
        // Type a partial answer before the transport drops; a transient
        // reconnect must not wipe it (only a changed round/match may reset).
        const partialLetter = findWord(beforeDrop.start, beforeDrop.end)[0];
        await guest.press(partialLetter);
        assert.equal((await readClient(guest)).word, partialLetter.toUpperCase());
        await guest.evaluate(() => { socket.io.engine.close(); });
        await guest.waitForFunction(
          expected => typeof socket !== 'undefined' &&
            socket.connected &&
            myPlayerId === expected &&
            document.querySelector('.screen.active')?.id === 'gameScreen' &&
            (players || []).length === 2,
          [beforeDrop.playerId],
          25000
        );
        const afterDrop = await readClient(guest);
        assert.equal(afterDrop.playerId, guestId, 'transient reconnect must keep the player id');
        assert.equal(afterDrop.round, 3);
        assert.equal(afterDrop.start, beforeDrop.start);
        assert.equal(afterDrop.end, beforeDrop.end);
        assert.equal(afterDrop.deadline, beforeDrop.deadline);
        assert.equal(afterDrop.word, partialLetter.toUpperCase(),
          'partial answer must survive the same-round reconnect');
        assert.equal(await guest.evaluate(() => isWordInputOpen()), true);
        assert.equal(afterDrop.submitted, false, 'unsent round should still accept input after reconnect');
        assert.equal(afterDrop.players.length, 2, 'transient reconnect must not duplicate the player');
        assertUniquePlayerIds(afterDrop.players, 'transient reconnect');

        // Clear the preserved partial answer before the normal submit loop.
        await guest.press('Backspace');
        assert.equal((await readClient(guest)).word, '');

        // Finish every remaining round quickly; each round ends as soon as both submit.
        for (let round = 3; round <= totalRounds; round += 1) {
          if (round > 3) {
            await Promise.all([waitForRound(host, round), waitForRound(guest, round)]);
          }
          const state = await readClient(guest);
          const word = findWord(state.start, state.end);
          await Promise.all([submitWord(host, word), submitWord(guest, word)]);
          await Promise.all([waitForResult(host, round), waitForResult(guest, round)]);
        }

        await Promise.all([waitForEnd(host), waitForEnd(guest)]);

        // Guest votes for a rematch, then refreshes. The vote and canPlayAgain
        // state must be restored from the finished snapshot.
        await guest.click('#playAgainBtn');
        await guest.waitForFunction(() => playAgainVoted === true, [], TEST_TIMEOUT);
        await reload(guest);
        await waitForEnd(guest);
        const finishedRestore = await readClient(guest);
        assert.equal(finishedRestore.screen, 'endScreen');
        assert.equal(finishedRestore.playAgainVoted, true, 'restored play-again vote should be visible');
        assert.notEqual(finishedRestore.playAgain.display, 'none', 'canPlayAgain should keep the button available');
        assert.equal(finishedRestore.playAgain.disabled, true);
        assert.match(finishedRestore.playAgain.text, /READY/i);

        // Host also votes: the server resets to the room lobby.
        await host.click('#playAgainBtn');
        await Promise.all([waitForLobby(host), waitForLobby(guest)]);

        // Start a second game, then the host leaves mid-round: guest wins by
        // forfeit and the dead rematch button must be hidden/disabled.
        await Promise.all([markReady(host), markReady(guest)]);
        await Promise.all([startGame(host), waitForRound(guest, 1)]);
        await host.evaluate(() => { socket.emit('leaveRoom'); });
        await waitForEnd(guest);
        const forfeit = await readClient(guest);
        assert.equal(forfeit.playAgain.display, 'none', 'dead rematch button should be hidden');
        assert.equal(forfeit.playAgain.disabled, true);

        // Finished snapshot must still route to the end screen with the dead button.
        await reload(guest);
        await waitForEnd(guest);
        const forfeitRestore = await readClient(guest);
        assert.equal(forfeitRestore.screen, 'endScreen', 'forfeit finished state must restore');
        assert.equal(forfeitRestore.playAgain.display, 'none', 'restored dead rematch button should stay hidden');
        assert.equal(forfeitRestore.playAgain.disabled, true);
        assertUniquePlayerIds(forfeitRestore.players, 'forfeit restore');

        assert.deepEqual(host.pageErrors, []);
        assert.deepEqual(guest.pageErrors, []);
      } finally {
        await host.close();
        await guest.close();
      }
    });
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('Failures:');
    for (const failure of failed) console.log(`- ${failure.name}: ${failure.error.message}`);
    process.exitCode = 1;
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
