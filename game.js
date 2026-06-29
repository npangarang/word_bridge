const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const socket = io({
  transports: isIOS ? ['polling', 'websocket'] : ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000
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
let roundDeadline = null;
let currentStartLetter = null;
let currentEndLetter = null;
let timerInterval = null;
let submitted = false;
let wordLookupClient = {};
let autoJoinRoomCode = null;  // from URL param ?room=

const $ = id => document.getElementById(id);

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

function sfxSubmit() { playBeep(600, 0.1); setTimeout(() => playBeep(900, 0.12), 80); }
function sfxInvalid() { playSweep(300, 80, 0.2, 'sawtooth'); }
function sfxTimerTick() { playBeep(1000, 0.04, 'square', 0.05); }
function sfxRoundStart() { playBeep(400, 0.08); setTimeout(() => playBeep(600, 0.1), 70); setTimeout(() => playBeep(900, 0.14), 140); }
function sfxWin() {
  playBeep(523, 0.12); setTimeout(() => playBeep(659, 0.12), 100);
  setTimeout(() => playBeep(784, 0.12), 200); setTimeout(() => playBeep(1047, 0.3), 300);
}
function sfxLose() { playSweep(400, 100, 0.4, 'sawtooth'); }
function sfxReady() { playBeep(700, 0.06); setTimeout(() => playBeep(1000, 0.08), 60); }

function showScreen(screenId, instant = false) {
  const current = document.querySelector('.screen.active');
  if (!instant && current && current.id !== screenId) {
    current.classList.add('exiting');
    current.addEventListener('animationend', function handler() {
      current.removeEventListener('animationend', handler);
      current.classList.remove('active', 'exiting');
      const next = $(screenId);
      next.classList.add('active');
    }, { once: true });
  } else {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active', 'exiting'));
    $(screenId).classList.add('active');
  }
}

// === Profile storage ===
const STORAGE_PROFILE = 'wb_profile';

function loadProfile() {
  try { return JSON.parse(localStorage.getItem(STORAGE_PROFILE)); } catch(e) { return null; }
}

function saveProfile(profile) {
  localStorage.setItem(STORAGE_PROFILE, JSON.stringify(profile));
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

function spawnConfetti(count) {
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
  const existing = document.querySelector('.round-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.className = 'round-banner';
  banner.textContent = text;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 1300);
}

function showFloatingReaction(emoji, x, y) {
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
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
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
          <span class="status-dot status-${p.status === 'online' ? 'online' : 'busy'}"></span>
          <span class="player-name-text">${escapeHtml(p.name)}</span>
        </div>
        ${p.status !== 'online' ? '<span class="in-game-label">IN GAME</span>' : ''}
      </div>
    `).join('');
}

// === Room lobby rendering ===
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
    return `
      <div class="player-item${p.ready ? ' ready' : ''}${isRoomHost ? ' host' : ''}">
        <div class="player-name">
          <span class="player-name-text">${escapeHtml(p.name)}${isYou ? ' (YOU)' : ''}${isRoomHost ? '<span class="host-crown">👑</span>' : ''}</span>
        </div>
        <span class="ready-badge ${p.ready ? 'ready-on' : 'ready-off'}">${p.ready ? 'READY' : '...'}</span>
      </div>
    `;
  }).join('');

  const readyCount = players.filter(p => p.ready).length;
  $('roomReadyStatus').textContent = `${readyCount}/${players.length} ready`;

  // Ready Up button reflects own state
  const me = players.find(p => p.id === myPlayerId);
  const readyBtn = $('readyUpLobbyBtn');
  if (me && me.ready) {
    readyBtn.textContent = 'READY';
    readyBtn.disabled = true;
    readyBtn.classList.remove('pulsing');
  } else {
    readyBtn.textContent = 'READY UP';
    readyBtn.disabled = false;
    readyBtn.classList.add('pulsing');
  }

  // Start Game button: host only, enabled when ≥2 players and all ready
  const startBtn = $('startGameBtn');
  if (isHost) {
    startBtn.style.display = 'inline-block';
    const allReady = players.length >= 2 && players.every(p => p.ready);
    startBtn.disabled = !allReady;
  } else {
    startBtn.style.display = 'none';
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for older browsers / non-https
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

function resetRoomState() {
  myRoomCode = null;
  isHost = false;
  players = [];
  roomHostId = null;
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

loadWordLookup();

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
  // One-way ready — disable button to prevent double-ready
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

$('leaveRoomLobbyBtn').addEventListener('click', () => {
  socket.emit('leaveRoom');
});

$('copyRoomCodeBtn').addEventListener('click', () => {
  if (myRoomCode) {
    copyToClipboard(myRoomCode).then(() => showToast('Room code copied!'));
  }
});

$('copyInviteLinkBtn').addEventListener('click', () => {
  if (myRoomCode) {
    const link = window.location.origin + '/?room=' + myRoomCode;
    copyToClipboard(link).then(() => showToast('Invite link copied!'));
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
        setTimeout(() => {
          $('wordInput').classList.remove('invalid-input');
          $('wordInput').placeholder = 'Type a word...';
        }, 1000);
        return;
      }
      submitted = true;
      sfxSubmit();
      $('wordInput').disabled = true;
      $('wordInput').classList.add('submitted-flash');
      setTimeout(() => $('wordInput').classList.remove('submitted-flash'), 600);
      $('tile1').classList.add('glow-burst');
      $('tile2').classList.add('glow-burst');
      setTimeout(() => {
        $('tile1').classList.remove('glow-burst');
        $('tile2').classList.remove('glow-burst');
      }, 600);
      socket.emit('submitWord', word);
    }
  }
});

// === End screen buttons ===
$('playAgainBtn').addEventListener('click', () => {
  socket.emit('restartGame');
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
  document.querySelectorAll('.emoji-option').forEach(btn => {
    btn.classList.remove('selected');
    if (profile && btn.dataset.emoji === profile.emoji) {
      btn.classList.add('selected');
    }
  });
  $('profileModal').classList.add('active');
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
$('tutorialClose').addEventListener('click', closeTutorialModal);
$('tutorialGotItBtn').addEventListener('click', closeTutorialModal);

// Close when clicking the backdrop (outside the card).
// stopPropagation on the card itself prevents backdrop click-through.
const tutorialCard = document.querySelector('.tutorial-modal-content');
if (tutorialCard) {
  tutorialCard.addEventListener('click', (e) => e.stopPropagation());
}
$('tutorialModal').addEventListener('click', (e) => {
  if (e.target === $('tutorialModal')) closeTutorialModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('tutorialModal').classList.contains('active')) {
    closeTutorialModal();
  }
});

document.querySelectorAll('.emoji-option').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.emoji-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
  });
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
  }
  closeProfileModal();
});

// === Socket event handlers ===

socket.on('nameConfirmed', (data) => {
  myPlayerId = data.playerId;
  myName = data.name;

  // Save name to profile (preserve existing emoji if set)
  const existingProfile = loadProfile();
  saveProfile({
    name: myName,
    emoji: existingProfile ? existingProfile.emoji : 'diamond'
  });

  // Auto-join if URL had ?room=code — skip lobby, go straight to room
  if (autoJoinRoomCode && myName) {
    socket.emit('joinRoom', { code: autoJoinRoomCode, name: myName });
    autoJoinRoomCode = null;
  } else {
    showScreen('lobbyScreen');
    socket.emit('requestOnlinePlayers');
  }
});

socket.on('onlinePlayers', (players) => {
  updateOnlinePlayersList(players);
});

socket.on('error', (data) => {
  // Show on whichever error element is currently visible/active
  const lobbyErr = $('lobbyError');
  const nameErr = $('nameError');
  if (lobbyErr && lobbyErr.offsetParent !== null) {
    showError(data.message, 'lobbyError');
  } else if (nameErr && nameErr.offsetParent !== null) {
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
  renderRoomLobby();
  showScreen('roomLobbyScreen');
});

socket.on('roomJoined', (data) => {
  myRoomCode = data.code;
  roomHostId = data.hostId;
  isHost = (data.hostId === myPlayerId);
  players = (data.players || []).map(p => ({ ...p }));
  renderRoomLobby();
  showScreen('roomLobbyScreen');
});

socket.on('playerJoined', (data) => {
  const existing = players.find(p => p.id === data.player.id);
  if (!existing) {
    players.push({ ...data.player });
  }
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
  // If host changed and I am the new host, update flag
  isHost = (roomHostId === myPlayerId);

  // Check if I'm still in the room
  if (!players.find(p => p.id === myPlayerId)) {
    // I was removed - go to lobby
    resetRoomState();
    showScreen('lobbyScreen');
    socket.emit('requestOnlinePlayers');
    return;
  }

  // If game is in progress and a player left, show toast
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
  resetRoomState();
  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
});

// === Round / game events ===
socket.on('roundStart', (data) => {
  currentRound = data.round;
  roundDeadline = data.deadline;
  currentStartLetter = data.startLetter;
  currentEndLetter = data.endLetter;
  submitted = false;

  $('currentRound').textContent = data.round;
  if ($('totalRounds')) $('totalRounds').textContent = data.totalRounds || 10;
  if ($('gameRoomCode')) $('gameRoomCode').textContent = myRoomCode || '';
  $('tile1').textContent = data.startLetter;
  $('tile2').textContent = data.endLetter;
  $('tile1').classList.remove('bounce-in');
  $('tile2').classList.remove('bounce-in');
  void $('tile1').offsetWidth;
  $('tile1').classList.add('bounce-in');
  $('tile2').classList.add('bounce-in');
  $('wordInput').value = '';
  $('wordInput').disabled = false;
  $('wordInput').classList.remove('invalid-input');
  $('wordInput').placeholder = 'TYPE A WORD...';
  $('wordInput').focus();
  $('submissionsStatus').innerHTML = '';

  showScreen('gameScreen');
  showRoundBanner('ROUND ' + data.round);
  sfxRoundStart();
  startTimer();
});

socket.on('playerSubmitted', (data) => {
  if (data.playerId === myPlayerId) return; // don't show own submission
  const container = $('submissionsStatus');
  if (!container) return;
  if (container.querySelector(`[data-pid="${data.playerId}"]`)) return;
  const el = document.createElement('div');
  el.className = 'submission-item';
  el.dataset.pid = data.playerId;
  el.textContent = data.playerName;
  container.appendChild(el);
});

socket.on('roundEnd', (data) => {
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');

  $('resultRound').textContent = data.round;

  // Determine round winner(s) by highest points (among valid submissions)
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

  // Result cards - one per player
  const resultsHTML = data.results.map((r, i) => {
    const isWinner = roundWinnerIds.includes(r.playerId);
    return `
      <div class="result-card${isWinner ? ' winner-card' : ''}" style="animation-delay: ${i * 0.1}s">
        <div class="result-header">
          <span class="result-player" style="color: ${r.playerId === myPlayerId ? 'var(--neon-green)' : 'var(--neon-magenta)'}">
            ${isWinner && hasSingleWinner ? '👑 ' : ''}${r.playerId === myPlayerId ? 'YOU' : escapeHtml(r.name)}
          </span>
          <span class="result-points">+${r.points} PTS</span>
        </div>
        <div class="result-word">${r.word ? escapeHtml(r.word) : '(no word)'}</div>
        <div class="result-meta">
          ${r.isValid ? `GOT IT IN ${r.timeTaken.toFixed(1)}S` : 'INVALID WORD'}
          ${r.bonus ? ' <span class="bonus">(+1 SPEED BONUS)</span>' : ''}
        </div>
      </div>
    `;
  }).join('');

  $('resultCards').innerHTML = resultsHTML;

  // Examples
  if (data.examples && data.examples.length > 0) {
    $('examplesContainer').innerHTML = `
      <p class="examples-label">VALID WORDS FOR ${data.pair[0]}...${data.pair[1]}:</p>
      <p class="examples-words">${data.examples.map(e => escapeHtml(e)).join(', ')}</p>
    `;
  } else {
    $('examplesContainer').innerHTML = '';
  }

  // Bar chart - all players
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
          <span class="bar-name" style="color: ${color}">${s.isMe ? 'YOU' : escapeHtml(s.name)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" data-target-width="${pct}" style="width: 0%; background: ${color}; box-shadow: inset 0 0 10px ${color}, 0 0 8px ${color};"></div>
        </div>
        <span class="bar-score" data-target-score="${s.score}" style="color: ${color};">0</span>
      </div>
    `;
  }).join('');

  // Animate bars and scores
  setTimeout(() => {
    document.querySelectorAll('#resultScores .bar-fill').forEach(bar => {
      bar.style.width = bar.dataset.targetWidth + '%';
    });
    document.querySelectorAll('#resultScores .bar-score').forEach((el) => {
      const target = parseInt(el.dataset.targetScore, 10);
      animateValue(el, 0, target, 600);
    });
  }, 100);

  // No ready button between rounds - server auto-advances after pause
  // Restart the auto-advance indicator animation by toggling it off→on
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
});

