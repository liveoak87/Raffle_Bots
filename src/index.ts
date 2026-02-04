import "dotenv/config";
import { Bot } from "grammy";
import { initDatabase } from "./database";
import * as db from "./database";
import {
  handleStart,
  handleHelp,
  handleGroupId,
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
  notifyWinnersAndCreator,
} from "./commands";
import { formatWinnersMessage, escapeHtml, getForwardedChat } from "./helpers";
import { parsePrizes } from "./types";
import {
  handleWizardMessage,
  handleWinnersCallback,
  handleTimeCallback,
  handleRequireCallback,
  handleSponsorCallback,
  handleStartDeepLink,
  getActiveWizard,
} from "./wizard";

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

// --- Auto-delete command messages in group chats ---
bot.use(async (ctx, next) => {
  const isGroup =
    ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  const isCommand = ctx.message?.text?.startsWith("/");

  if (isGroup && isCommand) {
    try {
      await ctx.deleteMessage();
    } catch {
      // Bot may not have delete permission
    }
  }

  await next();
});

// --- Register commands ---
bot.command("start", handleStart);
bot.command("help", handleHelp);
bot.command("groupid", handleGroupId);
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

// --- Wizard callback queries ---
bot.callbackQuery(/^wiz_winners_\d+$/, handleWinnersCallback);
bot.callbackQuery(/^wiz_time_/, handleTimeCallback);
bot.callbackQuery(/^wiz_require_/, handleRequireCallback);
bot.callbackQuery(/^wiz_sponsor_/, handleSponsorCallback);

// --- Handle text messages (for wizard responses in DMs) ---
bot.on("message:text", async (ctx) => {
  if (!ctx.from) return;
  // Skip commands — they're handled above
  if (ctx.message.text.startsWith("/")) return;

  // Only process wizard messages in private chat (DMs)
  if (ctx.chat.type !== "private") return;

  // Check if user has an active wizard
  const state = getActiveWizard(ctx.from.id);
  if (!state) return;

  await handleWizardMessage(ctx);
});

// --- Handle forwarded messages in DMs (for getting group IDs) ---
bot.on("message", async (ctx) => {
  if (!ctx.from) return;
  if (ctx.chat.type !== "private") return;

  const forwardChat = getForwardedChat(ctx.message);
  if (!forwardChat) return;

  // If user has an active wizard, the wizard handler already dealt with it
  const state = getActiveWizard(ctx.from.id);
  if (state) return;

  await ctx.reply(
    `📋 <b>Forwarded Message Info</b>\n\n` +
      `<b>Group:</b> ${escapeHtml(forwardChat.title)}\n` +
      `<b>Chat ID:</b> <code>${forwardChat.id}</code>\n\n` +
      `You can use this ID for the "require membership" feature when creating a raffle.`,
    { parse_mode: "HTML" }
  );
});

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
        // DM winners and creator
        await notifyWinnersAndCreator(bot.api, raffle, winners);
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
    { command: "groupid", description: "Show this group's chat ID" },
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
