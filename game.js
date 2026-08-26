const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const socket = io({
  transports: isIOS ? ['polling', 'websocket'] : ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000
});

// Re-authenticate on reconnect (server connection state recovery fallback)
socket.on('connect', () => {
  // On a recovered connection the server already restored our session
  // (name, room, comfortMode) via roomStateRestored + nameConfirmed. Emitting
  // setName again would trigger a second nameConfirmed that could eject us
  // from the restored room/game view. Only fresh connections need setName.
  if (socket.recovered) {
    // Re-sync comfort mode preference for round timing
    if (comfortPrefs.enabled) {
      socket.emit('setComfortMode', { enabled: true });
    }
    return;
  }
  if (myName) {
    socket.emit('setName', myName);
  }
  // Re-sync comfort mode preference for round timing
  if (comfortPrefs.enabled) {
    socket.emit('setComfortMode', { enabled: true });
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) {
    socket.connect();
  }
});

window.addEventListener('offline', () => socket.disconnect());
window.addEventListener('online', () => {
  if (!socket.connected) socket.connect();
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
let timerInterval = null;
let lastAnnouncedSecond = -1;
let lastTimerAnnounceSecond = -1;
let submitted = false;
let restoredIntoRoom = false; // set when roomStateRestored re-places us in a room/game
let _renamingViaProfile = false; // set while an editName round-trip is in flight
let wordLookupClient = {};
let wordCategoriesClient = {};
let roomCategories = { noun_adj_verb: true, countries: true, us_states: true, us_cities: true };
let autoJoinRoomCode = null;  // from URL param ?room=
let roundScores = { me: 0, opp: 0 }; // live score feed for the always-visible hint

const $ = id => document.getElementById(id);

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
  if (!instant && current && current.id !== screenId) {
    current.classList.add('exiting');
    const handler = function() {
      current.removeEventListener('animationend', handler);
      if (_pendingTransition && _pendingTransition.handler === handler) {
        _pendingTransition = null;
      }
      current.classList.remove('active', 'exiting');
      const next = $(screenId);
      next.classList.add('active');
    };
    _pendingTransition = { el: current, handler };
    current.addEventListener('animationend', handler, { once: true });
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
  // Sync preference with server so round timing adjusts (next round only)
  socket.emit('setComfortMode', { enabled: !!enabled });
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
    const readyLabel = p.ready ? 'Ready' : 'Not ready';
    return `
      <div class="player-item${p.ready ? ' ready' : ''}${isRoomHost ? ' host' : ''}">
        <div class="player-name">
          <span class="player-name-text">${escapeHtml(p.name)}${isYou ? ' (you)' : ''}${isRoomHost ? '<span class="host-crown" aria-label="Host">Host</span>' : ''}${p.comfortMode ? '<span class="comfort-badge" aria-label="Comfort mode enabled">Comfort</span>' : ''}</span>
        </div>
        <span class="ready-badge ${p.ready ? 'ready-on' : 'ready-off'}" aria-label="${readyLabel}">${p.ready ? 'Ready' : 'Not ready'}</span>
      </div>
    `;
  }).join('');

  const readyCount = players.filter(p => p.ready).length;
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

  // Start Game button
  const startBtn = $('startGameBtn');
  if (isHost) {
    startBtn.style.display = 'inline-block';
    const allReady = players.length >= 2 && players.every(p => p.ready);
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

function resetRoomState() {
  myRoomCode = null;
  isHost = false;
  players = [];
  roomHostId = null;
  restoredIntoRoom = false;
  roundScores = { me: 0, opp: 0 };
  updateScoreHint();
}

// === Reaction emoji system ===
document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const emoji = btn.dataset.emoji;
    const rect = btn.getBoundingClientRect();
    const x = rect.left + rect.width / 2 - 12;
    const y = rect.top - 10;
    showFloatingReaction(emoji, x, y);
    socket.emit('sendReaction', emoji);
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
    socket.emit('challengePlayer', { targetId, categories: challengeCategories });
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
    socket.emit('acceptChallenge', pendingChallenge.challengerId);
    closeChallengeModal();
  });

  $('declineChallengeBtn').addEventListener('click', () => {
    if (!pendingChallenge) return;
    socket.emit('declineChallenge', pendingChallenge.challengerId);
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
      socket.emit('declineChallenge', pendingChallenge.challengerId);
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
  myRoomCode = data.roomCode;
  roomHostId = data.hostId;
  isHost = (data.hostId === myPlayerId);
  players = (data.players || []).map(p => ({ ...p }));
  roomCategories = data.categories || { ...roomCategories };
});

