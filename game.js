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

let myPlayerId = null;
let myRoomCode = null;
let myName = null;
let isHost = false;
let opponentName = null;
let currentRound = 0;
let roundDeadline = null;
let currentStartLetter = null;
let currentEndLetter = null;
let timerInterval = null;
let submitted = false;
let wordLookupClient = {};
let currentChallengeId = null;
let challengeTimeoutInterval = null;
const CHALLENGE_TIMEOUT_SECONDS = 30;

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
let sfxTimerWarningInterval = null;

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

// === Profile & H2H storage ===
const STORAGE_PROFILE = 'wb_profile';
const STORAGE_H2H = 'wb_h2h';

function loadProfile() {
  try { return JSON.parse(localStorage.getItem(STORAGE_PROFILE)); } catch(e) { return null; }
}

function saveProfile(profile) {
  localStorage.setItem(STORAGE_PROFILE, JSON.stringify(profile));
}

function loadH2H() {
  try { return JSON.parse(localStorage.getItem(STORAGE_H2H)) || {}; } catch(e) { return {}; }
}

function saveH2H(h2h) {
  localStorage.setItem(STORAGE_H2H, JSON.stringify(h2h));
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

  // Clean up after animation
  setTimeout(() => {
    container.querySelectorAll('.confetti-particle').forEach(p => p.remove());
  }, 4500);
}

function showRoundBanner(text, isVS = false) {
  const existing = document.querySelector('.round-banner');
  if (existing) existing.remove();
  const banner = document.createElement('div');
  banner.className = 'round-banner' + (isVS ? ' vs-banner' : '');
  if (isVS) {
    const profile = loadProfile();
    banner.innerHTML = `
      <div class="vs-player vs-you">
        <span class="vs-avatar">${profile && profile.emoji ? getAvatarSVG(profile.emoji) : ''}</span>
        <span class="vs-name">YOU</span>
      </div>
      <div class="vs-divider">VS</div>
      <div class="vs-player vs-opponent">
        <span class="vs-name">${escapeHtml(text)}</span>
      </div>
    `;
  } else {
    banner.textContent = text;
  }
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), isVS ? 2000 : 1300);
}

function showFloatingReaction(emoji, x, y) {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  // Random horizontal drift
  el.style.animationDuration = (Math.random() * 0.5 + 1.3) + 's';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
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

function renderH2HList() {
  const h2h = loadH2H();
  const list = $('h2hList');
  if (!list) return;

  const entries = Object.entries(h2h).sort((a, b) => new Date(b[1].lastPlayed) - new Date(a[1].lastPlayed));

  if (entries.length === 0) {
    list.innerHTML = '<p class="h2h-empty">No matches yet</p>';
    return;
  }

  list.innerHTML = entries.map(([name, record]) => `
    <div class="h2h-row">
      <span class="h2h-name">${escapeHtml(name)}</span>
      <span class="h2h-stats">
        <span class="h2h-win">W:${record.wins}</span>
        <span class="h2h-loss">L:${record.losses}</span>
        <span class="h2h-tie">T:${record.ties}</span>
      </span>
    </div>
  `).join('');
}

function renderH2HSummary(opponentName, record) {
  const summary = $('h2hSummary');
  const content = $('h2hSummaryContent');
  if (!summary || !content) return;

  content.textContent = `${record.wins}W - ${record.losses}L - ${record.ties}T`;
  summary.style.display = 'block';
}

function showError(msg, elementId) {
  const el = $(elementId);
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

function playChallengeSound() {
  const audio = $('challengeSound');
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(e => console.log('Audio play failed:', e));
  }
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

function updateOnlinePlayersList(players) {
  const container = $('onlinePlayers');
  const countEl = $('onlineCount');
  const prevCount = parseInt(countEl.textContent || '0');
  countEl.textContent = players.length;

  if (players.length !== prevCount) {
    const onlineCountParent = $('onlineCount').parentElement;
    onlineCountParent.classList.remove('pulse');
    void onlineCountParent.offsetWidth;
    onlineCountParent.classList.add('pulse');
  }

  container.innerHTML = players
    .filter(p => p.id !== myPlayerId)
    .map(p => `
      <div class="player-item">
        <div class="player-name">
          <span class="status-dot status-${p.status === 'online' ? 'online' : 'busy'}"></span>
          <span class="player-name-text">${p.name}${p.id === myPlayerId ? ' (YOU)' : ''}</span>
        </div>
        ${p.status === 'online' && p.id !== myPlayerId ? `<button class="arcade-btn arcade-btn-magenta arcade-btn-small challenge-btn" data-id="${p.id}" data-name="${p.name}">CHALLENGE</button>` : ''}
        ${p.status !== 'online' ? '<span class="in-game-label">IN GAME</span>' : ''}
      </div>
    `).join('');

  container.querySelectorAll('.challenge-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.id;
      const targetName = btn.dataset.name;
      socket.emit('sendChallenge', targetId);
    });
  });
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
  // Show opponent's reaction coming from the right side
  const x = window.innerWidth - 60 + Math.random() * 40;
  const y = window.innerHeight * 0.3 + Math.random() * 100;
  showFloatingReaction(data.emoji, x, y);
});

