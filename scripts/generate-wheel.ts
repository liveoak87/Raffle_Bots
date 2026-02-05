/**
 * Spinning wheel GIF generator for Red Beard Raffle Bot.
 * Generates an animated spinning wheel GIF with colorful segments.
 *
 * Prerequisites: npm install canvas gif-encoder-2 (dev dependencies)
 * Usage: npx ts-node scripts/generate-wheel.ts
 */

// @ts-nocheck
/* eslint-disable */

const { createCanvas } = require("canvas");
const GIFEncoder = require("gif-encoder-2");
const fs = require("fs");
const path = require("path");

const SIZE = 400; // Square canvas
const CENTER = SIZE / 2;
const RADIUS = 170;
const OUTER_RING = 185;
const OUTPUT_DIR = path.join(__dirname, "..", "assets");

// Wheel segment colors — vibrant and varied
const SEGMENT_COLORS = [
  "#FF6B35", // Orange
  "#FFD700", // Gold
  "#FF1493", // Deep pink
  "#00D4FF", // Cyan
  "#7B68EE", // Medium slate blue
  "#32CD32", // Lime green
  "#FF4500", // Red-orange
  "#9370DB", // Medium purple
  "#00CED1", // Dark turquoise
  "#FF69B4", // Hot pink
  "#4169E1", // Royal blue
  "#FFB347", // Pastel orange
];

const NUM_SEGMENTS = SEGMENT_COLORS.length;

// Animation parameters
const TOTAL_FRAMES = 60;
const FRAME_DELAY = 50; // ms per frame (20fps)

// Rotation: starts fast, decelerates smoothly
// Total rotation ~ 5 full turns + partial
function getRotationAtFrame(frame: number): number {
  const t = frame / (TOTAL_FRAMES - 1); // 0..1

  // Ease-out cubic: fast start, smooth deceleration
  const eased = 1 - Math.pow(1 - t, 3);

  // Total rotation: ~5.3 full turns (in radians)
  const totalRotation = 5.3 * Math.PI * 2;

  return eased * totalRotation;
}

function drawWheel(
  ctx: CanvasRenderingContext2D,
  rotation: number,
  isLastFrame: boolean
): void {
  const canvas = ctx.canvas;

  // Dark background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Outer decorative ring
  ctx.save();
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, OUTER_RING, 0, Math.PI * 2);
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();

  // Draw segments
  const segmentAngle = (Math.PI * 2) / NUM_SEGMENTS;

  for (let i = 0; i < NUM_SEGMENTS; i++) {
    const startAngle = rotation + i * segmentAngle;
    const endAngle = startAngle + segmentAngle;

    // Segment fill
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(CENTER, CENTER);
    ctx.arc(CENTER, CENTER, RADIUS, startAngle, endAngle);
    ctx.closePath();
    ctx.fillStyle = SEGMENT_COLORS[i];
    ctx.fill();

    // Segment border
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Small dots near the outer edge of each segment
    const midAngle = startAngle + segmentAngle / 2;
    const dotX = CENTER + Math.cos(midAngle) * (RADIUS * 0.8);
    const dotY = CENTER + Math.sin(midAngle) * (RADIUS * 0.8);
    ctx.save();
    ctx.beginPath();
    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.fill();
    ctx.restore();
  }

  // Center hub
  ctx.save();
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, 30, 0, Math.PI * 2);
  const hubGrad = ctx.createRadialGradient(CENTER, CENTER, 5, CENTER, CENTER, 30);
  hubGrad.addColorStop(0, "#FFD700");
  hubGrad.addColorStop(1, "#B8860B");
  ctx.fillStyle = hubGrad;
  ctx.fill();
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Inner hub circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(CENTER, CENTER, 15, 0, Math.PI * 2);
  ctx.fillStyle = "#1a1a2e";
  ctx.fill();
  ctx.restore();

  // Pointer / ticker at the top
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(CENTER, CENTER - RADIUS - 5);
  ctx.lineTo(CENTER - 12, CENTER - RADIUS - 30);
  ctx.lineTo(CENTER + 12, CENTER - RADIUS - 30);
  ctx.closePath();
  ctx.fillStyle = "#FF0000";
  ctx.fill();
  ctx.strokeStyle = "#FFD700";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // Outer tick marks (like a prize wheel)
  for (let i = 0; i < NUM_SEGMENTS; i++) {
    const tickAngle = rotation + i * segmentAngle;
    const innerR = RADIUS - 2;
    const outerR = RADIUS + 8;
    const x1 = CENTER + Math.cos(tickAngle) * innerR;
    const y1 = CENTER + Math.sin(tickAngle) * innerR;
    const x2 = CENTER + Math.cos(tickAngle) * outerR;
    const y2 = CENTER + Math.sin(tickAngle) * outerR;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.strokeStyle = "#FFD700";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  // Glow effect on the last frame
  if (isLastFrame) {
    // Pulsing glow around the pointer area
    ctx.save();
    ctx.beginPath();
    ctx.arc(CENTER, CENTER - RADIUS - 15, 20, 0, Math.PI * 2);
    const glowGrad = ctx.createRadialGradient(
      CENTER, CENTER - RADIUS - 15, 2,
      CENTER, CENTER - RADIUS - 15, 20
    );
    glowGrad.addColorStop(0, "rgba(255, 215, 0, 0.6)");
    glowGrad.addColorStop(1, "rgba(255, 215, 0, 0)");
    ctx.fillStyle = glowGrad;
    ctx.fill();
    ctx.restore();
  }

  // Decorative corner sparkles
  const sparklePositions = [
    { x: 30, y: 30 }, { x: SIZE - 30, y: 30 },
    { x: 30, y: SIZE - 30 }, { x: SIZE - 30, y: SIZE - 30 },
    { x: SIZE / 2, y: 15 }, { x: SIZE / 2, y: SIZE - 15 },
  ];

  for (const sp of sparklePositions) {
    const flicker = Math.sin(rotation * 3 + sp.x) * 0.3 + 0.7;
    ctx.save();
    ctx.globalAlpha = flicker * 0.6;
    ctx.fillStyle = "#FFD700";
    drawStar(ctx, sp.x, sp.y, 2, 5, 4);
    ctx.fill();
    ctx.restore();
  }
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  points: number
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

// --- Generate the GIF ---

console.log("Generating spinning wheel GIF...");

const encoder = new GIFEncoder(SIZE, SIZE, "neuquant", true);
encoder.setDelay(FRAME_DELAY);
encoder.setRepeat(-1); // Play once, don't loop
encoder.setQuality(10);
encoder.setTransparent(0x000000);

encoder.start();

const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;

for (let frame = 0; frame < TOTAL_FRAMES; frame++) {
  const rotation = getRotationAtFrame(frame);
  const isLast = frame === TOTAL_FRAMES - 1;

  drawWheel(ctx, rotation, isLast);
  encoder.addFrame(ctx as unknown as CanvasRenderingContext2D);

  if (frame % 10 === 0) {
    console.log(`  Frame ${frame + 1}/${TOTAL_FRAMES}`);
  }
}

// Hold the last frame longer (1.5 seconds)
for (let i = 0; i < 3; i++) {
  const rotation = getRotationAtFrame(TOTAL_FRAMES - 1);
  drawWheel(ctx, rotation, true);
  encoder.setDelay(500);
  encoder.addFrame(ctx as unknown as CanvasRenderingContext2D);
}

encoder.finish();

const outputPath = path.join(OUTPUT_DIR, "wheel_spin.gif");
const buffer = encoder.out.getData();
fs.writeFileSync(outputPath, buffer);
console.log(`\nGenerated: ${outputPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
