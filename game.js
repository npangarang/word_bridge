const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// === Session lifecycle ===
// Native Socket.IO connection-state recovery is disabled by the server.
// Identity is a stable playerId backed by an opaque resume token. The token is
// per-tab (sessionStorage) and is read on every handshake so a page refresh can
// resume the same player/room. A resume failure must never silently register a
// second player or kick the tab that already owns the token.
const STORAGE_RESUME_TOKEN = 'wb_resume_token';
let memoryResumeToken = null;

function readResumeToken() {
  try {
    const stored = window.sessionStorage.getItem(STORAGE_RESUME_TOKEN) || null;
    if (stored) memoryResumeToken = stored;
    return stored || memoryResumeToken;
  } catch (e) {
    // Storage may be blocked (privacy mode/partitioning). The in-memory copy
    // still allows same-page transient reconnects; a full page reload cannot
    // resume without persistent storage.
    return memoryResumeToken;
  }
}
function storeResumeToken(token) {
  memoryResumeToken = token || null;
  try {
    if (token) window.sessionStorage.setItem(STORAGE_RESUME_TOKEN, token);
    else window.sessionStorage.removeItem(STORAGE_RESUME_TOKEN);
  } catch (e) { /* memory fallback above remains authoritative this page */ }
}

// `authoritativeReady` means the server has sent the authoritative room
// snapshot for the current connection/registration. It starts false: no room
// or game command may be sent until a real snapshot (or create/join ack) has
// been applied. Tests must drive that same snapshot flow.
let authoritativeReady = false;
let browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
let registrationPending = false;
let resumeConflict = false;
let resumeRetryTimer = null;
let resumeRetryAttempt = 0;
let resumeRetryExhausted = false;
let resumeNoticeShown = false;
let sessionExpiredHandled = false;
let serverClockOffset = 0;
let pageHiding = false;

// Bounded, cancellable retries for RESUME_IN_USE. Middleware rejections do not
// auto-retry, and we never fall back to setName while another tab owns the
// token. A refresh usually frees the old transport within the first attempt.
const RESUME_RETRY_DELAYS = [400, 800, 1500, 2500, 4000, 6000, 9000];

// Solo mode must boot even when the page is served without the Socket.IO client
// bundle (offline/static hosting). Multiplayer still uses the real client when
// it is available; the fallback keeps every top-level socket registration safe.
function createUnavailableSocket() {
  const handlers = new Map();
  const unavailable = {
    connected: false,
    on(event, callback) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(callback);
      return unavailable;
    },
    emit() { return unavailable; },
    connect() { return unavailable; },
    disconnect() { return unavailable; }
  };
  return unavailable;
}

function createSocketClient() {
  if (typeof io !== 'function') return createUnavailableSocket();
  try {
    return io({
      // Function form: read the token again for every reconnect attempt, including
      // attempts that happen after SESSION_EXPIRED cleared it.
      auth: (callback) => callback({ resumeToken: readResumeToken() }),
      transports: isIOS ? ['polling', 'websocket'] : ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 20000
    });
  } catch (error) {
    console.warn('Socket.IO unavailable — multiplayer disabled:', error);
    return createUnavailableSocket();
  }
}

const socket = createSocketClient();

function serverNow() {
  return Date.now() + serverClockOffset;
}

function cancelResumeRetry() {
  if (resumeRetryTimer) {
    clearTimeout(resumeRetryTimer);
    resumeRetryTimer = null;
  }
  resumeRetryAttempt = 0;
  resumeRetryExhausted = false;
}

function scheduleResumeRetry() {
  if (resumeRetryTimer || !resumeConflict) return;

  if (resumeRetryAttempt >= RESUME_RETRY_DELAYS.length) {
    if (!resumeRetryExhausted) {
      resumeRetryExhausted = true;
      const message = 'This session is still active in another tab. Close it and refresh, or enter your name to play as a new player.';
      if (myPlayerId) offerNewSessionAfterConflict(message);
      else showError(message, 'nameError');
    }
    return;
  }

  const delay = RESUME_RETRY_DELAYS[resumeRetryAttempt++];
  resumeRetryTimer = setTimeout(() => {
    resumeRetryTimer = null;
    if (resumeConflict && !socket.connected) socket.connect();
  }, delay);
}

function retryAfterUserGesture() {
  if (socket.connected || browserOffline) return;
  if (resumeConflict) {
    // A new visibility/online gesture may start one fresh bounded cycle.
    if (resumeRetryExhausted) {
      resumeRetryAttempt = 0;
      resumeRetryExhausted = false;
    }
    scheduleResumeRetry();
  } else {
    socket.connect();
  }
}

function handleSessionExpired() {
  if (sessionExpiredHandled) {
    showToast('Session expired. Enter your name to continue.');
    return;
  }
  sessionExpiredHandled = true;
  storeResumeToken(null);
  cancelResumeRetry();
  resumeConflict = false;
  resumeNoticeShown = false;
  registrationPending = false;
  authoritativeReady = false;
  myPlayerId = null;
  _renamingViaProfile = false;
  setEnterButtonLabel(false);

  // Clear stale room/game state once. Never recreate the old room: the user
  // explicitly registers again from the name screen.
  resetRoomState();
  const profile = loadProfile();
  if (profile && profile.name) $('playerNameInput').value = profile.name;
  showScreen('nameScreen');
  showError('Your session expired. Enter your name to continue. Your old room was not recreated.', 'nameError');

  // Middleware rejections do not auto-reconnect; try one fresh handshake
  // without a token (the auth callback now reads null).
  setTimeout(() => { if (!socket.connected) socket.connect(); }, 0);
}

function setEnterButtonLabel(conflict) {
  const button = $('enterLobbyBtn');
  if (!button) return;
  const label = conflict ? 'PLAY AS NEW PLAYER' : 'ENTER LOBBY';
  if (button.textContent !== label) button.textContent = label;
  button.setAttribute('aria-label', label);
}

function handleResumeInUse() {
  if (!readResumeToken()) return;
  resumeConflict = true;
  authoritativeReady = false;

  if (!resumeNoticeShown) {
    resumeNoticeShown = true;
    if (myPlayerId) {
      showToast('This session is active in another tab. Reconnecting…');
    } else {
      const profile = loadProfile();
      if (profile && profile.name) $('playerNameInput').value = profile.name;
      setEnterButtonLabel(true);
      showScreen('nameScreen');
      showError(
        'This game session is active in another tab. Close it and wait to reconnect, or enter your name to play as a new player.',
        'nameError'
      );
    }
  }

  scheduleResumeRetry();
}

// A tab that already had an identity can lose the token to another live tab
// (for example a half-open transport held past the retry budget). Automatic
// retries must not run forever, so offer the same explicit "play as a new
// player" escape as a fresh duplicate tab. The old token is retained until
// the user actually submits a name.
function offerNewSessionAfterConflict(message) {
  const profile = loadProfile();
  if (profile && profile.name) $('playerNameInput').value = profile.name;
  setEnterButtonLabel(true);
  myPlayerId = null;
  authoritativeReady = false;
  showScreen('nameScreen');
  showError(message, 'nameError');
}

function refreshInputAvailability() {
  const open = typeof isWordInputOpen === 'function' && isWordInputOpen();
  if (typeof setKeyboardEnabled === 'function') setKeyboardEnabled(open);

  if (soloMode) {
    // Solo never depends on transport/registration state. Only replace a stale
    // connection message if the local round is still open.
    const soloFeedback = $('wordFeedback');
    if (open && soloFeedback &&
        (soloFeedback.textContent === 'Reconnecting…' || soloFeedback.textContent === 'Offline')) {
      setWordFeedback(WORD_DEFAULT_FEEDBACK);
    }
    return;
  }

  if ((!socket.connected || browserOffline) && isGameScreenActive() && !submitted) {
    setWordFeedback(browserOffline ? 'Offline' : 'Reconnecting…', 'error');
    return;
  }
  const feedbackEl = $('wordFeedback');
  if (socket.connected && !browserOffline && open && feedbackEl &&
      (feedbackEl.textContent === 'Reconnecting…' || feedbackEl.textContent === 'Offline')) {
    setWordFeedback(WORD_DEFAULT_FEEDBACK);
  }
}

function syncComfortMode() {
  if (soloMode) return;
  // Always send the stored preference, including false. The server session
  // can outlive this page's localStorage/offline toggles, so only emitting
  // "true" would leave a stale comfort duration after reconnect.
  if (socket.connected && !browserOffline && myPlayerId) {
    socket.emit('setComfortMode', { enabled: !!comfortPrefs.enabled });
  }
}

socket.on('connect', () => {
  // A successful transport handshake proves connectivity even when a transient
  // navigator.onLine=false reading never produced a matching online event.
  browserOffline = false;
  pageHiding = false;
  cancelResumeRetry();
  resumeConflict = false;
  resumeNoticeShown = false;

  // A token means the server will resume identity + room automatically and
  // follow with nameConfirmed + roomStateRestored. Never emit setName here.
  const token = readResumeToken();
  authoritativeReady = !token;

  if (!token && registrationPending && myName) {
    // The user's explicit name entry may have raced a disconnect. Re-send on
    // the fresh transport; it is cleared only when nameConfirmed arrives.
    authoritativeReady = false;
    socket.emit('setName', myName);
  }

  syncComfortMode();
  refreshInputAvailability();
});

socket.on('disconnect', (reason) => {
  authoritativeReady = false;
  refreshInputAvailability();
  // The server only force-disconnects a resumed socket when its claim lost a
  // race (old transport closing / generation change). Socket.IO does not
  // auto-reconnect after `io server disconnect`, so retry the same token with
  // the same bounded policy; a truly expired token becomes SESSION_EXPIRED.
  if (reason === 'io server disconnect' && !pageHiding && readResumeToken()) {
    resumeConflict = true;
    scheduleResumeRetry();
  }
});

socket.on('connect_error', (error) => {
  const code = error && error.data && error.data.code;
  if (code === 'SESSION_EXPIRED') {
    handleSessionExpired();
    return;
  }
  if (code === 'RESUME_IN_USE') {
    handleResumeInUse();
    return;
  }
  authoritativeReady = false;
  refreshInputAvailability();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  retryAfterUserGesture();
});

window.addEventListener('offline', () => {
  // Do not force a transport disconnect: Socket.IO/engine.io may close it on
  // its own schedule. Block game/room commands immediately, but do not
  // invalidate authoritativeReady solely because the browser went offline: if
  // the transport stays live, online will simply resume sending without a new
  // snapshot.
  browserOffline = true;
  refreshInputAvailability();
});

window.addEventListener('online', () => {
  browserOffline = false;
  retryAfterUserGesture();
  if (socket.connected) {
    syncComfortMode();
    refreshInputAvailability();
  }
});

// Unload is a transport disconnect only: the server keeps the session during
// its grace window so the refreshed page can resume it. Never emit leaveRoom.
window.addEventListener('pagehide', () => {
  pageHiding = true;
  cancelResumeRetry();
  if (socket.connected) socket.disconnect();
});

window.addEventListener('pageshow', (event) => {
  pageHiding = false;
  if (event.persisted && !socket.connected) socket.connect();
});

// === State ===
let myPlayerId = null;
let myRoomCode = null;
let myName = null;
let isHost = false;
let players = [];           // all players in current room [{id,name,ready}]
let roomHostId = null;
let currentRound = 0;
let totalRounds = 10;
let roundDeadline = null;
let currentRoundDuration = 10000; // ms, from server roundStart.timeLeft (authoritative)
let currentStartLetter = null;
let currentEndLetter = null;
let currentMatchId = null;
let timerInterval = null;
let lastAnnouncedSecond = -1;
let lastTimerAnnounceSecond = -1;
let submitted = false;
let currentWord = '';       // uppercase text shown in the on-screen answer display
const WORD_MAX_LENGTH = 20;
let _renamingViaProfile = false; // set while an editName round-trip is in flight
let wordLookupClient = {};
let wordCategoriesClient = {};
let roomCategories = { noun_adj_verb: true, countries: true, us_states: true, us_cities: true };
let autoJoinRoomCode = null;  // from URL param ?room=
let roundScores = { me: 0, opp: 0 }; // live score feed for the always-visible hint
let disconnectPlayers = new Map(); // playerId -> name, survives multi-disconnect banners
let finishedGameEnd = null; // stored finished payload; membership changes must not re-render it
let finishedVoterIds = []; // authoritative play-again voter ids for the current finished room

// === Solo mode (local only, no server/socket) ===
const SOLO_BEST_STORAGE_KEY = 'wb_solo_best_v1';
const SOLO_PLAYER_ID = 'solo-player';
const SOLO_TOTAL_ROUNDS = 10;
const SOLO_ROUND_MS = 10000;
const SOLO_BONUS_WINDOW_MS = 3000;
const SOLO_RESULT_PAUSE_MS = 2600;
let soloMode = false;
let soloActive = false;
let soloRound = 0;
let soloScore = 0;
let soloMatchId = null;
let soloRoundStartTime = 0;
let soloSubmission = null;
let soloRoundEnding = false;
let soloAdvanceTimer = null;
let soloPreviousBest = 0;
let soloBest = 0;
let soloReturnScreen = 'nameScreen';

const $ = id => document.getElementById(id);

// Room-affecting commands are dropped, not buffered, until the socket is up
// and the latest authoritative restore has been applied. This prevents
// Socket.IO's offline send buffer from replaying stale create/join/submit
// commands after a reconnect.
function canSendRoomCommand() {
  return socket.connected && !browserOffline && authoritativeReady && !!myPlayerId;
}

function emitRoomCommand(event, payload) {
  if (!canSendRoomCommand()) {
    showToast('Still reconnecting — try again in a moment');
    return false;
  }
  socket.emit(event, payload);
  return true;
}

function emitIfConnected(event, payload) {
  if (!socket.connected || browserOffline) return false;
  socket.emit(event, payload);
  return true;
}

