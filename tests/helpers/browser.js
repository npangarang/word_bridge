'use strict';

/**
 * Dependency-free local browser harness for WordBridge UI regressions.
 *
 * - Node >= 22 (uses the built-in WHATWG WebSocket)
 * - Uses a locally installed Chromium/Chrome via CHROME_PATH or common paths
 * - No npm install, no external network: every non-localhost page request is
 *   intercepted and failed with BlockedByClient.
 * - The app is served with a fake socket.io client so UI state can be driven
 *   deterministically without a running game server.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const FAKE_SOCKET_SOURCE = `
(function () {
  window.__socketHandlers = {};
  window.__socketEmits = [];
  window.__socketConnectCalls = 0;
  window.io = function () {
    const socket = {
      connected: true,
      recovered: false,
      on(event, cb) {
        (window.__socketHandlers[event] ||= []).push(cb);
        return socket;
      },
      emit(event, data) {
        window.__socketEmits.push({ event, data });
        return socket;
      },
      connect() {
        window.__socketConnectCalls += 1;
        socket.connected = true;
        (window.__socketHandlers.connect || []).forEach(cb => cb());
        return socket;
      },
      disconnect(reason = 'io client disconnect') {
        socket.connected = false;
        (window.__socketHandlers.disconnect || []).forEach(cb => cb(reason));
        return socket;
      },
      fire(event, data) {
        (window.__socketHandlers[event] || []).forEach(cb => cb(data));
      }
    };
    window.__socket = socket;
    return socket;
  };
})();
`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function startStaticServer(rootDir) {
  const root = path.resolve(rootDir);

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch {
        res.writeHead(400);
        res.end('bad request');
        return;
      }

      if (pathname === '/socket.io/socket.io.js') {
        res.writeHead(200, {
          'Content-Type': MIME['.js'],
          'Cache-Control': 'no-store'
        });
        res.end(FAKE_SOCKET_SOURCE);
        return;
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(file).pipe(res);
    });

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(done))
      });
    });
  });
}

function browserTempRoot() {
  const requested = process.env.BROWSER_TMPDIR || process.env.TMPDIR || os.tmpdir();
  try {
    fs.mkdirSync(requested, { recursive: true });
    return requested;
  } catch {
    return os.tmpdir();
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`);
  }

  const candidates = [
    '/usr/sbin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/opt/google/chrome/chrome'
  ];

  // Optional local Playwright browser cache (used only if already installed;
  // this harness never downloads one).
  const cacheRoot = path.join(os.homedir(), '.cache', 'ms-playwright');
  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot)) {
      if (!entry.startsWith('chromium-')) continue;
      candidates.push(path.join(cacheRoot, entry, 'chrome-linux64', 'chrome'));
      candidates.push(path.join(cacheRoot, entry, 'chrome-linux', 'chrome'));
    }
  }

  const found = candidates.find(candidate => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      'No local Chromium/Chrome found. Set CHROME_PATH to an existing binary. ' +
      'This harness never installs or downloads a browser.'
    );
  }
  return found;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class CdpPage {
  constructor({ wsUrl, targetId, origin, closeTarget }) {
    this.wsUrl = wsUrl;
    this.targetId = targetId;
    this.origin = origin;
    this._closeTarget = closeTarget;
    this._ws = null;
    this._nextId = 0;
    this._pending = new Map();
    this._listeners = new Map();
    this._eventWaiters = new Map();
    this._closed = false;

    this.pageErrors = [];
    this.blockedExternal = [];
    this.requestedUrls = [];
  }

  async connect() {
    this._ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = event => {
        cleanup();
        reject(new Error(`CDP WebSocket failed: ${event.message || 'unknown error'}`));
      };
      const cleanup = () => {
        this._ws.removeEventListener('open', onOpen);
        this._ws.removeEventListener('error', onError);
      };
      this._ws.addEventListener('open', onOpen, { once: true });
      this._ws.addEventListener('error', onError, { once: true });
    });

    this._ws.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      if (message.id) {
        const pending = this._pending.get(message.id);
        if (!pending) return;
        this._pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
        } else {
          pending.resolve(message.result || {});
        }
        return;
      }

      if (!message.method) return;
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params && message.params.exceptionDetails;
        const text = details && (details.exception?.description || details.text || 'Uncaught page exception');
        this.pageErrors.push(text);
      }
      for (const listener of this._listeners.get(message.method) || []) {
        listener(message.params || {});
      }
      const waiters = this._eventWaiters.get(message.method);
      if (waiters && waiters.length) {
        this._eventWaiters.delete(message.method);
        for (const waiter of waiters) waiter.resolve(message.params || {});
      }
    });

    this._ws.addEventListener('close', () => {
      this._closed = true;
      for (const pending of this._pending.values()) {
        pending.reject(new Error('CDP connection closed'));
      }
      this._pending.clear();
    });

    await this._send('Page.enable');
    await this._send('Runtime.enable');
    await this._send('Log.enable');
    this._on('Fetch.requestPaused', params => this._handleRequestPaused(params));
    await this._send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }]
    });
  }

  _send(method, params = {}) {
    if (this._closed) return Promise.reject(new Error('CDP page is closed'));
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, method });
      this._ws.send(JSON.stringify({ id, method, params }));
    });
  }

  _on(method, listener) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(listener);
  }

  _waitForEvent(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const waiters = this._eventWaiters.get(method) || [];
      const timer = setTimeout(() => {
        const current = this._eventWaiters.get(method) || [];
        this._eventWaiters.set(method, current.filter(waiter => waiter.resolve !== wrapped.resolve));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const wrapped = {
        resolve: params => {
          clearTimeout(timer);
          resolve(params);
        }
      };
      waiters.push(wrapped);
      this._eventWaiters.set(method, waiters);
    });
  }

  _handleRequestPaused(params) {
    const url = params.request?.url || '';
    this.requestedUrls.push(url);

    // Only the local static server is reachable. This blocks the Google Fonts
    // @import and any other external asset so tests are fully offline.
    if (url.startsWith(this.origin + '/') || url === this.origin) {
      this._send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }

    this.blockedExternal.push(url);
    this._send('Fetch.failRequest', {
      requestId: params.requestId,
      errorReason: 'BlockedByClient'
    }).catch(() => {});
  }

  async setViewport(width, height, { mobile = true } = {}) {
    await this._send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
      screenWidth: width,
      screenHeight: height
    });
  }

  async setSafeAreaInsets(insets) {
    // Chrome 127+; harmless no-op on browsers that don't expose the command.
    try {
      await this._send('Emulation.setSafeAreaInsetsOverride', { insets });
      return true;
    } catch {
      return false;
    }
  }

  async setEmulatedMedia(media) {
    await this._send('Emulation.setEmulatedMedia', media);
  }

  async addInitScript(source) {
    await this._send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async goto(url) {
    const loaded = this._waitForEvent('Page.loadEventFired', 15000);
    const result = await this._send('Page.navigate', { url });
    if (result.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    await loaded;
  }

  async evaluate(fn, ...args) {
    const expression = typeof fn === 'function'
      ? `(${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')})`
      : String(fn);

    const response = await this._send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });

    if (response.exceptionDetails) {
      const detail = response.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || 'Evaluation failed');
    }
    return response.result ? response.result.value : undefined;
  }

  async waitForFunction(fn, args = [], timeout = 6000) {
    const expression = `Boolean((${fn.toString()})(${args.map(arg => JSON.stringify(arg)).join(',')}))`;
    const started = Date.now();
    let lastError = null;

    while (Date.now() - started < timeout) {
      try {
        if (await this.evaluate(expression)) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(50);
    }

    throw new Error(`Timed out waiting for function${lastError ? ` (last error: ${lastError.message})` : ''}`);
  }

  async waitForTimeout(ms) {
    await sleep(ms);
  }

  async click(selector) {
    const clicked = await this.evaluate(sel => {
      const element = document.querySelector(sel);
      if (!element) return false;
      element.click();
      return true;
    }, selector);
    if (!clicked) throw new Error(`Element not found: ${selector}`);
  }

  async focus(selector) {
    const focused = await this.evaluate(sel => {
      const element = document.querySelector(sel);
      if (!element) return false;
      element.focus();
      return document.activeElement === element;
    }, selector);
    if (!focused) throw new Error(`Could not focus: ${selector}`);
  }

  async _hitTarget(selector) {
    const info = await this.evaluate(async (sel) => {
      const element = document.querySelector(sel);
      if (!element) return { missing: true };
      element.scrollIntoView({ block: 'center', inline: 'center' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x,
        y,
        width: rect.width,
        height: rect.height,
        insideViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight,
        hit: !!(hit && (hit === element || hit.closest(sel) === element)),
        hitLabel: hit && (hit.getAttribute('aria-label') || hit.id || hit.tagName)
      };
    }, selector);

    if (info.missing) throw new Error(`Element not found: ${selector}`);
    if (info.width < 1 || info.height < 1 || !info.insideViewport) {
      throw new Error(`Element is not visibly hittable: ${selector} (${info.width}x${info.height})`);
    }
    if (!info.hit) {
      throw new Error(`Element is covered at its center: ${selector} (hit: ${info.hitLabel || 'none'})`);
    }
    return info;
  }

  /** Real mouse pointer click through CDP Input events. */
  async pointerClick(selector) {
    const point = await this._hitTarget(selector);
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y
    });
    await this._send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 1,
      clickCount: 1
    });
    await this._send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1
    });
    await sleep(20);
    return point;
  }

  /** Real touch tap through CDP Input events (enables touch emulation). */
  async tap(selector) {
    const point = await this._hitTarget(selector);
    await this._send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 1
    });
    await this._send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{
        x: point.x,
        y: point.y,
        radiusX: 2,
        radiusY: 2,
        force: 1,
        id: 1
      }]
    });
    await this._send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: []
    });
    await sleep(50);
    return point;
  }

  async press(key, { modifiers = 0 } = {}) {
    const info = keyInfo(key);
    await this._send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers,
      ...(info.text ? { text: info.text, unmodifiedText: info.text } : {})
    });
    await this._send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers
    });
  }

  async screenshot(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const result = await this._send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false
    });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  }

  async close() {
    if (this._closed) return;
    try {
      await this._send('Page.close');
    } catch {
      // ignore
    }
    this._ws.close();
    await sleep(50);
    if (this.targetId && this._closeTarget) {
      try { await this._closeTarget(this.targetId); } catch { /* ignore */ }
    }
  }
}

