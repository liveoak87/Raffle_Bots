/**
 * Banner generation script for Red Beard Raffle Bot.
 * Generates 3 branded banner PNGs using node-canvas.
 *
 * Prerequisites: npm install canvas (not a runtime dependency)
 * Usage: npx ts-node scripts/generate-banners.ts
 */

import { createCanvas, CanvasRenderingContext2D } from "canvas";
import * as fs from "fs";
import * as path from "path";

const WIDTH = 1200;
const HEIGHT = 400;
const OUTPUT_DIR = path.join(__dirname, "..", "assets");

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// --- Color Palettes ---
interface BannerConfig {
  filename: string;
  title: string;
  subtitle: string;
  gradientColors: [string, string, string];
  accentColor: string;
  particleColors: string[];
  iconEmoji: string;
}

const banners: BannerConfig[] = [
  {
    filename: "banner_open.png",
    title: "RAFFLE OPEN",
    subtitle: "Red Beard Raffle Bot",
    gradientColors: ["#1a0533", "#2d1b69", "#4a1a8a"],
    accentColor: "#ff6b35",
    particleColors: ["#ff6b35", "#ffd700", "#ff1493", "#00d4ff", "#7b68ee", "#ff4500"],
    iconEmoji: "ticket",
  },
  {
    filename: "banner_drawn.png",
    title: "WINNERS DRAWN",
    subtitle: "Red Beard Raffle Bot",
    gradientColors: ["#1a0a00", "#4a2800", "#6b3a00"],
    accentColor: "#ffd700",
    particleColors: ["#ffd700", "#ff6b35", "#ffaa00", "#fff700", "#ff4500", "#ffa500"],
    iconEmoji: "trophy",
  },
  {
    filename: "banner_closed.png",
    title: "RAFFLE CLOSED",
    subtitle: "Red Beard Raffle Bot",
    gradientColors: ["#1a1a2e", "#16213e", "#0f3460"],
    accentColor: "#e94560",
    particleColors: ["#e94560", "#536878", "#708090", "#4a6fa5", "#94a3b8"],
    iconEmoji: "closed",
  },
];

// --- Drawing Helpers ---

function drawGradientBackground(
  ctx: CanvasRenderingContext2D,
  colors: [string, string, string]
): void {
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(0.5, colors[1]);
  gradient.addColorStop(1, colors[2]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawStars(ctx: CanvasRenderingContext2D, count: number, colors: string[]): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * WIDTH;
    const y = Math.random() * HEIGHT;
    const size = Math.random() * 4 + 1;
    const color = colors[Math.floor(Math.random() * colors.length)];
    const alpha = Math.random() * 0.6 + 0.2;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;

    // Draw a 4-pointed star
    drawStar(ctx, x, y, size, size * 2.5, 4);
    ctx.fill();
    ctx.restore();
  }
}

function drawStar(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  innerRadius: number,
  outerRadius: number,
  points: number
): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = (Math.PI * i) / points - Math.PI / 2;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawConfetti(ctx: CanvasRenderingContext2D, count: number, colors: string[]): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * WIDTH;
    const y = Math.random() * HEIGHT;
    const w = Math.random() * 12 + 4;
    const h = Math.random() * 6 + 2;
    const rotation = Math.random() * Math.PI * 2;
    const color = colors[Math.floor(Math.random() * colors.length)];
    const alpha = Math.random() * 0.7 + 0.3;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.fillStyle = color;
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  }
}

function drawTicketIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);

  // Ticket body (rounded rectangle with notches)
  const w = size;
  const h = size * 0.6;
  const r = 12;
  const notchR = h * 0.15;

  ctx.fillStyle = color;
  ctx.beginPath();

  // Top edge
  ctx.moveTo(-w / 2 + r, -h / 2);
  ctx.lineTo(w / 2 - r, -h / 2);
  ctx.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);

  // Right edge with notch
  ctx.lineTo(w / 2, -notchR);
  ctx.arc(w / 2, 0, notchR, -Math.PI / 2, Math.PI / 2, true);
  ctx.lineTo(w / 2, h / 2 - r);
  ctx.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);

  // Bottom edge
  ctx.lineTo(-w / 2 + r, h / 2);
  ctx.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);

  // Left edge with notch
  ctx.lineTo(-w / 2, notchR);
  ctx.arc(-w / 2, 0, notchR, Math.PI / 2, -Math.PI / 2, true);
  ctx.lineTo(-w / 2, -h / 2 + r);
  ctx.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);

  ctx.closePath();
  ctx.fill();

  // Dashed line through middle
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(-w / 2 + notchR + 5, 0);
  ctx.lineTo(w / 2 - notchR - 5, 0);
  ctx.stroke();
  ctx.setLineDash([]);

  // Ticket text
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = `bold ${size * 0.12}px Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("RAFFLE", 0, -h * 0.15);
  ctx.fillText("TICKET", 0, h * 0.15);

  ctx.restore();
}

function drawTrophyIcon(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.translate(x, y);
  const s = size / 100;

  ctx.fillStyle = color;

  // Cup body
  ctx.beginPath();
  ctx.moveTo(-30 * s, -40 * s);
  ctx.lineTo(30 * s, -40 * s);
  ctx.lineTo(25 * s, 10 * s);
  ctx.quadraticCurveTo(0, 30 * s, -25 * s, 10 * s);
  ctx.closePath();
  ctx.fill();

  // Left handle
  ctx.beginPath();
  ctx.arc(-35 * s, -15 * s, 15 * s, -Math.PI / 2, Math.PI / 2);
  ctx.lineWidth = 5 * s;
  ctx.strokeStyle = color;
  ctx.stroke();

  // Right handle
  ctx.beginPath();
  ctx.arc(35 * s, -15 * s, 15 * s, Math.PI / 2, -Math.PI / 2);
  ctx.stroke();

  // Stem
  ctx.fillRect(-4 * s, 10 * s, 8 * s, 20 * s);

  // Base
  ctx.beginPath();
  ctx.ellipse(0, 35 * s, 20 * s, 6 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // Star on cup
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  drawStar(ctx, 0, -15 * s, 5 * s, 12 * s, 5);
  ctx.fill();

  ctx.restore();
}

function drawGlowingOrbs(ctx: CanvasRenderingContext2D, count: number, colors: string[]): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * WIDTH;
    const y = Math.random() * HEIGHT;
    const radius = Math.random() * 30 + 10;
    const color = colors[Math.floor(Math.random() * colors.length)];

    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color + "40");
    gradient.addColorStop(0.5, color + "15");
    gradient.addColorStop(1, color + "00");

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBanner(config: BannerConfig): void {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  // 1. Background gradient
  drawGradientBackground(ctx, config.gradientColors);

  // 2. Glowing orbs (ambient light)
  drawGlowingOrbs(ctx, 15, config.particleColors);

  // 3. Stars
  drawStars(ctx, 60, config.particleColors);

  // 4. Confetti particles
  drawConfetti(ctx, 40, config.particleColors);

  // 5. Decorative ticket icons (scattered, faded)
  if (config.iconEmoji === "ticket") {
    ctx.globalAlpha = 0.08;
    drawTicketIcon(ctx, 150, 200, 200, config.accentColor);
    drawTicketIcon(ctx, 1050, 180, 160, config.accentColor);
    ctx.globalAlpha = 0.05;
    drawTicketIcon(ctx, 600, 320, 120, "#ffffff");
    ctx.globalAlpha = 1;
  } else if (config.iconEmoji === "trophy") {
    ctx.globalAlpha = 0.1;
    drawTrophyIcon(ctx, 150, 200, 180, config.accentColor);
    drawTrophyIcon(ctx, 1050, 180, 140, config.accentColor);
    ctx.globalAlpha = 1;
  }

  // 6. Central decorative element — large faded icon
  ctx.globalAlpha = 0.06;
  if (config.iconEmoji === "ticket") {
    drawTicketIcon(ctx, WIDTH / 2, HEIGHT / 2 + 20, 400, "#ffffff");
  } else if (config.iconEmoji === "trophy") {
    drawTrophyIcon(ctx, WIDTH / 2, HEIGHT / 2 + 20, 300, "#ffffff");
  }
  ctx.globalAlpha = 1;

  // 7. Accent line across top
  const lineGrad = ctx.createLinearGradient(0, 0, WIDTH, 0);
  lineGrad.addColorStop(0, config.accentColor + "00");
  lineGrad.addColorStop(0.3, config.accentColor);
  lineGrad.addColorStop(0.7, config.accentColor);
  lineGrad.addColorStop(1, config.accentColor + "00");
  ctx.fillStyle = lineGrad;
  ctx.fillRect(0, 0, WIDTH, 4);

  // 8. Bottom accent line
  ctx.fillRect(0, HEIGHT - 4, WIDTH, 4);

  // 9. Main title text with glow
  ctx.save();
  ctx.shadowColor = config.accentColor;
  ctx.shadowBlur = 30;
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 72px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(config.title, WIDTH / 2, HEIGHT / 2 - 20);
  // Double pass for stronger glow
  ctx.fillText(config.title, WIDTH / 2, HEIGHT / 2 - 20);
  ctx.restore();

  // 10. Subtitle
  ctx.save();
  ctx.fillStyle = config.accentColor;
  ctx.font = "bold 24px Arial, Helvetica, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(config.subtitle, WIDTH / 2, HEIGHT / 2 + 40);
  ctx.restore();

  // 11. Decorative dots flanking the subtitle
  const subtitleWidth = ctx.measureText(config.subtitle).width;
  const dotY = HEIGHT / 2 + 40;
  ctx.fillStyle = config.accentColor;
  ctx.beginPath();
  ctx.arc(WIDTH / 2 - subtitleWidth / 2 - 20, dotY, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(WIDTH / 2 + subtitleWidth / 2 + 20, dotY, 4, 0, Math.PI * 2);
  ctx.fill();

  // 12. Corner decorations
  drawCornerAccents(ctx, config.accentColor);

  // Save to file
  const outputPath = path.join(OUTPUT_DIR, config.filename);
  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated: ${outputPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
}

function drawCornerAccents(ctx: CanvasRenderingContext2D, color: string): void {
  const size = 40;
  const margin = 20;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.5;

  // Top-left
  ctx.beginPath();
  ctx.moveTo(margin, margin + size);
  ctx.lineTo(margin, margin);
  ctx.lineTo(margin + size, margin);
  ctx.stroke();

  // Top-right
  ctx.beginPath();
  ctx.moveTo(WIDTH - margin - size, margin);
  ctx.lineTo(WIDTH - margin, margin);
  ctx.lineTo(WIDTH - margin, margin + size);
  ctx.stroke();

  // Bottom-left
  ctx.beginPath();
  ctx.moveTo(margin, HEIGHT - margin - size);
  ctx.lineTo(margin, HEIGHT - margin);
  ctx.lineTo(margin + size, HEIGHT - margin);
  ctx.stroke();

  // Bottom-right
  ctx.beginPath();
  ctx.moveTo(WIDTH - margin - size, HEIGHT - margin);
  ctx.lineTo(WIDTH - margin, HEIGHT - margin);
  ctx.lineTo(WIDTH - margin, HEIGHT - margin - size);
  ctx.stroke();

  ctx.globalAlpha = 1;
}

// --- Generate all banners ---
console.log("Generating banner images...\n");
for (const config of banners) {
  drawBanner(config);
}
console.log("\nDone! Banner images saved to assets/");