// Display order + labels for category toggles (used by renderCategoryToggles).
const CATEGORY_LABELS = {
  noun_adj_verb: 'Nouns / adjectives / verbs',
  countries: 'Countries',
  us_states: 'US States',
  us_cities: 'US Cities'
};
const CATEGORY_ORDER = ['noun_adj_verb', 'countries', 'us_states', 'us_cities'];

// === Retro Sound Engine (Web Audio API) ===
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playBeep(freq, duration, type = 'square', volume = 0.08) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch(e) { /* audio not available */ }
}

function playSweep(startFreq, endFreq, duration, type = 'square') {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(startFreq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + duration);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch(e) {}
}

function sfxSubmit() { if (comfortPrefs.motionOff) return; playBeep(600, 0.1); setTimeout(() => playBeep(900, 0.12), 80); }
function sfxInvalid() { if (comfortPrefs.motionOff) return; playSweep(300, 80, 0.2, 'sawtooth'); }
function sfxTimerTick() { if (comfortPrefs.motionOff) return; playBeep(1000, 0.04, 'square', 0.05); }
function sfxRoundStart() { if (comfortPrefs.motionOff) return; playBeep(400, 0.08); setTimeout(() => playBeep(600, 0.1), 70); setTimeout(() => playBeep(900, 0.14), 140); }
function sfxWin() {
  if (comfortPrefs.motionOff) return;
  playBeep(523, 0.12); setTimeout(() => playBeep(659, 0.12), 100);
  setTimeout(() => playBeep(784, 0.12), 200); setTimeout(() => playBeep(1047, 0.3), 300);
}
function sfxLose() { if (comfortPrefs.motionOff) return; playSweep(400, 100, 0.4, 'sawtooth'); }
function sfxReady() { if (comfortPrefs.motionOff) return; playBeep(700, 0.06); setTimeout(() => playBeep(1000, 0.08), 60); }

// Tracks in-flight screen transition so overlapping calls don't stack animationend listeners
let _pendingTransition = null;

function showScreen(screenId, instant = false) {
  if (_pendingTransition) {
    const { el, handler } = _pendingTransition;
    el.removeEventListener('animationend', handler);
    handler();
    _pendingTransition = null;
  }

  const current = document.querySelector('.screen.active');
  // Background tabs throttle/disable CSS animations, so animationend may never
  // arrive. Route immediately when hidden and keep a wall-clock fallback for
  // every transition so reconnect/restore state cannot be stuck off-screen.
  if (!instant && current && current.id !== screenId && !document.hidden) {
    current.classList.add('exiting');
    let fallbackTimer = null;
    const handler = function() {
      current.removeEventListener('animationend', handler);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (_pendingTransition && _pendingTransition.handler === handler) {
        _pendingTransition = null;
      }
      current.classList.remove('active', 'exiting');
      const next = $(screenId);
      next.classList.add('active');
    };
    _pendingTransition = { el: current, handler };
    current.addEventListener('animationend', handler, { once: true });
    fallbackTimer = setTimeout(() => {
      if (_pendingTransition && _pendingTransition.handler === handler) handler();
    }, 400);
  } else {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active', 'exiting'));
    _pendingTransition = null;
    $(screenId).classList.add('active');
  }
}

// === Profile storage ===
const STORAGE_PROFILE = 'wb_profile';
const STORAGE_COMFORT = 'wb_comfort_mode';

function loadProfile() {
  try { return JSON.parse(localStorage.getItem(STORAGE_PROFILE)); } catch(e) { return null; }
}
function saveProfile(profile) {
  localStorage.setItem(STORAGE_PROFILE, JSON.stringify(profile));
}

// === Solo best score (versioned localStorage, corrupt-safe) ===
function loadSoloBest() {
  try {
    const raw = localStorage.getItem(SOLO_BEST_STORAGE_KEY);
    if (raw === null || raw === '') return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.floor(value);
  } catch (error) {
    return 0;
  }
}

function saveSoloBest(value) {
  const normalized = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  try {
    localStorage.setItem(SOLO_BEST_STORAGE_KEY, String(normalized));
  } catch (error) {
    // Storage can be blocked in privacy mode; the run still works in memory.
  }
}

function renderSoloBestBadges() {
  const label = `BEST ${soloBest}`;
  const nameBadge = $('soloBestName');
  const lobbyBadge = $('soloBestLobby');
  const endBadge = $('soloBestEnd');
  if (nameBadge) nameBadge.textContent = label;
  if (lobbyBadge) lobbyBadge.textContent = label;
  if (endBadge) endBadge.textContent = String(soloBest);
}

// === Comfort Mode ===
// Mirrors the profile UI checkbox; defaults follow system preferences
let comfortPrefs = {
  enabled: false,        // master toggle — disables motion, increases text/tile scale
  motionOff: false,      // derived: stop decorative animations
  highContrast: false,   // derived: follow prefers-contrast
  source: 'system'       // 'system' | 'user'
};

function loadComfortPrefs() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_COMFORT));
    if (stored && typeof stored === 'object' && typeof stored.enabled === 'boolean') {
      comfortPrefs.enabled = stored.enabled;
      comfortPrefs.source = 'user';
    }
  } catch(e) {}
  // Re-evaluate system values
  const sysReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sysContrast = window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches;
  comfortPrefs.motionOff = comfortPrefs.enabled || sysReduce;
  comfortPrefs.highContrast = comfortPrefs.enabled || sysContrast;
}

function saveComfortPrefs() {
  localStorage.setItem(STORAGE_COMFORT, JSON.stringify({ enabled: comfortPrefs.enabled }));
}

function applyComfortPrefs() {
  document.body.classList.toggle('comfort-mode', comfortPrefs.enabled);
  document.body.classList.toggle('high-contrast', comfortPrefs.highContrast);
  document.body.classList.toggle('reduced-motion', comfortPrefs.motionOff);
  const cb = $('comfortToggle');
  if (cb) cb.checked = !!comfortPrefs.enabled;
}

function setComfortMode(enabled) {
  comfortPrefs.enabled = !!enabled;
  // When user explicitly toggles, follow their lead.
  comfortPrefs.source = 'user';
  const sysReduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const sysContrast = window.matchMedia && window.matchMedia('(prefers-contrast: more)').matches;
  comfortPrefs.motionOff = comfortPrefs.enabled || sysReduce;
  comfortPrefs.highContrast = comfortPrefs.enabled || sysContrast;
  applyComfortPrefs();
  saveComfortPrefs();
  // Sync preference with server so round timing adjusts (next round only).
  // It is also re-sent after registration/resume/online confirms the player.
  if (socket.connected && !browserOffline && myPlayerId) {
    socket.emit('setComfortMode', { enabled: !!enabled });
  }
}

// React to system preference changes if user hasn't set their own
function watchSystemComfortPrefs() {
  if (!window.matchMedia) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const contrast = window.matchMedia('(prefers-contrast: more)');
  const onChange = () => {
    if (comfortPrefs.source !== 'user') {
      comfortPrefs.motionOff = reduce.matches;
      comfortPrefs.highContrast = contrast.matches;
      applyComfortPrefs();
    } else {
      // If user has an explicit pref, still honor system overrides for motion
      comfortPrefs.motionOff = comfortPrefs.enabled || reduce.matches;
      comfortPrefs.highContrast = comfortPrefs.enabled || contrast.matches;
      applyComfortPrefs();
    }
  };
  if (reduce.addEventListener) reduce.addEventListener('change', onChange);
  if (contrast.addEventListener) contrast.addEventListener('change', onChange);
}

function announce(msg) {
  const el = $('srAnnounce');
  if (el) el.textContent = msg;
}
function announceAlert(msg) {
  const el = $('srAlert');
  if (el) el.textContent = msg;
}

function animateValue(el, start, end, duration) {
  const range = end - start;
  const startTime = performance.now();

  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + range * eased);
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Attribute-safe escaping. escapeHtml() serializes TEXT content and does NOT
// escape double quotes, so it is unsafe inside HTML attributes (e.g.
// data-player-name, aria-label). Use escapeAttr whenever user-derived data is
// interpolated into an attribute value.
function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Score units in visible text, aria labels and announcements all come from one
// place so 1 never renders as "1 points" (or "1 pts"). Compact UI slots use
// the short pt/pts form to preserve their existing widths.
function formatPoints(count, short = false) {
  const value = Number(count);
  const score = Number.isFinite(value) ? Math.trunc(value) : 0;
  if (short) return `${score} ${score === 1 ? 'pt' : 'pts'}`;
  return `${score} ${score === 1 ? 'point' : 'points'}`;
}

function spawnConfetti(count) {
  if (comfortPrefs.motionOff) return;
  const colors = ['var(--neon-green)', 'var(--neon-cyan)', 'var(--neon-magenta)', 'var(--neon-yellow)', 'var(--neon-orange)'];
  const container = document.body;
  const fragment = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'confetti-particle';
    particle.style.left = Math.random() * 100 + '%';
    particle.style.top = -(Math.random() * 20 + 5) + '%';
    particle.style.width = (Math.random() * 8 + 4) + 'px';
    particle.style.height = (Math.random() * 8 + 4) + 'px';
    particle.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    particle.style.boxShadow = `0 0 8px ${particle.style.backgroundColor}`;
    particle.style.animationDuration = (Math.random() * 2 + 2) + 's';
    particle.style.animationDelay = Math.random() * 1.5 + 's';
    fragment.appendChild(particle);
  }

  container.appendChild(fragment);

  setTimeout(() => {
    container.querySelectorAll('.confetti-particle').forEach(p => p.remove());
  }, 4500);
}

function showRoundBanner(text) {
  if (comfortPrefs.motionOff) {
    // Skip purely decorative motion, still surface the same state info via announcement
    announce(text);
    return;
  }
  const existing = document.querySelector('.round-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.className = 'round-banner';
  banner.textContent = text;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 1300);
}

