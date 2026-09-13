const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { generateDraftImage, generatePlayerImage } = require('./imageGenerator');

const app = express();
let server;
let io;

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use(express.static(path.join(__dirname, '..', 'player')));

// ─── Game State ───────────────────────────────────────────────────────────────

const rooms = new Map();

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
    maxPlayers: 4,
    maxRounds: 5,
    players: [],
    hostSocketId: null,
    leaderId: null,
    phase: 'lobby',
    currentRound: 1,
    draftOrder: [],
    currentPickIndex: 0,
    votes: {},
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

function roomSummary(room) {
  return {
    code: room.code,
    category: room.category,
    maxPlayers: room.maxPlayers,
    maxRounds: room.maxRounds,
    phase: room.phase,
    currentRound: room.currentRound,
    currentPickIndex: room.currentPickIndex,
    draftOrder: room.draftOrder,
    leaderId: room.leaderId,
    players: room.players.map(p => ({ id: p.id, name: p.name, picks: p.picks })),
    currentPickerId: room.phase === 'drafting' ? currentPicker(room)?.id : null,
  };
}

function tallyVotes(room) {
  const tally = {};
  room.players.forEach(p => { tally[p.id] = { name: p.name, votes: 0 }; });
  Object.values(room.votes).forEach(targetId => {
    if (tally[targetId]) tally[targetId].votes++;
  });
  return Object.values(tally).sort((a, b) => b.votes - a.votes);
}

// ─── Socket Handlers ──────────────────────────────────────────────────────────

