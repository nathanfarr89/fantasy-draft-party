const socket = io({ transports: ['websocket'] });

const SESSION_KEY = 'fdp-session';

let myId = null;
let roomCode = null;
let myPicks = [];
let selectedVoteTarget = null;
let gameState = null;
let lastTurnKey = null;
let wasOnDeck = false;
let resultsRendered = false;
let pickDeadline = null; // local-clock ms timestamp, or null when no time limit

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function activeScreenId() {
  const el = document.querySelector('.screen.active');
  return el ? el.id : null;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function playerColor(idx) {
  const colors = ['#6562F5','#C4D74F','#EB34A8','#16B8A6',
                  '#EAB308','#F05252','#1797F3','#F28C28'];
  return colors[idx % colors.length];
}

// ── Session (survives reloads, app switching and dropped connections) ───────

function saveSession(session) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (_) {}
}

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (_) { return null; }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

function returnToJoin(message) {
  clearSession();
  myId = null;
  gameState = null;
  document.getElementById('game-menu').style.display = 'none';
  document.getElementById('join-error').textContent = message || '';
  if (roomCode) document.getElementById('room-code-input').value = roomCode;
  showScreen('join-screen');
}

// ── Alerts: vibration, chime, screen wake lock ────────────────────────────────

let audioCtx = null;

// Must run inside a tap handler — mobile browsers only allow audio after a user gesture
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (_) {}
}

function playChime(freqs = [660, 880]) {
  if (!audioCtx) return;
  const start = audioCtx.currentTime;
  freqs.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const t = start + i * 0.15;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  });
}

// Vibration isn't supported on iOS, so the chime and flash cover those phones
function vibrate(pattern) {
  if (navigator.vibrate) navigator.vibrate(pattern);
}

function alertMyTurn() {
  vibrate([250, 100, 250, 100, 400]);
  playChime([660, 880, 1100]);
  document.body.classList.remove('flash');
  void document.body.offsetWidth; // restart the animation
  document.body.classList.add('flash');
}

let wakeLock = null;
async function requestWakeLock() {
  // Keeping the screen on stops phones from sleeping (and dropping the connection) mid-game
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (_) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!socket.connected) socket.connect();
  if (myId) requestWakeLock();
});

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('connect', () => {
  document.getElementById('connection-banner').style.display = 'none';
  const session = loadSession();
  if (session) {
    roomCode = session.code;
    socket.emit('player:rejoin', session);
  }
});

socket.on('disconnect', () => {
  if (myId) document.getElementById('connection-banner').style.display = 'block';
});

socket.on('player:joined', (data) => {
  myId = data.playerId;
  saveSession({ code: roomCode, playerId: data.playerId, token: data.token });
  document.getElementById('game-menu').style.display = 'flex';
  requestWakeLock();
  render(data.room);
});

socket.on('player:rejoin_failed', () => {
  returnToJoin('Your previous game has ended. Join a new one below.');
});

socket.on('player:error', ({ message }) => {
  const active = document.querySelector('.screen.active');
  const err = active && active.querySelector('.error');
  if (err) err.textContent = message;
  // Re-enable submit button so the player can try again
  const submitBtn = document.getElementById('submit-pick-btn');
  if (submitBtn) submitBtn.disabled = false;
});

socket.on('host:state_update', (state) => {
  if (myId) render(state);
});

socket.on('player:my_image_ready', ({ dataUrl }) => {
  showImageDownload('my-image-container', 'my-draft-img', 'my-download-link', dataUrl, 'my-draft.png');
});

socket.on('player:full_image_ready', ({ dataUrl }) => {
  showImageDownload('full-image-container', 'full-draft-img', 'full-download-link', dataUrl, 'full-draft.png');
});

// ── Rendering ─────────────────────────────────────────────────────────────────