function showFloatingReaction(emoji, x, y) {
  if (comfortPrefs.motionOff) return;
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.animationDuration = (Math.random() * 0.5 + 1.3) + 's';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

function showToast(msg) {
  const existing = document.querySelector('.toast-notification');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast-notification';
  toast.role = 'status';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
  announceAlert(msg);
}

const AVATAR_SVGS = {
  diamond: '<svg viewBox="0 0 24 24" class="avatar-icon"><polygon points="12,2 22,12 12,22 2,12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  circle: '<svg viewBox="0 0 24 24" class="avatar-icon"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>',
  square: '<svg viewBox="0 0 24 24" class="avatar-icon"><rect x="3" y="3" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="7" x2="17" y2="17" stroke="currentColor" stroke-width="2"/><line x1="17" y1="7" x2="7" y2="17" stroke="currentColor" stroke-width="2"/></svg>',
  triangle: '<svg viewBox="0 0 24 24" class="avatar-icon"><polygon points="12,3 22,20 2,20" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  star: '<svg viewBox="0 0 24 24" class="avatar-icon"><polygon points="12,2 15,9 23,9 16,14 18,22 12,17 6,22 8,14 1,9 9,9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  heart: '<svg viewBox="0 0 24 24" class="avatar-icon"><path d="M12 22C12 22 2 14 2 8c0-3 2.5-5 5-5 1.5 0 3 1 4.5 2.5C13 4 14.5 3 16 3c2.5 0 5 2 5 5 0 6-9 14-9 14z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  hexagon: '<svg viewBox="0 0 24 24" class="avatar-icon"><polygon points="12,2 21,7 21,17 12,22 3,17 3,7" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" class="avatar-icon"><rect x="9" y="4" width="6" height="16" rx="1.5" fill="currentColor"/><rect x="4" y="9" width="16" height="6" rx="1.5" fill="currentColor"/></svg>',
  eye: '<svg viewBox="0 0 24 24" class="avatar-icon"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" class="avatar-icon"><polygon points="13,2 3,13 10,13 8,22 19,10 12,10 15,2" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  shield: '<svg viewBox="0 0 24 24" class="avatar-icon"><path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6L12 2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" class="avatar-icon"><polygon points="12,1 14,9 22,11 14,13 12,21 10,13 2,11 10,9" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>'
};

function getAvatarSVG(code) {
  return AVATAR_SVGS[code] || AVATAR_SVGS.diamond;
}

const AVATAR_COLORS = {
  diamond: 'var(--neon-cyan)',
  circle: 'var(--neon-green)',
  square: 'var(--neon-magenta)',
  triangle: 'var(--neon-yellow)',
  star: 'var(--neon-orange)',
  heart: '#ff4488',
  hexagon: 'var(--neon-cyan)',
  cross: 'var(--neon-green)',
  eye: 'var(--neon-yellow)',
  bolt: 'var(--neon-orange)',
  shield: '#ff44ff',
  sparkle: 'var(--neon-cyan)'
};

function showError(msg, elementId) {
  const el = $(elementId);
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  announceAlert(msg);
  setTimeout(() => el.style.display = 'none', 3000);
}

function loadWordLookup() {
  return fetch('/word_lookup.json')
    .then(r => r.json())
    .then(data => {
      wordLookupClient = {};
      for (const key of Object.keys(data)) {
        wordLookupClient[key] = new Set(data[key]);
      }
      console.log('Word lookup loaded:', Object.keys(wordLookupClient).length, 'pairs');
    })
    .catch(err => console.error('Failed to load word lookup:', err));
}

function loadWordCategories() {
  return fetch('/word_categories.json')
    .then(r => r.json())
    .then(data => {
      wordCategoriesClient = data || {};
      console.log('Word categories loaded:', Object.keys(wordCategoriesClient).length, 'words');
    })
    .catch(err => console.error('Failed to load word categories:', err));
}

function validateClientWord(word, startLetter, endLetter) {
  const w = word.toLowerCase();
  const s = startLetter.toLowerCase();
  const e = endLetter.toLowerCase();

  if (w.length < 3) return { valid: false, reason: 'Word must be at least 3 letters' };
  if (!w.startsWith(s)) return { valid: false, reason: `Word must start with ${s.toUpperCase()}` };
  if (!w.endsWith(e)) return { valid: false, reason: `Word must end with ${e.toUpperCase()}` };

  const key = s + e;
  const words = wordLookupClient[key];
  if (!words || !words.has(w)) return { valid: false, reason: 'Word not in dictionary' };

  const hasDisabled = Object.values(roomCategories).some(v => v === false);
  if (hasDisabled) {
    const wordCats = wordCategoriesClient[w];
    if (!wordCats || wordCats.length === 0 || !wordCats.some(cat => roomCategories[cat])) {
      return { valid: false, reason: 'Word not in selected categories' };
    }
  }

  return { valid: true };
}

function updateOnlinePlayersList(list) {
  const container = $('onlinePlayers');
  const countEl = $('onlineCount');
  const prevCount = parseInt(countEl.textContent || '0');
  countEl.textContent = list.length;

  if (list.length !== prevCount) {
    const onlineCountParent = $('onlineCount').parentElement;
    onlineCountParent.classList.remove('pulse');
    void onlineCountParent.offsetWidth;
    onlineCountParent.classList.add('pulse');
  }

  container.innerHTML = list
    .filter(p => p.id !== myPlayerId)
    .map(p => `
      <div class="player-item">
        <div class="player-name">
          <span class="status-dot status-${p.status === 'online' ? 'online' : 'busy'}" aria-hidden="true"></span>
          <span class="status-text sr-only">${p.status === 'online' ? 'Available' : 'In game'}</span>
          <span class="player-name-text">${escapeHtml(p.name)}</span>
        </div>
        ${p.status !== 'online' ? '<span class="in-game-label">In game</span>' :
          `<button class="challenge-btn" data-player-id="${p.id}" data-player-name="${escapeAttr(p.name)}" type="button" aria-label="Challenge ${escapeAttr(p.name)} to a game">⚔ Challenge</button>`}
      </div>
    `).join('');
}

function renderRoomLobby() {
  if (!myRoomCode) return;

  // Segmented LCD-style room code
  $('roomCodeValue').innerHTML = myRoomCode
    .split('')
    .map(c => `<span class="code-char">${escapeHtml(c)}</span>`)
    .join('');

  const list = $('roomPlayersList');
  list.innerHTML = players.map(p => {
    const isYou = p.id === myPlayerId;
    const isRoomHost = p.id === roomHostId;
    const connected = p.connected !== false;
    const readyLabel = !connected ? 'Reconnecting' : (p.ready ? 'Ready' : 'Not ready');
    return `
      <div class="player-item${p.ready && connected ? ' ready' : ''}${isRoomHost ? ' host' : ''}${connected ? '' : ' reconnecting'}">
        <div class="player-name">
          <span class="player-name-text">${escapeHtml(p.name)}${isYou ? ' (you)' : ''}${isRoomHost ? '<span class="host-crown" aria-label="Host">Host</span>' : ''}${p.comfortMode ? '<span class="comfort-badge" aria-label="Comfort mode enabled">Comfort</span>' : ''}</span>
        </div>
        <span class="ready-badge ${p.ready && connected ? 'ready-on' : 'ready-off'}" aria-label="${readyLabel}">${!connected ? 'Reconnecting' : (p.ready ? 'Ready' : 'Not ready')}</span>
      </div>
    `;
  }).join('');

  const readyCount = players.filter(p => p.ready && p.connected !== false).length;
  const status = $('roomReadyStatus');
  status.textContent = `${readyCount} of ${players.length} ready`;

  // Ready Up button reflects own state
  const me = players.find(p => p.id === myPlayerId);
  const readyBtn = $('readyUpLobbyBtn');
  if (me && me.ready) {
    readyBtn.textContent = 'READY';
    readyBtn.setAttribute('aria-pressed', 'true');
    readyBtn.disabled = true;
    readyBtn.classList.remove('pulsing');
  } else {
    readyBtn.textContent = 'READY UP';
    readyBtn.setAttribute('aria-pressed', 'false');
    readyBtn.disabled = false;
    readyBtn.classList.add('pulsing');
  }

  // Start Game button. Disconnected (reconnecting) members are not live, so
  // the host cannot start until every player is connected and ready.
  const startBtn = $('startGameBtn');
  if (isHost) {
    startBtn.style.display = 'inline-block';
    const allReady = players.length >= 2 && players.every(p => p.ready && p.connected !== false);
    startBtn.disabled = !allReady;
    startBtn.setAttribute('aria-disabled', String(!allReady));
  } else {
    startBtn.style.display = 'none';
  }

  renderCategoryToggles();
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch(e) {}
  document.body.removeChild(ta);
  return Promise.resolve();
}

// === Category toggles (host-controlled) ===
function renderCategoryToggles() {
  const container = $('categoryTogglesRow');
  if (!container) return;

  const subtitle = $('categoryTogglesSubtitle');
  if (subtitle) {
    subtitle.textContent = isHost ? 'Tap to toggle' : 'Host only';
    subtitle.classList.toggle('host-mode', isHost);
    subtitle.classList.toggle('readonly-mode', !isHost);
  }

  container.innerHTML = CATEGORY_ORDER.map(cat => {
    const isOn = !!roomCategories[cat];
    const label = CATEGORY_LABELS[cat] || cat;
    const stateClass = isOn ? 'active' : 'inactive';
    const disabledClass = isHost ? '' : 'disabled';
    const disabledAttrs = isHost ? '' : 'tabindex="-1" aria-disabled="true"';
    const role = isHost ? 'switch' : '';
    const checked = isHost ? (isOn ? 'true' : 'false') : '';
    return `
      <button type="button"
              class="category-toggle ${stateClass} ${disabledClass}"
              data-category="${cat}"
              role="${role}"
              ${role ? `aria-checked="${checked}"` : ''}
              aria-label="${escapeAttr(label)} ${isOn ? 'on' : 'off'}${isHost ? '' : ' (host only, read only)'}"
              ${disabledAttrs}>
        <span class="category-label">${escapeHtml(label)}</span>
        <span class="toggle-state" aria-hidden="true">${isOn ? 'On' : 'Off'}</span>
      </button>
    `;
  }).join('');
}

function stopPhaseTimers() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  lastAnnouncedSecond = -1;
  lastTimerAnnounceSecond = -1;
  const timerBar = $('timerBar');
  if (timerBar) timerBar.classList.remove('critical');
  const gameScreen = $('gameScreen');
  if (gameScreen) gameScreen.classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');
}

function resetGamePhaseForLobby() {
  stopPhaseTimers();
  currentRound = 0;
  roundDeadline = null;
  currentStartLetter = null;
  currentEndLetter = null;
  currentMatchId = null;
  submitted = false;
  currentWord = '';
  playAgainVoted = false;
  finishedGameEnd = null;
  finishedVoterIds = [];
  const display = $('wordDisplay');
  if (display) display.classList.remove('submitted', 'invalid');
  const submissions = $('submissionsStatus');
  if (submissions) submissions.innerHTML = '';
  resetWordEntry();
  updateScoreHint();
}

function resetRoomState() {
  myRoomCode = null;
  isHost = false;
  players = [];
  roomHostId = null;
  currentRound = 0;
  roundDeadline = null;
  currentStartLetter = null;
  currentEndLetter = null;
  currentMatchId = null;
  submitted = false;
  currentWord = '';
  playAgainVoted = false;
  finishedGameEnd = null;
  finishedVoterIds = [];
  roundScores = { me: 0, opp: 0 };
  stopPhaseTimers();
  disconnectPlayers.clear();
  renderDisconnectBanner();
  updateScoreHint();
}

// Authoritative roster replacement/upsert helpers. Roster identity is the
// stable player id only — display names are allowed to collide.
function normalizePlayers(list) {
  if (!Array.isArray(list)) return [];
  const byId = new Map();
  for (const raw of list) {
    if (!raw || !raw.id) continue;
    const normalized = { ...raw };
    normalized.connected = raw.connected !== false;
    normalized.submitted = !!raw.submitted;
    byId.set(raw.id, { ...(byId.get(raw.id) || {}), ...normalized });
  }
  return [...byId.values()];
}

function setRoster(list, hostId) {
  players = normalizePlayers(list);
  if (hostId !== undefined && hostId !== null) roomHostId = hostId;
  isHost = !!myPlayerId && roomHostId === myPlayerId;

  const rosterById = new Map(players.map(player => [player.id, player]));
  for (const id of [...disconnectPlayers.keys()]) {
    const player = rosterById.get(id);
    if (!player || player.connected !== false) disconnectPlayers.delete(id);
  }
  for (const player of players) {
    if (player.connected === false) disconnectPlayers.set(player.id, player.name);
  }
  renderDisconnectBanner();
  syncScoresFromRoster();
}

function syncScoresFromRoster() {
  const me = players.find(player => player.id === myPlayerId);
  roundScores.me = me ? (me.score || 0) : 0;
  roundScores.opp = players
    .filter(player => player.id !== myPlayerId)
    .reduce((sum, player) => sum + (player.score || 0), 0);
  updateScoreHint();
}

function renderSubmissionChipsFromRoster() {
  const container = $('submissionsStatus');
  if (!container) return;
  container.innerHTML = '';
  for (const player of players) {
    if (player.id === myPlayerId || !player.submitted) continue;
    const chip = document.createElement('div');
    chip.className = 'submission-item';
    chip.dataset.pid = player.id;
    chip.setAttribute('aria-label', `${player.name} submitted`);
    chip.textContent = player.name;
    container.appendChild(chip);
  }
}

function renderDisconnectBanner() {
  const names = [...disconnectPlayers.values()].filter(Boolean);
  const gameScreen = $('gameScreen');
  const gameHeader = document.querySelector('#gameScreen .game-header');
  const gameNotice = document.getElementById('gameDisconnectNotice');
  const globalBanner = document.getElementById('disconnectBanner');
  const fullText = `${names.join(', ')} disconnected. Waiting to reconnect.`;
  const count = names.length;
  const summary = `${count} ${count === 1 ? 'player' : 'players'} disconnected. Waiting to reconnect.`;

  // In the active game the disconnect status shares the reserved HUD status
  // row instead of floating over the play area. The visible copy is compact;
  // the complete name list stays in the alert's accessible text.
  if (names.length && gameHeader) {
    let notice = gameNotice;
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'gameDisconnectNotice';
      notice.className = 'disconnect-banner game-disconnect-notice';
      notice.setAttribute('role', 'alert');
      notice.setAttribute('aria-atomic', 'true');
      gameHeader.appendChild(notice);
    }
    const countSummary = `${count} ${count === 1 ? 'player' : 'players'} disconnected.`;
    notice.innerHTML =
      `<span class="disconnect-banner-icon" aria-hidden="true">!</span>` +
      `<span class="game-disconnect-summary" aria-hidden="true">` +
        `<span class="disconnect-summary-count">${escapeHtml(countSummary)}</span>` +
        `<span class="disconnect-summary-wait"> Waiting to reconnect.</span>` +
      `</span>` +
      `<span class="sr-only">${escapeHtml(fullText)}</span>`;
    notice.title = fullText;
    notice.dataset.count = String(count);
    if (gameScreen) gameScreen.classList.add('has-disconnect-notice');
  } else {
    if (gameNotice) gameNotice.remove();
    if (gameScreen) gameScreen.classList.remove('has-disconnect-notice');
  }

  // Keep the full result/end alert mounted for the screen transition. CSS
  // hides it during the active game (where the compact HUD notice is shown)
  // and reveals it on the result/end screens.
  if (!names.length) {
    if (globalBanner) globalBanner.remove();
    return;
  }

  const element = globalBanner || document.createElement('div');
  if (!globalBanner) {
    element.id = 'disconnectBanner';
    element.className = 'disconnect-banner';
    element.setAttribute('role', 'alert');
    document.body.appendChild(element);
  }
  element.innerHTML = `<span class="disconnect-banner-icon" aria-hidden="true">!</span><span>${escapeHtml(fullText)}</span>`;
}

function hideDisconnectBanners() {
  disconnectPlayers.clear();
  renderDisconnectBanner();
}

// Initial create/join acknowledgements are authoritative for the lobby view;
// roomStateRestored remains the authority after name registration/resume.
function applyRoomEntry(data) {
  if (!data || !data.code) return;
  authoritativeReady = true;
  autoJoinRoomCode = null;
  myRoomCode = data.code;
  roomHostId = data.hostId || null;
  isHost = !!myPlayerId && roomHostId === myPlayerId;
  if (data.categories) roomCategories = { ...roomCategories, ...data.categories };
  if (data.matchId !== undefined && data.matchId !== null) currentMatchId = data.matchId;
  setRoster(data.players, data.hostId || null);
  resetGamePhaseForLobby();
  renderRoomLobby();
  showScreen('roomLobbyScreen', true);
  refreshInputAvailability();
}

// Apply the authoritative post-registration/resume snapshot. This is the only
// path that re-places a refreshed client into lobby/playing/paused/finished.
function applyRoomStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (soloMode) return; // a live solo run owns the UI until it exits

  cancelResumeRetry();
  resumeConflict = false;
  resumeNoticeShown = false;
  authoritativeReady = true;
  setEnterButtonLabel(false);

  if (Number.isFinite(Number(snapshot.serverNow))) {
    serverClockOffset = Number(snapshot.serverNow) - Date.now();
  }

  stopPhaseTimers();
  const code = snapshot.code || null;

  if (!code || snapshot.state === 'online') {
    resetRoomState();
    roomCategories = { noun_adj_verb: true, countries: true, us_states: true, us_cities: true };
    if (!myPlayerId) {
      showScreen('nameScreen', true);
      refreshInputAvailability();
      return;
    }
    showScreen('lobbyScreen', true);
    socket.emit('requestOnlinePlayers');

    // Invite links join exactly once, only after the roomless snapshot confirms
    // the name registration/resume has completed.
    if (autoJoinRoomCode) {
      const inviteCode = autoJoinRoomCode;
      autoJoinRoomCode = null;
      if (canSendRoomCommand()) {
        socket.emit('joinRoom', { code: inviteCode, name: myName });
      }
    }
    syncComfortMode();
    refreshInputAvailability();
    return;
  }

  // A restore that already has a room must consume any pending invite so a
  // later roomless transition cannot unexpectedly join an old link.
  autoJoinRoomCode = null;
  myRoomCode = code;
  roomHostId = snapshot.hostId || null;
  isHost = !!myPlayerId && roomHostId === myPlayerId;
  roomCategories = {
    noun_adj_verb: true,
    countries: true,
    us_states: true,
    us_cities: true,
    ...(snapshot.categories || {})
  };
  setRoster(snapshot.players, snapshot.hostId || null);

  if (snapshot.state === 'lobby') {
    resetGamePhaseForLobby();
    renderRoomLobby();
    showScreen('roomLobbyScreen', true);
  } else if (snapshot.state === 'playing' && snapshot.roundStart) {
    applyRoundStart(snapshot.roundStart, {
      restore: true,
      ownSubmission: snapshot.ownSubmission
    });
  } else if (snapshot.state === 'paused' && snapshot.lastRoundEnd) {
    applyRoundEnd(snapshot.lastRoundEnd, { restore: true });
  } else if (snapshot.state === 'finished' && snapshot.gameEnd) {
    applyGameEnd(snapshot.gameEnd, {
      restore: true,
      voterIds: snapshot.playAgainVoterIds
    });
  } else {
    resetGamePhaseForLobby();
    renderRoomLobby();
    showScreen('roomLobbyScreen', true);
  }
  syncComfortMode();
  refreshInputAvailability();
}