loadWordLookup();

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

$('acceptChallengeBtn').addEventListener('click', () => {
  if (currentChallengeId) {
    socket.emit('acceptChallenge', currentChallengeId);
    hideChallengeModal();
  }
});

$('declineChallengeBtn').addEventListener('click', () => {
  if (currentChallengeId) {
    socket.emit('declineChallenge', currentChallengeId);
    hideChallengeModal();
  }
});

$('cancelChallengeBtn').addEventListener('click', () => {
  if (currentChallengeId) {
    socket.emit('cancelChallenge', currentChallengeId);
    hideChallengeSentModal();
  }
});

$('readyUpLobbyBtn').addEventListener('click', () => {
  sfxReady();
  socket.emit('playerReady');
  $('readyUpLobbyBtn').disabled = true;
  $('readyUpLobbyBtn').textContent = 'Waiting...';
  $('readyUpLobbyBtn').classList.remove('pulsing');
});

$('readyUpBtn').addEventListener('click', () => {
  sfxReady();
  socket.emit('playerReady');
  $('readyUpBtn').disabled = true;
  $('readyUpBtn').textContent = 'Waiting...';
  $('readyUpBtn').classList.remove('pulsing');
  $('waitingStatus').style.display = 'block';
  $('waitingStatus').textContent = 'Waiting for opponent...';
});

$('leaveRoomBtn').addEventListener('click', () => {
  socket.emit('leaveRoom');
  showScreen('lobbyScreen');
});

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

$('playAgainBtn').addEventListener('click', () => {
  socket.emit('restartGame');
});

$('returnToLobbyBtn').addEventListener('click', () => {
  socket.emit('returnToLobby');
  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
  renderH2HList();
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

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen && (activeScreen.id === 'readyScreen' || activeScreen.id === 'resultScreen')) {
      e.preventDefault();
      const readyBtn = activeScreen.id === 'readyScreen' ? $('readyUpLobbyBtn') : $('readyUpBtn');
      if (readyBtn && !readyBtn.disabled) {
        readyBtn.click();
      }
    }
  }
});

socket.on('nameConfirmed', (data) => {
  myPlayerId = data.playerId;
  myName = data.name;

  // Save name to profile (preserve existing emoji if set)
  const existingProfile = loadProfile();
  saveProfile({
    name: myName,
    emoji: existingProfile ? existingProfile.emoji : 'diamond'
  });

  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
  renderH2HList();
});

socket.on('onlinePlayers', (players) => {
  updateOnlinePlayersList(players);
});

socket.on('error', (data) => {
  showError(data.message, 'nameError');
});

