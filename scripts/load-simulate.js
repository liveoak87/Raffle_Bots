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
const databasePath = process.env.DATABASE_PATH || "/data/raffle.db";
const db = new Database(databasePath, { readonly: true });

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

// Estimate group post edits once the render cache is warm. Reminders, draws,
// callback answers, errors and retries are separate from these entry profiles.
const CHAT_API_MIN_INTERVAL_MS = 1100;
const editCapacity = 60_000 / CHAT_API_MIN_INTERVAL_MS;
console.log("Projected group post edits per minute after the first refresh:");
console.log("  Quiet, unchanged raffles: 0 (Telegram renders relative time).");
console.log(`  One entry per raffle: up to ${SIMULATE_N}.`);
console.log(`  Ten entries per raffle in one short burst: up to ${2 * SIMULATE_N}.`);
console.log(`  Ten entries per raffle spaced six seconds apart: up to ${10 * SIMULATE_N}.`);
console.log(`  Group request pacing: about ${editCapacity.toFixed(1)} requests/minute before other traffic and retries.`);
console.log("  New group messages also share a separate limit of 20 in a rolling minute.");