// === Reaction emoji system ===
document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const emoji = btn.dataset.emoji;
    const rect = btn.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - 12;
    const y = rect.top - 10;
    showFloatingReaction(emoji, x, y);
    if (!soloMode) emitIfConnected('sendReaction', emoji);
  });
});

socket.on('reactionReceived', (data) => {
  const x = window.innerWidth - 60 + Math.random() * 40;
  const y = window.innerHeight * 0.3 + Math.random() * 100;
  showFloatingReaction(data.emoji, x, y);
});

// === Challenge system ===
let pendingChallenge = null;
let challengeTimerInterval = null;

const DEFAULT_CHALLENGE_CATEGORIES = { noun_adj_verb: true, countries: true, us_states: true, us_cities: true };
let challengeCategories = { ...DEFAULT_CHALLENGE_CATEGORIES };

$('onlinePlayers').addEventListener('click', (e) => {
  const btn = e.target.closest('.challenge-btn');
  if (!btn) return;
  const targetId = btn.dataset.playerId;
  const targetName = btn.dataset.playerName;
  if (!targetId) return;
  openChallengeSendModal(targetId, targetName);
});

function openChallengeSendModal(targetId, targetName) {
  challengeCategories = { ...DEFAULT_CHALLENGE_CATEGORIES };

  pendingChallenge = { targetId, targetName, mode: 'send' };

  $('challengeModalTitle').textContent = 'CHALLENGE';
  $('challengeModalMsg').textContent = `Challenge ${targetName} to a game?`;

  renderChallengeCategoryToggles();

  $('challengeModalBtns').innerHTML = `
    <button id="sendChallengeBtn" class="arcade-btn arcade-btn-primary" type="button">Challenge</button>
    <button id="cancelSendChallengeBtn" class="arcade-btn arcade-btn-secondary" type="button">Cancel</button>
  `;

  $('challengeModalTimer').style.display = 'none';

  $('sendChallengeBtn').addEventListener('click', () => {
    if (!emitRoomCommand('challengePlayer', { targetId, categories: challengeCategories })) return;
    closeChallengeModal();
    showToast(`Challenge sent to ${targetName}`);
  });

  $('cancelSendChallengeBtn').addEventListener('click', closeChallengeModal);

  $('challengeModal').classList.add('active');
}

function openChallengeReceiveModal(challengerId, challengerName, categories) {
  pendingChallenge = { challengerId, challengerName, categories, mode: 'receive' };

  $('challengeModalTitle').textContent = 'CHALLENGE';
  $('challengeModalMsg').textContent = `${challengerName} challenges you to a game!`;

  renderChallengeReceiveCategories(categories);

  $('challengeModalBtns').innerHTML = `
    <button id="acceptChallengeBtn" class="arcade-btn arcade-btn-primary" type="button">Accept</button>
    <button id="declineChallengeBtn" class="arcade-btn arcade-btn-secondary" type="button">Decline</button>
  `;

  $('challengeModalTimer').style.display = 'block';
  const fill = $('challengeModalTimer').querySelector('.challenge-timer-fill');
  if (fill) {
    fill.style.animation = 'none';
    void fill.offsetWidth;
    fill.style.animation = '';
  }

  $('acceptChallengeBtn').addEventListener('click', () => {
    if (!pendingChallenge) return;
    if (!emitRoomCommand('acceptChallenge', pendingChallenge.challengerId)) return;
    closeChallengeModal();
  });

  $('declineChallengeBtn').addEventListener('click', () => {
    if (!pendingChallenge) return;
    if (!emitRoomCommand('declineChallenge', pendingChallenge.challengerId)) return;
    closeChallengeModal();
  });

  $('challengeModal').classList.add('active');
}

function renderChallengeCategoryToggles() {
  const container = $('challengeModalCats');
  container.innerHTML = `
    <div class="challenge-cats-label">Word categories</div>
    <div class="challenge-cats-grid">
      ${CATEGORY_ORDER.map(cat => {
        const isOn = challengeCategories[cat];
        const label = CATEGORY_LABELS[cat] || cat;
        return `
          <button type="button" class="category-toggle-sm ${isOn ? 'active' : 'inactive'}" data-cat="${cat}" aria-pressed="${isOn}">
            <span class="cat-label-sm">${escapeHtml(label)}: ${isOn ? 'on' : 'off'}</span>
          </button>
        `;
      }).join('')}
    </div>
  `;

  container.querySelectorAll('.category-toggle-sm').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat;
      challengeCategories[cat] = !challengeCategories[cat];
      btn.classList.toggle('active', challengeCategories[cat]);
      btn.classList.toggle('inactive', !challengeCategories[cat]);
      btn.setAttribute('aria-pressed', String(challengeCategories[cat]));
      const lbl = btn.querySelector('.cat-label-sm');
      if (lbl) lbl.textContent = `${CATEGORY_LABELS[cat] || cat}: ${challengeCategories[cat] ? 'on' : 'off'}`;
    });
  });
}

function renderChallengeReceiveCategories(categories) {
  const container = $('challengeModalCats');
  if (!categories) { container.innerHTML = ''; return; }

  const catList = CATEGORY_ORDER.filter(cat => categories[cat]);
  const offList = CATEGORY_ORDER.filter(cat => !categories[cat]);

  if (catList.length === CATEGORY_ORDER.length) {
    container.innerHTML = '<span class="challenge-cats-all">All categories enabled</span>';
  } else {
    container.innerHTML = catList.map(cat => {
      const label = CATEGORY_LABELS[cat] || cat;
      return `<span class="challenge-cat-tag active">${escapeHtml(label)} on</span>`;
    }).join('') + offList.map(cat => {
      const label = CATEGORY_LABELS[cat] || cat;
      return `<span class="challenge-cat-tag inactive">${escapeHtml(label)} off</span>`;
    }).join('');
  }
}

function closeChallengeModal() {
  $('challengeModal').classList.remove('active');
  clearChallengeState();
}

function clearChallengeState() {
  pendingChallenge = null;
  if (challengeTimerInterval) {
    clearInterval(challengeTimerInterval);
    challengeTimerInterval = null;
  }
}

$('challengeModal').addEventListener('click', (e) => {
  if (e.target === $('challengeModal')) {
    if (pendingChallenge && pendingChallenge.mode === 'receive') {
      emitRoomCommand('declineChallenge', pendingChallenge.challengerId);
    }
    closeChallengeModal();
  }
});

socket.on('challengeReceived', (data) => {
  openChallengeReceiveModal(data.challengerId, data.challengerName, data.categories);
  if (!comfortPrefs.motionOff) {
    playBeep(800, 0.06);
    setTimeout(() => playBeep(1000, 0.08), 60);
  }
});

socket.on('challengeSent', (data) => {
  showToast(`Challenge sent to ${data.targetName}`);
});

socket.on('challengeAccepted', (data) => {
  clearChallengeState();
  applyRoomEntry({
    code: data.roomCode || data.code,
    hostId: data.hostId,
    players: data.players,
    categories: data.categories,
    maxPlayers: data.maxPlayers,
    matchId: data.matchId
  });
});

socket.on('challengeDeclined', (data) => {
  clearChallengeState();
  closeChallengeModal();
  showToast(`${data.targetName} declined your challenge`);
  emitIfConnected('requestOnlinePlayers');
});

socket.on('challengeExpired', (data) => {
  clearChallengeState();
  closeChallengeModal();
  if (data.targetName) {
    showToast(`Challenge to ${data.targetName} expired`);
  }
  emitIfConnected('requestOnlinePlayers');
});

socket.on('challengeCancelled', (data) => {
  clearChallengeState();
  closeChallengeModal();
  if (data.challengerName) {
    showToast(`${data.challengerName} cancelled the challenge`);
  }
  emitIfConnected('requestOnlinePlayers');
});

loadWordLookup();
loadWordCategories();

// === Name screen ===
// An explicit name submission starts (or re-registers) a session. It is never
// sent automatically as a RESUME_IN_USE fallback: when another tab owns the
// token, the user must deliberately choose "play as a new player" here.
function startExplicitNewSession(name) {
  storeResumeToken(null);
  cancelResumeRetry();
  sessionExpiredHandled = false;
  resumeConflict = false;
  resumeNoticeShown = false;
  registrationPending = true;
  authoritativeReady = false;
  myName = name;
  setEnterButtonLabel(false);

  if (!socket.connected) {
    socket.connect();
  } else {
    socket.emit('setName', name);
  }
}

function submitNameFromInput() {
  const name = $('playerNameInput').value.trim();
  if (!name) {
    showError('Please enter your name', 'nameError');
    return;
  }

  if (resumeConflict) {
    startExplicitNewSession(name);
    showToast('Starting a new player session');
    return;
  }

  myName = name;
  if (!socket.connected) {
    registrationPending = true;
    socket.connect();
    return;
  }
  registrationPending = true;
  authoritativeReady = false;
  socket.emit('setName', name);
}

$('enterLobbyBtn').addEventListener('click', submitNameFromInput);

const soloBtn = $('soloBtn');
if (soloBtn) soloBtn.addEventListener('click', startSoloRun);
const lobbySoloBtn = $('lobbySoloBtn');
if (lobbySoloBtn) lobbySoloBtn.addEventListener('click', startSoloRun);

$('playerNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNameFromInput();
});

$('editNameBtn').addEventListener('click', () => {
  showScreen('nameScreen');
  $('playerNameInput').value = myName || '';
});

$('refreshLobbyBtn').addEventListener('click', () => {
  emitIfConnected('requestOnlinePlayers');
});

// === Room buttons ===
$('createRoomBtn').addEventListener('click', () => {
  if (!myName) return;
  emitRoomCommand('createRoom', myName);
});

$('joinRoomInput').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

$('joinRoomBtn').addEventListener('click', () => {
  const code = $('joinRoomInput').value.trim();
  if (!code) {
    showError('Enter a room code', 'lobbyError');
    return;
  }
  if (!myName) return;
  emitRoomCommand('joinRoom', { code, name: myName });
});

$('joinRoomInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    $('joinRoomBtn').click();
  }
});

$('readyUpLobbyBtn').addEventListener('click', () => {
  const me = players.find(p => p.id === myPlayerId);
  if (!me || me.ready) return;
  if (!emitRoomCommand('readyUp')) return;
  sfxReady();
  me.ready = true;
  renderRoomLobby();
});

$('startGameBtn').addEventListener('click', () => {
  emitRoomCommand('startGame');
});

// Category toggle click handler
$('categoryTogglesRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.category-toggle');
  if (!btn) return;
  if (!isHost) return;
  const cat = btn.dataset.category;
  if (!cat || typeof roomCategories[cat] === 'undefined') return;
  if (!canSendRoomCommand()) {
    showToast('Still reconnecting — try again in a moment');
    return;
  }
  roomCategories[cat] = !roomCategories[cat];
  renderCategoryToggles();
  socket.emit('updateCategories', roomCategories);
});

// Explicit leave: do not clear the local room until the server acknowledges
// with roomLeft. Unload/pagehide never emits this.
$('leaveRoomLobbyBtn').addEventListener('click', () => {
  emitRoomCommand('leaveRoom');
});

$('copyRoomCodeBtn').addEventListener('click', () => {
  if (myRoomCode) {
    copyToClipboard(myRoomCode).then(() => showToast('Room code copied to clipboard'));
  }
});

$('copyInviteLinkBtn').addEventListener('click', () => {
  if (myRoomCode) {
    const link = window.location.origin + '/?room=' + myRoomCode;
    copyToClipboard(link).then(() => showToast('Invite link copied to clipboard'));
  }
});

// === Word input — on-screen keyboard, hardware typing, validation ===
const WORD_DEFAULT_FEEDBACK = 'Tap or type · ⌫ delete · Enter submit';