function keyInfo(key) {
  if (key === 'Tab') return { key: 'Tab', code: 'Tab', vk: 9 };
  if (key === 'Enter') return { key: 'Enter', code: 'Enter', vk: 13, text: '\r' };
  if (key === 'Backspace') return { key: 'Backspace', code: 'Backspace', vk: 8 };
  if (key === 'Delete') return { key: 'Delete', code: 'Delete', vk: 46 };
  if (key === ' ') return { key: ' ', code: 'Space', vk: 32, text: ' ' };
  if (key === '-') return { key: '-', code: 'Minus', vk: 189, text: '-' };
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return { key, code: `Key${upper}`, vk: upper.charCodeAt(0), text: key };
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, vk: key.charCodeAt(0), text: key };
  }
  if (key === '!') return { key: '!', code: 'Digit1', vk: 49, text: '!' };
  throw new Error(`Unsupported test key: ${key}`);
}

class Browser {
  constructor({ process, tempDir, port, chromePath }) {
    this.process = process;
    this.tempDir = tempDir;
    this.port = port;
    this.chromePath = chromePath;
    this.closed = false;
  }

  static async launch() {
    if (typeof WebSocket !== 'function') {
      throw new Error('This test harness requires Node >= 22 for the built-in WebSocket.');
    }

    const chromePath = findChrome();
    const tempDir = fs.mkdtempSync(path.join(browserTempRoot(), 'wordbridge-ui-'));
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${tempDir}`,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-domain-reliability',
      '--disable-client-side-phishing-detection',
      '--disable-sync',
      '--disable-default-apps',
      '--metrics-recording-only',
      '--no-pings',
      '--force-device-scale-factor=1',
      'about:blank'
    ];

    let stderr = '';
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    const portFile = path.join(tempDir, 'DevToolsActivePort');
    const started = Date.now();
    while (!fs.existsSync(portFile)) {
      if (child.exitCode !== null) {
        throw new Error(`Chromium exited during launch (${child.exitCode}):\n${stderr.slice(-2000)}`);
      }
      if (Date.now() - started > 15000) {
        child.kill('SIGKILL');
        throw new Error(`Timed out waiting for Chromium DevTools port.\n${stderr.slice(-2000)}`);
      }
      await sleep(100);
    }

    const [port] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
    return new Browser({ process: child, tempDir, port, chromePath });
  }

  async newPage({
    width = 390,
    height = 844,
    origin = this._origin || '',
    safeArea = null,
    media = null,
    initScripts = []
  } = {}) {
    const target = await this._json(`/json/new?about:blank`, { method: 'PUT' });
    const page = new CdpPage({
      wsUrl: target.webSocketDebuggerUrl,
      targetId: target.id,
      origin,
      closeTarget: id => this._json(`/json/close/${id}`).catch(() => {})
    });
    await page.connect();
    await page.setViewport(width, height);
    if (safeArea) await page.setSafeAreaInsets(safeArea);
    if (media) await page.setEmulatedMedia(media);
    for (const source of initScripts) await page.addInitScript(source);
    return page;
  }

  async _json(pathname, options = {}) {
    const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, options);
    if (!response.ok) throw new Error(`CDP HTTP ${pathname}: ${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  setOrigin(origin) {
    this._origin = origin;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.process && this.process.exitCode === null) {
      this.process.kill('SIGTERM');
      await sleep(300);
      if (this.process.exitCode === null) this.process.kill('SIGKILL');
    }
    try {
      fs.rmSync(this.tempDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function openAppPage(browser, origin, pageOptions = {}) {
  const page = await browser.newPage(pageOptions);
  await page.goto(origin + '/');
  await page.waitForFunction(() => window.__socket && document.getElementById('wordDisplay'));
  return page;
}

module.exports = {
  Browser,
  CdpPage,
  openAppPage,
  startStaticServer,
  findChrome,
  FAKE_SOCKET_SOURCE
};