socket.on('challengeReceived', (data) => {
  currentChallengeId = data.challengeId;
  $('challengerName').textContent = data.challengerName;
  showChallengeModal();
  playChallengeSound();
  startChallengeTimer(CHALLENGE_TIMEOUT_SECONDS);
});

socket.on('challengeSent', (data) => {
  currentChallengeId = data.challengeId;
  $('targetName').textContent = data.targetName;
  showChallengeSentModal();
  startSentChallengeTimer(CHALLENGE_TIMEOUT_SECONDS);
});

socket.on('challengeDeclined', (data) => {
  hideChallengeSentModal();
  alert(`${data.declinerName} declined your challenge`);
});

socket.on('challengeEnded', () => {
  hideChallengeModal();
  hideChallengeSentModal();
  currentChallengeId = null;
});

socket.on('challengeTimeout', () => {
  hideChallengeModal();
  hideChallengeSentModal();
  currentChallengeId = null;
  alert('Challenge timed out');
});

function showChallengeModal() {
  $('challengeModal').classList.add('active');
  $('challengeTimer').textContent = '';
}

function hideChallengeModal() {
  $('challengeModal').classList.remove('active');
  clearInterval(challengeTimeoutInterval);
  currentChallengeId = null;
}

function showChallengeSentModal() {
  $('challengeSentModal').classList.add('active');
  $('sentChallengeTimer').textContent = '';
}

function hideChallengeSentModal() {
  $('challengeSentModal').classList.remove('active');
  clearInterval(challengeTimeoutInterval);
  currentChallengeId = null;
}