function isEditableElement(el) {
  return el instanceof Element &&
    !!el.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

function isGameScreenActive() {
  return $('gameScreen').classList.contains('active') &&
    !document.querySelector('.modal-overlay.active');
}

function isWordInputOpen() {
  if (soloMode) {
    return isGameScreenActive() &&
      soloActive &&
      !submitted &&
      !!roundDeadline &&
      Date.now() < roundDeadline;
  }
  return isGameScreenActive() &&
    socket.connected &&
    !browserOffline &&
    authoritativeReady &&
    !!myPlayerId &&
    !submitted &&
    !!roundDeadline &&
    serverNow() < roundDeadline;
}

function setWordFeedback(message, state = '') {
  const el = $('wordFeedback');
  if (!el) return;
  if (el.textContent !== message) el.textContent = message;
  el.classList.toggle('feedback-error', state === 'error');
  el.classList.toggle('feedback-success', state === 'success');
}

function renderWordDisplay() {
  const display = $('wordDisplay');
  const value = $('wordDisplayValue');
  const announceEl = $('wordDisplayAnnounce');
  if (!display || !value) return;

  const hasWord = currentWord.length > 0;
  display.classList.toggle('empty', !hasWord);
  display.classList.toggle('submitted', submitted);
  value.textContent = hasWord
    ? currentWord
    : (submitted ? 'WAITING…' : 'TAP OR TYPE');

  if (announceEl) {
    if (submitted) {
      announceEl.textContent = 'Word submitted. Waiting for the round to end.';
    } else if (hasWord) {
      announceEl.textContent = `Current word: ${currentWord.split('').join(' ')}. ${currentWord.length} ${currentWord.length === 1 ? 'letter' : 'letters'}.`;
    } else {
      announceEl.textContent = 'No letters entered.';
    }
  }
}

function setKeyboardEnabled(enabled) {
  document.querySelectorAll('#gameKeyboard .word-key').forEach(btn => {
    btn.disabled = !enabled;
  });
  const submitBtn = $('submitWordBtn');
  if (submitBtn) submitBtn.disabled = !enabled;
}

function resetWordEntry() {
  currentWord = '';
  submitted = false;
  const display = $('wordDisplay');
  if (display) display.classList.remove('submitted', 'invalid');
  setKeyboardEnabled(true);
  setWordFeedback(WORD_DEFAULT_FEEDBACK);
  renderWordDisplay();
}

function appendWordText(text) {
  if (!isWordInputOpen()) return;
  const cleaned = String(text || '').toUpperCase().replace(/[^A-Z-]/g, '');
  if (!cleaned) return;

  const remaining = WORD_MAX_LENGTH - currentWord.length;
  currentWord += cleaned.slice(0, remaining);
  const display = $('wordDisplay');
  if (display) display.classList.remove('invalid');

  if (cleaned.length > remaining) {
    setWordFeedback(`Maximum ${WORD_MAX_LENGTH} characters`, 'error');
  } else {
    setWordFeedback(WORD_DEFAULT_FEEDBACK);
  }
  renderWordDisplay();
}

function appendLetter(letter) {
  appendWordText(letter);
}

function deleteLastLetter() {
  if (!isWordInputOpen() || currentWord.length === 0) return;
  currentWord = currentWord.slice(0, -1);
  const display = $('wordDisplay');
  if (display) display.classList.remove('invalid');
  setWordFeedback(WORD_DEFAULT_FEEDBACK);
  renderWordDisplay();
}

function handleWordSubmit() {
  if (!isGameScreenActive() || submitted) return;

  // No offline replay: a multiplayer submission typed while the transport or
  // restore is not ready is dropped, not buffered for later. Solo is local and
  // never consults socket state.
  if (!soloMode && (!socket.connected || browserOffline || !authoritativeReady)) {
    setWordFeedback(browserOffline ? 'Offline' : 'Reconnecting…', 'error');
    showToast(browserOffline
      ? 'You are offline — try again when the connection returns'
      : 'Still reconnecting — try again in a moment');
    return;
  }

  const nowMs = soloMode ? Date.now() : serverNow();
  if (!roundDeadline || nowMs >= roundDeadline) {
    setWordFeedback("Time's up", 'error');
    setKeyboardEnabled(false);
    if (soloMode && soloActive && !soloRoundEnding) endSoloRound();
    return;
  }

  const word = currentWord.toLowerCase();
  if (!word) {
    setWordFeedback('Type a word first', 'error');
    announceAlert('Type a word first');
    return;
  }

  const result = validateClientWord(word, currentStartLetter, currentEndLetter);
  if (!result.valid) {
    sfxInvalid();
    const display = $('wordDisplay');
    if (display) display.classList.add('invalid');
    setWordFeedback(result.reason, 'error');
    announceAlert(result.reason);
    setTimeout(() => {
      if (!submitted && display) display.classList.remove('invalid');
    }, 1000);
    return;
  }

  submitted = true;
  sfxSubmit();
  setKeyboardEnabled(false);
  renderWordDisplay();
  setWordFeedback('Word sent. Waiting for the round to end.', 'success');
  focusWordDisplay();

  if (!comfortPrefs.motionOff) {
    $('tile1').classList.add('glow-burst');
    $('tile2').classList.add('glow-burst');
    setTimeout(() => {
      $('tile1').classList.remove('glow-burst');
      $('tile2').classList.remove('glow-burst');
    }, 600);
  }

  if (soloMode) {
    const timeTaken = Math.max(0, (Date.now() - soloRoundStartTime) / 1000);
    soloSubmission = { word, isValid: true, timeTaken };
    announce(`Word submitted: ${word}. Waiting for round to end.`);
    // Let the locked display and success feedback land before the result screen.
    setTimeout(() => {
      if (soloMode && soloActive && !soloRoundEnding) endSoloRound();
    }, 250);
    return;
  }

  socket.emit('submitWord', {
    word,
    matchId: currentMatchId,
    round: currentRound
  });
  announce(`Word submitted: ${word}. Waiting for round to end.`);
}

function focusWordDisplay(delay = 0) {
  const doFocus = () => {
    if (!isGameScreenActive()) return;
    const display = $('wordDisplay');
    if (display) display.focus({ preventScroll: true });
  };
  if (delay > 0) setTimeout(doFocus, delay);
  else doFocus();
}

// On-screen keyboard buttons — data-key letters/hyphen, data-action backspace.
// A real pointer tap focuses the button. After acting on it, hand focus back to
// the non-editable answer display so hardware Enter submits instead of
// re-activating the last letter. Keyboard/AT activation (detail 0, no pointer
// origin) deliberately keeps focus on the button for accessible semantics.
let pointerActivatedKey = null;
let pointerActivationTimer = null;

$('gameKeyboard').addEventListener('pointerdown', (e) => {
  const key = e.target.closest('.word-key');
  if (!key || key.disabled) return;
  pointerActivatedKey = key;
  clearTimeout(pointerActivationTimer);
  pointerActivationTimer = setTimeout(() => {
    pointerActivatedKey = null;
  }, 700);
});

$('gameKeyboard').addEventListener('pointercancel', () => {
  pointerActivatedKey = null;
  clearTimeout(pointerActivationTimer);
});

$('gameKeyboard').addEventListener('click', (e) => {
  const key = e.target.closest('.word-key');
  if (!key || key.disabled) return;

  const pointerOrigin = pointerActivatedKey === key && e.detail > 0;
  pointerActivatedKey = null;
  clearTimeout(pointerActivationTimer);

  if (key.dataset.action === 'backspace') {
    deleteLastLetter();
  } else if (key.dataset.key) {
    appendLetter(key.dataset.key);
  }

  if (pointerOrigin) focusWordDisplay();
});

$('submitWordBtn').addEventListener('click', handleWordSubmit);

// Hardware keyboards: type letters, hyphen, Delete/Backspace, Enter.
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
  if (!isGameScreenActive() || submitted) return;
  if (isEditableElement(e.target)) return;

  const targetIsAction = e.target instanceof Element &&
    !!e.target.closest('button, a, [role="button"]');

  if (e.key === 'Enter') {
    // Let a focused button activate natively; don't double-submit.
    if (targetIsAction) return;
    e.preventDefault();
    handleWordSubmit();
    return;
  }

  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    deleteLastLetter();
    return;
  }

  if (e.key === ' ') {
    if (targetIsAction) return;
    e.preventDefault();
    return;
  }

  if (/^[a-zA-Z-]$/.test(e.key)) {
    e.preventDefault();
    appendLetter(e.key);
  }
});

// Preserve paste/desktop entry from the old textbox, restricted to the
// dictionary alphabet (letters/hyphen) and the old 20-character cap.
document.addEventListener('paste', (e) => {
  if (!isWordInputOpen() || isEditableElement(e.target)) return;
  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  if (!text) return;
  const cleaned = text.toUpperCase().replace(/[^A-Z-]/g, '');
  if (!cleaned) return;
  e.preventDefault();
  appendWordText(cleaned);
});

// Keep the newest submission chip visible in the one-row status strip without
// changing the strip's height (which would move the keyboard). The fade only
// appears when the strip actually overflows, so a partly-scrolled chip reads as
// scrollable rather than clipped.
const submissionsEl = $('submissionsStatus');
function updateSubmissionOverflow() {
  if (!submissionsEl) return;
  submissionsEl.classList.toggle(
    'is-scrollable',
    submissionsEl.scrollWidth > submissionsEl.clientWidth + 1
  );
}
if (submissionsEl && window.MutationObserver) {
  new MutationObserver(() => {
    requestAnimationFrame(() => {
      submissionsEl.scrollLeft = submissionsEl.scrollWidth;
      updateSubmissionOverflow();
    });
  }).observe(submissionsEl, { childList: true });
  window.addEventListener('resize', updateSubmissionOverflow);
  updateSubmissionOverflow();
}

// === End screen buttons ===
let playAgainVoted = false;

$('playAgainBtn').addEventListener('click', () => {
  if (soloMode) {
    startSoloRun();
    return;
  }
  if (playAgainVoted) return;
  emitRoomCommand('requestPlayAgain');
});

// Explicit return-to-lobby also waits for the server's roomLeft ack. Unload
// never calls this (it is a transport disconnect only).
$('returnToLobbyBtn').addEventListener('click', () => {
  if (soloMode) {
    exitSoloMode();
    return;
  }
  emitRoomCommand('returnToLobby');
});

// === Profile modal handlers ===
function openProfileModal() {
  const profile = loadProfile();
  $('profileNameInput').value = profile ? profile.name || '' : '';
  const savedEmoji = profile ? profile.emoji : 'diamond';
  document.querySelectorAll('.emoji-option').forEach(btn => {
    const isSelected = btn.dataset.emoji === savedEmoji;
    btn.classList.toggle('selected', isSelected);
    btn.setAttribute('aria-checked', String(isSelected));
  });
  // Sync comfort toggle with current preference
  const cb = $('comfortToggle');
  if (cb) cb.checked = !!comfortPrefs.enabled;
  $('profileModal').classList.add('active');
  // Focus first interactive element for keyboard users
  setTimeout(() => {
    const first = $('profileModal').querySelector('button, input, [tabindex]');
    if (first) first.focus({ preventScroll: true });
  }, 50);
}

function closeProfileModal() {
  $('profileModal').classList.remove('active');
}

$('profileBtn').addEventListener('click', openProfileModal);

const profileIndicatorEditBtn = $('profileIndicatorEditBtn');
if (profileIndicatorEditBtn) {
  profileIndicatorEditBtn.addEventListener('click', openProfileModal);
}

$('cancelProfileBtn').addEventListener('click', closeProfileModal);

$('profileModal').addEventListener('click', (e) => {
  if (e.target === $('profileModal')) closeProfileModal();
});

// === Tutorial (How to Play) modal ===
function openTutorialModal() {
  $('tutorialModal').classList.add('active');
  sfxReady();
}

function closeTutorialModal() {
  $('tutorialModal').classList.remove('active');
}

$('howToPlayBtn').addEventListener('click', openTutorialModal);
const tutorialCloseBtn = $('tutorialClose');
if (tutorialCloseBtn) tutorialCloseBtn.addEventListener('click', closeTutorialModal);

const tutorialGotItBtn = $('tutorialGotItBtn');
if (tutorialGotItBtn) tutorialGotItBtn.addEventListener('click', closeTutorialModal);

const tutorialCard = document.querySelector('.tutorial-modal-content');
if (tutorialCard) {
  tutorialCard.addEventListener('click', (e) => e.stopPropagation());
}

const tutorialModalEl = $('tutorialModal');
if (tutorialModalEl) {
  tutorialModalEl.addEventListener('click', (e) => {
    if (e.target === tutorialModalEl) closeTutorialModal();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('tutorialModal').classList.contains('active')) closeTutorialModal();
    if ($('profileModal').classList.contains('active')) closeProfileModal();
    if ($('challengeModal').classList.contains('active')) {
      if (pendingChallenge && pendingChallenge.mode === 'receive') {
        emitRoomCommand('declineChallenge', pendingChallenge.challengerId);
      }
      closeChallengeModal();
    }
  }
});

document.querySelectorAll('.emoji-option').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emoji-option').forEach(b => {
      b.classList.remove('selected');
      b.setAttribute('aria-checked', 'false');
    });
    btn.classList.add('selected');
    btn.setAttribute('aria-checked', 'true');
  });
});

// Comfort toggle wiring
$('comfortToggle').addEventListener('change', (e) => {
  setComfortMode(e.target.checked);
});

$('saveProfileBtn').addEventListener('click', () => {
  const name = $('profileNameInput').value.trim();
  const selectedEmoji = document.querySelector('.emoji-option.selected');
  const emoji = selectedEmoji ? selectedEmoji.dataset.emoji : 'diamond';
  if (name) {
    saveProfile({ name, emoji });
    myName = name;
    $('playerNameInput').value = name;
    const indicator = $('profileIndicator');
    if (indicator) {
      $('profileIndicatorEmoji').innerHTML = getAvatarSVG(emoji);
      $('profileIndicatorEmoji').style.color = AVATAR_COLORS[emoji] || 'var(--neon-cyan)';
      $('profileIndicatorName').textContent = name;
      indicator.style.display = 'flex';
    }
    // Sync the updated name with the server so subsequent room/challenge
    // actions use it (the server holds the authoritative name in onlinePlayers).
    // Only when we've already entered the lobby — the server has a profile row.
    if (myPlayerId) {
      _renamingViaProfile = true;
      if (!emitIfConnected('editName', name)) {
        _renamingViaProfile = false;
      }
    }
    showToast('Profile saved');
  }
  // Comfort Mode is already persisted via change handler; close modal regardless
  closeProfileModal();
});