socket.on('challengeDeclined', (data) => {
  clearChallengeState();
  closeChallengeModal();
  showToast(`${data.targetName} declined your challenge`);
  socket.emit('requestOnlinePlayers');
});

socket.on('challengeExpired', (data) => {
  clearChallengeState();
  closeChallengeModal();
  if (data.targetName) {
    showToast(`Challenge to ${data.targetName} expired`);
  }
  socket.emit('requestOnlinePlayers');
});

socket.on('challengeCancelled', (data) => {
  clearChallengeState();
  closeChallengeModal();
  if (data.challengerName) {
    showToast(`${data.challengerName} cancelled the challenge`);
  }
  socket.emit('requestOnlinePlayers');
});

loadWordLookup();
loadWordCategories();

// === Name screen ===
$('enterLobbyBtn').addEventListener('click', () => {
  const name = $('playerNameInput').value.trim();
  if (!name) {
    showError('Please enter your name', 'nameError');
    return;
  }
  myName = name;
  socket.emit('setName', name);
});

$('playerNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const name = $('playerNameInput').value.trim();
    if (name) {
      myName = name;
      socket.emit('setName', name);
    }
  }
});

$('editNameBtn').addEventListener('click', () => {
  showScreen('nameScreen');
  $('playerNameInput').value = myName || '';
});

$('refreshLobbyBtn').addEventListener('click', () => {
  socket.emit('requestOnlinePlayers');
});

// === Room buttons ===
$('createRoomBtn').addEventListener('click', () => {
  if (!myName) return;
  socket.emit('createRoom', myName);
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
  socket.emit('joinRoom', { code, name: myName });
});

$('joinRoomInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    $('joinRoomBtn').click();
  }
});

$('readyUpLobbyBtn').addEventListener('click', () => {
  sfxReady();
  const me = players.find(p => p.id === myPlayerId);
  if (me && !me.ready) {
    me.ready = true;
    renderRoomLobby();
    socket.emit('readyUp');
  }
});

$('startGameBtn').addEventListener('click', () => {
  socket.emit('startGame');
});

// Category toggle click handler
$('categoryTogglesRow').addEventListener('click', (e) => {
  const btn = e.target.closest('.category-toggle');
  if (!btn) return;
  if (!isHost) return;
  const cat = btn.dataset.category;
  if (!cat || typeof roomCategories[cat] === 'undefined') return;
  roomCategories[cat] = !roomCategories[cat];
  renderCategoryToggles();
  socket.emit('updateCategories', roomCategories);
});

$('leaveRoomLobbyBtn').addEventListener('click', () => {
  socket.emit('leaveRoom');
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

// === Word input ===
$('wordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !submitted) {
    const word = $('wordInput').value.trim();
    if (word) {
      const result = validateClientWord(word, currentStartLetter, currentEndLetter);
      if (!result.valid) {
        sfxInvalid();
        $('wordInput').classList.add('invalid-input');
        $('wordInput').placeholder = result.reason;
        announceAlert(result.reason);
        setTimeout(() => {
          $('wordInput').classList.remove('invalid-input');
          $('wordInput').placeholder = 'TYPE A WORD...';
        }, 1000);
        return;
      }
      submitted = true;
      sfxSubmit();
      $('wordInput').disabled = true;
      $('wordInput').classList.add('submitted-flash');
      setTimeout(() => $('wordInput').classList.remove('submitted-flash'), 600);
      if (!comfortPrefs.motionOff) {
        $('tile1').classList.add('glow-burst');
        $('tile2').classList.add('glow-burst');
        setTimeout(() => {
          $('tile1').classList.remove('glow-burst');
          $('tile2').classList.remove('glow-burst');
        }, 600);
      }
      socket.emit('submitWord', word);
      announce(`Word submitted: ${word}. Waiting for round to end.`);
    }
  }
});

// === End screen buttons ===
let playAgainVoted = false;

$('playAgainBtn').addEventListener('click', () => {
  if (playAgainVoted) return;
  socket.emit('requestPlayAgain');
});