socket.on('gameEnd', (data) => {
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');

  // Rankings list - sort by score descending
  const sortedRankings = [...(data.rankings || [])].sort((a, b) => b.score - a.score);

  const rankingsHTML = sortedRankings.map((r, i) => {
    const isMe = r.id === myPlayerId;
    const rankClass = i === 0 ? 'rank-gold' : (i === 1 ? 'rank-silver' : (i === 2 ? 'rank-bronze' : 'rank-default'));
    const place = i === 0 ? '1ST' : (i === 1 ? '2ND' : (i === 2 ? '3RD' : `${i + 1}TH`));
    return `
      <div class="ranking-row ${rankClass}${isMe ? ' me' : ''}">
        <span class="rank-place">${place}</span>
        <span class="rank-name">${escapeHtml(r.name)}${isMe ? ' (YOU)' : ''}</span>
        <span class="rank-score">${r.score}</span>
      </div>
    `;
  }).join('');

  $('finalRankings').innerHTML = rankingsHTML;

  // Winner display
  const winDisplay = $('winnerDisplay');
  winDisplay.classList.remove('win');
  winDisplay.classList.remove('tie');
  winDisplay.style.color = '';

  if (data.isTie) {
    winDisplay.textContent = 'TIE!';
    winDisplay.classList.add('tie');
    sfxLose();
  } else {
    const winner = (data.players || []).find(p => p.id === data.winnerId);
    const isWinner = data.winnerId === myPlayerId;
    if (data.forfeit) {
      winDisplay.textContent = isWinner ? 'OPPONENT FORFEITED - YOU WIN!' : 'YOU FORFEITED';
    } else {
      winDisplay.textContent = isWinner ? 'YOU WIN!' : `${winner ? winner.name : 'Someone'} WINS!`;
    }
    if (isWinner && !data.forfeit) {
      winDisplay.classList.add('win');
      sfxWin();
      setTimeout(() => spawnConfetti(60), 400);
    } else {
      sfxLose();
    }
  }

  // Play Again: host only
  if (isHost) {
    $('playAgainBtn').style.display = 'inline-block';
  } else {
    $('playAgainBtn').style.display = 'none';
  }

  showScreen('endScreen');
});