// === Always-visible score hint ===
// The visible rows are keyed by stable player id and updated in place. That
// keeps the polite live region from re-announcing the whole roster whenever one
// score changes; ordering is score-descending with roster order as tie-break.
function updateScoreHint() {
  const container = $('scoreHint');
  const me = $('scoreHintYou');
  if (!container) return;

  const myScore = soloMode ? soloScore : roundScores.me;
  if (me) me.textContent = myScore;

  const meRow = $('scoreHintMeRow');
  if (meRow) meRow.setAttribute('aria-label', `You: ${formatPoints(myScore)}`);

  const bestRow = $('scoreHintBestRow');
  const bestEl = $('scoreHintBest');
  const emptyEl = $('scoreHintEmpty');

  if (soloMode) {
    if (bestRow) {
      bestRow.hidden = false;
      bestRow.setAttribute('aria-label', `Best score: ${formatPoints(soloBest)}`);
    }
    if (bestEl) bestEl.textContent = soloBest;
    if (emptyEl) emptyEl.hidden = true;
    container.querySelectorAll('.score-hint-opponent').forEach(el => el.remove());
    return;
  }

  if (bestRow) bestRow.hidden = true;

  const ordered = players
    .map((player, index) => ({
      id: player.id,
      name: player.name || 'Player',
      score: Number(player.score) || 0,
      index
    }))
    .filter(player => player.id !== myPlayerId)
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  if (emptyEl) emptyEl.hidden = ordered.length > 0;

  const existing = new Map();
  container.querySelectorAll('.score-hint-opponent').forEach(el => {
    if (el.dataset.pid) existing.set(el.dataset.pid, el);
    else el.remove();
  });
  for (const [pid, el] of existing) {
    if (!ordered.some(player => player.id === pid)) el.remove();
  }

  const nodes = new Map();
  for (const player of ordered) {
    let el = existing.get(player.id);
    if (!el) {
      el = document.createElement('span');
      el.className = 'score-hint-opponent';
      el.dataset.pid = player.id;
      const nameEl = document.createElement('span');
      nameEl.className = 'score-hint-opp-name';
      nameEl.setAttribute('aria-hidden', 'true');
      const scoreEl = document.createElement('span');
      scoreEl.className = 'score-hint-opp-score';
      scoreEl.setAttribute('aria-hidden', 'true');
      el.appendChild(nameEl);
      el.appendChild(scoreEl);
    }
    const nameEl = el.querySelector('.score-hint-opp-name');
    const scoreEl = el.querySelector('.score-hint-opp-score');
    if (nameEl && nameEl.textContent !== player.name) nameEl.textContent = player.name;
    if (scoreEl && scoreEl.textContent !== String(player.score)) scoreEl.textContent = player.score;
    el.dataset.name = player.name;
    el.dataset.score = String(player.score);
    const label = `${player.name}: ${formatPoints(player.score)}`;
    if (el.getAttribute('aria-label') !== label) el.setAttribute('aria-label', label);
    if (el.title !== label) el.title = label;
    nodes.set(player.id, el);
  }

  const currentOrder = [...container.querySelectorAll('.score-hint-opponent')]
    .map(el => el.dataset.pid)
    .join('|');
  const targetOrder = ordered.map(player => player.id).join('|');
  if (currentOrder !== targetOrder) {
    for (const player of ordered) container.appendChild(nodes.get(player.id));
  }
}
updateScoreHint();

// === Solo mode ===
// A complete local match using the same dictionary, pair pool, round screens
// and timer. No room/socket commands are ever emitted from this path.
function pickSoloPair() {
  const pairs = Object.keys(wordLookupClient)
    .filter(key => wordLookupClient[key] && wordLookupClient[key].size > 0);
  if (!pairs.length) return null;
  const key = pairs[Math.floor(Math.random() * pairs.length)];
  return [key[0].toUpperCase(), key[1].toUpperCase()];
}

function getSoloExamples(pair) {
  if (!Array.isArray(pair) || pair.length < 2) return null;
  const words = wordLookupClient[(pair[0] + pair[1]).toLowerCase()];
  if (!words || !words.size) return null;
  return [...words].slice(0, 5);
}

function startSoloRun() {
  const pairs = Object.keys(wordLookupClient)
    .filter(key => wordLookupClient[key] && wordLookupClient[key].size > 0);
  if (!pairs.length) {
    showToast('Dictionary is still loading — try again in a moment');
    return;
  }

  if (!soloMode) {
    soloReturnScreen = document.querySelector('.screen.active')?.id === 'lobbyScreen'
      ? 'lobbyScreen'
      : 'nameScreen';
  }

  clearTimeout(soloAdvanceTimer);
  soloAdvanceTimer = null;
  stopPhaseTimers();
  hideDisconnectBanners();

  soloMode = true;
  soloActive = true;
  soloRound = 0;
  soloScore = 0;
  soloRoundStartTime = 0;
  soloSubmission = null;
  soloRoundEnding = false;
  soloMatchId = 'solo-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  soloPreviousBest = Math.max(loadSoloBest(), soloBest || 0);
  soloBest = soloPreviousBest;
  roundScores = { me: 0, opp: 0 };
  roomCategories = { noun_adj_verb: true, countries: true, us_states: true, us_cities: true };

  const gameScreen = $('gameScreen');
  if (gameScreen) gameScreen.classList.add('solo-mode');
  document.body.classList.add('solo-mode');
  const roomCode = $('gameRoomCode');
  if (roomCode) {
    roomCode.textContent = 'SOLO';
    roomCode.setAttribute('aria-label', 'Solo mode');
  }
  const soloSummary = $('soloEndSummary');
  if (soloSummary) soloSummary.hidden = true;
  const newBestBadge = $('soloNewBestBadge');
  if (newBestBadge) newBestBadge.hidden = true;
  const playAgain = $('playAgainBtn');
  if (playAgain) playAgain.style.display = 'none';
  const returnButton = $('returnToLobbyBtn');
  if (returnButton) returnButton.textContent = 'MAIN MENU';

  renderSoloBestBadges();
  startSoloRound();
}

function startSoloRound() {
  if (!soloMode || !soloActive) return;
  clearTimeout(soloAdvanceTimer);
  soloAdvanceTimer = null;

  if (soloRound >= SOLO_TOTAL_ROUNDS) {
    finishSoloRun();
    return;
  }

  const pair = pickSoloPair();
  if (!pair) {
    showToast('No solo word pairs are available');
    exitSoloMode();
    return;
  }

  soloRound += 1;
  soloSubmission = null;
  soloRoundEnding = false;
  soloRoundStartTime = Date.now();
  roundDeadline = soloRoundStartTime + SOLO_ROUND_MS;
  currentRoundDuration = SOLO_ROUND_MS;
  currentRound = soloRound;
  totalRounds = SOLO_TOTAL_ROUNDS;
  currentStartLetter = pair[0];
  currentEndLetter = pair[1];
  currentMatchId = soloMatchId;
  roundScores = { me: soloScore, opp: 0 };

  applyRoundStart({
    round: soloRound,
    totalRounds: SOLO_TOTAL_ROUNDS,
    startLetter: pair[0],
    endLetter: pair[1],
    deadline: roundDeadline,
    timeLeft: SOLO_ROUND_MS / 1000,
    matchId: soloMatchId
  }, { solo: true });
  updateScoreHint();
}

function endSoloRound() {
  if (!soloMode || !soloActive || soloRoundEnding) return;
  soloRoundEnding = true;
  stopPhaseTimers();
  roundDeadline = null;

  const submission = soloSubmission;
  const isValid = !!(submission && submission.isValid);
  const bonus = isValid && submission.timeTaken <= (SOLO_BONUS_WINDOW_MS / 1000) ? 1 : 0;
  const points = isValid ? 1 + bonus : 0;
  soloScore += points;
  roundScores = { me: soloScore, opp: 0 };

  const pair = [currentStartLetter, currentEndLetter];
  const result = {
    playerId: SOLO_PLAYER_ID,
    name: 'You',
    word: isValid ? submission.word : '(no submission)',
    isValid,
    timeTaken: isValid ? submission.timeTaken : null,
    points,
    bonus,
    totalScore: soloScore
  };
  soloSubmission = null;

  applyRoundEnd({
    results: [result],
    pair,
    round: soloRound,
    totalRounds: SOLO_TOTAL_ROUNDS,
    examples: getSoloExamples(pair)
  }, { solo: true });
  updateScoreHint();

  // Keep the ending guard set until the next round starts. A submit-side
  // timeout can race the 10s timer; it must not score the same round twice.
  const finalRound = soloRound >= SOLO_TOTAL_ROUNDS;
  soloAdvanceTimer = setTimeout(() => {
    soloAdvanceTimer = null;
    if (!soloMode || !soloActive) return;
    if (finalRound) finishSoloRun();
    else startSoloRound();
  }, SOLO_RESULT_PAUSE_MS);
}

function finishSoloRun() {
  if (!soloMode) return;
  clearTimeout(soloAdvanceTimer);
  soloAdvanceTimer = null;
  stopPhaseTimers();
  roundDeadline = null;
  soloActive = false;

  const newBest = soloScore > soloPreviousBest;
  if (newBest) {
    soloBest = soloScore;
    saveSoloBest(soloScore);
  }
  renderSoloBestBadges();

  applyGameEnd({
    players: [{ id: SOLO_PLAYER_ID, name: 'You' }],
    rankings: [{ id: SOLO_PLAYER_ID, name: 'You', score: soloScore }],
    winnerId: SOLO_PLAYER_ID,
    isTie: false,
    canPlayAgain: true,
    solo: true,
    newBest,
    best: soloBest
  }, { solo: true, newBest });
}

function exitSoloMode(targetScreen = soloReturnScreen) {
  clearTimeout(soloAdvanceTimer);
  soloAdvanceTimer = null;
  stopPhaseTimers();

  soloMode = false;
  soloActive = false;
  soloRound = 0;
  soloScore = 0;
  soloRoundStartTime = 0;
  soloSubmission = null;
  soloRoundEnding = false;
  roundDeadline = null;
  currentRound = 0;
  currentMatchId = null;
  currentStartLetter = null;
  currentEndLetter = null;
  submitted = false;
  currentWord = '';

  const gameScreen = $('gameScreen');
  if (gameScreen) gameScreen.classList.remove('solo-mode');
  document.body.classList.remove('solo-mode');
  const roomCode = $('gameRoomCode');
  if (roomCode) {
    roomCode.textContent = '';
    roomCode.setAttribute('aria-label', 'Room code');
  }
  const soloSummary = $('soloEndSummary');
  if (soloSummary) soloSummary.hidden = true;
  const newBestBadge = $('soloNewBestBadge');
  if (newBestBadge) newBestBadge.hidden = true;
  const playAgain = $('playAgainBtn');
  if (playAgain) playAgain.style.display = 'none';
  const returnButton = $('returnToLobbyBtn');
  if (returnButton) returnButton.textContent = 'RETURN TO LOBBY';

  roundScores = { me: 0, opp: 0 };
  resetWordEntry();
  updateScoreHint();
  renderSoloBestBadges();

  const target = targetScreen === 'lobbyScreen' ? 'lobbyScreen' : 'nameScreen';
  showScreen(target, true);
  if (target === 'lobbyScreen') renderRoomLobby();
}

// === Round / game events ===
// nameConfirmed is identity/profile only. Screen routing is always driven by
// the authoritative roomStateRestored snapshot that follows a registration or
// resume, so a duplicate nameConfirmed (profile rename) can never eject a
// restored player back to the lobby.
socket.on('nameConfirmed', (data) => {
  if (!data || !data.playerId) return;
  myPlayerId = data.playerId;
  myName = data.name;

  if (typeof data.resumeToken === 'string' && data.resumeToken) {
    storeResumeToken(data.resumeToken);
    registrationPending = false;
    sessionExpiredHandled = false;
    resumeConflict = false;
    resumeNoticeShown = false;
    cancelResumeRetry();
  }

  const existingProfile = loadProfile();
  saveProfile({
    name: myName,
    emoji: existingProfile ? existingProfile.emoji : 'diamond'
  });

  // Profile renames also arrive as nameConfirmed (editName). This is a
  // background name sync — never redirect screens for it.
  if (_renamingViaProfile) {
    _renamingViaProfile = false;
    const me = players.find(p => p.id === myPlayerId);
    if (me) {
      me.name = myName;
      if (myRoomCode) renderRoomLobby();
      updateScoreHint();
    }
    return;
  }

  const me = players.find(p => p.id === myPlayerId);
  if (me && me.name !== myName) {
    me.name = myName;
    if (myRoomCode) renderRoomLobby();
    updateScoreHint();
  }

  syncComfortMode();
});

socket.on('onlinePlayers', (players) => {
  updateOnlinePlayersList(players);
});

socket.on('error', (data) => {
  if (data.code === 'category_mismatch' && submitted) {
    submitted = false;
    setKeyboardEnabled(true);
    const display = $('wordDisplay');
    if (display) display.classList.remove('submitted');
    renderWordDisplay();
    setWordFeedback(data.message || 'Word not in selected categories', 'error');
    announceAlert(data.message || 'Word not in selected categories');
    focusWordDisplay();
  }

  const lobbyErr = $('lobbyError');
  const nameErr = $('nameError');
  const visible = (el) => el && (el.offsetParent !== null || el.style.display === 'block');
  if (visible(lobbyErr)) {
    showError(data.message, 'lobbyError');
  } else if (visible(nameErr)) {
    showError(data.message, 'nameError');
  } else {
    showToast(data.message);
  }
});

// === Room events ===
socket.on('roomCreated', (data) => {
  applyRoomEntry(data);
});

socket.on('roomJoined', (data) => {
  applyRoomEntry(data);
});

socket.on('roomStateRestored', (data) => {
  applyRoomStateSnapshot(data);
});

socket.on('playerJoined', (data) => {
  if (!data) return;
  if (Array.isArray(data.players)) {
    setRoster(data.players, data.hostId);
  } else if (data.player && data.player.id) {
    const incoming = normalizePlayers([data.player])[0];
    const existing = players.find(p => p.id === incoming.id);
    if (existing) Object.assign(existing, incoming);
    else players.push(incoming);
    if (data.hostId !== undefined && data.hostId !== null) roomHostId = data.hostId;
    isHost = !!myPlayerId && roomHostId === myPlayerId;
    disconnectPlayers.delete(incoming.id);
    renderDisconnectBanner();
  }
  syncScoresFromRoster();
  renderRoomLobby();
});