$('returnToLobbyBtn').addEventListener('click', () => {
  socket.emit('returnToLobby');
  resetRoomState();
  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
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
        socket.emit('declineChallenge', pendingChallenge.challengerId);
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
      socket.emit('editName', name);
    }
    showToast('Profile saved');
  }
  // Comfort Mode is already persisted via change handler; close modal regardless
  closeProfileModal();
});

// === Always-visible score hint ===
function updateScoreHint() {
  const me = $('scoreHintYou');
  const opp = $('scoreHintOpp');
  if (me) me.textContent = roundScores.me;
  if (opp) opp.textContent = roundScores.opp;
}
updateScoreHint();

// === Round / game events ===
socket.on('nameConfirmed', (data) => {
  myPlayerId = data.playerId;
  myName = data.name;

  // Sync comfort mode preference with server for round timing
  if (comfortPrefs.enabled) {
    socket.emit('setComfortMode', { enabled: true });
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
    }
    return;
  }

  // Recovery safety: roomStateRestored has already re-placed us into an
  // existing room/game/result view. Do NOT eject back to the lobby.
  if (restoredIntoRoom) {
    restoredIntoRoom = false;
    const me = players.find(p => p.id === myPlayerId);
    if (me && me.name !== myName) {
      me.name = myName;
      renderRoomLobby();
    }
    return;
  }

  if (autoJoinRoomCode && myName) {
    socket.emit('joinRoom', { code: autoJoinRoomCode, name: myName });
    autoJoinRoomCode = null;
  } else {
    // Clear any stale room reference left over from a disconnect whose room no
    // longer exists before returning to the lobby.
    if (myRoomCode) resetRoomState();
    showScreen('lobbyScreen');
    socket.emit('requestOnlinePlayers');
  }
});

socket.on('onlinePlayers', (players) => {
  updateOnlinePlayersList(players);
});

