const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');

// In-memory cache: raffleId -> Buffer
const cache = new Map();

async function generateBanner(prize, raffleId = null) {
  // Return cached version if available
  if (raffleId && cache.has(raffleId)) {
    return cache.get(raffleId);
  }

  const width = 800;
  const height = 200;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ── Background gradient ──────────────────────────────────────────────────
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#0f0c29');
  gradient.addColorStop(0.5, '#302b63');
  gradient.addColorStop(1, '#24243e');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // ── Decorative accent lines ──────────────────────────────────────────────
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(50, 10);
  ctx.lineTo(width - 50, 10);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(50, height - 10);
  ctx.lineTo(width - 50, height - 10);
  ctx.stroke();

  // ── Corner decorations ───────────────────────────────────────────────────
  ctx.fillStyle = '#FFD700';
  const cornerSize = 8;
  // Top-left
  ctx.fillRect(40, 5, cornerSize, cornerSize);
  // Top-right
  ctx.fillRect(width - 40 - cornerSize, 5, cornerSize, cornerSize);
  // Bottom-left
  ctx.fillRect(40, height - 5 - cornerSize, cornerSize, cornerSize);
  // Bottom-right
  ctx.fillRect(width - 40 - cornerSize, height - 5 - cornerSize, cornerSize, cornerSize);

  // ── Sparkle dots ─────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(255, 215, 0, 0.3)';
  const sparkles = [
    [120, 40], [680, 35], [200, 160], [600, 155],
    [90, 100], [710, 95], [350, 25], [450, 175]
  ];
  for (const [sx, sy] of sparkles) {
    ctx.beginPath();
    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Title text ───────────────────────────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText('ULTIMATE RANDOMIZER', width / 2 + 2, 75 + 2);

  // Main title
  const titleGradient = ctx.createLinearGradient(150, 50, 650, 100);
  titleGradient.addColorStop(0, '#FFD700');
  titleGradient.addColorStop(0.5, '#FFF8DC');
  titleGradient.addColorStop(1, '#FFD700');
  ctx.fillStyle = titleGradient;
  ctx.font = 'bold 42px sans-serif';
  ctx.fillText('ULTIMATE RANDOMIZER', width / 2, 75);

  // ── Divider ──────────────────────────────────────────────────────────────
  const divGrad = ctx.createLinearGradient(200, 0, 600, 0);
  divGrad.addColorStop(0, 'rgba(255, 215, 0, 0)');
  divGrad.addColorStop(0.5, 'rgba(255, 215, 0, 0.8)');
  divGrad.addColorStop(1, 'rgba(255, 215, 0, 0)');
  ctx.strokeStyle = divGrad;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(200, 105);
  ctx.lineTo(600, 105);
  ctx.stroke();

  // ── Prize text ───────────────────────────────────────────────────────────
  ctx.fillStyle = '#CCCCCC';
  ctx.font = '22px sans-serif';
  const prizeText = prize.length > 50 ? prize.substring(0, 47) + '...' : prize;
  ctx.fillText(prizeText, width / 2, 140);

  // ── Encode to PNG buffer ─────────────────────────────────────────────────
  const buffer = canvas.toBuffer('image/png');

  if (raffleId) {
    cache.set(raffleId, buffer);
  }

  return buffer;
}

function clearBannerCache(raffleId) {
  cache.delete(raffleId);
}

module.exports = { generateBanner, clearBannerCache };
