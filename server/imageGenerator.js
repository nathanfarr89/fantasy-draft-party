// Image generation using node-canvas
// Falls back to graceful error if canvas is unavailable (optional dependency)

let createCanvas;
try {
  ({ createCanvas } = require('@napi-rs/canvas'));
} catch (e) {
  createCanvas = null;
}

const COLORS = [
  '#E63946', '#2A9D8F', '#E9C46A', '#F4A261', '#264653',
  '#6A4C93', '#1982C4', '#8AC926', '#FF595E', '#6A994E',
];

const BG = '#1a1a2e';
const CARD_BG = '#16213e';
const TEXT_PRIMARY = '#eaeaea';
const TEXT_SECONDARY = '#a0a0b0';
const ACCENT = '#e94560';

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  let currentY = y;
  for (let i = 0; i < words.length; i++) {
    const testLine = line + words[i] + ' ';
    if (ctx.measureText(testLine).width > maxWidth && i > 0) {
      ctx.fillText(line.trim(), x, currentY);
      line = words[i] + ' ';
      currentY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line.trim(), x, currentY);
  return currentY;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

async function generateDraftImage(room) {
  if (!createCanvas) throw new Error('Canvas module not available');

  const CARD_W = 300;
  const CARD_PADDING = 20;
  const HEADER_H = 120;
  const PICK_ROW_H = 36;
  const CARD_TOP_PAD = 60;
  const cols = Math.min(room.players.length, 4);
  const rows = Math.ceil(room.players.length / 4);
  const maxPicks = room.maxRounds;
  const cardH = CARD_TOP_PAD + maxPicks * PICK_ROW_H + 20;
  const canvasW = cols * (CARD_W + CARD_PADDING) + CARD_PADDING;
  const canvasH = HEADER_H + rows * (cardH + CARD_PADDING) + CARD_PADDING;

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Header
  ctx.fillStyle = ACCENT;
  ctx.fillRect(0, 0, canvasW, 6);

  ctx.fillStyle = TEXT_PRIMARY;
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FANTASY DRAFT RESULTS', canvasW / 2, 50);

  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = '20px sans-serif';
  ctx.fillText(room.category, canvasW / 2, 85);

  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = '16px sans-serif';
  ctx.fillText(`${room.players.length} players · ${room.maxRounds} rounds`, canvasW / 2, 110);

  // Player cards
  room.players.forEach((player, idx) => {
    const col = idx % 4;
    const row = Math.floor(idx / 4);
    const x = CARD_PADDING + col * (CARD_W + CARD_PADDING);
    const y = HEADER_H + CARD_PADDING + row * (cardH + CARD_PADDING);
    const color = COLORS[idx % COLORS.length];

    // Card background
    ctx.fillStyle = CARD_BG;
    roundRect(ctx, x, y, CARD_W, cardH, 10);
    ctx.fill();

    // Color accent bar
    ctx.fillStyle = color;
    roundRect(ctx, x, y, CARD_W, 6, 3);
    ctx.fill();

    // Player name
    ctx.fillStyle = color;
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(player.name.toUpperCase(), x + 14, y + 35);

    // Picks
    player.picks.forEach((pick, pickIdx) => {
      const pickY = y + CARD_TOP_PAD + pickIdx * PICK_ROW_H;

      // Alternating row tint
      if (pickIdx % 2 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.fillRect(x + 10, pickY - 14, CARD_W - 20, PICK_ROW_H);
      }

      ctx.fillStyle = TEXT_SECONDARY;
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`${pickIdx + 1}.`, x + 14, pickY + 4);

      ctx.fillStyle = TEXT_PRIMARY;
      ctx.font = '15px sans-serif';
      const maxW = CARD_W - 50;
      const text = pick.length > 28 ? pick.slice(0, 27) + '…' : pick;
      ctx.fillText(text, x + 32, pickY + 4);
    });
  });

  const buf = await canvas.encode('png');
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function generatePlayerImage(room, player) {
  if (!createCanvas) throw new Error('Canvas module not available');

  const W = 600;
  const PICK_ROW_H = 50;
  const HEADER_H = 140;
  const H = HEADER_H + player.picks.length * PICK_ROW_H + 60;
  const playerIdx = room.players.findIndex(p => p.id === player.id);
  const color = COLORS[playerIdx % COLORS.length];

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // Top accent bar
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, 6);

  // Header
  ctx.fillStyle = color;
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(player.name.toUpperCase(), W / 2, 60);

  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = '18px sans-serif';
  ctx.fillText(room.category, W / 2, 90);

  ctx.fillStyle = TEXT_SECONDARY;
  ctx.font = '15px sans-serif';
  ctx.fillText(`${player.picks.length} picks`, W / 2, 120);

  // Divider
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(30, 135, W - 60, 1);

  // Picks
  player.picks.forEach((pick, idx) => {
    const y = HEADER_H + idx * PICK_ROW_H;

    if (idx % 2 === 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.04)';
      ctx.fillRect(20, y, W - 40, PICK_ROW_H);
    }

    ctx.fillStyle = color;
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`${idx + 1}.`, 36, y + 32);

    ctx.fillStyle = TEXT_PRIMARY;
    ctx.font = '18px sans-serif';
    ctx.fillText(pick, 60, y + 32);
  });

  // Bottom accent
  ctx.fillStyle = color;
  ctx.fillRect(0, H - 4, W, 4);

  const buf = await canvas.encode('png');
  return 'data:image/png;base64,' + buf.toString('base64');
}

module.exports = { generateDraftImage, generatePlayerImage };