socket.on('error', (data) => {
  if (data.code === 'category_mismatch' && submitted) {
    submitted = false;
    $('wordInput').disabled = false;
    $('wordInput').classList.remove('submitted-flash');
    $('wordInput').focus();
    $('wordInput').select();
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
  myRoomCode = data.code;
  roomHostId = data.hostId;
  isHost = true;
  players = (data.players || []).map(p => ({ ...p }));
  roomCategories = data.categories || { ...roomCategories };
  renderRoomLobby();
  showScreen('roomLobbyScreen');
});

socket.on('roomJoined', (data) => {
  myRoomCode = data.code;
  roomHostId = data.hostId;
  isHost = (data.hostId === myPlayerId);
  players = (data.players || []).map(p => ({ ...p }));
  roomCategories = data.categories || { ...roomCategories };
  renderRoomLobby();
  showScreen('roomLobbyScreen');
});

socket.on('roomStateRestored', (data) => {
  restoredIntoRoom = true;
  myRoomCode = data.code;
  roomHostId = data.hostId;
  isHost = (data.hostId === myPlayerId);
  players = (data.players || []).map(p => ({ ...p }));
  roomCategories = data.categories || { ...roomCategories };
  renderRoomLobby();
  if (data.state === 'lobby') {
    showScreen('roomLobbyScreen', true);
  }
});

socket.on('playerJoined', (data) => {
  const existing = players.find(p => p.id === data.player.id);
  if (!existing) {
    players.push({ ...data.player });
  }
  renderRoomLobby();
});

// Disconnect banner
let _disconnectBanner = null;
function _showDisconnectBanner(playerName) {
  _hideDisconnectBanner();
  const banner = document.createElement('div');
  banner.id = 'disconnectBanner';
  banner.className = 'disconnect-banner';
  banner.setAttribute('role', 'alert');
  banner.innerHTML = `<span class="disconnect-banner-icon" aria-hidden="true">!</span><span>${escapeHtml(playerName || 'Opponent')} disconnected. Waiting to reconnect.</span>`;
  document.body.appendChild(banner);
  announceAlert(`${playerName || 'Opponent'} disconnected`);
}
function _hideDisconnectBanner() {
  const el = document.getElementById('disconnectBanner');
  if (el) el.remove();
  _disconnectBanner = null;
}

socket.on('opponentDisconnected', (data) => {
  _showDisconnectBanner(data.playerName || 'Opponent');
});

socket.on('playerRejoined', (data) => {
  _hideDisconnectBanner();
  players = (data.players || []).map(p => ({ ...p }));
  roomHostId = data.hostId;
  isHost = (roomHostId === myPlayerId);
  renderRoomLobby();
});

socket.on('playerUpdated', (data) => {
  players = (data.players || []).map(p => ({ ...p }));
  roomHostId = data.hostId;
  isHost = (roomHostId === myPlayerId);
  renderRoomLobby();
});

socket.on('playerLobbyReady', (data) => {
  const p = players.find(p => p.id === data.playerId);
  if (p) {
    p.ready = true;
  }
  renderRoomLobby();
});

socket.on('playerLeft', (data) => {
  players = (data.players || []).map(p => ({ ...p }));
  roomHostId = data.hostId;
  isHost = (roomHostId === myPlayerId);

  if (!players.find(p => p.id === myPlayerId)) {
    _hideDisconnectBanner();
    resetRoomState();
    showScreen('lobbyScreen');
    socket.emit('requestOnlinePlayers');
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
});

socket.on('roomLeft', () => {
  _hideDisconnectBanner();
  resetRoomState();
  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
});

socket.on('roundStart', (data) => {
  currentRound = data.round;
  totalRounds = data.totalRounds || 10;
  roundDeadline = data.deadline;
  currentStartLetter = data.startLetter;
  currentEndLetter = data.endLetter;
  // Authoritative round duration from the server (defaults to 10s for
  // safety, but comfort rooms send 15s).
  const roundSeconds = Number(data.timeLeft) || 10;
  currentRoundDuration = roundSeconds * 1000;
  submitted = false;
  // Reset live scores for the new game (only on first round)
  if (data.round === 1) {
    roundScores = { me: 0, opp: 0 };
  }

  $('currentRound').textContent = data.round;
  $('totalRounds').textContent = totalRounds;
  if ($('gameRoomCode')) $('gameRoomCode').textContent = myRoomCode || '';
  $('tile1').textContent = data.startLetter;
  $('tile2').textContent = data.endLetter;
  $('tile1').classList.remove('bounce-in');
  $('tile2').classList.remove('bounce-in');
  void $('tile1').offsetWidth;
  $('tile1').classList.add('bounce-in');
  $('tile2').classList.add('bounce-in');

  const pairAnnounce = $('tilePairAnnounce');
  if (pairAnnounce) pairAnnounce.textContent = `Start letter ${data.startLetter}, end letter ${data.endLetter}`;

  $('wordInput').value = '';
  $('wordInput').disabled = false;
  $('wordInput').classList.remove('invalid-input');
  $('wordInput').placeholder = 'TYPE A WORD...';
  $('wordInput').focus();
  $('submissionsStatus').innerHTML = '';
  updateScoreHint();

  showScreen('gameScreen');
  showRoundBanner('ROUND ' + data.round);
  sfxRoundStart();
  // Polite live-region announcement for screen readers
  announce(`Round ${data.round} of ${totalRounds}. Type a word starting with ${data.startLetter} ending with ${data.endLetter}. ${roundSeconds} seconds.`);
  startTimer();
});

socket.on('playerSubmitted', (data) => {
  if (data.playerId === myPlayerId) return;
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

socket.on('roundEnd', (data) => {
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');

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
  const meResult = data.results.find(r => r.playerId === myPlayerId);
  if (meResult) roundScores.me = meResult.totalScore;
  const oppTotal = data.results
    .filter(r => r.playerId !== myPlayerId)
    .reduce((sum, r) => sum + (r.totalScore || 0), 0);
  roundScores.opp = oppTotal;
  updateScoreHint();

  // Result cards — every result carries explicit status text, not color-only
  const resultsHTML = data.results.map((r, i) => {
    const isWinner = hasSingleWinner && roundWinnerIds.includes(r.playerId);
    const isYou = r.playerId === myPlayerId;
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
          <span class="result-points">+${r.points} pts</span>
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
    isMe: r.playerId === myPlayerId,
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
  }
  const advIndicator = $('autoAdvanceIndicator');
  if (advIndicator) {
    advIndicator.style.animation = 'none';
    void advIndicator.offsetWidth;
    advIndicator.style.animation = '';
  }

  showScreen('resultScreen');

  // Build an accessible summary of the round
  const meLine = meResult
    ? (meResult.isValid ? `You scored ${meResult.points} points with "${meResult.word}". Your total is ${meResult.totalScore}.` : `Your word was invalid. Your total stays at ${meResult.totalScore}.`)
    : '';
  const winnerLine = hasSingleWinner && roundWinnerIds.length
    ? (roundWinnerIds[0] === myPlayerId ? 'You won this round.' : `${escapeHtml((data.results.find(r => r.playerId === roundWinnerIds[0]) || {}).name || 'Someone')} won this round.`)
    : (roundWinnerIds.length > 1 ? 'This round was a tie.' : '');
  announce(`Round ${data.round} results. ${winnerLine} ${meLine}`);
});

socket.on('gameEnd', (data) => {
  _hideDisconnectBanner();
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');

  const sortedRankings = [...(data.rankings || [])].sort((a, b) => b.score - a.score);

  const rankingsHTML = sortedRankings.map((r, i) => {
    const isMe = r.id === myPlayerId;
    let rankClass, place, placeLabel;
    if (i === 0) { rankClass = 'rank-gold'; place = '1st'; placeLabel = '1st place'; }
    else if (i === 1) { rankClass = 'rank-silver'; place = '2nd'; placeLabel = '2nd place'; }
    else if (i === 2) { rankClass = 'rank-bronze'; place = '3rd'; placeLabel = '3rd place'; }
    else { rankClass = 'rank-default'; place = `${i + 1}th`; placeLabel = `${i + 1}th place`; }
    return `
      <div class="ranking-row ${rankClass}${isMe ? ' me' : ''}" role="listitem">
        <span class="rank-place" aria-label="${placeLabel}">${place}</span>
        <span class="rank-name">${escapeHtml(r.name)}${isMe ? ' (you)' : ''}</span>
        <span class="rank-score" aria-label="${r.score} points">${r.score} pts</span>
      </div>
    `;
  }).join('');

  $('finalRankings').innerHTML = rankingsHTML;
  $('finalRankings').setAttribute('role', 'list');

  const winDisplay = $('winnerDisplay');
  winDisplay.classList.remove('win');
  winDisplay.classList.remove('tie');
  winDisplay.style.color = '';

  if (data.isTie) {
    winDisplay.textContent = 'Tie game';
    winDisplay.classList.add('tie');
    sfxLose();
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
      sfxWin();
      setTimeout(() => spawnConfetti(60), 400);
    } else {
      sfxLose();
    }
  }

  playAgainVoted = false;
  $('playAgainBtn').style.display = 'inline-block';
  $('playAgainBtn').textContent = 'PLAY AGAIN';
  $('playAgainBtn').disabled = false;

  showScreen('endScreen');

  // Final standings announcement
  const standingLines = sortedRankings.map((r, i) => `${i + 1}. ${escapeHtml(r.name)} — ${r.score} points`).join('. ');
  announce(`Game over. Final standings: ${standingLines}. ${winDisplay.textContent}`);
});

socket.on('playAgainVote', ({ voteCount, playerCount, votedId }) => {
  const btn = $('playAgainBtn');
  if (!btn) return;

  if (votedId === myPlayerId) {
    playAgainVoted = true;
    btn.textContent = 'READY ✓';
    btn.disabled = true;
  }

  if (voteCount >= playerCount) {
    btn.textContent = 'STARTING…';
    btn.disabled = true;
  } else if (voteCount > 0 && votedId !== myPlayerId) {
    btn.textContent = playAgainVoted ? 'READY ✓' : 'PLAY AGAIN';
  }
});

socket.on('gameReset', (data) => {
  _hideDisconnectBanner();
  if ($('resultCards')) $('resultCards').innerHTML = '';
  if ($('resultScores')) $('resultScores').innerHTML = '';
  if ($('examplesContainer')) $('examplesContainer').innerHTML = '';
  if ($('finalRankings')) $('finalRankings').innerHTML = '';
  if ($('winnerDisplay')) {
    $('winnerDisplay').textContent = '';
    $('winnerDisplay').classList.remove('win', 'tie');
  }

  players = (data.players || []).map(p => ({ ...p }));
  roomHostId = data.hostId;
  isHost = (roomHostId === myPlayerId);
  roomCategories = data.categories || { ...roomCategories };
  playAgainVoted = false;
  currentRound = 0;
  roundDeadline = null;
  currentStartLetter = null;
  currentEndLetter = null;
  submitted = false;
  roundScores = { me: 0, opp: 0 };
  updateScoreHint();
  clearInterval(timerInterval);

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
  const p = players.find(p => p.id === data.playerId);
  if (p) {
    p.comfortMode = data.comfortMode;
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
    const now = Date.now();
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
      announce('Time up.');
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