socket.on('opponentDisconnected', (data) => {
  if (!data) return;
  if (Array.isArray(data.players)) setRoster(data.players, data.hostId);
  if (data.playerId) {
    disconnectPlayers.set(data.playerId, data.playerName || 'Player');
  } else if (data.playerName) {
    disconnectPlayers.set('name:' + data.playerName, data.playerName);
  }
  renderDisconnectBanner();
  renderRoomLobby();
  recomputeFinishedRematch();
});

socket.on('playerRejoined', (data) => {
  if (!data) return;
  if (Array.isArray(data.players)) setRoster(data.players, data.hostId);
  if (data.playerId) disconnectPlayers.delete(data.playerId);
  renderDisconnectBanner();
  renderRoomLobby();
  recomputeFinishedRematch();
});

socket.on('playerUpdated', (data) => {
  if (!data) return;
  if (Array.isArray(data.players)) {
    setRoster(data.players, data.hostId);
  } else if (data.playerId) {
    const player = players.find(p => p.id === data.playerId);
    if (player && data.name) player.name = data.name;
    if (data.hostId !== undefined && data.hostId !== null) roomHostId = data.hostId;
    isHost = !!myPlayerId && roomHostId === myPlayerId;
  }
  const me = players.find(p => p.id === myPlayerId);
  if (me && me.name) myName = me.name;
  syncScoresFromRoster();
  renderRoomLobby();
  recomputeFinishedRematch();
});

socket.on('playerLobbyReady', (data) => {
  if (!data) return;
  if (Array.isArray(data.players)) {
    setRoster(data.players, data.hostId);
  } else {
    const p = players.find(player => player.id === data.playerId);
    if (p) p.ready = true;
  }
  renderRoomLobby();
});

socket.on('playerLeft', (data) => {
  if (!data) return;
  if (Array.isArray(data.players)) {
    setRoster(data.players, data.hostId);
  } else {
    players = players.filter(p => p.id !== data.playerId);
    if (data.hostId !== undefined && data.hostId !== null) roomHostId = data.hostId;
    isHost = !!myPlayerId && roomHostId === myPlayerId;
  }
  if (data.playerId) disconnectPlayers.delete(data.playerId);
  renderDisconnectBanner();
  syncScoresFromRoster();

  if (!players.find(p => p.id === myPlayerId)) {
    hideDisconnectBanners();
    resetRoomState();
    showScreen('lobbyScreen', true);
    emitIfConnected('requestOnlinePlayers');
    return;
  }

  const gameScreen = $('gameScreen');
  const resultScreen = $('resultScreen');
  const endScreen = $('endScreen');
  const isMidGame = (gameScreen.classList.contains('active') ||
                     resultScreen.classList.contains('active') ||
                     endScreen.classList.contains('active'));
  if (isMidGame) {
    showToast('A player left the room');
  }
  renderRoomLobby();
  recomputeFinishedRematch();
});

socket.on('roomLeft', () => {
  if (soloMode) return;
  // Only a server ack clears the local room. Explicit leave / return-to-lobby
  // never mutate room state optimistically.
  authoritativeReady = true;
  hideDisconnectBanners();
  resetRoomState();
  showScreen('lobbyScreen', true);
  emitIfConnected('requestOnlinePlayers');
});

// A live roundStart and a restored snapshot roundStart share one renderer so
// a refresh cannot reset first-round scores or lose the cached duration.
function applyRoundStart(data, options = {}) {
  if (!data) return;
  if (soloMode && !options.solo) return; // server rounds never interrupt solo
  const restore = !!options.restore;
  const ownSubmission = options.ownSubmission || null;
  // A transport reconnect re-sends the same active round. Do not discard a
  // partially typed answer unless the match/round actually changed.
  const previousWord = currentWord;
  const previousRound = currentRound;
  const previousMatchId = currentMatchId;
  const previousSubmitted = submitted;

  stopPhaseTimers();
  currentRound = data.round;
  totalRounds = data.totalRounds || 10;
  roundDeadline = data.deadline || (serverNow() + (Number(data.timeLeft) || 10) * 1000);
  currentStartLetter = data.startLetter;
  currentEndLetter = data.endLetter;
  // timeLeft is the ORIGINAL round duration, not the remaining time.
  const roundSeconds = Number(data.timeLeft) || 10;
  currentRoundDuration = roundSeconds * 1000;
  if (data.matchId !== undefined && data.matchId !== null) currentMatchId = data.matchId;

  submitted = false;
  playAgainVoted = false;
  finishedGameEnd = null;
  finishedVoterIds = [];
  // Reset live scores only on a live first round. Restoring round 1 must keep
  // the authoritative roster score from before the refresh.
  if (!restore && data.round === 1) {
    roundScores = { me: soloMode ? soloScore : 0, opp: 0 };
  }

  $('currentRound').textContent = data.round;
  $('totalRounds').textContent = totalRounds;
  if ($('gameRoomCode')) $('gameRoomCode').textContent = soloMode ? 'SOLO' : (myRoomCode || '');
  $('tile1').textContent = data.startLetter;
  $('tile2').textContent = data.endLetter;
  $('tile1').classList.remove('bounce-in');
  $('tile2').classList.remove('bounce-in');
  void $('tile1').offsetWidth;
  $('tile1').classList.add('bounce-in');
  $('tile2').classList.add('bounce-in');

  const pairAnnounce = $('tilePairAnnounce');
  if (pairAnnounce) pairAnnounce.textContent = `Start letter ${data.startLetter}, end letter ${data.endLetter}`;

  // Close any OS keyboard left open from a lobby text field before the game
  // surface takes over. The answer display is deliberately not editable.
  if (document.activeElement instanceof Element && isEditableElement(document.activeElement)) {
    document.activeElement.blur();
  }
  resetWordEntry();
  $('submissionsStatus').innerHTML = '';

  if (restore) {
    renderSubmissionChipsFromRoster();
    if (ownSubmission && typeof ownSubmission === 'object') {
      submitted = true;
      currentWord = String(ownSubmission.word || '').toUpperCase();
      const display = $('wordDisplay');
      if (display) display.classList.add('submitted');
      renderWordDisplay();
      setKeyboardEnabled(false);
      setWordFeedback('Word sent. Waiting for the round to end.', 'success');
    } else {
      const me = players.find(p => p.id === myPlayerId);
      if (me && me.submitted) {
        submitted = true;
        setKeyboardEnabled(false);
        renderWordDisplay();
        setWordFeedback('Word sent. Waiting for the round to end.', 'success');
      }
    }
    syncScoresFromRoster();
  }

  const sameActiveRound = restore &&
    !previousSubmitted &&
    !!previousWord &&
    data.matchId !== undefined &&
    data.matchId !== null &&
    previousMatchId !== null &&
    previousMatchId !== undefined &&
    String(previousMatchId) === String(data.matchId) &&
    previousRound === data.round;
  if (sameActiveRound && !submitted && !ownSubmission && serverNow() < roundDeadline) {
    currentWord = previousWord.slice(0, WORD_MAX_LENGTH);
    renderWordDisplay();
    setWordFeedback(WORD_DEFAULT_FEEDBACK);
  }
  updateScoreHint();

  if (restore) {
    showScreen('gameScreen', true);
    focusWordDisplay(60);
    announce(`Reconnected. Round ${data.round} of ${totalRounds}. Type a word starting with ${data.startLetter} ending with ${data.endLetter}.`);
  } else {
    showScreen('gameScreen');
    showRoundBanner('ROUND ' + data.round);
    sfxRoundStart();
    // Focus after the screen transition so screen readers land on the word
    // display (a div, never a native input).
    focusWordDisplay(450);
    announce(`Round ${data.round} of ${totalRounds}. Type a word starting with ${data.startLetter} ending with ${data.endLetter}. ${roundSeconds} seconds.`);
  }

  startTimer();
  refreshInputAvailability();
  // The animated screen transition keeps #gameScreen from being .active until
  // its exit animation completes; re-evaluate once the new screen is live.
  setTimeout(refreshInputAvailability, 460);
}

socket.on('roundStart', (data) => {
  applyRoundStart(data);
});

socket.on('playerSubmitted', (data) => {
  if (!data || soloMode) return;
  if (data.playerId === myPlayerId) return;
  const rosterPlayer = players.find(player => player.id === data.playerId);
  if (rosterPlayer) rosterPlayer.submitted = true;
  const container = $('submissionsStatus');
  if (!container) return;
  if (container.querySelector(`[data-pid="${data.playerId}"]`)) return;
  const el = document.createElement('div');
  el.className = 'submission-item';
  el.dataset.pid = data.playerId;
  el.setAttribute('aria-label', `${data.playerName} submitted`);
  el.textContent = data.playerName;
  container.appendChild(el);
  // Update opponent-side score for the hint (server authoritative on totals in roundEnd)
  announceAlert(`${data.playerName} submitted a word`);
});

function applyRoundEnd(data, options = {}) {
  if (!data || !Array.isArray(data.results)) return;
  if (soloMode && !options.solo) return; // server rounds never interrupt solo
  const restore = !!options.restore;
  const meId = soloMode ? SOLO_PLAYER_ID : myPlayerId;
  stopPhaseTimers();
  roundDeadline = null;
  currentRound = data.round || currentRound;
  playAgainVoted = false;
  finishedGameEnd = null;
  finishedVoterIds = [];
  if (Array.isArray(data.pair) && data.pair.length >= 2) {
    currentStartLetter = String(data.pair[0]).toUpperCase();
    currentEndLetter = String(data.pair[1]).toUpperCase();
  }

  $('resultRound').textContent = data.round;

  const validResults = data.results.filter(r => r.isValid);
  let topPoints = -1;
  let roundWinnerIds = [];
  validResults.forEach(r => {
    if (r.points > topPoints) {
      topPoints = r.points;
      roundWinnerIds = [r.playerId];
    } else if (r.points === topPoints) {
      roundWinnerIds.push(r.playerId);
    }
  });
  const hasSingleWinner = roundWinnerIds.length === 1;
  const meResult = data.results.find(r => r.playerId === meId);
  if (meResult) roundScores.me = meResult.totalScore;
  const oppTotal = data.results
    .filter(r => r.playerId !== meId)
    .reduce((sum, r) => sum + (r.totalScore || 0), 0);
  roundScores.opp = oppTotal;
  // Keep the lobby roster authoritative for later snapshot-style reads and
  // for a refresh that happens between rounds. Solo has no roster.
  if (!soloMode) {
    for (const result of data.results) {
      const rosterPlayer = players.find(player => player.id === result.playerId);
      if (rosterPlayer) {
        rosterPlayer.score = result.totalScore || 0;
        rosterPlayer.submitted = false;
      }
    }
  }
  updateScoreHint();

  // Result cards — every result carries explicit status text, not color-only
  const resultsHTML = data.results.map((r, i) => {
    const isWinner = hasSingleWinner && roundWinnerIds.includes(r.playerId);
    const isYou = r.playerId === meId;
    const wordDisplay = r.word
      ? escapeHtml(r.word)
      : '<span class="result-empty">(no submission)</span>';
    return `
      <div class="result-card${isWinner ? ' winner-card' : ''}" style="animation-delay: ${i * 0.1}s">
        <div class="result-header">
          <span class="result-player">
            ${isWinner ? '<span class="winner-tag">Winner</span>' : ''}
            ${isYou ? 'You' : escapeHtml(r.name)}
          </span>
          <span class="result-points">+${formatPoints(r.points, true)}</span>
        </div>
        <div class="result-word">${wordDisplay}</div>
        <div class="result-meta">
          ${r.isValid ? `Submitted in ${r.timeTaken.toFixed(1)} seconds` : 'Invalid word'}
          ${r.bonus ? ' <span class="bonus">+1 speed bonus</span>' : ''}
        </div>
      </div>
    `;
  }).join('');

  $('resultCards').innerHTML = resultsHTML;

  if (data.examples && data.examples.length > 0) {
    $('examplesContainer').innerHTML = `
      <p class="examples-label">Other valid words for ${data.pair[0]}…${data.pair[1]}</p>
      <p class="examples-words">${data.examples.map(e => escapeHtml(e)).join(', ')}</p>
    `;
  } else {
    $('examplesContainer').innerHTML = '';
  }

  const scores = data.results.map(r => ({
    name: r.name,
    score: r.totalScore,
    isMe: r.playerId === meId,
    isWinner: roundWinnerIds.includes(r.playerId),
  }));
  const maxScore = Math.max(...scores.map(s => s.score), 1);
  const colors = ['var(--neon-magenta)', 'var(--neon-cyan)', 'var(--neon-yellow)', 'var(--neon-orange)'];

  $('resultScores').innerHTML = scores.map((s, i) => {
    const pct = (s.score / maxScore) * 100;
    const color = s.isMe ? 'var(--neon-green)' : colors[(i - 1 + colors.length) % colors.length];
    return `
      <div class="bar-row${s.isWinner ? ' round-winner' : ''}">
        <div class="bar-player">
          <span class="bar-name" style="color: ${color}">${s.isMe ? 'You' : escapeHtml(s.name)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill ${s.isMe ? 'you-bar' : 'opp-bar'}" data-target-width="${pct}" style="width: 0%; background: ${color}; box-shadow: inset 0 0 10px ${color}, 0 0 8px ${color};"></div>
        </div>
        <span class="bar-score ${s.isMe ? 'you-score' : 'opp-score'}" data-target-score="${s.score}" style="color: ${color};">0</span>
      </div>
    `;
  }).join('');

  setTimeout(() => {
    document.querySelectorAll('#resultScores .bar-fill').forEach(bar => {
      bar.style.width = bar.dataset.targetWidth + '%';
    });
    document.querySelectorAll('#resultScores .bar-score').forEach((el) => {
      const target = parseInt(el.dataset.targetScore, 10);
      animateValue(el, 0, target, 600);
    });
  }, 100);

  const advFill = document.querySelector('#autoAdvanceIndicator .auto-advance-fill');
  if (advFill) {
    advFill.style.animation = 'none';
    void advFill.offsetWidth;
    advFill.style.animation = '';
    advFill.style.animationDuration = soloMode ? `${SOLO_RESULT_PAUSE_MS}ms` : '';
  }
  const advLabel = $('autoAdvanceLabel');
  if (advLabel) {
    advLabel.textContent = soloMode && data.round >= totalRounds ? 'FINAL SCORE' : 'NEXT ROUND';
  }
  const advIndicator = $('autoAdvanceIndicator');
  if (advIndicator) {
    advIndicator.style.animation = 'none';
    void advIndicator.offsetWidth;
    advIndicator.style.animation = '';
  }

  showScreen('resultScreen', restore);
  renderDisconnectBanner();

  // Build an accessible summary of the round
  const meLine = meResult
    ? (meResult.isValid
      ? `You scored ${formatPoints(meResult.points)} with "${meResult.word}". Your total is ${formatPoints(meResult.totalScore)}.`
      : `Your word was invalid. Your total stays at ${formatPoints(meResult.totalScore)}.`)
    : '';
  const winnerLine = hasSingleWinner && roundWinnerIds.length
    ? (roundWinnerIds[0] === meId ? 'You won this round.' : `${escapeHtml((data.results.find(r => r.playerId === roundWinnerIds[0]) || {}).name || 'Someone')} won this round.`)
    : (roundWinnerIds.length > 1 ? 'This round was a tie.' : '');
  announce(`Round ${data.round} results. ${winnerLine} ${meLine}`);
}

