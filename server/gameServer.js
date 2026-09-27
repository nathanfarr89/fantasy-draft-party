const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const path = require('path');
const { generateDraftImage, generatePlayerImage } = require('./imageGenerator');

const app = express();
let server;
let io;

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'player')));

// ─── Game State ───────────────────────────────────────────────────────────────

const MAX_PLAYERS = 8;
const PICK_TIME_OPTIONS = [0, 60, 180, 300]; // seconds; 0 = no limit
const SKIPPED_PICK = '(skipped)';
// Lobby players who stay disconnected this long are removed so their slot frees up
const LOBBY_DISCONNECT_GRACE_MS = 60 * 1000;

const rooms = new Map();

function randomId(bytes = 8) { return crypto.randomBytes(bytes).toString('hex'); }

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = generateRoomCode();
  const room = {
    code,
    category: '',
    maxRounds: 5,
    pickTimeLimit: 0,
    players: [],
    hostSocketId: null,
    leaderId: null,
    phase: 'lobby',
    currentRound: 1,
    draftOrder: [],
    currentPickIndex: 0,
    pickDeadline: null,
    pickTimer: null,
    votes: {},
    results: null,
    lastActivity: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function getSnakeDraftOrder(playerCount, round) {
  const base = Array.from({ length: playerCount }, (_, i) => i);
  return round % 2 === 1 ? base : [...base].reverse();
}

function currentPicker(room) {
  return room.players[room.draftOrder[room.currentPickIndex]];
}

function findPlayer(room, playerId) {
  return room.players.find(p => p.id === playerId);
}

function advancePick(room) {
  room.currentPickIndex++;
  if (room.currentPickIndex >= room.players.length) {
    room.currentRound++;
    room.currentPickIndex = 0;
    if (room.currentRound > room.maxRounds) return 'draft_complete';
    room.draftOrder = getSnakeDraftOrder(room.players.length, room.currentRound);
    return 'next_round';
  }
  return 'next_pick';
}

function touchRoom(room) { room.lastActivity = Date.now(); }

function clearPickTimer(room) {
  clearTimeout(room.pickTimer);
  room.pickTimer = null;
  room.pickDeadline = null;
}

function startPickTimer(room) {
  clearPickTimer(room);
  if (!room.pickTimeLimit || room.phase !== 'drafting') return;
  const turnKey = `${room.currentRound}:${room.currentPickIndex}`;
  room.pickDeadline = Date.now() + room.pickTimeLimit * 1000;
  room.pickTimer = setTimeout(() => {
    if (room.phase !== 'drafting' || `${room.currentRound}:${room.currentPickIndex}` !== turnKey) return;
    recordPick(room, SKIPPED_PICK);
  }, room.pickTimeLimit * 1000);
}

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, picks: p.picks, connected: p.connected }));
}

function roomSummary(room) {
  return {
    code: room.code,
    category: room.category,
    maxPlayers: MAX_PLAYERS,
    maxRounds: room.maxRounds,
    pickTimeLimit: room.pickTimeLimit,
    // Relative, not absolute, so clients aren't affected by clock skew
    pickTimeRemainingMs: room.pickDeadline ? Math.max(0, room.pickDeadline - Date.now()) : null,
    phase: room.phase,
    currentRound: room.currentRound,
    currentPickIndex: room.currentPickIndex,
    draftOrder: room.draftOrder,
    leaderId: room.leaderId,
    players: publicPlayers(room),
    currentPickerId: room.phase === 'drafting' ? currentPicker(room)?.id : null,
    votedIds: Object.keys(room.votes),
    results: room.results,
  };
}

function broadcast(room) {
  io.to(room.code).emit('host:state_update', roomSummary(room));
}

function tallyVotes(room) {
  const tally = {};
  room.players.forEach(p => { tally[p.id] = { id: p.id, name: p.name, votes: 0 }; });
  Object.values(room.votes).forEach(targetId => {
    if (tally[targetId]) tally[targetId].votes++;
  });
  return Object.values(tally).sort((a, b) => b.votes - a.votes);
}