function setupSockets(ioInstance) {
  ioInstance.on('connection', (socket) => {

    // ── Host screen connects — auto-create a room ─────────────────────────────
    socket.on('host:init', () => {
      const room = createRoom();
      room.hostSocketId = socket.id;
      socket.join(room.code);
      socket.emit('host:room_created', { code: room.code });
      socket.emit('host:state_update', roomSummary(room));
    });

    // ── Player joins ──────────────────────────────────────────────────────────
    socket.on('player:join', ({ code, name }) => {
      const room = rooms.get(code);
      if (!room) { socket.emit('player:error', { message: 'Room not found.' }); return; }
      if (room.phase !== 'lobby') { socket.emit('player:error', { message: 'Game already in progress.' }); return; }
      if (room.players.length >= 8) { socket.emit('player:error', { message: 'Room is full (max 8 players).' }); return; }
      const trimmed = name.trim().slice(0, 20);
      if (!trimmed) { socket.emit('player:error', { message: 'Name required.' }); return; }
      if (room.players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
        socket.emit('player:error', { message: 'Name already taken.' }); return;
      }

      const isLeader = room.players.length === 0;
      const player = { id: socket.id, name: trimmed, picks: [] };
      room.players.push(player);
      touchRoom(room);
      if (isLeader) room.leaderId = socket.id;

      socket.join(code);
      socket.data.roomCode = code;
      socket.data.playerId = socket.id;

      socket.emit('player:joined', { playerId: socket.id, isLeader, room: roomSummary(room) });
      ioInstance.to(code).emit('host:state_update', roomSummary(room));
    });

    // ── Leader updates settings ───────────────────────────────────────────────
    socket.on('player:update_settings', ({ code, category, maxPlayers, maxRounds }) => {
      const room = rooms.get(code);
      if (!room || room.leaderId !== socket.id || room.phase !== 'lobby') return;
      if (category !== undefined) room.category = category.trim().slice(0, 60);
      if (maxRounds !== undefined) room.maxRounds = Math.min(10, Math.max(1, parseInt(maxRounds)));

      // If room is now over capacity, trim — just in case
      ioInstance.to(code).emit('host:state_update', roomSummary(room));
    });

    // ── Leader starts the game ────────────────────────────────────────────────
    socket.on('player:start_game', ({ code }) => {
      const room = rooms.get(code);
      if (!room || room.leaderId !== socket.id) return;
      if (room.players.length < 2) { socket.emit('player:error', { message: 'Need at least 2 players to start.' }); return; }
      if (!room.category.trim()) { socket.emit('player:error', { message: 'Please enter a draft category.' }); return; }

      room.players = room.players.sort(() => Math.random() - 0.5);
      room.draftOrder = getSnakeDraftOrder(room.players.length, 1);
      room.currentRound = 1;
      room.currentPickIndex = 0;
      room.phase = 'drafting';
      ioInstance.to(code).emit('host:state_update', roomSummary(room));
      ioInstance.to(code).emit('game:phase_change', { phase: 'drafting' });
    });

    // ── Draft pick ────────────────────────────────────────────────────────────
    socket.on('player:submit_pick', ({ code, pick }) => {
      const room = rooms.get(code);
      if (!room || room.phase !== 'drafting') return;
      const picker = currentPicker(room);
      if (!picker || picker.id !== socket.id) { socket.emit('player:error', { message: 'Not your turn.' }); return; }
      const trimmed = pick.trim().slice(0, 60);
      if (!trimmed) { socket.emit('player:error', { message: 'Pick cannot be empty.' }); return; }

      const normalized = trimmed.toLowerCase();
      const allPicks = room.players.flatMap(p => p.picks.map(pk => pk.toLowerCase()));
      if (allPicks.includes(normalized)) {
        socket.emit('player:error', { message: 'That pick has already been taken.' }); return;
      }

      picker.picks.push(trimmed);
      touchRoom(room);

      const result = advancePick(room);
      if (result === 'draft_complete') {
        if (room.players.length === 2) {
          room.phase = 'results';
          const tally = tallyVotes(room);
          ioInstance.to(code).emit('host:state_update', roomSummary(room));
          ioInstance.to(code).emit('game:results', { tally, players: room.players });
          ioInstance.to(code).emit('game:phase_change', { phase: 'results' });
        } else {
          room.phase = 'voting';
          ioInstance.to(code).emit('host:state_update', roomSummary(room));
          ioInstance.to(code).emit('game:phase_change', { phase: 'voting' });
        }
      } else {
        ioInstance.to(code).emit('host:state_update', roomSummary(room));
      }
    });

    // ── Vote ──────────────────────────────────────────────────────────────────
    socket.on('player:submit_vote', ({ code, targetId }) => {
      const room = rooms.get(code);
      if (!room || room.phase !== 'voting') return;
      if (socket.id === targetId) { socket.emit('player:error', { message: "You can't vote for yourself." }); return; }
      if (!room.players.some(p => p.id === targetId)) { socket.emit('player:error', { message: 'Invalid vote target.' }); return; }
      if (room.votes[socket.id]) { socket.emit('player:error', { message: 'Already voted.' }); return; }

      room.votes[socket.id] = targetId;
      socket.emit('player:vote_recorded');

      const voterCount = Object.keys(room.votes).length;
      if (voterCount >= room.players.length) {
        room.phase = 'results';
        const tally = tallyVotes(room);
        ioInstance.to(code).emit('host:state_update', roomSummary(room));
        ioInstance.to(code).emit('game:results', { tally, players: room.players });
        ioInstance.to(code).emit('game:phase_change', { phase: 'results' });
      } else {
        ioInstance.to(code).emit('host:votes_update', { votesCast: voterCount, total: room.players.length });
      }
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
      const player = room.players.find(p => p.id === socket.id);
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
    socket.on('disconnect', () => {
      const code = socket.data.roomCode;
      if (!code) return;
      const room = rooms.get(code);
      if (!room) return;

      if (room.hostSocketId === socket.id) {
        ioInstance.to(code).emit('game:host_disconnected');
        rooms.delete(code);
        return;
      }

      if (room.phase === 'lobby') {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.leaderId === socket.id && room.players.length > 0) {
          room.leaderId = room.players[0].id;
          ioInstance.to(room.leaderId).emit('player:promoted_to_leader');
        }
        ioInstance.to(code).emit('host:state_update', roomSummary(room));
      }
    });
  });
}

// ─── Server Lifecycle ─────────────────────────────────────────────────────────

// Expire rooms that have been idle for 2 hours
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const [code, room] of rooms.entries()) {
    if (room.lastActivity < cutoff) rooms.delete(code);
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