socket.on('gameReset', (data) => {
  players = (data.players || []).map(p => ({ ...p }));
  roomHostId = data.hostId;
  isHost = (roomHostId === myPlayerId);
  renderRoomLobby();
  showScreen('roomLobbyScreen');
});

// === Timer ===
function startTimer() {
  clearInterval(timerInterval);

  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');

  let lastTickSecond = 99;

  function updateTimer() {
    const now = Date.now();
    const totalTime = 10000;
    const remaining = Math.max(0, roundDeadline - now);
    const secondsLeft = Math.ceil(remaining / 1000);
    const progress = (remaining / totalTime) * 100;

    $('timerDisplay').textContent = secondsLeft;
    $('timerProgress').style.width = progress + '%';

    if (secondsLeft <= 4 && secondsLeft !== lastTickSecond) {
      sfxTimerTick();
      lastTickSecond = secondsLeft;
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
    }
  }

  updateTimer();
  timerInterval = setInterval(updateTimer, 100);
}

// === Init ===
(function initProfile() {
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
      // Always set auto-join — works even on fresh devices without a saved profile
      autoJoinRoomCode = code;
      // Pre-fill join input as fallback
      const joinInput = $('joinRoomInput');
      if (joinInput) joinInput.value = code;
      // Show room code on name screen so user knows they're joining
      const subtitle = document.querySelector('.arcade-subtitle');
      if (subtitle) subtitle.textContent = 'JOIN ROOM ' + code;
    }
  } catch(e) {
    console.warn('URL parse failed:', e);
  }
})();