function finishGame(room) {
  clearPickTimer(room);
  room.phase = 'results';
  room.results = { tally: tallyVotes(room) };
}

// Records a pick for whoever is on the clock and moves the draft forward
function recordPick(room, pick) {
  currentPicker(room).picks.push(pick);
  touchRoom(room);

  if (advancePick(room) === 'draft_complete') {
    clearPickTimer(room);
    if (room.players.length === 2) finishGame(room);
    else room.phase = 'voting';
  } else {
    startPickTimer(room);
  }
  broadcast(room);
}

// Back to the lobby with the same players, so a new game doesn't need everyone to rejoin
function resetToLobby(room) {
  clearPickTimer(room);
  room.phase = 'lobby';
  room.currentRound = 1;
  room.currentPickIndex = 0;
  room.draftOrder = [];
  room.votes = {};
  room.results = null;
  room.players = room.players.filter(p => p.connected);
  room.players.forEach(p => { p.picks = []; });
  if (!findPlayer(room, room.leaderId)) room.leaderId = room.players[0]?.id || null;
  touchRoom(room);
}

function removePlayer(room, playerId) {
  const player = findPlayer(room, playerId);
  if (!player) return;
  clearTimeout(player.removeTimer);
  room.players = room.players.filter(p => p.id !== playerId);
  if (room.leaderId === playerId) room.leaderId = room.players[0]?.id || null;
}

