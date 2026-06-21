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

function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screenId).classList.add('active');
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
  $('onlineCount').textContent = players.length;

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
  socket.emit('playerReady');
  $('readyUpLobbyBtn').disabled = true;
  $('readyUpLobbyBtn').textContent = 'Waiting...';
});

$('readyUpBtn').addEventListener('click', () => {
  socket.emit('playerReady');
  $('readyUpBtn').disabled = true;
  $('readyUpBtn').textContent = 'Waiting...';
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
        $('wordInput').classList.add('invalid-input');
        $('wordInput').placeholder = result.reason;
        setTimeout(() => {
          $('wordInput').classList.remove('invalid-input');
          $('wordInput').placeholder = 'Type a word...';
        }, 1000);
        return;
      }
      submitted = true;
      $('wordInput').disabled = true;
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
  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
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
  $('opponentStatus').textContent = '';

  submitted = false;
  hideChallengeModal();
  hideChallengeSentModal();

  showScreen('gameScreen');
  startTimer();
});

socket.on('playerSubmitted', (data) => {
  if (data.playerId !== myPlayerId) {
    $('opponentStatus').textContent = `${opponentName} submitted!`;
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
  $('opponentStatus').textContent = '';

  showScreen('gameScreen');
  startTimer();
});

socket.on('roundEnd', (data) => {
  clearInterval(timerInterval);

  const myResult = data.results.find(r => r.playerId === myPlayerId);
  const oppResult = data.results.find(r => r.playerId !== myPlayerId);

  $('resultRound').textContent = data.round;

  $('resultCards').innerHTML = data.results.map(r => `
    <div class="result-card">
      <div class="result-header">
        <span class="result-player" style="color: ${r.playerId === myPlayerId ? 'var(--neon-green)' : 'var(--neon-magenta)'}">${r.playerId === myPlayerId ? 'YOU' : opponentName}</span>
        <span class="result-points">+${r.points} PTS</span>
      </div>
      <div class="result-word">${r.word}</div>
      <div class="result-meta">
        ${r.isValid ? `GOT IT IN ${r.timeTaken.toFixed(1)}S` : 'INVALID WORD'}
        ${r.bonus ? ' <span class="bonus">(+1 SPEED BONUS)</span>' : ''}
      </div>
    </div>
  `).join('');

  if (data.examples && data.examples.length > 0) {
    $('examplesContainer').innerHTML = `
      <p class="examples-label">VALID WORDS FOR ${data.pair[0]}...${data.pair[1]}:</p>
      <p class="examples-words">${data.examples.join(', ')}</p>
    `;
  } else {
    $('examplesContainer').innerHTML = '';
  }

  $('resultScores').innerHTML = `
    <div class="score-item">
      <div class="score-value">${myResult?.totalScore || 0}</div>
      <div class="score-label">Your Score</div>
    </div>
    <div class="score-item">
      <div class="score-value">${oppResult?.totalScore || 0}</div>
      <div class="score-label">${opponentName}</div>
    </div>
  `;

  $('readyUpBtn').style.display = 'block';
  $('readyUpBtn').disabled = false;
  $('readyUpBtn').textContent = 'Ready Up';
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

  $('finalScores').innerHTML = data.players.map(p => `
    <div class="stat-item">
      <div class="stat-value">${p.score}</div>
      <div class="stat-label">${p.name}</div>
    </div>
  `).join('');

  if (data.isTie) {
    $('winnerDisplay').textContent = "It's a tie!";
  } else {
    const winner = data.players.find(p => p.id === data.winner);
    const isWinner = data.winner === myPlayerId;
    $('winnerDisplay').textContent = isWinner ? 'You win!' : `${winner.name} wins!`;
    $('winnerDisplay').style.color = isWinner ? '#43e97b' : '#f5576c';
  }

  showScreen('endScreen');
});

socket.on('opponentLeft', () => {
  clearInterval(timerInterval);
  alert(`${opponentName || 'Opponent'} left the game`);
  showScreen('lobbyScreen');
  socket.emit('requestOnlinePlayers');
});

socket.on('gameReset', (data) => {
  $('readyUpLobbyBtn').disabled = false;
  $('readyUpLobbyBtn').textContent = 'Ready Up';
  $('lobbyWaitingStatus').textContent = '';
  showScreen('readyScreen');
});

function startTimer() {
  clearInterval(timerInterval);

  function updateTimer() {
    const now = Date.now();
    const totalTime = 10000;
    const remaining = Math.max(0, roundDeadline - now);
    const secondsLeft = Math.ceil(remaining / 1000);
    const progress = (remaining / totalTime) * 100;

    $('timerDisplay').textContent = secondsLeft;
    $('timerProgress').style.width = progress + '%';

    if (secondsLeft <= 3) {
      $('timerDisplay').classList.add('warning');
    } else {
      $('timerDisplay').classList.remove('warning');
    }

    if (remaining <= 0) {
      clearInterval(timerInterval);
    }
  }

  updateTimer();
  timerInterval = setInterval(updateTimer, 100);
}