socket.on('roundEnd', (data) => {
  applyRoundEnd(data);
});

function canRematchFromRoster() {
  return players.length >= 2 && players.every(player => player.connected !== false);
}

function renderRematchButton(canPlayAgain, expectedPlayerCount) {
  const button = $('playAgainBtn');
  if (!button || !finishedGameEnd) return;

  if (!canPlayAgain) {
    // Keep the stored vote/voter ids untouched; only the action is unavailable
    // while the finished room does not have enough connected players.
    button.style.display = 'none';
    button.disabled = true;
    button.textContent = 'PLAY AGAIN';
    return;
  }

  const playerCount = Number.isFinite(expectedPlayerCount) && expectedPlayerCount > 0
    ? expectedPlayerCount
    : players.length;
  const voteCount = finishedVoterIds.length;

  button.style.display = 'inline-block';
  if (voteCount > 0 && playerCount > 0 && voteCount >= playerCount) {
    button.textContent = 'STARTING…';
    button.disabled = true;
    return;
  }
  if (playAgainVoted) {
    button.textContent = 'READY ✓';
    button.disabled = true;
    return;
  }
  button.textContent = 'PLAY AGAIN';
  button.disabled = false;
}

// Membership/connectivity changes in a finished room can change server
// availability (canPlayAgain) after gameEnd was rendered. Reconcile the action
// from the current roster while preserving the authoritative votes — never
// re-run gameEnd rendering here.
function recomputeFinishedRematch() {
  if (soloMode) return;
  if (!finishedGameEnd) return;
  renderRematchButton(canRematchFromRoster());
}

function applyGameEnd(data, options = {}) {
  if (!data) return;
  if (soloMode && !options.solo) return; // server rounds never interrupt solo
  const restore = !!options.restore;
  const soloRun = soloMode || !!options.solo;
  const voterIds = Array.isArray(options.voterIds) ? options.voterIds : [];

  stopPhaseTimers();
  roundDeadline = null;
  hideDisconnectBanners();

  const sortedRankings = [...(data.rankings || [])].sort((a, b) => b.score - a.score);

  const rankingsHTML = sortedRankings.map((r, i) => {
    const isMe = r.id === myPlayerId || (soloRun && r.id === SOLO_PLAYER_ID);
    const youSuffix = isMe && !soloRun ? ' (you)' : '';
    let rankClass, place, placeLabel;
    if (i === 0) { rankClass = 'rank-gold'; place = '1st'; placeLabel = '1st place'; }
    else if (i === 1) { rankClass = 'rank-silver'; place = '2nd'; placeLabel = '2nd place'; }
    else if (i === 2) { rankClass = 'rank-bronze'; place = '3rd'; placeLabel = '3rd place'; }
    else { rankClass = 'rank-default'; place = `${i + 1}th`; placeLabel = `${i + 1}th place`; }
    return `
      <div class="ranking-row ${rankClass}${isMe ? ' me' : ''}" role="listitem">
        <span class="rank-place" aria-label="${placeLabel}">${place}</span>
        <span class="rank-name">${escapeHtml(r.name)}${youSuffix}</span>
        <span class="rank-score" aria-label="${formatPoints(r.score)}">${formatPoints(r.score, true)}</span>
      </div>
    `;
  }).join('');

  $('finalRankings').innerHTML = rankingsHTML;
  $('finalRankings').setAttribute('role', 'list');

  const winDisplay = $('winnerDisplay');
  winDisplay.classList.remove('win');
  winDisplay.classList.remove('tie');
  winDisplay.style.color = '';

  const soloSummary = $('soloEndSummary');
  const newBestBadge = $('soloNewBestBadge');
  const soloBestEnd = $('soloBestEnd');

  if (soloRun) {
    const score = sortedRankings.length ? sortedRankings[0].score : soloScore;
    const newBest = !!(options.newBest || data.newBest);
    const best = Number.isFinite(Number(data.best)) ? Number(data.best) : soloBest;
    winDisplay.textContent = newBest ? `NEW BEST — ${formatPoints(score)}!` : `SOLO SCORE ${formatPoints(score)}`;
    if (newBest) winDisplay.classList.add('win');
    if (soloSummary) soloSummary.hidden = false;
    if (soloBestEnd) soloBestEnd.textContent = String(best);
    if (newBestBadge) newBestBadge.hidden = !newBest;
    const playAgain = $('playAgainBtn');
    if (playAgain) {
      playAgain.style.display = 'inline-block';
      playAgain.disabled = false;
      playAgain.textContent = 'PLAY AGAIN';
    }
    const returnButton = $('returnToLobbyBtn');
    if (returnButton) returnButton.textContent = 'MAIN MENU';

    finishedGameEnd = null;
    finishedVoterIds = [];
    playAgainVoted = false;

    if (!restore) {
      if (newBest) {
        sfxWin();
        setTimeout(() => spawnConfetti(60), 400);
      } else if (score === 0) {
        sfxLose();
      }
    }
  } else {
    if (soloSummary) soloSummary.hidden = true;
    if (newBestBadge) newBestBadge.hidden = true;
    const returnButton = $('returnToLobbyBtn');
    if (returnButton) returnButton.textContent = 'RETURN TO LOBBY';

    if (data.isTie) {
      winDisplay.textContent = 'Tie game';
      winDisplay.classList.add('tie');
      if (!restore) sfxLose();
    } else {
      const winner = (data.players || []).find(p => p.id === data.winnerId);
      const isWinner = data.winnerId === myPlayerId;
      if (data.forfeit) {
        winDisplay.textContent = isWinner ? 'Opponent forfeited — you win!' : 'You forfeited';
      } else {
        winDisplay.textContent = isWinner ? 'You win!' : `${winner ? winner.name : 'Someone'} wins!`;
      }
      if (isWinner && !data.forfeit) {
        winDisplay.classList.add('win');
        if (!restore) {
          sfxWin();
          setTimeout(() => spawnConfetti(60), 400);
        }
      } else if (!restore) {
        sfxLose();
      }
    }

    finishedGameEnd = data;
    finishedVoterIds = [...voterIds];
    playAgainVoted = !!(myPlayerId && voterIds.includes(myPlayerId));
    renderRematchButton(data.canPlayAgain !== false);
  }

  showScreen('endScreen', restore);

  // Final standings announcement
  const standingLines = sortedRankings.map((r, i) => `${i + 1}. ${escapeHtml(r.name)} — ${formatPoints(r.score)}`).join('. ');
  if (soloRun) {
    const headline = winDisplay.textContent;
    const terminator = /[.!?]$/.test(headline) ? '' : '.';
    announce(`Solo run over. ${headline}${terminator} Best ${formatPoints(soloBest)}.`);
  } else {
    announce(`Game over. Final standings: ${standingLines}. ${winDisplay.textContent}`);
  }
}

socket.on('gameEnd', (data) => {
  applyGameEnd(data);
});

socket.on('playAgainVote', (data) => {
  if (!data || soloMode) return;
  const { playerCount, votedId, voterIds } = data;
  if (Array.isArray(voterIds)) {
    finishedVoterIds = [...voterIds];
  } else if (votedId && !finishedVoterIds.includes(votedId)) {
    finishedVoterIds.push(votedId);
  }
  if (votedId === myPlayerId ||
      (myPlayerId && finishedVoterIds.includes(myPlayerId))) {
    playAgainVoted = true;
  }
  if (!finishedGameEnd) return;
  // Record votes even while the button is temporarily hidden, then reconcile
  // the action. Never reset the local own-vote flag from a membership change.
  renderRematchButton(canRematchFromRoster(), playerCount);
});

socket.on('gameReset', (data) => {
  if (!data || soloMode) return;
  stopPhaseTimers();
  hideDisconnectBanners();
  if ($('resultCards')) $('resultCards').innerHTML = '';
  if ($('resultScores')) $('resultScores').innerHTML = '';
  if ($('examplesContainer')) $('examplesContainer').innerHTML = '';
  if ($('finalRankings')) $('finalRankings').innerHTML = '';
  if ($('winnerDisplay')) {
    $('winnerDisplay').textContent = '';
    $('winnerDisplay').classList.remove('win', 'tie');
  }

  if (data.code) myRoomCode = data.code;
  if (Array.isArray(data.players)) {
    setRoster(data.players, data.hostId);
  } else {
    if (data.hostId !== undefined && data.hostId !== null) roomHostId = data.hostId;
    isHost = !!myPlayerId && roomHostId === myPlayerId;
  }
  if (data.categories) roomCategories = { ...data.categories };
  playAgainVoted = false;
  finishedGameEnd = null;
  finishedVoterIds = [];
  currentRound = 0;
  roundDeadline = null;
  currentStartLetter = null;
  currentEndLetter = null;
  currentMatchId = null;
  submitted = false;
  currentWord = '';
  roundScores = { me: 0, opp: 0 };
  updateScoreHint();
  resetWordEntry();

  renderRoomLobby();
  showScreen('roomLobbyScreen', true);
  announce('New game starting. Returned to room lobby.');
});

socket.on('categoriesUpdated', (data) => {
  if (data && data.categories) {
    roomCategories = data.categories;
    renderCategoryToggles();
  }
});

socket.on('comfortModeUpdated', (data) => {
  if (!data) return;
  if (Array.isArray(data.players)) {
    setRoster(data.players, data.hostId);
  } else {
    const p = players.find(player => player.id === data.playerId);
    if (p) p.comfortMode = data.comfortMode;
  }
  renderRoomLobby();
});

// === Timer ===
function startTimer() {
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');
  lastAnnouncedSecond = -1;
  lastTimerAnnounceSecond = -1;

  function updateTimer() {
    const now = soloMode ? Date.now() : serverNow();
    const totalTime = currentRoundDuration;
    const remaining = Math.max(0, roundDeadline - now);
    const secondsLeft = Math.ceil(remaining / 1000);
    const progress = (remaining / totalTime) * 100;

    $('timerDisplay').textContent = secondsLeft;
    $('timerProgress').style.width = progress + '%';

    const timerRegion = $('srTimer');
    if (timerRegion) {
      timerRegion.textContent = `${secondsLeft} seconds remaining`;
    }

    if (secondsLeft <= 4 && secondsLeft !== lastAnnouncedSecond) {
      sfxTimerTick();
      lastAnnouncedSecond = secondsLeft;
    }

    // Polite live announcement only at 5s and 1s — never spams SR
    if ((secondsLeft === 5 || secondsLeft === 1) && secondsLeft !== lastTimerAnnounceSecond) {
      lastTimerAnnounceSecond = secondsLeft;
      const msg = secondsLeft === 5
        ? `5 seconds left in this round`
        : `1 second left`;
      announce(msg);
    }

    if (secondsLeft <= 4) {
      $('timerDisplay').classList.add('warning');
      $('timerBar').classList.add('critical');
      $('gameScreen').classList.add('screen-critical');
      document.body.classList.add('timer-critical');
    } else {
      $('timerDisplay').classList.remove('warning');
      $('timerBar').classList.remove('critical');
      $('gameScreen').classList.remove('screen-critical');
      document.body.classList.remove('timer-critical');
    }

    if (remaining <= 0) {
      clearInterval(timerInterval);
      $('timerBar').classList.remove('critical');
      $('gameScreen').classList.remove('screen-critical');
      document.body.classList.remove('timer-critical');
      setKeyboardEnabled(false);
      if (!submitted) {
        const display = $('wordDisplay');
        if (display) display.classList.remove('invalid');
        setWordFeedback("Time's up", 'error');
      }
      announce('Time up.');
      if (soloMode && soloActive && !soloRoundEnding) endSoloRound();
    }
  }

  updateTimer();
  timerInterval = setInterval(updateTimer, 100);
}

// === Init ===
(function initProfile() {
  // Restore comfort prefs first so all subsequent rendering uses correct scale
  loadComfortPrefs();
  applyComfortPrefs();
  watchSystemComfortPrefs();

  soloBest = loadSoloBest();
  renderSoloBestBadges();

  const profile = loadProfile();
  if (profile) {
    const nameInput = $('playerNameInput');
    if (nameInput) nameInput.value = profile.name || '';
    const indicator = $('profileIndicator');
    if (indicator && profile.emoji) {
      $('profileIndicatorEmoji').innerHTML = getAvatarSVG(profile.emoji);
      $('profileIndicatorEmoji').style.color = AVATAR_COLORS[profile.emoji] || 'var(--neon-cyan)';
      $('profileIndicatorName').textContent = profile.name || 'Player';
      indicator.style.display = 'flex';
    }
  }

  // Parse URL for ?room=CODE
  try {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get('room');
    if (roomCode) {
      const code = roomCode.toUpperCase().trim();
      autoJoinRoomCode = code;
      const joinInput = $('joinRoomInput');
      if (joinInput) joinInput.value = code;
    }
  } catch(e) {
    console.warn('URL parse failed:', e);
  }
})();