// Every state update carries the full room, so the phone can always rebuild the
// right screen — including after reconnecting mid-game.
function render(state) {
  gameState = state;
  const me = state.players.find(p => p.id === myId);
  if (!me) { returnToJoin('You were removed from the game. Rejoin below.'); return; }

  const amLeader = state.leaderId === myId;
  document.getElementById('end-game-btn').style.display =
    amLeader && state.phase !== 'lobby' ? 'block' : 'none';

  pickDeadline = state.pickTimeRemainingMs != null ? Date.now() + state.pickTimeRemainingMs : null;
  updateTimers();

  if (state.phase !== 'results') resultsRendered = false;
  if (state.phase !== 'drafting') { lastTurnKey = null; wasOnDeck = false; }

  if (state.phase === 'lobby') renderLobby(state, amLeader);
  else if (state.phase === 'drafting') updatePickScreen(state, amLeader);
  else if (state.phase === 'voting') renderVoting(state, amLeader);
  else if (state.phase === 'results' && !resultsRendered) {
    resultsRendered = true;
    renderResults(state.results.tally, state.players);
  }
}

// ── Lobby ─────────────────────────────────────────────────────────────────────

function pickTimeLabel(seconds) {
  return seconds ? `${seconds / 60} min per pick` : 'No time limit';
}

function renderLobby(state, amLeader) {
  const n = state.players.length;
  const countText = `${n} player${n !== 1 ? 's' : ''} joined (max ${state.maxPlayers})`;
  document.getElementById('lobby-player-count').textContent = countText;
  document.getElementById('wait-player-count').textContent = countText;
  document.getElementById('wait-settings').textContent = state.category
    ? `${state.category} · ${state.maxRounds} rounds · ${pickTimeLabel(state.pickTimeLimit)}`
    : '';

  if (amLeader) {
    // Only fill the inputs when arriving here, so live updates don't clobber typing
    if (activeScreenId() !== 'leader-lobby-screen') {
      document.getElementById('category-input').value = state.category || '';
      document.getElementById('max-rounds-select').value = state.maxRounds;
      document.getElementById('pick-time-select').value = state.pickTimeLimit || 0;
      showScreen('leader-lobby-screen');
    }
    document.getElementById('start-game-btn').disabled = n < 2 || !state.category.trim();
  } else {
    showScreen('waiting-lobby-screen');
  }
}

// Debounce settings updates so we don't fire on every keystroke
let settingsTimer = null;
function emitSettings() {
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    socket.emit('player:update_settings', {
      code: roomCode,
      category: document.getElementById('category-input').value,
      maxRounds: document.getElementById('max-rounds-select').value,
      pickTimeLimit: document.getElementById('pick-time-select').value,
    });
  }, 300);
}

// ── Draft ─────────────────────────────────────────────────────────────────────

function nextPickerId(state) {
  const order = state.draftOrder;
  const n = order.length;
  const isLastPickOfDraft = state.currentRound >= state.maxRounds && state.currentPickIndex >= n - 1;
  if (isLastPickOfDraft) return null;
  // Snake draft: whoever picks last in a round also picks first in the next
  const nextIdx = state.currentPickIndex + 1 < n ? order[state.currentPickIndex + 1] : order[n - 1];
  return state.players[nextIdx]?.id;
}

function updatePickScreen(state, amLeader) {
  const me = state.players.find(p => p.id === myId);
  myPicks = me.picks;
  renderMyPicks();

  const isMyTurn = state.currentPickerId === myId;
  const turnKey = `${state.currentRound}:${state.currentPickIndex}`;
  const isNewTurn = turnKey !== lastTurnKey;
  lastTurnKey = turnKey;

  document.getElementById('pick-category').textContent = state.category;
  document.getElementById('pick-round-badge').textContent =
    `ROUND ${state.currentRound} OF ${state.maxRounds}`;

  if (isMyTurn) {
    // Only reset the input when the turn begins, not on unrelated updates
    if (isNewTurn || activeScreenId() !== 'pick-screen') {
      document.getElementById('pick-input').value = '';
      document.getElementById('pick-error').textContent = '';
      document.getElementById('submit-pick-btn').disabled = false;
      showScreen('pick-screen');
      document.getElementById('pick-input').focus();
      if (isNewTurn) alertMyTurn();
    }
    wasOnDeck = false;
    return;
  }

  const picker = state.players.find(p => p.id === state.currentPickerId);
  document.getElementById('wait-message').textContent =
    picker ? `${picker.name} is picking...` : 'Waiting...';
  document.getElementById('wait-away-note').textContent =
    picker && !picker.connected ? `${picker.name} has disconnected.` : '';
  document.getElementById('skip-turn-btn').style.display =
    amLeader && picker && !picker.connected ? 'block' : 'none';

  const onDeck = nextPickerId(state) === myId;
  document.getElementById('on-deck-note').style.display = onDeck ? 'block' : 'none';
  if (onDeck && !wasOnDeck) vibrate(150);
  wasOnDeck = onDeck;

  showScreen('wait-screen');
}

