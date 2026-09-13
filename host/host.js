const io = require('../node_modules/socket.io/client-dist/socket.io.js');
const { SERVER_URL } = require('../config');

let socket;
let currentRoomCode = null;
let gameState = null;

const PLAYER_COLORS = [
  '#6562F5', // 1
  '#C4D74F', // 2
  '#EB34A8', // 3
  '#16B8A6', // 4
  '#EAB308', // 5
  '#F05252', // 6
  '#1797F3', // 7
  '#F28C28', // 8
];

function playerColor(idx) { return PLAYER_COLORS[idx % PLAYER_COLORS.length]; }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// Returns player array in pick order for the given (1-indexed) round
function snakeOrder(players, round) {
  const base = [...players];
  return round % 2 === 0 ? base.reverse() : base;
}

async function init() {
  // Show the URL players use to join
  const displayUrl = SERVER_URL.replace(/^https?:\/\//, '').replace(/:3000$/, '');
  document.getElementById('join-url').textContent = SERVER_URL.includes('localhost')
    ? (() => {
        const os = require('os');
        const nets = os.networkInterfaces();
        for (const iface of Object.values(nets)) {
          for (const addr of iface) {
            if (addr.family === 'IPv4' && !addr.internal) return `http://${addr.address}:3000`;
          }
        }
        return SERVER_URL;
      })()
    : SERVER_URL;

  socket = io(SERVER_URL, { transports: ['websocket'] });
  socket.on('connect', () => socket.emit('host:init'));

  socket.on('host:room_created', ({ code }) => {
    currentRoomCode = code;
    document.getElementById('room-code').textContent = code;
  });

  socket.on('host:state_update', (state) => {
    gameState = state;
    if (state.phase === 'lobby') renderLobby(state);
    else if (state.phase === 'drafting') renderDraft(state);
  });

  socket.on('game:phase_change', ({ phase }) => {
    if (phase === 'drafting') showScreen('draft-screen');
    else if (phase === 'voting') showScreen('voting-screen');
    else if (phase === 'results') showScreen('results-screen');
  });

  socket.on('host:votes_update', ({ votesCast, total }) => {
    document.getElementById('vote-progress').textContent = `${votesCast} / ${total}`;
  });

  socket.on('game:results', ({ tally, players }) => renderResults(tally, players));

  socket.on('host:image_ready', ({ dataUrl }) => {
    document.getElementById('preview-img').src = dataUrl;
    document.getElementById('preview-download').href = dataUrl;
    document.getElementById('image-preview').style.display = 'flex';
  });

  document.getElementById('gen-full-image-btn').addEventListener('click', () => {
    socket.emit('host:generate_full_image', { code: currentRoomCode });
  });

  document.getElementById('play-again-btn').addEventListener('click', () => {
    currentRoomCode = null;
    gameState = null;
    showScreen('lobby-screen');
    socket.emit('host:init');
  });

  document.getElementById('close-preview').addEventListener('click', () => {
    document.getElementById('image-preview').style.display = 'none';
  });
}

// ── Lobby ─────────────────────────────────────────────────────────────────────

function renderLobby(state) {
  // Category & rounds
  const catEl = document.getElementById('display-category');
  if (state.category) {
    catEl.innerHTML = `<div class="settings-cat-value">${escHtml(state.category)}</div>`;
  } else {
    catEl.innerHTML = `<span class="settings-cat-placeholder">Waiting for leader to set...</span>`;
  }
  document.getElementById('display-max-rounds').textContent = state.maxRounds || '–';

  // Player count
  const count = state.players.length;
  document.getElementById('players-count').textContent = `${count} OF 8`;

  // 8-slot grid
  const list = document.getElementById('player-list');
  const slots = Array.from({ length: 8 }, (_, i) => {
    const player = state.players[i];
    const isLeader = player && player.id === state.leaderId;
    const color = playerColor(i);
    if (player) {
      return `<div class="player-row">
        <div class="player-name-display" style="color:${color}">${escHtml(player.name)}</div>
        <div class="player-badge">${isLeader ? 'LEADER' : `P${i + 1}`}</div>
      </div>`;
    } else {
      return `<div class="player-row">
        <div class="player-slot-empty">P${i + 1}</div>
      </div>`;
    }
  });
  list.innerHTML = slots.join('');

  // Status message
  const statusEl = document.getElementById('lobby-status');
  if (count === 0) {
    statusEl.textContent = 'Waiting for players to join...';
  } else if (count < 2) {
    statusEl.textContent = 'Need at least 2 players to start.';
  } else if (!state.category) {
    statusEl.textContent = `${count} player${count !== 1 ? 's' : ''} joined — leader needs to set a category.`;
  } else {
    statusEl.textContent = `${count} player${count !== 1 ? 's' : ''} ready — leader can start the game from their phone.`;
  }
}

// ── Draft ─────────────────────────────────────────────────────────────────────

function renderDraft(state) {
  document.getElementById('draft-category').textContent = state.category;
  document.getElementById('draft-round-current').textContent = state.currentRound;
  document.getElementById('draft-round-total').textContent = state.maxRounds;

  const order = snakeOrder(state.players, state.currentRound);
  const currentIdx = order.findIndex(p => p.id === state.currentPickerId);
  const nextIdx = currentIdx + 1 < order.length ? currentIdx + 1 : null;
  const nextPickerId = nextIdx !== null ? order[nextIdx].id : null;

  // Active picker name (large headline)
  const currentPicker = state.players.find(p => p.id === state.currentPickerId);
  const pickerIdx = state.players.findIndex(p => p.id === state.currentPickerId);
  const pickerColor = playerColor(pickerIdx);
  const nameEl = document.getElementById('active-picker-name');
  nameEl.textContent = currentPicker ? currentPicker.name.toUpperCase() : '–';
  nameEl.style.color = pickerColor;

  // Snake order pills
  const bar = document.getElementById('draft-order-bar');
  const pills = order.map((player, i) => {
    const pIdx = state.players.findIndex(p => p.id === player.id);
    const color = playerColor(pIdx);
    const isActive = player.id === state.currentPickerId;
    const arrow = i < order.length - 1 ? `<span class="order-arrow">→</span>` : '';
    return `<div class="order-pill${isActive ? ' active' : ''}" style="color:${color}">
      <span>${escHtml(player.name.toUpperCase())}</span>
    </div>${arrow}`;
  }).join('');
  bar.innerHTML = `<div class="order-label">Pick Order</div>${pills}`;

  // Player boards
  const boards = document.getElementById('draft-boards');
  boards.innerHTML = state.players.map((player, idx) => {
    const color = playerColor(idx);
    const isActive = player.id === state.currentPickerId;
    const isOnDeck = player.id === nextPickerId;

    const pickSlots = Array.from({ length: state.maxRounds }, (_, r) => {
      const pick = player.picks[r];
      if (pick) {
        return `<div class="board-pick">
          <span class="board-pick-num">${r + 1}</span>
          <span class="board-pick-text">${escHtml(pick)}</span>
        </div>`;
      } else if (r === player.picks.length && isActive) {
        return `<div class="board-pick">
          <span class="board-pick-num">${r + 1}</span>
          <span class="board-pick-text pending">Picking...</span>
        </div>`;
      } else {
        return `<div class="board-pick">
          <span class="board-pick-num" style="color:var(--border)">${r + 1}</span>
          <span class="board-pick-text" style="color:var(--border)">—</span>
        </div>`;
      }
    }).join('');

    return `<div class="board-card${isOnDeck ? ' on-deck' : ''}" style="color:${color}">
      <div class="board-card-header">
        <div class="board-card-name">${escHtml(player.name.toUpperCase())}</div>
        ${isOnDeck ? `<div class="board-on-deck-badge">ON DECK</div>` : ''}
      </div>
      ${pickSlots}
    </div>`;
  }).join('');
}

// ── Results ───────────────────────────────────────────────────────────────────

function renderResults(tally, players) {
  const winner = tally[0];
  const winnerPlayer = players.find(p => p.name === winner.name);
  const winnerIdx = players.findIndex(p => p.name === winner.name);
  const winnerColor = playerColor(winnerIdx);
  const hasVotes = tally.some(e => e.votes > 0);

  // Left panel: winner name + picks
  document.getElementById('results-winner-name').textContent = winner.name.toUpperCase();
  document.getElementById('results-winner-name').style.color = winnerColor;
  document.getElementById('results-vote-subtitle').textContent = hasVotes
    ? `${winner.votes} vote${winner.votes !== 1 ? 's' : ''}`
    : 'Draft Complete';

  const winnerPicks = winnerPlayer ? winnerPlayer.picks : [];
  document.getElementById('results-winner-picks').innerHTML = winnerPicks
    .map((p, i) => `<div class="results-winner-pick">
      <span class="results-pick-num">${i + 1}</span>
      <span class="results-pick-val">${escHtml(p)}</span>
    </div>`).join('');

  // Right panel: bar chart tally
  const maxVotes = Math.max(...tally.map(e => e.votes), 1);
  const rows = document.getElementById('tally-rows');
  rows.innerHTML = tally.map((entry, i) => {
    const eIdx = players.findIndex(p => p.name === entry.name);
    const color = playerColor(eIdx);
    const pct = hasVotes ? Math.round((entry.votes / maxVotes) * 100) : 0;
    return `<div class="tally-row">
      <div class="tally-name" style="color:${color}">${escHtml(entry.name.toUpperCase())}</div>
      <div class="tally-bar-track">
        <div class="tally-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="tally-votes">${entry.votes}</div>
    </div>`;
  }).join('');
}

init().catch(console.error);
