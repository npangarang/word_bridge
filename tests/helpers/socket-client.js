'use strict';

/**
 * Minimal Socket.IO test client + deterministic application clock.
 *
 * Uses the real UMD Socket.IO client shipped with the server dependency
 * (`socket.io/client-dist/socket.io.js`) over Node >= 22's native WebSocket.
 * No undeclared socket.io-client package is required. Run the server tests
 * with the server runtime dependencies on NODE_PATH, e.g.:
 *
 *   NODE_PATH='/path/to/node_modules' node --test tests/server*.test.js
 *
 * Socket.IO's own network timers stay real; only WordBridge's injected
 * application timers use ManualClock.
 */

const path = require('node:path');
const { io } = require(path.join(
  path.dirname(require.resolve('socket.io/package.json')),
  'client-dist/socket.io.js'
));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitUntil(predicate, { timeout = 3000, interval = 10, message = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`);
    await delay(interval);
  }
}

class TestClient {
  constructor(socket) {
    this.socket = socket;
    this.connected = false;
    this.lastConnectError = null;
    this._events = [];
    this._consumed = new Set();
    this._waiters = new Map();

    socket.on('connect', () => {
      this.connected = true;
      this._push('connect', undefined);
    });
    socket.on('disconnect', reason => {
      this.connected = false;
      this._push('disconnect', reason);
    });
    socket.on('connect_error', error => {
      this.lastConnectError = error;
      this._push('connect_error', {
        message: error.message,
        code: error.data && error.data.code,
        data: error.data
      });
    });
    socket.onAny((event, data) => {
      this._push(event, data);
    });
  }

  static async connect(url, { auth, timeout = 4000, transports = ['websocket'] } = {}) {
    const socket = io(url, {
      auth,
      transports,
      reconnection: false,
      forceNew: true,
      timeout
    });
    const client = new TestClient(socket);

    if (socket.connected) {
      client.connected = true;
      return client;
    }

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error(`Timed out connecting to ${url}; events=${JSON.stringify(client._events.slice(-6))}`));
      }, timeout);
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = error => {
        cleanup();
        socket.close();
        const code = error.data && error.data.code;
        reject(new Error(`connect_error${code ? ` ${code}` : ''}: ${error.message}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        socket.off('connect_error', onError);
      };
      socket.on('connect', onConnect);
      socket.on('connect_error', onError);
    });
    return client;
  }

  static async connectExpectError(url, { auth, timeout = 4000 } = {}) {
    const socket = io(url, {
      auth,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      timeout
    });
    const client = new TestClient(socket);
    const payload = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out waiting for connect_error'));
      }, timeout);
      client._waiters.set('connect_error', [{
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject,
        predicate: () => true
      }]);
    });
    socket.close();
    return payload;
  }

  _push(event, data) {
    const index = this._events.push({ event, data }) - 1;
    const waiters = this._waiters.get(event);
    if (!waiters || waiters.length === 0) return;

    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i];
      if (waiter.predicate && !waiter.predicate(data)) continue;
      waiters.splice(i, 1);
      this._consumed.add(index);
      waiter.resolve(data);
      return;
    }
  }

  waitFor(event, predicate, timeout = 3000) {
    if (typeof predicate === 'number') {
      timeout = predicate;
      predicate = undefined;
    }

    for (let i = 0; i < this._events.length; i += 1) {
      if (this._consumed.has(i)) continue;
      const entry = this._events[i];
      if (entry.event !== event) continue;
      if (predicate && !predicate(entry.data)) continue;
      this._consumed.add(i);
      return Promise.resolve(entry.data);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiters = this._waiters.get(event) || [];
        this._waiters.set(event, waiters.filter(w => w !== waiter));
        reject(new Error(
          `Timed out waiting for ${event}; recent=${JSON.stringify(this._events.slice(-10))}`
        ));
      }, timeout);
      const waiter = {
        predicate,
        resolve: data => {
          clearTimeout(timer);
          resolve(data);
        },
        reject
      };
      if (!this._waiters.has(event)) this._waiters.set(event, []);
      this._waiters.get(event).push(waiter);
    });
  }

  hasEvent(event, predicate) {
    return this._events.some((entry, index) => {
      if (this._consumed.has(index) || entry.event !== event) return false;
      return !predicate || predicate(entry.data);
    });
  }

  emit(event, data) {
    this.socket.emit(event, data);
  }

  async disconnect() {
    this.socket.disconnect();
    await delay(30);
  }

  close() {
    this.socket.close();
  }
}

class ManualClock {
  constructor(start = 1_700_000_000_000) {
    this.current = start;
    this.nextTimerId = 1;
    this.timers = new Map();

    this.now = () => this.current;
    this.setTimeout = (fn, delayMs = 0) => {
      const id = this.nextTimerId;
      this.nextTimerId += 1;
      this.timers.set(id, {
        id,
        due: this.current + Math.max(0, delayMs),
        fn
      });
      return id;
    };
    this.clearTimeout = id => {
      this.timers.delete(id);
    };
  }

  tick(ms) {
    const target = this.current + ms;
    for (;;) {
      let next = null;
      for (const timer of this.timers.values()) {
        if (timer.due > target) continue;
        if (!next || timer.due < next.due || (timer.due === next.due && timer.id < next.id)) {
          next = timer;
        }
      }
      if (!next) break;
      this.timers.delete(next.id);
      // Simulate a delayed callback: overdue timers observe the current wall
      // clock, never a clock that moves backwards to their original due time.
      this.current = Math.max(this.current, next.due);
      next.fn();
    }
    this.current = target;
  }

  pendingCount() {
    return this.timers.size;
  }
}

async function register(client, name) {
  client.emit('setName', name);
  const confirmed = await client.waitFor('nameConfirmed', data => data.name === name);
  const snapshot = await client.waitFor('roomStateRestored', data => data.serverNow !== undefined);
  return { confirmed, snapshot };
}

async function connectRegistered(url, name, options = {}) {
  const client = await TestClient.connect(url, options);
  const { confirmed, snapshot } = await register(client, name);
  return { client, confirmed, snapshot };
}

async function resumeClient(url, token, options = {}) {
  const client = await TestClient.connect(url, { ...options, auth: { resumeToken: token } });
  const confirmed = await client.waitFor('nameConfirmed', data => data.resumed === true);
  const snapshot = await client.waitFor('roomStateRestored', data => data.serverNow !== undefined);
  return { client, confirmed, snapshot };
}

module.exports = {
  TestClient,
  ManualClock,
  delay,
  waitUntil,
  register,
  connectRegistered,
  resumeClient
};
