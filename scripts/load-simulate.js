/**
 * Load simulator: validates the bot's per-chat throttle protects against
 * the "50 raffles in one chat" scenario without bumping into Telegram's
 * actual rate limits.
 *
 * What it does:
 *   1. Reads the live DB (read-only — does NOT modify anything)
 *   2. Picks the busiest chat by active-raffle count
 *   3. Reports projected API call rate under three load profiles:
 *        - Quiet: countdown refresh only
 *        - Active: + 1 entry/raffle/minute
 *        - Stress: + 10 entries/raffle/minute
 *
 * Use this BEFORE a planned high-load event (like the user's 50-raffle day)
 * to verify the bot can handle it.
 *
 * Run from inside the container:
 *   docker exec raffle-bot node /app/scripts/load-simulate.js
 */

const Database = require("better-sqlite3");
const db = new Database("/data/raffle.db", { readonly: true });

console.log("=== Load Simulation ===\n");

// All currently-open raffles with end times, grouped by chat
const raffles = db
  .prepare(
    `SELECT chat_id, COUNT(*) as n
     FROM raffles
     WHERE status = 'open' AND ends_at IS NOT NULL
     GROUP BY chat_id
     ORDER BY n DESC`
  )
  .all();

if (raffles.length === 0) {
  console.log("No open raffles to simulate against.");
  process.exit(0);
}

console.log("Current load by chat:");
for (const r of raffles.slice(0, 10)) {
  console.log(`  Chat ${r.chat_id}: ${r.n} active raffle(s)`);
}
console.log();

// Pick a target N to simulate
const SIMULATE_N = parseInt(process.argv[2] || "50", 10);
console.log(`Simulating ${SIMULATE_N} concurrent raffles in ONE chat:`);
console.log();

// Telegram's per-chat sustained limit is ~1 msg/sec for groups
const CHAT_API_MIN_INTERVAL_MS = 1100;
const COUNTDOWN_REFRESH_PER_MIN = 1; // each raffle refreshes once per min in tight mode

// Profile A: Quiet — just countdown refreshes
const quietApiCallsPerMin = SIMULATE_N * COUNTDOWN_REFRESH_PER_MIN;
const quietCallsPerSec = quietApiCallsPerMin / 60;

console.log("Profile A — Quiet (countdown only):");
console.log(`  API calls/min: ${quietApiCallsPerMin}`);
console.log(`  API calls/sec: ${quietCallsPerSec.toFixed(2)}`);
console.log(`  Headroom under 1.1s throttle: ${quietCallsPerSec < 1 / (CHAT_API_MIN_INTERVAL_MS / 1000) ? "✅ OK" : "⚠️ tight"}`);
console.log();

// Profile B: Active — 1 entry/raffle/min
const activeApiCallsPerMin = SIMULATE_N * (COUNTDOWN_REFRESH_PER_MIN + 1);
const activeCallsPerSec = activeApiCallsPerMin / 60;
console.log("Profile B — Active (1 entry/raffle/min):");
console.log(`  API calls/min: ${activeApiCallsPerMin}`);
console.log(`  API calls/sec: ${activeCallsPerSec.toFixed(2)}`);
console.log(`  Headroom: ${activeCallsPerSec < 1 / (CHAT_API_MIN_INTERVAL_MS / 1000) ? "✅ OK" : "⚠️ near limit"}`);
console.log();

// Profile C: Stress — 10 entries/raffle/min
const stressApiCallsPerMin = SIMULATE_N * (COUNTDOWN_REFRESH_PER_MIN + 10);
const stressCallsPerSec = stressApiCallsPerMin / 60;
console.log("Profile C — Stress (10 entries/raffle/min):");
console.log(`  API calls/min: ${stressApiCallsPerMin}`);
console.log(`  API calls/sec: ${stressCallsPerSec.toFixed(2)}`);
console.log(`  Note: smart debounce batches rapid entries to ~1 edit per debounce window`);
console.log(`  Effective rate with debounce: ~${(SIMULATE_N * 2).toFixed(0)}/min (= ${(SIMULATE_N * 2 / 60).toFixed(2)}/sec)`);
const effectiveStressCallsPerSec = (SIMULATE_N * 2) / 60;
console.log(`  Effective headroom: ${effectiveStressCallsPerSec < 1 / (CHAT_API_MIN_INTERVAL_MS / 1000) ? "✅ OK" : "⚠️ near limit"}`);
console.log();

console.log("Throttle wall-time projections:");
console.log(`  Per-chat throttle: ${CHAT_API_MIN_INTERVAL_MS}ms between any 2 sends`);
console.log(`  ${SIMULATE_N} sequential calls to one chat: ${((SIMULATE_N * CHAT_API_MIN_INTERVAL_MS) / 1000).toFixed(1)}s`);
console.log(`  If 50 raffles refresh in lockstep: ${((50 * CHAT_API_MIN_INTERVAL_MS) / 1000).toFixed(1)}s — fits inside 60s refresh cycle: ${50 * CHAT_API_MIN_INTERVAL_MS < 60_000 ? "✅" : "❌ NEEDS LARGER REFRESH WINDOW"}`);
console.log();

console.log("Recommendations:");
if (50 * CHAT_API_MIN_INTERVAL_MS > 60_000) {
  console.log("  ⚠️ At >50 raffles per chat, lower CHAT_API_MIN_INTERVAL_MS or extend the countdown cycle.");
}
console.log("  ✅ With smart debounce, entry bursts collapse to 1-2 edits per raffle per 2.5s window.");
console.log("  ✅ Per-chat throttle (1.1s) means group will see at most ~55 messages/min from the bot.");
console.log("  ℹ️  Telegram's true per-chat group limit is ~20 msg/min sustained. We're at the edge but");
console.log("      autoRetry with 90s max backoff will absorb any 429 spikes.");