function renderMyPicks() {
  const html = myPicks.length === 0
    ? '<div style="color:var(--muted);font-size:0.9rem;">None yet</div>'
    : myPicks.map((p, i) =>
        `<div class="pick-chip"><span class="num">${i + 1}.</span><span>${escHtml(p)}</span></div>`
      ).join('');
  ['my-picks-list', 'wait-picks-list'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function formatClock(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

let warnedForTurn = null;
function updateTimers() {
  const remaining = pickDeadline ? Math.max(0, pickDeadline - Date.now()) : null;
  ['pick-timer', 'wait-timer'].forEach(id => {
    const el = document.getElementById(id);
    el.style.display = remaining === null ? 'none' : 'block';
    if (remaining === null) return;
    el.textContent = formatClock(remaining);
    el.classList.toggle('urgent', remaining <= 10000);
  });

  // One buzz when your own clock hits 10 seconds
  const isMyTurn = gameState && gameState.currentPickerId === myId;
  if (isMyTurn && remaining !== null && remaining <= 10000 && remaining > 0 && warnedForTurn !== lastTurnKey) {
    warnedForTurn = lastTurnKey;
    vibrate([100, 80, 100]);
    playChime([440]);
  }
}
setInterval(updateTimers, 250);

// ── Vote ──────────────────────────────────────────────────────────────────────

function renderVoting(state, amLeader) {
  const n = state.players.length;
  document.getElementById('vote-progress-note').textContent = `${state.votedIds.length} of ${n} votes in`;
  document.getElementById('end-voting-btn').style.display = amLeader ? 'block' : 'none';

  if (state.votedIds.includes(myId)) showScreen('voted-screen');
  else if (activeScreenId() !== 'vote-screen') renderVoteScreen(state);
}

function renderVoteScreen(state) {
  selectedVoteTarget = null;
  document.getElementById('submit-vote-btn').disabled = true;
  const optionsEl = document.getElementById('vote-options');
  optionsEl.innerHTML = state.players.map((player, idx) => {
    const isSelf = player.id === myId;
    const color = playerColor(idx);
    const preview = player.picks.slice(0, 3).map(p => `• ${p}`).join(' ');
    return `<div class="vote-option${isSelf ? ' self' : ''}"
                 data-id="${escHtml(player.id)}"
                 style="border-left:4px solid ${color}">
      <div>${escHtml(player.name)}</div>
      <div class="picks-preview">${escHtml(preview)}${player.picks.length > 3 ? '...' : ''}</div>
    </div>`;
  }).join('');

  optionsEl.querySelectorAll('.vote-option:not(.self)').forEach(el => {
    el.addEventListener('click', () => {
      optionsEl.querySelectorAll('.vote-option').forEach(o => o.classList.remove('selected'));
      el.classList.add('selected');
      selectedVoteTarget = el.dataset.id;
      document.getElementById('submit-vote-btn').disabled = false;
    });
  });

  document.getElementById('vote-error').textContent = '';
  showScreen('vote-screen');
}

// ── Results ───────────────────────────────────────────────────────────────────

function renderResults(tally, players) {
  const hasVotes = tally.some(e => e.votes > 0);

  document.getElementById('my-image-container').style.display = 'none';
  document.getElementById('full-image-container').style.display = 'none';

  if (hasVotes) {
    // 3+ players: show winner + my picks
    const winner = tally[0];
    document.getElementById('results-winner').innerHTML = `
      <div class="trophy">🏆</div>
      <div class="winner-name">${escHtml(winner.name)}</div>
      <div class="winner-sub">${winner.votes} vote${winner.votes !== 1 ? 's' : ''}</div>
    `;
    const me = players.find(p => p.id === myId);
    document.getElementById('my-final-picks').innerHTML = me
      ? me.picks.map((p, i) =>
          `<div class="pick-chip"><span class="num">${i + 1}.</span><span>${escHtml(p)}</span></div>`
        ).join('')
      : '';
    document.getElementById('results-voted-section').style.display = 'block';
    document.getElementById('results-nodraft-section').style.display = 'none';
    if (winner.id === myId) { vibrate([100, 50, 100, 50, 300]); playChime([523, 659, 784, 1047]); }
  } else {
    // 2 players: show everyone's full draft side by side
    document.getElementById('all-drafts-list').innerHTML = players.map(player =>
      `<div style="margin-bottom:16px">
        <div class="section-label" style="margin-bottom:6px">${escHtml(player.name)}'s Draft</div>
        ${player.picks.map((p, i) =>
          `<div class="pick-chip"><span class="num">${i + 1}.</span><span>${escHtml(p)}</span></div>`
        ).join('')}
      </div>`
    ).join('');
    document.getElementById('results-voted-section').style.display = 'none';
    document.getElementById('results-nodraft-section').style.display = 'block';
  }

  showScreen('player-results-screen');
}

function showImageDownload(containerId, imgId, linkId, dataUrl, filename) {
  const container = document.getElementById(containerId);
  document.getElementById(imgId).src = dataUrl;
  const link = document.getElementById(linkId);
  link.href = dataUrl;
  link.download = filename;
  container.style.display = 'block';
}

// ── UI events ─────────────────────────────────────────────────────────────────

document.getElementById('room-code-input').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

document.getElementById('join-btn').addEventListener('click', () => {
  unlockAudio();
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  const name = document.getElementById('name-input').value.trim();
  const err = document.getElementById('join-error');
  if (code.length !== 4) { err.textContent = 'Room code must be 4 characters.'; return; }
  if (!name) { err.textContent = 'Please enter your name.'; return; }
  err.textContent = '';
  roomCode = code;
  socket.emit('player:join', { code, name });
});

// A returning player's first tap re-enables sound (browsers block it until then)
document.addEventListener('pointerdown', unlockAudio, { once: true });

// Leader settings
['category-input', 'max-rounds-select', 'pick-time-select'].forEach(id => {
  document.getElementById(id).addEventListener('input', emitSettings);
});

document.getElementById('start-game-btn').addEventListener('click', () => {
  const err = document.getElementById('leader-error');
  if (!document.getElementById('category-input').value.trim()) {
    err.textContent = 'Please enter a draft category.'; return;
  }
  err.textContent = '';
  clearTimeout(settingsTimer);
  emitSettings();
  // Let the debounced settings land before starting
  setTimeout(() => socket.emit('player:start_game', { code: roomCode }), 350);
});

document.getElementById('submit-pick-btn').addEventListener('click', () => {
  const pick = document.getElementById('pick-input').value.trim();
  const err = document.getElementById('pick-error');
  if (!pick) { err.textContent = 'Enter your pick first.'; return; }
  err.textContent = '';
  document.getElementById('submit-pick-btn').disabled = true;
  socket.emit('player:submit_pick', { code: roomCode, pick });
});

document.getElementById('pick-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('submit-pick-btn').click();
  }
});

document.getElementById('submit-vote-btn').addEventListener('click', () => {
  if (!selectedVoteTarget) return;
  socket.emit('player:submit_vote', { code: roomCode, targetId: selectedVoteTarget });
  document.getElementById('submit-vote-btn').disabled = true;
});

document.getElementById('skip-turn-btn').addEventListener('click', () => {
  if (confirm('Skip this player\'s turn?')) socket.emit('player:skip_turn', { code: roomCode });
});

document.getElementById('end-voting-btn').addEventListener('click', () => {
  if (confirm('Close voting and show results now?')) socket.emit('player:end_voting', { code: roomCode });
});

document.getElementById('end-game-btn').addEventListener('click', () => {
  if (confirm('End this game for everyone and go back to the lobby?')) {
    socket.emit('player:end_game', { code: roomCode });
  }
});

document.getElementById('leave-game-btn').addEventListener('click', () => {
  if (!confirm('Leave this game?')) return;
  socket.emit('player:leave');
  returnToJoin();
});

document.getElementById('gen-my-image-btn').addEventListener('click', () => {
  socket.emit('player:generate_my_image', { code: roomCode });
});

document.getElementById('gen-full-image-btn-player').addEventListener('click', () => {
  socket.emit('player:generate_full_image', { code: roomCode });
});