function startChallengeTimer(seconds) {
  clearInterval(challengeTimeoutInterval);
  let remaining = seconds;
  $('challengeTimer').textContent = `Time remaining: ${remaining}s`;

  challengeTimeoutInterval = setInterval(() => {
    remaining--;
    $('challengeTimer').textContent = `Time remaining: ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(challengeTimeoutInterval);
    }
  }, 1000);
}

function startSentChallengeTimer(seconds) {
  clearInterval(challengeTimeoutInterval);
  let remaining = seconds;
  $('sentChallengeTimer').textContent = `Time remaining: ${remaining}s`;

  challengeTimeoutInterval = setInterval(() => {
    remaining--;
    $('sentChallengeTimer').textContent = `Time remaining: ${remaining}s`;
    if (remaining <= 0) {
      clearInterval(challengeTimeoutInterval);
    }
  }, 1000);
}

socket.on('gameStart', (data) => {
  myPlayerId = socket.id;
  myRoomCode = data.roomCode;
  isHost = data.isHost;
  currentRound = data.round;
  roundDeadline = data.deadline;
  currentStartLetter = data.startLetter;
  currentEndLetter = data.endLetter;

  opponentName = data.players.find(p => p.id !== socket.id)?.name || 'Opponent';

  $('currentRound').textContent = data.round;
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
  $('wordInput').focus();
  $('opponentStatus').textContent = '';

  submitted = false;
  hideChallengeModal();
  hideChallengeSentModal();

  showScreen('gameScreen');
  showRoundBanner(opponentName, true);
  startTimer();
});

socket.on('playerSubmitted', (data) => {
  if (data.playerId !== myPlayerId) {
    const status = $('opponentStatus');
    status.textContent = `${opponentName} submitted!`;
    status.classList.add('submitted-flash');
    setTimeout(() => status.classList.remove('submitted-flash'), 800);
  }
});

socket.on('roundStart', (data) => {
  currentRound = data.round;
  roundDeadline = data.deadline;
  currentStartLetter = data.startLetter;
  currentEndLetter = data.endLetter;
  submitted = false;

  $('currentRound').textContent = data.round;
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
  $('wordInput').focus();
  $('opponentStatus').textContent = '';

  showScreen('gameScreen');
  showRoundBanner('ROUND ' + data.round);
  sfxRoundStart();
  startTimer();
});

socket.on('roundEnd', (data) => {
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');

  const myResult = data.results.find(r => r.playerId === myPlayerId);
  const oppResult = data.results.find(r => r.playerId !== myPlayerId);

  $('resultRound').textContent = data.round;

  // Staggered card entries with round winner highlight
  const roundWinnerId = !myResult || !oppResult ? null
    : myResult.points > oppResult.points ? myPlayerId
    : oppResult.points > myResult.points ? oppResult.playerId
    : null;

  const resultsHTML = data.results.map((r, i) => `
    <div class="result-card${r.playerId === roundWinnerId ? ' winner-card' : ''}" style="animation-delay: ${i * 0.15}s">
      <div class="result-header">
        <span class="result-player" style="color: ${r.playerId === myPlayerId ? 'var(--neon-green)' : 'var(--neon-magenta)'}">
          ${r.playerId === roundWinnerId ? '👑 ' : ''}${r.playerId === myPlayerId ? 'YOU' : escapeHtml(opponentName)}
        </span>
        <span class="result-points">+${r.points} PTS</span>
      </div>
      <div class="result-word">${r.word}</div>
      <div class="result-meta">
        ${r.isValid ? `GOT IT IN ${r.timeTaken.toFixed(1)}S` : 'INVALID WORD'}
        ${r.bonus ? ' <span class="bonus">(+1 SPEED BONUS)</span>' : ''}
      </div>
    </div>
  `).join('');

  $('resultCards').innerHTML = resultsHTML;

  if (data.examples && data.examples.length > 0) {
    $('examplesContainer').innerHTML = `
      <p class="examples-label">VALID WORDS FOR ${data.pair[0]}...${data.pair[1]}:</p>
      <p class="examples-words">${data.examples.join(', ')}</p>
    `;
  } else {
    $('examplesContainer').innerHTML = '';
  }

  // Bar chart scores
  const myScore = myResult?.totalScore || 0;
  const oppScore = oppResult?.totalScore || 0;
  const maxScore = Math.max(myScore, oppScore, 1);
  const myPct = (myScore / maxScore) * 100;
  const oppPct = (oppScore / maxScore) * 100;

  const profile = loadProfile();
  const myAvatar = profile && profile.emoji ? getAvatarSVG(profile.emoji) : '';
  const roundWinner = myResult && oppResult
    ? (myResult.points > oppResult.points ? 'you' : oppResult.points > myResult.points ? 'opp' : null)
    : null;

  $('resultScores').innerHTML = `
    <div class="bar-row${roundWinner === 'you' ? ' round-winner' : ''}">
      <div class="bar-player">
        <span class="bar-avatar" style="color: ${AVATAR_COLORS[profile?.emoji] || 'var(--neon-cyan)'}">${myAvatar}</span>
        <span class="bar-name" style="color: var(--neon-green)">YOU</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill you-bar" id="myBar" style="width: 0%"></div>
      </div>
      <span class="bar-score you-score" id="myBarScore">0</span>
    </div>
    <div class="bar-row${roundWinner === 'opp' ? ' round-winner' : ''}">
      <div class="bar-player">
        <span class="bar-avatar" style="color: var(--neon-magenta)"></span>
        <span class="bar-name" style="color: var(--neon-magenta)">${escapeHtml(opponentName)}</span>
      </div>
      <div class="bar-track">
        <div class="bar-fill opp-bar" id="oppBar" style="width: 0%"></div>
      </div>
      <span class="bar-score opp-score" id="oppBarScore">0</span>
    </div>
  `;

  // Animate bars and scores
  setTimeout(() => {
    const myBar = $('myBar');
    const oppBar = $('oppBar');
    if (myBar) myBar.style.width = myPct + '%';
    if (oppBar) oppBar.style.width = oppPct + '%';
    animateValue($('myBarScore'), 0, myScore, 600);
    animateValue($('oppBarScore'), 0, oppScore, 600);
  }, 100);

  $('readyUpBtn').style.display = 'block';
  $('readyUpBtn').disabled = false;
  $('readyUpBtn').textContent = 'Ready Up';
  $('readyUpBtn').classList.add('pulsing');
  $('waitingStatus').style.display = 'none';

  showScreen('resultScreen');
});

socket.on('waitingForReady', () => {
  $('readyUpBtn').style.display = 'block';
  $('readyUpBtn').disabled = false;
  $('readyUpBtn').textContent = 'Ready Up';
  $('waitingStatus').style.display = 'none';
});

socket.on('playerReady', (data) => {
  if (data.playerId !== myPlayerId) {
    $('waitingStatus').style.display = 'block';
    $('waitingStatus').textContent = `${opponentName} is ready!`;
  }
});

socket.on('gameEnd', (data) => {
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');

  $('finalScores').innerHTML = data.players.map((p, i) => `
    <div class="stat-item" style="animation-delay: ${i * 0.2}s">
      <div class="stat-value">${p.score}</div>
      <div class="stat-label">${p.name}</div>
    </div>
  `).join('');

  const winDisplay = $('winnerDisplay');
  winDisplay.classList.remove('win');

  if (data.isTie) {
    winDisplay.textContent = "It's a tie!";
    winDisplay.style.color = 'var(--neon-yellow)';
    sfxLose();
  } else {
    const winner = data.players.find(p => p.id === data.winner);
    const isWinner = data.winner === myPlayerId;
    winDisplay.textContent = isWinner ? 'YOU WIN!' : `${winner.name} wins!`;
    if (isWinner) {
      winDisplay.classList.add('win');
      sfxWin();
      setTimeout(() => spawnConfetti(60), 400);
    } else {
      winDisplay.style.color = 'var(--neon-red)';
      sfxLose();
    }
  }

  // Update H2H record
  if (data.players && opponentName && myName) {
    const h2h = loadH2H();
    const opponent = data.players.find(p => p.name !== myName);
    if (opponent) {
      const record = h2h[opponent.name] || { wins: 0, losses: 0, ties: 0 };
      if (data.isTie) {
        record.ties++;
      } else if (data.winner === myPlayerId) {
        record.wins++;
      } else {
        record.losses++;
      }
      record.lastPlayed = new Date().toISOString();
      h2h[opponent.name] = record;
      saveH2H(h2h);

      // Show H2H summary on end screen
      renderH2HSummary(opponent.name, record);
    }
  }

  showScreen('endScreen');
});

socket.on('opponentLeft', () => {
  clearInterval(timerInterval);
  $('timerBar').classList.remove('critical');
  $('gameScreen').classList.remove('screen-critical');
  document.body.classList.remove('timer-critical');
  alert(`${opponentName || 'Opponent'} left the game`);
  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
});

socket.on('gameReset', (data) => {
  $('readyUpLobbyBtn').disabled = false;
  $('readyUpLobbyBtn').textContent = 'Ready Up';
  $('readyUpLobbyBtn').classList.add('pulsing');
  $('lobbyWaitingStatus').textContent = '';
  const h2hSummary = $('h2hSummary');
  if (h2hSummary) h2hSummary.style.display = 'none';
  showScreen('readyScreen');
});

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

// On page load, check for saved profile
(function initProfile() {
  const profile = loadProfile();
  if (profile) {
    // Pre-fill name input
    const nameInput = $('playerNameInput');
    if (nameInput) nameInput.value = profile.name || '';
    // Show profile indicator on name screen
    const indicator = $('profileIndicator');
    if (indicator && profile.emoji) {
      $('profileIndicatorEmoji').innerHTML = getAvatarSVG(profile.emoji);
      $('profileIndicatorEmoji').style.color = AVATAR_COLORS[profile.emoji] || 'var(--neon-cyan)';
      $('profileIndicatorName').textContent = profile.name || 'Player';
      indicator.style.display = 'flex';
    }
  }
})();