function isLeader(socket, room) {
  return room && socket.data.playerId && room.leaderId === socket.data.playerId;
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────

function setupSockets(ioInstance) {
  ioInstance.on('connection', (socket) => {

    // ── Host screen connects — resume its room if it still exists, else create one
    socket.on('host:init', ({ code } = {}) => {
      let room = code && rooms.get(code);
      if (!room) room = createRoom();
      room.hostSocketId = socket.id;
      socket.join(room.code);
      socket.data.hostRoomCode = room.code;
      socket.emit('host:room_created', { code: room.code });
      socket.emit('host:state_update', roomSummary(room));
    });

    // ── Player joins ──────────────────────────────────────────────────────────
    socket.on('player:join', ({ code, name }) => {
      const room = rooms.get(code);
      if (!room) { socket.emit('player:error', { message: 'Room not found.' }); return; }
      if (room.phase !== 'lobby') { socket.emit('player:error', { message: 'Game already in progress.' }); return; }
      if (room.players.length >= MAX_PLAYERS) { socket.emit('player:error', { message: `Room is full (max ${MAX_PLAYERS} players).` }); return; }
      const trimmed = String(name || '').trim().slice(0, 20);
      if (!trimmed) { socket.emit('player:error', { message: 'Name required.' }); return; }
      if (room.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
        socket.emit('player:error', { message: 'Name already taken.' }); return;
      }

      const player = {
        id: randomId(),
        token: randomId(16),
        name: trimmed,
        picks: [],
        socketId: socket.id,
        connected: true,
        removeTimer: null,
      };
      room.players.push(player);
      if (!room.leaderId) room.leaderId = player.id;
      touchRoom(room);

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = player.id;

      socket.emit('player:joined', { playerId: player.id, token: player.token, room: roomSummary(room) });
      broadcast(room);
    });

    // ── Player reconnects (socket dropped, or page reloaded) ──────────────────
    socket.on('player:rejoin', ({ code, playerId, token }) => {
      const room = rooms.get(code);
      const player = room && findPlayer(room, playerId);
      if (!player || player.token !== token) {
        socket.emit('player:rejoin_failed');
        return;
      }

      // Kick any stale socket still attached to this player (e.g. an old tab)
      if (player.socketId && player.socketId !== socket.id) {
        const old = ioInstance.sockets.sockets.get(player.socketId);
        if (old) { old.data.playerId = null; old.leave(code); }
      }

      clearTimeout(player.removeTimer);
      player.removeTimer = null;
      player.socketId = socket.id;
      player.connected = true;
      touchRoom(room);

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = player.id;

      socket.emit('player:joined', { playerId: player.id, token: player.token, room: roomSummary(room) });
      broadcast(room);
    });

    // ── Player leaves voluntarily ─────────────────────────────────────────────
    socket.on('player:leave', () => {
      const room = rooms.get(socket.data.roomCode);
      const playerId = socket.data.playerId;
      socket.data.roomCode = null;
      socket.data.playerId = null;
      if (!room) return;
      socket.leave(room.code);

      if (room.phase === 'lobby') {
        removePlayer(room, playerId);
      } else {
        // Mid-game the player keeps their slot; their turns can be skipped
        const player = findPlayer(room, playerId);
        if (player) { player.connected = false; player.socketId = null; }
      }
      broadcast(room);
    });

    // ── Leader updates settings ───────────────────────────────────────────────
    socket.on('player:update_settings', ({ code, category, maxRounds, pickTimeLimit }) => {
      const room = rooms.get(code);
      if (!isLeader(socket, room) || room.phase !== 'lobby') return;
      if (category !== undefined) room.category = String(category).trim().slice(0, 60);
      if (maxRounds !== undefined) room.maxRounds = Math.min(10, Math.max(1, parseInt(maxRounds) || 5));
      if (pickTimeLimit !== undefined) {
        const limit = parseInt(pickTimeLimit) || 0;
        room.pickTimeLimit = PICK_TIME_OPTIONS.includes(limit) ? limit : 0;
      }
      touchRoom(room);
      broadcast(room);
    });

    // ── Leader starts the game ────────────────────────────────────────────────
    socket.on('player:start_game', ({ code }) => {
      const room = rooms.get(code);
      if (!isLeader(socket, room) || room.phase !== 'lobby') return;
      if (room.players.length < 2) { socket.emit('player:error', { message: 'Need at least 2 players to start.' }); return; }
      if (!room.category.trim()) { socket.emit('player:error', { message: 'Please enter a draft category.' }); return; }

      room.players = room.players.sort(() => Math.random() - 0.5);
      room.draftOrder = getSnakeDraftOrder(room.players.length, 1);
      room.currentRound = 1;
      room.currentPickIndex = 0;
      room.phase = 'drafting';
      startPickTimer(room);
      touchRoom(room);
      broadcast(room);
    });

    // ── Draft pick ────────────────────────────────────────────────────────────
    socket.on('player:submit_pick', ({ code, pick }) => {
      const room = rooms.get(code);
      if (!room || room.phase !== 'drafting') return;
      const picker = currentPicker(room);
      if (!picker || picker.id !== socket.data.playerId) { socket.emit('player:error', { message: 'Not your turn.' }); return; }
      const trimmed = String(pick || '').trim().slice(0, 60);
      if (!trimmed) { socket.emit('player:error', { message: 'Pick cannot be empty.' }); return; }

      const normalized = trimmed.toLowerCase();
      const allPicks = room.players.flatMap(p => p.picks.filter(pk => pk !== SKIPPED_PICK).map(pk => pk.toLowerCase()));
      if (allPicks.includes(normalized)) {
        socket.emit('player:error', { message: 'That pick has already been taken.' }); return;
      }

      recordPick(room, trimmed);
    });

    // ── Leader skips the current picker (e.g. they dropped out) ───────────────
    socket.on('player:skip_turn', ({ code }) => {
      const room = rooms.get(code);
      if (!isLeader(socket, room) || room.phase !== 'drafting') return;
      recordPick(room, SKIPPED_PICK);
    });

    // ── Vote ──────────────────────────────────────────────────────────────────
    socket.on('player:submit_vote', ({ code, targetId }) => {
      const room = rooms.get(code);
      if (!room || room.phase !== 'voting') return;
      const voterId = socket.data.playerId;
      if (!findPlayer(room, voterId)) return;
      if (voterId === targetId) { socket.emit('player:error', { message: "You can't vote for yourself." }); return; }
      if (!findPlayer(room, targetId)) { socket.emit('player:error', { message: 'Invalid vote target.' }); return; }
      if (room.votes[voterId]) { socket.emit('player:error', { message: 'Already voted.' }); return; }

      room.votes[voterId] = targetId;
      touchRoom(room);
      maybeFinishVoting(room);
      broadcast(room);
    });

    // ── Leader ends voting early (e.g. someone left and can't vote) ───────────
    socket.on('player:end_voting', ({ code }) => {
      const room = rooms.get(code);
      if (!isLeader(socket, room) || room.phase !== 'voting') return;
      finishGame(room);
      broadcast(room);
    });

    // ── End the current game and return everyone to the lobby ─────────────────
    // Allowed from the host screen or the leader's phone.
    function handleEndGame(room) {
      if (!room) return;
      resetToLobby(room);
      broadcast(room);
    }
    socket.on('host:end_game', () => handleEndGame(rooms.get(socket.data.hostRoomCode)));
    socket.on('player:end_game', ({ code }) => {
      const room = rooms.get(code);
      if (isLeader(socket, room)) handleEndGame(room);
    });

    // ── Image generation ──────────────────────────────────────────────────────

    // Host screen requests full image
    socket.on('host:generate_full_image', async ({ code }) => {
      const room = rooms.get(code);
      if (!room) return;
      try {
        const dataUrl = await generateDraftImage(room);
        socket.emit('host:image_ready', { dataUrl });
      } catch (err) {
        console.error('Image generation failed:', err);
      }
    });

    // Any player requests full draft image
    socket.on('player:generate_full_image', async ({ code }) => {
      const room = rooms.get(code);
      if (!room) return;
      try {
        const dataUrl = await generateDraftImage(room);
        socket.emit('player:full_image_ready', { dataUrl });
      } catch (err) {
        console.error('Image generation failed:', err);
        socket.emit('player:error', { message: 'Image generation failed.' });
      }
    });

    // Player requests their own card
    socket.on('player:generate_my_image', async ({ code }) => {
      const room = rooms.get(code);
      if (!room) return;
      const player = findPlayer(room, socket.data.playerId);
      if (!player) return;
      try {
        const dataUrl = await generatePlayerImage(room, player);
        socket.emit('player:my_image_ready', { dataUrl });
      } catch (err) {
        console.error('Image generation failed:', err);
        socket.emit('player:error', { message: 'Image generation failed.' });
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    // Phones drop their connection whenever the screen locks or the browser is
    // backgrounded, so a disconnect only marks the player as away. They get their
    // slot back via player:rejoin.
    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.roomCode);
      const player = room && findPlayer(room, socket.data.playerId);
      if (!player || player.socketId !== socket.id) return;

      player.connected = false;
      player.socketId = null;
      if (room.phase === 'lobby') {
        player.removeTimer = setTimeout(() => {
          if (player.connected || room.phase !== 'lobby') return;
          removePlayer(room, player.id);
          broadcast(room);
        }, LOBBY_DISCONNECT_GRACE_MS);
      }
      broadcast(room);
    });
  });
}

// Waits for everyone (a locked phone may just be reconnecting); the leader
// can close voting early via player:end_voting if someone is really gone.
function maybeFinishVoting(room) {
  if (Object.keys(room.votes).length >= room.players.length) finishGame(room);
}

// ─── Server Lifecycle ─────────────────────────────────────────────────────────

// Expire rooms that have been idle for 2 hours
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms.entries()) {
    if (room.lastActivity < cutoff) {
      clearPickTimer(room);
      rooms.delete(code);
    }
  }
}, 10 * 60 * 1000);

function startServer(port) {
  return new Promise((resolve, reject) => {
    server = http.createServer(app);
    // WebSocket-only: no polling fallback, so no sticky sessions needed
    io = new Server(server, {
      cors: { origin: '*' },
      transports: ['websocket'],
    });
    setupSockets(io);
    server.listen(port, '0.0.0.0', () => resolve(server));
    server.on('error', reject);
  });
}

function stopServer() {
  if (server) server.close();
}

module.exports = { startServer, stopServer };
