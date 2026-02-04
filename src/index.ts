import "dotenv/config";
import { Bot } from "grammy";
import { initDatabase } from "./database";
import * as db from "./database";
import {
  handleStart,
  handleHelp,
  handleNewRaffle,
  handleListRaffles,
  handleDraw,
  handleCancelRaffle,
  handleMyEntries,
  handleRaffleHistory,
  handleExportEntries,
  handleRerun,
  handleEnterCallback,
  handleLeaveCallback,
  handleEntriesCallback,
} from "./commands";
import { formatWinnersMessage, escapeHtml } from "./helpers";
import { parsePrizes } from "./types";

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("Error: BOT_TOKEN environment variable is required.");
  console.error("Get a token from @BotFather on Telegram and set it in .env");
  process.exit(1);
}

const DB_PATH = process.env.DATABASE_PATH || "./raffle.db";

// Data retention: hours to keep completed raffle data (0 = keep forever)
const DATA_RETENTION_HOURS = parseInt(
  process.env.DATA_RETENTION_HOURS || "0",
  10
);

// Initialize database
initDatabase(DB_PATH);
console.log(`Database initialized at ${DB_PATH}`);
if (DATA_RETENTION_HOURS > 0) {
  console.log(
    `Data retention: completed raffle data will be purged after ${DATA_RETENTION_HOURS} hours`
  );
} else {
  console.log(`Data retention: disabled (data kept indefinitely)`);
}

// Create bot
const bot = new Bot(BOT_TOKEN);

// --- Register commands ---
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("newraffle", handleNewRaffle);
bot.command("raffles", handleListRaffles);
bot.command("draw", handleDraw);
bot.command("cancelraffle", handleCancelRaffle);
bot.command("myentries", handleMyEntries);
bot.command("rafflehistory", handleRaffleHistory);
bot.command("exportentries", handleExportEntries);
bot.command("rerun", handleRerun);

// --- Register callback queries ---
bot.callbackQuery(/^enter_\d+$/, handleEnterCallback);
bot.callbackQuery(/^leave_\d+$/, handleLeaveCallback);
bot.callbackQuery(/^entries_\d+$/, handleEntriesCallback);

// --- Auto-draw expired raffles ---
const EXPIRY_CHECK_INTERVAL = 30_000; // 30 seconds

async function checkExpiredRaffles(): Promise<void> {
  try {
    const expired = db.getExpiredOpenRaffles();
    for (const raffle of expired) {
      console.log(`Auto-drawing expired raffle: ${raffle.id} - ${raffle.title}`);

      const entryCount = db.getEntryCount(raffle.id);

      if (entryCount === 0) {
        db.markRaffleDrawn(raffle.id);
        try {
          await bot.api.sendMessage(
            raffle.chat_id,
            `🎟 <b>${escapeHtml(raffle.title)}</b>\n\n⏰ Raffle ended. No entries were received.`,
            { parse_mode: "HTML" }
          );
        } catch {
          // Chat may no longer be accessible
        }
      } else {
        const winners = db.selectWinners(raffle.id);
        try {
          await bot.api.sendMessage(
            raffle.chat_id,
            formatWinnersMessage(raffle, winners),
            { parse_mode: "HTML" }
          );
        } catch {
          // Chat may no longer be accessible
        }
      }

      // Update the original raffle post
      if (raffle.message_id) {
        try {
          const updatedRaffle = db.getRaffleById(raffle.id);
          if (updatedRaffle) {
            const prizes = parsePrizes(updatedRaffle);
            let text = `🎟 <b>${escapeHtml(updatedRaffle.title)}</b>\n\n`;

            if (prizes.length > 1) {
              text += `🎁 <b>Prizes:</b>\n`;
              prizes.forEach((p, i) => {
                const label = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
                text += `  ${label} ${escapeHtml(p)}\n`;
              });
            } else {
              text += `🎁 <b>Prize:</b> ${escapeHtml(prizes[0])}\n`;
            }

            text += `👥 <b>Entries:</b> ${entryCount}\n`;
            text += `\n🎉 This raffle has ended!`;

            const winners = db.getWinnersForRaffle(raffle.id);
            if (winners.length > 0) {
              text += `\n\n🏆 <b>Winners:</b>\n`;
              winners.forEach((w) => {
                const mention = `<a href="tg://user?id=${w.user_id}">${escapeHtml(w.user_display_name)}</a>`;
                if (w.prize) {
                  text += `  🎁 ${mention} — ${escapeHtml(w.prize)}\n`;
                } else {
                  text += `  • ${mention}\n`;
                }
              });
            }

            await bot.api.editMessageText(
              raffle.chat_id,
              raffle.message_id,
              text,
              { parse_mode: "HTML" }
            );
          }
        } catch {
          // Message may be too old or deleted
        }
      }
    }
  } catch (err) {
    console.error("Error checking expired raffles:", err);
  }
}

// --- Auto-purge completed raffle data ---
const PURGE_CHECK_INTERVAL = 60 * 60 * 1000; // check every hour

function purgeOldData(): void {
  if (DATA_RETENTION_HOURS <= 0) return;
  try {
    const purged = db.purgeExpiredData(DATA_RETENTION_HOURS);
    if (purged > 0) {
      console.log(`Data retention: purged ${purged} completed raffle(s)`);
    }
  } catch (err) {
    console.error("Error purging old data:", err);
  }
}

// --- Error handling ---
bot.catch((err) => {
  console.error("Bot error:", err);
});

// --- Start bot ---
async function main(): Promise<void> {
  // Set bot commands for the menu
  await bot.api.setMyCommands([
    { command: "newraffle", description: "Create a new raffle" },
    { command: "raffles", description: "List open raffles" },
    { command: "draw", description: "Draw winners for a raffle" },
    { command: "cancelraffle", description: "Cancel a raffle" },
    { command: "myentries", description: "See your active entries" },
    { command: "rafflehistory", description: "View past raffles" },
    { command: "exportentries", description: "Export participant list" },
    { command: "rerun", description: "Re-run a raffle with same participants" },
    { command: "help", description: "Show help message" },
  ]);

  // Start expiry checker
  setInterval(checkExpiredRaffles, EXPIRY_CHECK_INTERVAL);

  // Start data retention purge (run once at startup, then hourly)
  purgeOldData();
  setInterval(purgeOldData, PURGE_CHECK_INTERVAL);

  console.log("Raffle Bot is running! Press Ctrl+C to stop.");
  await bot.start();
}

main().catch((err) => {
  console.error("Failed to start bot:", err);
  process.exit(1);
});
