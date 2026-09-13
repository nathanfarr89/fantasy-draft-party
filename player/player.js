const socket = io({ transports: ['websocket'] });

let myId = null;
let myName = '';
let roomCode = null;
let isLeader = false;
let myPicks = [];
let selectedVoteTarget = null;
let gameState = null;

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
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

// ── Socket events ─────────────────────────────────────────────────────────────

socket.on('player:joined', (data) => {
  myId = data.playerId;
  isLeader = data.isLeader;
  gameState = data.room;
  if (isLeader) {
    populateLeaderSettings(data.room);
    showScreen('leader-lobby-screen');
  } else {
    showScreen('waiting-lobby-screen');
  }
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
  gameState = state;
  if (state.phase === 'lobby') {
    updateLobbyPlayerCount(state);
  } else if (state.phase === 'drafting') {
    updatePickScreen(state);
  }
});

socket.on('game:phase_change', ({ phase }) => {
  if (phase === 'drafting' && gameState) updatePickScreen(gameState);
  else if (phase === 'voting') renderVoteScreen(gameState);
  else if (phase === 'results') { /* handled by game:results */ }
});

socket.on('player:promoted_to_leader', () => {
  isLeader = true;
  if (gameState) {
    populateLeaderSettings(gameState);
    showScreen('leader-lobby-screen');
  }
});

socket.on('player:vote_recorded', () => showScreen('voted-screen'));

socket.on('game:results', ({ tally, players }) => renderResults(tally, players));

socket.on('player:my_image_ready', ({ dataUrl }) => {
  showImageDownload('my-image-container', 'my-draft-img', 'my-download-link', dataUrl, 'my-draft.png');
});

socket.on('player:full_image_ready', ({ dataUrl }) => {
  showImageDownload('full-image-container', 'full-draft-img', 'full-download-link', dataUrl, 'full-draft.png');
});

socket.on('game:host_disconnected', () => {
  alert('The host has left the game.');
  location.reload();
});

// ── Leader lobby ──────────────────────────────────────────────────────────────

function populateLeaderSettings(room) {
  document.getElementById('category-input').value = room.category || '';
  document.getElementById('max-rounds-select').value = room.maxRounds;
}

function updateLobbyPlayerCount(state) {
  const countEl = document.getElementById('lobby-player-count');
  if (countEl) countEl.textContent = `${state.players.length} of ${state.maxPlayers} players joined`;

  const waitCountEl = document.getElementById('wait-player-count');
  if (waitCountEl) waitCountEl.textContent = `${state.players.length} of ${state.maxPlayers} players joined`;

  const startBtn = document.getElementById('start-game-btn');
  if (startBtn) startBtn.disabled = state.players.length < 2 || !state.category.trim();
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
    });
  }, 300);
}

// ── Draft ─────────────────────────────────────────────────────────────────────

function updatePickScreen(state) {
  const me = state.players.find(p => p.id === myId);
  if (me) {
    myPicks = me.picks;
    renderMyPicks();
  }

  const isMyTurn = state.currentPickerId === myId;
  document.getElementById('pick-category').textContent = state.category;
  document.getElementById('pick-round-badge').textContent =
    `ROUND ${state.currentRound} OF ${state.maxRounds}`;

  if (isMyTurn) {
    document.getElementById('pick-input').value = '';
    document.getElementById('pick-error').textContent = '';
    document.getElementById('submit-pick-btn').disabled = false;
    showScreen('pick-screen');
    document.getElementById('pick-input').focus();
  } else {
    const picker = state.players.find(p => p.id === state.currentPickerId);
    document.getElementById('wait-message').textContent =
      picker ? `${picker.name} is picking...` : 'Waiting...';
    showScreen('wait-screen');
  }
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

// ── Vote ──────────────────────────────────────────────────────────────────────

function renderVoteScreen(state) {
  if (!state) return;
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
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  const name = document.getElementById('name-input').value.trim();
  const err = document.getElementById('join-error');
  if (code.length !== 4) { err.textContent = 'Room code must be 4 characters.'; return; }
  if (!name) { err.textContent = 'Please enter your name.'; return; }
  err.textContent = '';
  myName = name;
  roomCode = code;
  socket.emit('player:join', { code, name });
});

// Leader settings
['category-input', 'max-rounds-select'].forEach(id => {
  document.getElementById(id).addEventListener('input', emitSettings);
});

document.getElementById('start-game-btn').addEventListener('click', () => {
  const err = document.getElementById('leader-error');
  if (!document.getElementById('category-input').value.trim()) {
    err.textContent = 'Please enter a draft category.'; return;
  }
  err.textContent = '';
  socket.emit('player:start_game', { code: roomCode });
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

document.getElementById('gen-my-image-btn').addEventListener('click', () => {
  socket.emit('player:generate_my_image', { code: roomCode });
});

document.getElementById('gen-full-image-btn-player').addEventListener('click', () => {
  socket.emit('player:generate_full_image', { code: roomCode });
});
