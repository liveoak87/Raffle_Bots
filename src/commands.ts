import * as fs from "fs";
import * as path from "path";
import { InlineKeyboard, InputFile } from "grammy";
import type { Context } from "grammy";
import * as db from "./database";
import { parsePrizes } from "./types";
import { metrics, computeLatencyStats } from "./metrics";
import { getJobStats } from "./jobs";
import {
  escapeHtml,
  getUserDisplayName,
  formatRaffleMessage,
  formatWinnersMessage,
  formatCountdown,
  replyPrivately,
  buildRaffleKeyboard,
  buildMessageLink,
} from "./helpers";
import {
  startWizard,
  startRaffleWizardForGroup,
  startTemplateWizard,
  handleStartDeepLink,
  startEditWizard,
  startBugReport,
  buildDefaultTopicSetupText,
  setActiveWizardDestination,
} from "./wizard";
import { t, getLanguageName, getAvailableLanguages } from "./i18n";
import { sendWheelSpin, sendRafflePost, getBannerFileId, sendWinnerPost } from "./banners";
import { getForumTopicName } from "./forumTopics";
import { getGroupManagementAccess, isGroupOwner } from "./access";
import {
  decodeRerunDestination,
  encodeRerunDestination,
  resolveRerunThread,
  sendWithGeneralFallback,
  type RerunDestination,
} from "./rerun";

// --- Smart debounced post updates ---
// Pattern: first entry refreshes the message immediately (so users see their
// click registered), but subsequent entries within DEBOUNCE_MS are batched
// into a single edit. After the window closes, the next entry starts a
// fresh "immediate" cycle.
//
// This gives both perceived snappiness (instant feedback) AND protection
// from API rate limits during entry bursts.
const DEBOUNCE_MS = 2_500;
interface PendingUpdate {
  timer: ReturnType<typeof setTimeout>;
  ctx: Context;
  lastEditAt: number;
}
const pendingPostUpdates = new Map<number, PendingUpdate>();

function debouncedUpdateRafflePost(ctx: Context, raffleId: number): void {
  const now = Date.now();
  const existing = pendingPostUpdates.get(raffleId);

  // First entry in a fresh window — edit immediately
  if (!existing || now - existing.lastEditAt > DEBOUNCE_MS) {
    if (existing) clearTimeout(existing.timer);
    pendingPostUpdates.set(raffleId, {
      timer: setTimeout(() => {}, 0), // placeholder, replaced below
      ctx,
      lastEditAt: now,
    });
    updateRafflePost(ctx, raffleId).catch((err) =>
      console.error("Failed to update raffle post:", err)
    );
    // Schedule a "trailing edge" refresh in case more entries arrive during the window
    const trailingTimer = setTimeout(() => {
      const e = pendingPostUpdates.get(raffleId);
      if (e) {
        pendingPostUpdates.delete(raffleId);
        updateRafflePost(ctx, raffleId).catch((err) =>
          console.error("Failed to update raffle post (trailing):", err)
        );
      }
    }, DEBOUNCE_MS);
    pendingPostUpdates.get(raffleId)!.timer = trailingTimer;
    return;
  }

  // Subsequent entry within the debounce window — refresh the trailing timer
  clearTimeout(existing.timer);
  existing.ctx = ctx;
  existing.timer = setTimeout(() => {
    pendingPostUpdates.delete(raffleId);
    updateRafflePost(ctx, raffleId).catch((err) =>
      console.error("Failed to update raffle post (trailing):", err)
    );
  }, DEBOUNCE_MS);
}

/**
 * Estimate a Telegram account's age in days based on user ID ranges.
 * Telegram IDs are roughly sequential; this uses known reference points.
 * Returns null if unable to estimate (very old accounts).
 */
function estimateAccountAgeDays(userId: number): number | null {
  // Known approximate reference points (userId → Unix timestamp)
  const refs: Array<[number, number]> = [
    [1_000_000_000, new Date("2020-06-01").getTime()],
    [2_000_000_000, new Date("2021-05-01").getTime()],
    [5_000_000_000, new Date("2022-06-01").getTime()],
    [6_000_000_000, new Date("2023-01-01").getTime()],
    [7_000_000_000, new Date("2024-01-01").getTime()],
    [8_000_000_000, new Date("2025-01-01").getTime()],
  ];

  // Very old accounts (pre-2020) — can't estimate well, assume old enough
  if (userId < refs[0][0]) return null;

  // Find surrounding reference points and interpolate
  for (let i = 0; i < refs.length - 1; i++) {
    if (userId >= refs[i][0] && userId < refs[i + 1][0]) {
      const fraction =
        (userId - refs[i][0]) / (refs[i + 1][0] - refs[i][0]);
      const estimatedMs =
        refs[i][1] + fraction * (refs[i + 1][1] - refs[i][1]);
      return Math.floor((Date.now() - estimatedMs) / 86_400_000);
    }
  }

  // Beyond last reference — extrapolate from last two points
  const last = refs[refs.length - 1];
  const prev = refs[refs.length - 2];
  const rate = (last[1] - prev[1]) / (last[0] - prev[0]);
  const estimatedMs = last[1] + (userId - last[0]) * rate;
  return Math.max(0, Math.floor((Date.now() - estimatedMs) / 86_400_000));
}

/** Format a duration in ms to a human-readable string like "2h 30m" */
function formatDurationHuman(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  return parts.length > 0 ? parts.join(" ") : "< 1m";
}

function buildPrivateHomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎛 Manage My Groups", "admin_groups").row()
    .text("🎟 My Active Entries", "home_entries").row()
    .text("🐛 Report a Bug", "home_bugreport").text("❓ Help", "home_help");
}

async function showPrivateHome(ctx: Context): Promise<void> {
  const message =
    `🎟 <b>Raffle Bot</b>\n\n` +
    `Choose what you want to do. Group setup and raffle management stay in this private chat.`;
  const options = {
    parse_mode: "HTML" as const,
    reply_markup: buildPrivateHomeKeyboard(),
  };

  if (ctx.chat?.type === "private") {
    await ctx.reply(message, options);
  } else if (ctx.from) {
    try { await ctx.api.sendMessage(ctx.from.id, message, options); } catch {}
  }
}

// /start - Open the private button-based home screen.
export async function handleStart(ctx: Context): Promise<void> {
  // Check for deep link payload (e.g., /start newraffle_-1001234567890)
  const text = ctx.message?.text || "";
  const payload = text.replace(/^\/start(@\w+)?/i, "").trim();
  if (payload) {
    const handled = await handleStartDeepLink(ctx, payload);
    if (handled) return;
    if (payload === "manage") {
      await showAdminGroupPicker(ctx);
      return;
    }
  }

  await showPrivateHome(ctx);
}

// /help
export async function handleHelp(ctx: Context): Promise<void> {
  await replyPrivately(ctx,
    `🎟 <b>Raffle Bot Help</b>\n\n` +
      `<b>Group administration stays private.</b>\n` +
      `Open the Admin Center, select a group where you are an admin, then use its buttons to create and manage raffles.\n\n` +
      `<b>Wizard options include:</b>\n` +
      `• 📝 Rules / description\n` +
      `• 👥 Max entries\n` +
      `• 👁 Anonymous mode (hide entries until draw)\n` +
      `• 🖼 Raffle banner image\n` +
      `• 🕐 Delayed start time\n` +
      `• 💎 Sponsor\n` +
      `• 📌 Auto-pin raffle message\n` +
      `• 🔒 Required group membership\n` +
      `• 📛 Username requirement\n` +
      `• 📅 Minimum account age\n` +
      `• 🛡 Winner cooldown\n` +
      `• 🔗 Referral bonus entries\n\n` +
      `<b>Admin Center tools:</b>\n` +
      `Create, templates, draw, edit, cancel, re-run, export, history, stats, defaults, setup check, referrals, language, and timezone.\n\n` +
      `<b>Note:</b> Group owners can choose whether all admins or only approved admins may manage raffles.\n` +
      `<b>Supported languages:</b> English, Espanol, Portugues, Русский, Francais, Deutsch`,
    {
      parse_mode: "HTML",
      reply_markup: buildPrivateHomeKeyboard(),
    });
}

export async function handleHomeCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;
  await ctx.answerCallbackQuery();

  if (data === "home_main") {
    await showPrivateHome(ctx);
    return;
  }
  if (data === "home_entries") {
    await handleMyEntries(ctx);
    return;
  }
  if (data === "home_bugreport") {
    await startBugReport(ctx, ctx.from.id, "Direct Message");
    return;
  }
  if (data === "home_help") {
    await handleHelp(ctx);
  }
}

// /newraffle - Create a raffle
export async function handleNewRaffle(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "create");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can create raffles.");
    return;
  }

  await startWizard(ctx);
}

// /setraffletopic - Save the current forum topic for future Command Central raffles
export async function handleSetRaffleTopic(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;

  if (ctx.chat.type === "private") {
    await ctx.reply(
      `Open the group, enter the topic where raffles should be posted, then send ` +
        `<code>/setraffletopic</code> inside that topic.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const chatId = ctx.chat.id;
  if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
    await replyPrivately(ctx, "Only group admins can set the default raffle topic.");
    return;
  }

  const threadId = ctx.message?.message_thread_id;
  if (!threadId) {
    await replyPrivately(
      ctx,
      `📍 <b>No topic detected</b>\n\nOpen the desired raffle topic first, then send ` +
        `<code>/setraffletopic</code> inside that topic.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const existing = db.getGroupDefaults(chatId);
  const topicName =
    getForumTopicName(ctx.message) ||
    (existing?.thread_id === threadId ? existing.thread_name : null);
  if (!topicName) {
    await replyPrivately(
      ctx,
      `📍 <b>Topic name not detected</b>\n\nSend <code>/setraffletopic</code> as a new message ` +
        `inside the topic, rather than as a reply to another message.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  db.upsertGroupDefaults(chatId, { thread_id: threadId, thread_name: topicName });
  const wizardUpdate = setActiveWizardDestination(ctx.from.id, chatId, threadId, topicName);
  const groupTitle = ctx.chat.title || db.getBotGroup(chatId)?.title || "this group";
  const keyboard = new InlineKeyboard();
  if (wizardUpdate === "options") {
    keyboard.text("✅ Continue Current Raffle", "wiz_opt_destination_back").row();
  }
  keyboard.text("⚙️ View Group Defaults", `admin_do_defaults_${chatId}`);

  const confirmation =
    `✅ <b>Default raffle topic saved</b>\n\n` +
      `<b>${escapeHtml(groupTitle)}</b> will use <b>${escapeHtml(topicName)}</b> for new raffles started from Command Central.\n\n` +
      (wizardUpdate
        ? `Your current raffle has also been updated to post there.\n\n`
        : "") +
      `<i>Sending /newraffle inside another topic will use that topic for that raffle only.</i>`;
  try {
    await ctx.api.sendMessage(ctx.from.id, confirmation, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch {
    // If the admin has not opened the bot's DM yet, keep the group fallback
    // short and avoid exposing Command Central controls in the topic.
    await replyPrivately(ctx, confirmation, { parse_mode: "HTML" });
  }
}

// /raffles - List open raffles
export async function handleListRaffles(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "raffles");
    return;
  }

  await showOpenRafflesForChat(ctx, ctx.chat.id);
}

async function showOpenRafflesForChat(ctx: Context, chatId: number): Promise<void> {
  const raffles = db.getOpenRafflesForChat(chatId);
  const send = (text: string, options?: Parameters<typeof ctx.reply>[1]) =>
    ctx.chat?.type === "private"
      ? ctx.reply(text, options)
      : replyPrivately(ctx, text, options);

  if (raffles.length === 0) {
    await send("No open raffles in this group.");
    return;
  }

  let msg = `🎟 <b>Open Raffles (${raffles.length})</b>\n\n`;
  for (const raffle of raffles) {
    const count = db.getEntryCount(raffle.id);
    const maxStr = raffle.max_entries ? `/${raffle.max_entries}` : "";
    const prizes = parsePrizes(raffle);

    msg += `<b>${raffle.id}.</b> ${escapeHtml(raffle.title)}\n`;
    if (prizes.length > 1) {
      msg += `   🎁 ${prizes.length} prizes | 👥 ${count}${maxStr} entries\n`;
    } else {
      msg += `   🎁 ${escapeHtml(prizes[0])} | 👥 ${count}${maxStr} entries\n`;
    }
    if (raffle.ends_at) {
      msg += `   ⏰ Ends: ${formatCountdown(new Date(raffle.ends_at + "Z"))}\n`;
    }
    msg += `\n`;
  }

  await send(msg, { parse_mode: "HTML" });
}

async function executeDraw(ctx: Context, raffle: NonNullable<ReturnType<typeof db.getRaffleById>>): Promise<string> {
  const entryCount = db.getEntryCount(raffle.id);
  if (entryCount === 0) {
    db.markRaffleDrawn(raffle.id);
    await revokeReferralInviteLinks(ctx.api, raffle.id);
    await updateRafflePost(ctx, raffle.id);
    return `🎟 <b>${escapeHtml(raffle.title)}</b>\n\nNo entries were received. Raffle closed with no winners.`;
  }

  const lang = db.getChatLanguage(raffle.chat_id);
  const entries = db.getEntriesForRaffle(raffle.id);
  const entryNames = entries.map((e) => e.user_display_name);
  const winners = db.selectWinners(raffle.id);

  // Countdown animation (if animation enabled and at least 1 entry)
  if (entryNames.length >= 1 && raffle.show_animation) {
    await sendWheelSpin(ctx.api, raffle.chat_id, raffle.thread_id);
  }

  // Announce winners with embedded "WINNERS DRAWN" banner
  await sendWinnerPost(ctx.api, raffle.chat_id, formatWinnersMessage(raffle, winners, lang), raffle.thread_id);

  // Mark as drawn and announced after successful announcement
  db.markRaffleDrawn(raffle.id);
  db.markRaffleAnnounced(raffle.id);
  await revokeReferralInviteLinks(ctx.api, raffle.id);

  await updateRafflePost(ctx, raffle.id);

  // DM winners and the creator
  await notifyWinnersAndCreator(ctx.api, raffle, winners);
  return `🏆 Winners drawn for <b>${escapeHtml(raffle.title)}</b>.`;
}

async function isAdminOfChat(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  return (await getGroupManagementAccess(ctx.api, chatId, userId)).allowed;
}

type AdminAction =
  | "menu"
  | "create"
  | "raffles"
  | "templates"
  | "draw"
  | "edit"
  | "cancel"
  | "rerun"
  | "export"
  | "history"
  | "stats"
  | "defaults"
  | "access"
  | "setup"
  | "referrals"
  | "language"
  | "timezone";

const ADMIN_SCAN_BATCH_SIZE = 8;

function buildAdminDashboardKeyboard(chatId: number, isOwner: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text("➕ Create Raffle", `admin_do_create_${chatId}`).row()
    .text("🎟 Open Raffles", `admin_do_raffles_${chatId}`).row()
    .text("📋 Templates", `admin_do_templates_${chatId}`).text("🏆 Draw", `admin_do_draw_${chatId}`).row()
    .text("✏️ Edit", `admin_do_edit_${chatId}`).text("🚫 Cancel", `admin_do_cancel_${chatId}`).row()
    .text("🔄 Re-run", `admin_do_rerun_${chatId}`).text("📤 Export", `admin_do_export_${chatId}`).row()
    .text("🕘 History", `admin_do_history_${chatId}`).text("📊 Stats", `admin_do_stats_${chatId}`).row()
    .text("⚙️ Defaults", `admin_do_defaults_${chatId}`).text("🧪 Setup Check", `admin_do_setup_${chatId}`).row()
    .text("🔗 Referrals", `admin_do_referrals_${chatId}`).row()
    .text("🌐 Language", `admin_do_language_${chatId}`).text("🕐 Timezone", `admin_do_timezone_${chatId}`).row();
  if (isOwner) {
    keyboard.text("🔐 Admin Access", `admin_do_access_${chatId}`).row();
  }
  return keyboard
    .text("🐛 Report a Bug", `admin_bug_${chatId}`).row()
    .text("↔️ Change Group", "admin_groups").text("🏠 Main Menu", "home_main");
}

async function discoverAdminGroups(ctx: Context, userId: number): Promise<ReturnType<typeof db.getUserAdminGroups>> {
  db.clearUserAdminGroups(userId);
  const groups = db.getActiveBotGroups();

  for (let i = 0; i < groups.length; i += ADMIN_SCAN_BATCH_SIZE) {
    const batch = groups.slice(i, i + ADMIN_SCAN_BATCH_SIZE);
    await Promise.all(
      batch.map(async (group) => {
        try {
          const member = await ctx.api.getChatMember(group.chat_id, userId);
          if (member.status === "administrator" || member.status === "creator") {
            db.rememberUserAdminGroup(
              userId,
              group.chat_id,
              member.status === "creator" ? "creator" : "administrator"
            );
          }
        } catch {
          // Telegram only guarantees this lookup when the bot can inspect members.
        }
      })
    );
    if (i + ADMIN_SCAN_BATCH_SIZE < groups.length) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return db.getUserAdminGroups(userId);
}

async function showAdminGroupPicker(
  ctx: Context,
  forceRefresh = false,
  action: AdminAction = "menu"
): Promise<void> {
  if (!ctx.from || ctx.chat?.type !== "private") {
    const botInfo = await ctx.api.getMe();
    await ctx.reply("Open my private chat to manage your groups.", {
      reply_markup: new InlineKeyboard().url("Open Admin Center", `https://t.me/${botInfo.username}?start=manage`),
    });
    return;
  }

  let statusMessage: Awaited<ReturnType<typeof ctx.reply>> | undefined;
  let groups = forceRefresh ? [] : db.getUserAdminGroups(ctx.from.id);
  if (groups.length === 0) {
    statusMessage = await ctx.reply("Checking the groups where you are an admin...");
    groups = await discoverAdminGroups(ctx, ctx.from.id);
  }

  const keyboard = new InlineKeyboard();
  for (const group of groups.slice(0, 40)) {
    keyboard.text(
      group.title || `Group ${group.chat_id}`,
      `admin_group_${action}_${group.chat_id}`
    ).row();
  }
  keyboard.text("🔄 Refresh My Groups", `admin_refresh_${action}`).row();
  keyboard.text("🐛 Report a Bug", "home_bugreport").text("🏠 Main Menu", "home_main");

  const text = groups.length > 0
    ? `<b>Select a group to manage</b>\n\nI found ${groups.length} group${groups.length === 1 ? "" : "s"} where you are an admin.`
    : `<b>No admin groups found</b>\n\nMake sure this bot is in the group and can inspect members, then tap Refresh My Groups.`;
  const options = { parse_mode: "HTML" as const, reply_markup: keyboard };

  if (statusMessage) {
    await ctx.api.editMessageText(ctx.chat.id, statusMessage.message_id, text, options);
  } else {
    await ctx.reply(text, options);
  }
}

async function showAdminDashboard(ctx: Context, chatId: number): Promise<void> {
  if (!ctx.from) return;
  const access = await getGroupManagementAccess(ctx.api, chatId, ctx.from.id);
  if (!access.allowed) {
    await ctx.reply("You do not have permission to manage that group.");
    return;
  }
  const group = db.getBotGroup(chatId);
  let title = group?.title || "Selected Group";
  try {
    const chat = await ctx.api.getChat(chatId);
    if ("title" in chat && chat.title) title = chat.title;
  } catch {}

  await ctx.reply(
    `<b>${escapeHtml(title)} Admin Center</b>\n\nChoose what you want to manage. Everything stays in this private chat; only raffle posts and required results are sent to the group.`,
    { parse_mode: "HTML", reply_markup: buildAdminDashboardKeyboard(chatId, access.isOwner) }
  );
}

async function runAdminAction(
  ctx: Context,
  action: AdminAction,
  chatId: number,
  rerunDestination?: RerunDestination
): Promise<void> {
  if (!ctx.from) return;
  const access = await getGroupManagementAccess(ctx.api, chatId, ctx.from.id);
  if (!access.allowed) {
    await ctx.reply("You do not have permission to manage that group.");
    return;
  }
  const group = db.getBotGroup(chatId);
  const title = group?.title || "the group";

  switch (action) {
    case "menu": return showAdminDashboard(ctx, chatId);
    case "create": await startRaffleWizardForGroup(ctx, chatId, title); return;
    case "raffles": await showOpenRafflesForChat(ctx, chatId); return;
    case "templates": await buildTemplateHub(ctx, chatId); return;
    case "draw": await showDrawForChat(ctx, chatId); return;
    case "edit": await showEditForChat(ctx, chatId); return;
    case "cancel": await showCancelForChat(ctx, chatId); return;
    case "rerun": await showRerunForChat(ctx, chatId, false, rerunDestination); return;
    case "export": await showExportForChat(ctx, chatId); return;
    case "history": await showRaffleHistoryForChat(ctx, chatId); return;
    case "stats": await showGroupStatsForChat(ctx, chatId); return;
    case "defaults": await showDefaultsForChat(ctx, chatId); return;
    case "access":
      if (!access.isOwner) {
        await ctx.reply("Only the Telegram group owner can change Admin Access.");
        return;
      }
      await showAccessSettingsForChat(ctx, chatId);
      return;
    case "setup": await showSetupCheckForChat(ctx, chatId); return;
    case "referrals": await showReferralsForChat(ctx, chatId); return;
    case "language": await showLanguageForChat(ctx, chatId); return;
    case "timezone": await showTimezoneForChat(ctx, chatId); return;
  }
}

export async function handleManage(ctx: Context): Promise<void> {
  await showAdminGroupPicker(ctx);
}

export async function handleAdminCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;
  await ctx.answerCallbackQuery();

  if (data === "admin_close") {
    try { await ctx.deleteMessage(); } catch {}
    return;
  }
  if (data === "admin_groups") {
    await showAdminGroupPicker(ctx);
    return;
  }
  const bugMatch = data.match(/^admin_bug_(-?\d+)$/);
  if (bugMatch) {
    const chatId = parseInt(bugMatch[1], 10);
    const group = db.getBotGroup(chatId);
    await startBugReport(ctx, chatId, group?.title || "Selected Group");
    return;
  }
  const refreshMatch = data.match(/^admin_refresh_([a-z]+)$/);
  if (refreshMatch) {
    await showAdminGroupPicker(ctx, true, refreshMatch[1] as AdminAction);
    return;
  }
  const groupMatch = data.match(/^admin_group_([a-z]+)_(-?\d+)$/);
  if (groupMatch) {
    await runAdminAction(
      ctx,
      groupMatch[1] as AdminAction,
      parseInt(groupMatch[2], 10)
    );
    return;
  }
  const actionMatch = data.match(/^admin_do_([a-z]+)_(-?\d+)(?:_(s|g|t\d+))?$/);
  if (actionMatch) {
    await runAdminAction(
      ctx,
      actionMatch[1] as AdminAction,
      parseInt(actionMatch[2], 10),
      actionMatch[3] ? decodeRerunDestination(actionMatch[3]) : undefined
    );
  }
}

function buildDrawKeyboard(chatId: number, raffles: Array<NonNullable<ReturnType<typeof db.getRaffleById>>>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const r of raffles) {
    keyboard.text(`🏆 ${r.title.slice(0, 32)}`, `draw_pick_${chatId}_${r.id}`).row();
  }
  keyboard.text("❌ Cancel", "draw_cancel");
  return keyboard;
}

async function showDrawForChat(ctx: Context, chatId: number): Promise<void> {
  const openRaffles = db.getOpenRafflesForChat(chatId);
  if (openRaffles.length === 0) {
    await ctx.reply("No open raffles to draw from.");
    return;
  }
  if (openRaffles.length === 1) {
    const raffle = openRaffles[0];
    const keyboard = new InlineKeyboard()
      .text("✅ Draw Winners", `draw_confirm_${chatId}_${raffle.id}`)
      .row()
      .text("❌ Cancel", "draw_cancel");
    await ctx.reply(
      `🏆 <b>Draw winners?</b>\n\n` +
        `Raffle: <b>${escapeHtml(raffle.title)}</b>\n` +
        `Entries: <b>${db.getEntryCount(raffle.id)}</b>\n` +
        `Winners: <b>${raffle.max_winners}</b>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }
  await ctx.reply("🏆 <b>Pick a raffle to draw:</b>", {
    parse_mode: "HTML",
    reply_markup: buildDrawKeyboard(chatId, openRaffles),
  });
}

// /draw - Draw winners through a guided pick/confirm flow
export async function handleDraw(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "draw");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can draw raffle winners.");
    return;
  }

  await showDrawForChat(ctx, ctx.chat.id);
}

export async function handleDrawCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  if (data === "draw_cancel") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Draw cancelled.");
    return;
  }

  const pick = data.match(/^draw_pick_(-?\d+)_(\d+)$/);
  if (pick) {
    const chatId = parseInt(pick[1], 10);
    const raffleId = parseInt(pick[2], 10);
    if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only group admins can draw winners.", show_alert: true });
      return;
    }
    const raffle = db.getRaffleById(raffleId);
    if (!raffle || raffle.chat_id !== chatId || raffle.status !== "open") {
      await ctx.answerCallbackQuery({ text: "This raffle is no longer open.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const keyboard = new InlineKeyboard()
      .text("✅ Draw Winners", `draw_confirm_${chatId}_${raffle.id}`)
      .row()
      .text("⬅️ Back", `draw_back_${chatId}`);
    await ctx.editMessageText(
      `🏆 <b>Draw winners?</b>\n\n` +
        `Raffle: <b>${escapeHtml(raffle.title)}</b>\n` +
        `Entries: <b>${db.getEntryCount(raffle.id)}</b>\n` +
        `Winners: <b>${raffle.max_winners}</b>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  const back = data.match(/^draw_back_(-?\d+)$/);
  if (back) {
    const chatId = parseInt(back[1], 10);
    if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only group admins can draw winners.", show_alert: true });
      return;
    }
    const openRaffles = db.getOpenRafflesForChat(chatId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`🏆 <b>Pick a raffle to draw:</b>`, {
      parse_mode: "HTML",
      reply_markup: buildDrawKeyboard(chatId, openRaffles),
    });
    return;
  }

  const confirm = data.match(/^draw_confirm_(-?\d+)_(\d+)$/);
  if (!confirm) return;

  const chatId = parseInt(confirm[1], 10);
  const raffleId = parseInt(confirm[2], 10);
  if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Only group admins can draw winners.", show_alert: true });
    return;
  }

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.chat_id !== chatId || raffle.status !== "open") {
    await ctx.answerCallbackQuery({ text: "This raffle is no longer open.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Drawing winners..." });
  const result = await executeDraw(ctx, raffle);
  await ctx.editMessageText(result, { parse_mode: "HTML" });
}

// /cancelraffle - Cancel a raffle (sends interactive buttons to DM)
export async function handleCancelRaffle(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "cancel");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can cancel raffles.");
    return;
  }

  await showCancelForChat(ctx, ctx.chat.id);
}

async function showCancelForChat(ctx: Context, chatId: number): Promise<void> {
  const openRaffles = db.getOpenRafflesForChat(chatId);
  if (openRaffles.length === 0) {
    await ctx.reply("No open raffles to cancel.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const r of openRaffles) {
    keyboard.text(`🎟 ${r.title}`, `cancel_pick_${r.id}`).row();
  }
  keyboard.text("❌ Nevermind", `cancel_no`);

  await ctx.reply("Which raffle do you want to cancel?", { reply_markup: keyboard });
}

// Callback handler for cancel buttons (runs in DM)
export async function handleCancelCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  await ctx.answerCallbackQuery();

  // "Nevermind" button
  if (data === "cancel_no") {
    await ctx.editMessageText("👍 No raffle was cancelled.");
    return;
  }

  // Pick a raffle → show confirmation
  const pickMatch = data.match(/^cancel_pick_(\d+)$/);
  if (pickMatch) {
    const raffleId = parseInt(pickMatch[1], 10);
    const raffle = db.getRaffleById(raffleId);
    if (!raffle || raffle.status !== "open") {
      await ctx.editMessageText("This raffle is no longer open.");
      return;
    }
    if (!ctx.from || !(await isAdminOfChat(ctx, raffle.chat_id, ctx.from.id))) {
      await ctx.editMessageText("You are no longer an admin of that group.");
      return;
    }
    const keyboard = new InlineKeyboard()
      .text("✅ Yes, cancel it", `cancel_yes_${raffleId}`)
      .text("❌ No, keep it", `cancel_no`);
    await ctx.editMessageText(
      `⚠️ Cancel raffle <b>${escapeHtml(raffle.title)}</b>?\n\nThis cannot be undone.`,
      { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  // Confirm cancellation
  const yesMatch = data.match(/^cancel_yes_(\d+)$/);
  if (yesMatch) {
    const raffleId = parseInt(yesMatch[1], 10);
    const raffle = db.getRaffleById(raffleId);
    if (!raffle) {
      await ctx.editMessageText("Raffle not found.");
      return;
    }
    if (!ctx.from || !(await isAdminOfChat(ctx, raffle.chat_id, ctx.from.id))) {
      await ctx.editMessageText("You are no longer an admin of that group.");
      return;
    }
    if (raffle.status === "drawn") {
      await ctx.editMessageText("Cannot cancel a raffle that has already been drawn.");
      return;
    }
    if (raffle.status !== "open") {
      await ctx.editMessageText("This raffle is no longer open.");
      return;
    }

    db.closeRaffle(raffleId);
    await revokeReferralInviteLinks(ctx.api, raffleId);

    await ctx.editMessageText(
      `🚫 Raffle <b>${escapeHtml(raffle.title)}</b> has been cancelled.`,
      { parse_mode: "HTML" });

    // Update the raffle post in the group
    await updateRafflePost(ctx, raffleId);
  }
}

// Callback handler for repost button (admin-only, on raffle post)
export async function handleRepostCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const match = data.match(/^repost_(\d+)$/);
  if (!match) return;

  const raffleId = parseInt(match[1], 10);
  const userId = ctx.from!.id;

  // Admin check
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== "open") {
    await ctx.answerCallbackQuery({ text: "This raffle is no longer open.", show_alert: true });
    return;
  }

  const isAdmin = await isAdminOfChat(ctx, raffle.chat_id, userId);
  if (!isAdmin) {
    await ctx.answerCallbackQuery({ text: "Only group admins can repost raffles.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Reposting raffle..." });

  const chatId = raffle.chat_id;
  const oldMessageId = raffle.message_id;
  const lang = db.getChatLanguage(chatId);
  const botUsername = ctx.me.username;

  const count = db.getEntryCount(raffleId);
  const displayCount = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : count;
  const caption = formatRaffleMessage(raffle, count, lang);
  const keyboard = buildRaffleKeyboard(raffle, displayCount, lang, botUsername);

  // Send a new raffle post at the bottom of the chat
  const newMsgId = await sendRafflePost(
    ctx.api,
    chatId,
    "open",
    caption,
    keyboard,
    raffle.image_file_id,
    raffle.thread_id
  );

  if (!newMsgId) {
    await ctx.api.sendMessage(userId, "Failed to repost the raffle. Please try again.");
    return;
  }

  // Update the database to point to the new message
  db.updateRaffleMessageId(raffleId, newMsgId);

  // Handle the old post: try to delete, otherwise edit with a link
  if (oldMessageId) {
    try {
      await ctx.api.deleteMessage(chatId, oldMessageId);
    } catch {
      // Deletion failed (probably older than 48h) — edit with a redirect link
      const newLink = buildMessageLink(chatId, newMsgId);
      const redirectText = newLink
        ? `⬇️ <b>This raffle has moved.</b>\n\n<a href="${newLink}">Tap here to go to the active raffle</a>`
        : `⬇️ <b>This raffle has moved.</b> Scroll down to find it.`;
      try {
        await ctx.api.editMessageCaption(chatId, oldMessageId, {
          caption: redirectText,
          parse_mode: "HTML",
        });
      } catch {
        try {
          await ctx.api.editMessageText(chatId, oldMessageId, redirectText, {
            parse_mode: "HTML",
          });
        } catch {
          // Old message couldn't be edited either — ignore
        }
      }
    }
  }

  // Auto-pin the new post if the raffle had auto_pin enabled
  if (raffle.auto_pin) {
    try {
      await ctx.api.pinChatMessage(chatId, newMsgId, { disable_notification: true });
    } catch {
      // Pin failed — bot may not have pin permissions
    }
  }
}

// /myentries - Show user's active entries
export async function handleMyEntries(ctx: Context): Promise<void> {
  if (!ctx.chat || !ctx.from) return;

  const userId = ctx.from.id;
  const inDm = ctx.chat.type === "private";
  const openRaffles = inDm
    ? db.getOpenRafflesEnteredByUser(userId)
    : db.getOpenRafflesForChat(ctx.chat.id);

  const entered = openRaffles.filter((r) => db.hasUserEntered(r.id, userId));

  if (entered.length === 0) {
    const message = inDm
      ? "You don't have any active raffle entries."
      : "You haven't entered any active raffles in this group.";
    if (inDm) {
      await ctx.reply(message, {
        reply_markup: new InlineKeyboard().text("🏠 Main Menu", "home_main"),
      });
    }
    else await replyPrivately(ctx, message);
    return;
  }

  let msg = `🎟 <b>Your Active Entries</b>\n\n`;
  for (const r of entered) {
    const prizes = parsePrizes(r);
    msg += `• ${escapeHtml(r.title)} (ID: ${r.id})\n`;
    if (prizes.length > 1) {
      msg += `  🎁 ${prizes.length} prizes available\n`;
    } else {
      msg += `  🎁 ${escapeHtml(prizes[0])}\n`;
    }
    if (inDm) {
      const group = db.getBotGroup(r.chat_id);
      msg += `  📍 ${escapeHtml(group?.title || "Unknown group")}\n`;
    }
    if (r.referral_enabled) {
      const bonus = db.getBonusEntries(r.id, userId);
      msg += `  🔗 ${1 + bonus} total entries (${bonus} referral bonus)\n`;
    }
  }

  if (inDm) {
    await ctx.reply(msg, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("🏠 Main Menu", "home_main"),
    });
  }
  else await replyPrivately(ctx, msg, { parse_mode: "HTML" });
}

// /rafflehistory - Show recent raffles
export async function handleRaffleHistory(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "history");
    return;
  }

  await showRaffleHistoryForChat(ctx, ctx.chat.id);
}

async function showRaffleHistoryForChat(ctx: Context, chatId: number): Promise<void> {
  const raffles = db.getRecentRafflesForChat(chatId, 10);

  if (raffles.length === 0) {
    await ctx.reply("No raffle history in this group.");
    return;
  }

  let msg = `📜 <b>Recent Raffles</b>\n\n`;
  for (const raffle of raffles) {
    const statusEmoji =
      raffle.status === "open"
        ? "🟢"
        : raffle.status === "closed"
          ? "🔴"
          : "🏆";
    const count = db.getEntryCount(raffle.id);
    const prizes = parsePrizes(raffle);

    msg += `${statusEmoji} <b>${escapeHtml(raffle.title)}</b> (ID: ${raffle.id})\n`;
    if (prizes.length > 1) {
      msg += `   🎁 ${prizes.length} prizes | 👥 ${count} entries | ${raffle.status}\n`;
    } else {
      msg += `   🎁 ${escapeHtml(prizes[0])} | 👥 ${count} entries | ${raffle.status}\n`;
    }

    if (raffle.status === "drawn") {
      const winners = db.getWinnersForRaffle(raffle.id);
      if (winners.length > 0) {
        winners.forEach((w) => {
          if (w.prize) {
            msg += `   🏆 ${escapeHtml(w.user_display_name)} — ${escapeHtml(w.prize)}\n`;
          } else {
            msg += `   🏆 ${escapeHtml(w.user_display_name)}\n`;
          }
        });
      }
    }
    msg += `\n`;
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
}

// /exportentries - Export all participants for a raffle.
// Works in two contexts:
//   - In a group: lists/exports raffles from that group (admin only)
//   - In DM:      lists/exports raffles the user CREATED across all groups
//                 (admin-of-chat fallback for non-creator admins)
async function sendEntriesExport(
  ctx: Context,
  raffle: NonNullable<ReturnType<typeof db.getRaffleById>>,
  recipientId: number
): Promise<void> {
  const entries = db.getEntriesForRaffle(raffle.id);
  if (entries.length === 0) {
    await ctx.api.sendMessage(
      recipientId,
      `No entries found for raffle "${escapeHtml(raffle.title)}".`,
      { parse_mode: "HTML" }
    );
    return;
  }

  let msg = `📋 <b>Participants Export: ${escapeHtml(raffle.title)}</b>\n`;
  msg += `<b>Raffle ID:</b> ${raffle.id} | <b>Status:</b> ${raffle.status}\n`;
  msg += `<b>Total Entries:</b> ${entries.length}\n\n`;
  msg += `<b>Participant List:</b>\n`;
  entries.forEach((e, i) => {
    const username = e.user_name ? `@${e.user_name}` : `[${e.user_id}]`;
    msg += `${i + 1}. ${escapeHtml(e.user_display_name)} (${username})\n`;
  });
  msg += `\n<b>User IDs (for re-run):</b>\n<code>`;
  msg += entries.map((e) => e.user_id).join(", ");
  msg += `</code>`;
  msg += `\n\n💡 To reuse these participants, open Re-run from the private Admin Center.`;

  if (msg.length > 4000) {
    const csvLines = ["#,Display Name,Username,User ID,Entered At"];
    entries.forEach((e, i) => {
      csvLines.push(
        `${i + 1},"${e.user_display_name}","${e.user_name || ""}",${e.user_id},"${e.entered_at}"`
      );
    });
    const buffer = Buffer.from(csvLines.join("\n"), "utf-8");
    await ctx.api.sendDocument(
      recipientId,
      new InputFile(buffer, `raffle_${raffle.id}_participants.csv`),
      {
        caption: `📋 Participants for "${raffle.title}" (${entries.length} entries)\n\nTo reuse these participants, open Re-run from the private Admin Center.`,
      }
    );
    return;
  }

  await ctx.api.sendMessage(recipientId, msg, { parse_mode: "HTML" });
}

async function canExportRaffle(
  ctx: Context,
  raffle: NonNullable<ReturnType<typeof db.getRaffleById>>,
  userId: number,
  sourceChatId?: number
): Promise<boolean> {
  if (sourceChatId !== undefined && sourceChatId !== raffle.chat_id) return false;
  return isAdminOfChat(ctx, raffle.chat_id, userId);
}

async function showExportForChat(ctx: Context, chatId: number): Promise<void> {
  const raffles = db.getRecentRafflesForChat(chatId, 20);
  if (raffles.length === 0) {
    await ctx.reply("No raffles found in this group.");
    return;
  }
  let msg = `📋 <b>Pick a raffle to export:</b>\n\n`;
  const keyboard = new InlineKeyboard();
  for (const raffle of raffles) {
    const count = db.getEntryCount(raffle.id);
    msg += `• ${escapeHtml(raffle.title)} (${count} entries, ${raffle.status})\n`;
    keyboard.text(
      `${raffle.title.slice(0, 28)} (${count})`,
      `export_pick_${chatId}_${raffle.id}`
    ).row();
  }
  keyboard.text("❌ Close", "export_close");
  await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
}

export async function handleExportEntries(ctx: Context): Promise<void> {
  if (!ctx.from || !ctx.chat) return;
  const userId = ctx.from.id;
  const text = ctx.message?.text || "";
  const typedArgs = text.replace(/^\/exportentries(@\w+)?/i, "").trim();
  const args = "";
  const inDm = ctx.chat.type === "private";
  if (typedArgs) {
    const reply = (message: string) => (inDm ? ctx.reply(message) : replyPrivately(ctx, message));
    await reply("Participant export is button-based now. Opening the export picker.");
  }

  // ---- Listing branch (no raffle ID provided) ----
  if (!args) {
    if (inDm) {
      // DM: list raffles this user created across all groups
      const myRaffles = db.getRecentRafflesByCreator(userId, 30);
      if (myRaffles.length === 0) {
        await ctx.reply(
          "You haven't created any raffles yet.\n\n" +
            "If you want to export a raffle from a group where you're an admin but didn't create it, " +
            "open that group's Export tool from the private Admin Center.",
          { parse_mode: "HTML" }
        );
        return;
      }

      // Group by chat for readability, and look up chat titles
      const byChat = new Map<number, typeof myRaffles>();
      for (const r of myRaffles) {
        if (!byChat.has(r.chat_id)) byChat.set(r.chat_id, []);
        byChat.get(r.chat_id)!.push(r);
      }

      const groupNames = new Map<number, string>();
      for (const chatId of byChat.keys()) {
        const cached = db.getBotGroup(chatId);
        if (cached?.title) {
          groupNames.set(chatId, cached.title);
          continue;
        }
        try {
          const chat = await ctx.api.getChat(chatId);
          if ("title" in chat && chat.title) groupNames.set(chatId, chat.title);
        } catch {
          // Bot may no longer be in the chat — fall through to chat-id fallback
        }
      }

      let msg = `📋 <b>Your recent raffles</b> (across all groups)\n\n`;
      msg += `Pick the raffle you want to export:\n\n`;
      const keyboard = new InlineKeyboard();
      for (const [chatId, list] of byChat) {
        const name = groupNames.get(chatId) || `Chat ${chatId}`;
        msg += `<b>📍 ${escapeHtml(name)}</b>\n`;
        for (const r of list) {
          const count = db.getEntryCount(r.id);
          msg += `• ${escapeHtml(r.title)} (${count} entries, ${r.status})\n`;
          keyboard.text(`${r.title.slice(0, 28)} (${count})`, `export_pick_${chatId}_${r.id}`).row();
        }
        msg += `\n`;
      }
      msg += `<i>Showing up to 30 most recent raffles you created.</i>`;
      keyboard.text("❌ Close", "export_close");
      await ctx.reply(msg, { parse_mode: "HTML", reply_markup: keyboard });
      return;
    }

    // Group: existing behavior — list raffles in this chat (admin only)
    const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
    if (!isAdmin) {
      await replyPrivately(ctx, "Only group admins can export entries.");
      return;
    }
    const allRaffles = db.getRecentRafflesForChat(ctx.chat.id, 20);
    if (allRaffles.length === 0) {
      await replyPrivately(ctx, "No raffles found in this chat.");
      return;
    }
    let msg = `📋 <b>Pick a raffle to export:</b>\n\n`;
    const keyboard = new InlineKeyboard();
    for (const r of allRaffles) {
      const count = db.getEntryCount(r.id);
      msg += `• ${escapeHtml(r.title)} (${count} entries, ${r.status})\n`;
      keyboard.text(`${r.title.slice(0, 28)} (${count})`, `export_pick_${ctx.chat.id}_${r.id}`).row();
    }
    keyboard.text("❌ Close", "export_close");
    await replyPrivately(ctx, msg, { parse_mode: "HTML", reply_markup: keyboard });
    return;
  }

  // ---- Export branch (raffle ID provided) ----
  const raffleId = parseInt(args, 10);
  if (isNaN(raffleId)) {
    const reply = (text: string) => (inDm ? ctx.reply(text) : replyPrivately(ctx, text));
    await reply("Please provide a valid raffle ID.");
    return;
  }

  const raffle = db.getRaffleById(raffleId);
  if (!raffle) {
    const reply = (text: string) => (inDm ? ctx.reply(text) : replyPrivately(ctx, text));
    await reply("Raffle not found.");
    return;
  }

  if (!inDm && raffle.chat_id !== ctx.chat.id) {
    await replyPrivately(ctx, "Raffle not found in this chat.");
    return;
  }
  const authorized = await isAdminOfChat(ctx, raffle.chat_id, userId);
  if (!authorized) {
    const reply = (text: string) => (inDm ? ctx.reply(text) : replyPrivately(ctx, text));
    await reply("You do not have permission to export raffles for that group.");
    return;
  }

  await sendEntriesExport(ctx, raffle, userId);
}

export async function handleExportCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  if (data === "export_close") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  const match = data.match(/^export_pick_(-?\d+)_(\d+)$/);
  if (!match) return;
  const chatId = parseInt(match[1], 10);
  const raffleId = parseInt(match[2], 10);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || !(await canExportRaffle(ctx, raffle, ctx.from.id, chatId))) {
    await ctx.answerCallbackQuery({ text: "You cannot export that raffle.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Sending export..." });
  await sendEntriesExport(ctx, raffle, ctx.from.id);
}

// /rerun - Re-run a raffle with same participants from a previous one
export async function handleRerun(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "rerun");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can re-run raffles.");
    return;
  }

  await showRerunForChat(
    ctx,
    ctx.chat.id,
    false,
    ctx.message?.message_thread_id
      ? { kind: "topic", threadId: ctx.message.message_thread_id }
      : { kind: "general" }
  );
}

async function showRerunForChat(
  ctx: Context,
  chatId: number,
  edit = false,
  destination: RerunDestination = { kind: "source" }
): Promise<void> {
  const drawnRaffles = db
    .getRecentRafflesForChat(chatId, 20)
    .filter((r) => r.status === "drawn" || r.status === "closed");

  if (drawnRaffles.length === 0) {
    await ctx.reply("No completed raffles to re-run.");
    return;
  }

  const keyboard = new InlineKeyboard();
  const destinationToken = encodeRerunDestination(destination);
  for (const r of drawnRaffles.slice(0, 10)) {
    const count = db.getEntryCount(r.id);
    keyboard.text(
      `${escapeHtml(r.title)} (${count} entries)`,
      `rerun_pick_${r.id}_${destinationToken}`
    );
    keyboard.row();
  }
  keyboard.text("❌ Cancel", "rerun_cancel");

  const text = `🔄 <b>Re-run a Raffle</b>\n\nPick a completed raffle to re-run with the same participants:`;
  const options = { parse_mode: "HTML" as const, reply_markup: keyboard };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

export async function handleRerunCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  // Cancel button
  if (data === "rerun_cancel") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Re-run cancelled.");
    return;
  }

  // Pick a raffle to preview
  const pickMatch = data.match(/^rerun_pick_(\d+)(?:_(s|g|t\d+))?$/);
  if (pickMatch) {
    const sourceId = parseInt(pickMatch[1], 10);
    const destination = decodeRerunDestination(pickMatch[2]);
    const destinationToken = encodeRerunDestination(destination);

    const sourceRaffle = db.getRaffleById(sourceId);
    if (!sourceRaffle) {
      await ctx.answerCallbackQuery({ text: "Raffle not found.", show_alert: true });
      return;
    }
    if (!(await isAdminOfChat(ctx, sourceRaffle.chat_id, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "You are no longer an admin of that group.", show_alert: true });
      return;
    }

    const entryCount = db.getEntryCount(sourceId);
    const prizes = sourceRaffle.prizes
      ? (JSON.parse(sourceRaffle.prizes) as string[]).map((p) => escapeHtml(p)).join(", ")
      : escapeHtml(sourceRaffle.prize);

    // Calculate original duration for display
    let timerLine = `⏰ <b>Timer:</b> No time limit\n`;
    if (sourceRaffle.ends_at && sourceRaffle.created_at) {
      const durationMs =
        new Date(sourceRaffle.ends_at + "Z").getTime() -
        new Date(sourceRaffle.created_at + "Z").getTime();
      if (durationMs > 0) {
        timerLine = `⏰ <b>Timer:</b> ${formatDurationHuman(durationMs)}\n`;
      }
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("✅ Re-run This Raffle", `rerun_confirm_${sourceId}_${destinationToken}`)
      .row()
      .text("⬅️ Back", `rerun_back_${sourceRaffle.chat_id}_${destinationToken}`);

    await ctx.editMessageText(
      `🔄 <b>Re-run: ${escapeHtml(sourceRaffle.title)}</b>\n\n` +
        `🎁 <b>Prize:</b> ${prizes}\n` +
        `🏆 <b>Winners:</b> ${sourceRaffle.max_winners}\n` +
        `👥 <b>Entries to copy:</b> ${entryCount}\n` +
        timerLine +
        (sourceRaffle.sponsor_name ? `💎 <b>Sponsor:</b> ${escapeHtml(sourceRaffle.sponsor_name)}\n` : "") +
        `\n<i>A new open raffle will be created with all ${entryCount} participants pre-entered.</i>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // Back to raffle list
  const backMatch = data.match(/^rerun_back_(-?\d+)(?:_(s|g|t\d+))?$/);
  if (backMatch) {
    const chatId = parseInt(backMatch[1], 10);
    const destination = decodeRerunDestination(backMatch[2]);
    if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "You are no longer an admin of that group.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await showRerunForChat(ctx, chatId, true, destination);
    return;
  }

  // Confirm re-run
  const confirmMatch = data.match(/^rerun_confirm_(\d+)(?:_(s|g|t\d+))?$/);
  if (confirmMatch) {
    const sourceId = parseInt(confirmMatch[1], 10);
    const destination = decodeRerunDestination(confirmMatch[2]);
    const destinationToken = encodeRerunDestination(destination);

    const sourceRaffle = db.getRaffleById(sourceId);
    if (!sourceRaffle) {
      await ctx.answerCallbackQuery({ text: "Raffle not found.", show_alert: true });
      return;
    }
    const chatId = sourceRaffle.chat_id;
    if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "You are no longer an admin of that group.", show_alert: true });
      return;
    }

    const sourceEntries = db.getEntriesForRaffle(sourceId);
    if (sourceEntries.length === 0) {
      await ctx.answerCallbackQuery({ text: "No entries to copy.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "Creating re-run..." });
    try {
      await ctx.editMessageText("🔄 Creating the re-run...");
    } catch {}

    const displayName = getUserDisplayName(
      ctx.from.first_name,
      ctx.from.last_name
    );

    // Calculate ends_at using the same duration as the original raffle
    let newEndsAt: string | null = null;
    if (sourceRaffle.ends_at && sourceRaffle.created_at) {
      const durationMs =
        new Date(sourceRaffle.ends_at + "Z").getTime() -
        new Date(sourceRaffle.created_at + "Z").getTime();
      if (durationMs > 0) {
        const newEnd = new Date(Date.now() + durationMs);
        newEndsAt = newEnd
          .toISOString()
          .replace("T", " ")
          .replace("Z", "")
          .split(".")[0];
      }
    }

    const preferredThreadId = resolveRerunThread(destination, sourceRaffle.thread_id);
    let newRaffleId: number | null = null;
    let postedMessageId: number | null = null;

    try {
      // Create a new raffle with the same settings
      const newRaffle = db.createRaffle({
        chat_id: chatId,
        thread_id: preferredThreadId,
        creator_id: ctx.from.id,
        creator_name: displayName,
        title: `${sourceRaffle.title} (Re-run)`,
        description: sourceRaffle.description,
        prize: sourceRaffle.prize,
        prizes: sourceRaffle.prizes,
        max_entries: null,
        max_winners: sourceRaffle.max_winners,
        ends_at: newEndsAt,
        starts_at: null,
        display_timezone: db.getChatTimezone(chatId),
        required_chat_id: sourceRaffle.required_chat_id,
        required_chat_title: sourceRaffle.required_chat_title,
        sponsor_name: sourceRaffle.sponsor_name,
        anonymous: sourceRaffle.anonymous,
        image_file_id: sourceRaffle.image_file_id,
        auto_pin: sourceRaffle.auto_pin,
        min_account_age_days: sourceRaffle.min_account_age_days,
        require_username: sourceRaffle.require_username,
        winner_cooldown: sourceRaffle.winner_cooldown,
        show_animation: sourceRaffle.show_animation,
        referral_enabled: sourceRaffle.referral_enabled,
        max_referral_entries: sourceRaffle.max_referral_entries,
        revoke_referral_links: sourceRaffle.revoke_referral_links,
      });
      newRaffleId = newRaffle.id;

      // Copy all entries from the source raffle
      const added = db.bulkAddEntries(
        newRaffle.id,
        sourceEntries.map((e) => ({
          user_id: e.user_id,
          user_name: e.user_name,
          user_display_name: e.user_display_name,
        }))
      );

      const rerunLang = db.getChatLanguage(chatId);
      const botUsername = ctx.me.username;

      const raffleKeyboard = buildRaffleKeyboard(newRaffle, added, rerunLang, botUsername);

      const caption = formatRaffleMessage(newRaffle, added, rerunLang) +
        `\n\n🔄 <i>Re-run of "${escapeHtml(sourceRaffle.title)}" with ${added} participants copied.</i>`;

      const posted = await sendWithGeneralFallback(
        (threadId) => sendRafflePost(
          ctx.api,
          chatId,
          "open",
          caption,
          raffleKeyboard,
          newRaffle.image_file_id,
          threadId
        ),
        preferredThreadId
      );

      if (!posted) {
        db.deleteRaffle(newRaffle.id);
        newRaffleId = null;
        await ctx.editMessageText(
          "❌ <b>The re-run could not be posted.</b>\n\nThe selected topic and the group’s General topic are not accepting posts. No raffle was created. Choose another raffle or open the destination topic and try again.",
          {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard()
              .text("🔄 Try Again", `rerun_back_${chatId}_${destinationToken}`)
              .row()
              .text("⬅️ Admin Center", `admin_do_menu_${chatId}`),
          }
        );
        return;
      }
      postedMessageId = posted.messageId;

      if (posted.threadId !== preferredThreadId) {
        db.updateRaffleFields(newRaffle.id, { thread_id: posted.threadId });
      }
      db.updateRaffleMessageId(newRaffle.id, posted.messageId);

      const link = buildMessageLink(chatId, posted.messageId);
      const keyboard = new InlineKeyboard();
      if (link) keyboard.url("🎟 Open Raffle", link).row();
      keyboard.text("⬅️ Admin Center", `admin_do_menu_${chatId}`);

      const fallbackNote = posted.threadId !== preferredThreadId
        ? "\n\n<i>The selected topic was unavailable, so the raffle was posted in General.</i>"
        : "";
      await ctx.editMessageText(
        `✅ <b>Re-run posted</b>\n\n${added} participants were copied into the new raffle.${fallbackNote}`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
    } catch (err) {
      if (newRaffleId !== null && postedMessageId === null) {
        try { db.deleteRaffle(newRaffleId); } catch {}
      }
      console.error(`Failed to create re-run from raffle ${sourceId}:`, err);
      await ctx.editMessageText(
        postedMessageId === null
          ? "❌ <b>The re-run could not be created.</b>\n\nNo raffle was posted. Please try again."
          : "⚠️ <b>The raffle was posted, but its confirmation could not be completed.</b>\n\nPlease check the group before trying again.",
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard()
            .text("🔄 Try Again", `rerun_back_${chatId}_${destinationToken}`)
            .row()
            .text("⬅️ Admin Center", `admin_do_menu_${chatId}`),
        }
      );
    }
  }
}

// ===================================================================
// TEMPLATE HUB — Button-based template management
// ===================================================================

/** Format template details for preview */
function formatTemplateSummary(tmpl: ReturnType<typeof db.getTemplateById>): string {
  if (!tmpl) return "Template not found.";
  let msg = "";
  msg += `📝 <b>Title:</b> ${escapeHtml(tmpl.title)}\n`;
  if (tmpl.description) {
    msg += `📄 <b>Rules:</b> ${escapeHtml(tmpl.description.slice(0, 120))}${tmpl.description.length > 120 ? "..." : ""}\n`;
  }
  if (tmpl.prizes) {
    try {
      const prizes = JSON.parse(tmpl.prizes) as string[];
      if (prizes.length > 1) {
        msg += `🎁 <b>Prizes:</b> ${prizes.map((p) => escapeHtml(p)).join(", ")}\n`;
      } else {
        msg += `🎁 <b>Prize:</b> ${escapeHtml(tmpl.prize)}\n`;
      }
    } catch {
      msg += `🎁 <b>Prize:</b> ${escapeHtml(tmpl.prize)}\n`;
    }
  } else {
    msg += `🎁 <b>Prize:</b> ${escapeHtml(tmpl.prize)}\n`;
  }
  msg += `🏆 <b>Winners:</b> ${tmpl.max_winners}\n`;
  if (tmpl.max_entries) {
    msg += `👥 <b>Max entries:</b> ${tmpl.max_entries}\n`;
  }
  if (tmpl.duration_minutes) {
    msg += `⏰ <b>Duration:</b> ${formatDurationHuman(tmpl.duration_minutes * 60000)}\n`;
  }
  if (tmpl.sponsor_name) {
    msg += `💎 <b>Sponsor:</b> ${escapeHtml(tmpl.sponsor_name)}\n`;
  }
  if (tmpl.anonymous) {
    msg += `👁 <b>Hidden entries:</b> On\n`;
  }
  if (tmpl.image_file_id) msg += `🖼 <b>Image:</b> Added\n`;
  if (tmpl.auto_pin) msg += `📌 <b>Auto-pin:</b> On\n`;
  if (tmpl.require_username) msg += `📛 <b>Username required:</b> Yes\n`;
  if (tmpl.required_chat_id) {
    msg += `🔒 <b>Required group:</b> ${escapeHtml(tmpl.required_chat_title || String(tmpl.required_chat_id))}\n`;
  }
  if (tmpl.min_account_age_days) msg += `📅 <b>Min age:</b> ${tmpl.min_account_age_days}d\n`;
  if (tmpl.winner_cooldown) msg += `🛡 <b>Winner cooldown:</b> ${tmpl.winner_cooldown}\n`;
  if (tmpl.show_animation === 0) msg += `🎡 <b>Animation:</b> Off\n`;
  if (tmpl.referral_enabled) {
    msg += `🔗 <b>Referrals:</b> On (${tmpl.max_referral_entries > 0 ? `max ${tmpl.max_referral_entries}` : "unlimited"})\n`;
  }
  if (tmpl.recurring_interval_minutes) {
    const interval = formatDurationHuman(tmpl.recurring_interval_minutes * 60000);
    msg += `🔄 <b>Recurring:</b> every ${interval}`;
    msg += tmpl.recurring_active ? " (active)\n" : " (paused)\n";
  }
  return msg;
}

/** Build and show the template list hub (send new or edit existing message) */
async function buildTemplateHub(
  ctx: Context,
  chatId: number,
  edit: boolean = false
): Promise<void> {
  const templates = db.getTemplatesForChat(chatId);

  const keyboard = new InlineKeyboard();
  for (const tmpl of templates.slice(0, 10)) {
    let label = tmpl.name;
    if (tmpl.recurring_active) label += " 🔄";
    keyboard.text(label, `tmpl_pick_${tmpl.id}`);
    keyboard.row();
  }
  keyboard.text("➕ Create New", `tmpl_create_${chatId}`);
  keyboard.row();
  keyboard.text("❌ Close", "tmpl_cancel");

  const text =
    templates.length > 0
      ? `📋 <b>Templates (${templates.length})</b>\n\nTap a template to use, edit, or delete:`
      : `📋 <b>Templates</b>\n\nNo templates saved yet. Tap below to create one:`;

  if (edit) {
    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }
}

/** Handle all tmpl_* callback queries */
export async function handleTemplateCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  // --- Close hub ---
  if (data === "tmpl_cancel") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  // --- Back to template list ---
  const backMatch = data.match(/^tmpl_back_(-?\d+)$/);
  if (backMatch) {
    await ctx.answerCallbackQuery();
    await buildTemplateHub(ctx, parseInt(backMatch[1], 10), true);
    return;
  }

  const createMatch = data.match(/^tmpl_create_(-?\d+)$/);
  if (createMatch) {
    const chatId = parseInt(createMatch[1], 10);
    if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only group admins can create templates.", show_alert: true });
      return;
    }
    const group = db.getBotGroup(chatId);
    await ctx.answerCallbackQuery();
    await startTemplateWizard(ctx.api, ctx.from.id, chatId, group?.title || "the group");
    return;
  }

  // --- Pick a template (action menu) ---
  if (data.startsWith("tmpl_pick_")) {
    const templateId = parseInt(data.replace("tmpl_pick_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }
    if (!(await isAdminOfChat(ctx, tmpl.chat_id, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only group admins can manage templates.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("🚀 Use Template", `tmpl_use_${tmpl.id}`)
      .row();

    if (tmpl.recurring_interval_minutes) {
      keyboard.text(
        tmpl.recurring_active ? "⏸ Pause Recurring" : "🔄 Start Recurring",
        `tmpl_recur_${tmpl.id}`
      );
      keyboard.row();
    }

    keyboard
      .text("🗑 Delete", `tmpl_delete_${tmpl.id}`)
      .text("⬅️ Back", `tmpl_back_${tmpl.chat_id}`);

    await ctx.editMessageText(
      `📋 <b>Template: "${escapeHtml(tmpl.name)}"</b>\n\n` +
        formatTemplateSummary(tmpl),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // --- Use template (confirmation screen) ---
  if (data.startsWith("tmpl_use_confirm_")) {
    const templateId = parseInt(data.replace("tmpl_use_confirm_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }
    const chatId = tmpl.chat_id;
    if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only admins can create raffles.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // Delete the hub message
    try {
      await ctx.deleteMessage();
    } catch {}

    // Create the raffle (reuses logic from handleUseTemplate)
    const displayName = getUserDisplayName(ctx.from.first_name, ctx.from.last_name);

    let endsAt: string | null = null;
    if (tmpl.duration_minutes) {
      const endDate = new Date(Date.now() + tmpl.duration_minutes * 60 * 1000);
      endsAt = endDate.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    }
    let startsAt: string | null = null;
    if (tmpl.starts_after_minutes) {
      const startDate = new Date(Date.now() + tmpl.starts_after_minutes * 60 * 1000);
      startsAt = startDate.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    }

    const raffle = db.createRaffle({
      chat_id: chatId,
      thread_id: tmpl.thread_id,
      creator_id: ctx.from.id,
      creator_name: displayName,
      title: tmpl.title,
      description: tmpl.description || "",
      prize: tmpl.prize,
      prizes: tmpl.prizes,
      max_entries: tmpl.max_entries,
      max_winners: tmpl.max_winners,
      ends_at: endsAt,
      starts_at: startsAt,
      display_timezone: tmpl.display_timezone || db.getChatTimezone(chatId),
      required_chat_id: tmpl.required_chat_id,
      required_chat_title: tmpl.required_chat_title,
      sponsor_name: tmpl.sponsor_name,
      anonymous: tmpl.anonymous,
      image_file_id: tmpl.image_file_id,
      auto_pin: tmpl.auto_pin,
      min_account_age_days: tmpl.min_account_age_days,
      require_username: tmpl.require_username,
      winner_cooldown: tmpl.winner_cooldown,
      show_animation: tmpl.show_animation,
      referral_enabled: tmpl.referral_enabled,
      max_referral_entries: tmpl.max_referral_entries,
      revoke_referral_links: tmpl.revoke_referral_links,
    });

    const lang = db.getChatLanguage(chatId);
    const botUsername = ctx.me.username;

    const raffleKeyboard = buildRaffleKeyboard(raffle, 0, lang, botUsername);

    const msgId = await sendRafflePost(
      ctx.api,
      chatId,
      "open",
      formatRaffleMessage(raffle, 0, lang),
      raffleKeyboard,
      raffle.image_file_id,
      raffle.thread_id
    );

    if (msgId) {
      db.updateRaffleMessageId(raffle.id, msgId);
      if (raffle.auto_pin) {
        try {
          await ctx.api.pinChatMessage(chatId, msgId, { disable_notification: true });
        } catch {}
      }
    }

    return;
  }

  if (data.startsWith("tmpl_use_")) {
    const templateId = parseInt(data.replace("tmpl_use_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }
    if (!(await isAdminOfChat(ctx, tmpl.chat_id, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only group admins can use templates.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("✅ Create Raffle", `tmpl_use_confirm_${tmpl.id}`)
      .row()
      .text("⬅️ Back", `tmpl_pick_${tmpl.id}`);

    await ctx.editMessageText(
      `🚀 <b>Create raffle from "${escapeHtml(tmpl.name)}"?</b>\n\n` +
        formatTemplateSummary(tmpl),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // --- Toggle recurring ---
  if (data.startsWith("tmpl_recur_")) {
    const templateId = parseInt(data.replace("tmpl_recur_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl || !tmpl.recurring_interval_minutes) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }
    if (!(await isAdminOfChat(ctx, tmpl.chat_id, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only admins can manage recurring.", show_alert: true });
      return;
    }

    if (tmpl.recurring_active) {
      db.setRecurringActive(tmpl.id, false, null);
      await ctx.answerCallbackQuery({ text: "Recurring paused." });
    } else {
      const nextRun = new Date(Date.now() + tmpl.recurring_interval_minutes * 60 * 1000);
      const nextRunStr = nextRun.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
      db.setRecurringActive(tmpl.id, true, nextRunStr);
      await ctx.answerCallbackQuery({ text: "Recurring activated!" });
    }

    // Refresh the action menu with updated status
    const updated = db.getTemplateById(templateId);
    if (!updated) return;

    const keyboard = new InlineKeyboard()
      .text("🚀 Use Template", `tmpl_use_${updated.id}`)
      .row();

    if (updated.recurring_interval_minutes) {
      keyboard.text(
        updated.recurring_active ? "⏸ Pause Recurring" : "🔄 Start Recurring",
        `tmpl_recur_${updated.id}`
      );
      keyboard.row();
    }

    keyboard
      .text("🗑 Delete", `tmpl_delete_${updated.id}`)
      .text("⬅️ Back", `tmpl_back_${updated.chat_id}`);

    await ctx.editMessageText(
      `📋 <b>Template: "${escapeHtml(updated.name)}"</b>\n\n` +
        formatTemplateSummary(updated),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // --- Delete confirmation ---
  if (data.startsWith("tmpl_delete_yes_")) {
    const templateId = parseInt(data.replace("tmpl_delete_yes_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl || !(await isAdminOfChat(ctx, tmpl.chat_id, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only admins can delete templates.", show_alert: true });
      return;
    }
    const name = tmpl ? tmpl.name : "template";

    const deleted = db.deleteTemplateById(templateId);
    if (deleted) {
      await ctx.answerCallbackQuery({ text: `"${name}" deleted.` });
    } else {
      await ctx.answerCallbackQuery({ text: "Template already deleted.", show_alert: true });
    }

    // Return to hub
    await buildTemplateHub(ctx, tmpl.chat_id, true);
    return;
  }

  if (data.startsWith("tmpl_delete_")) {
    const templateId = parseInt(data.replace("tmpl_delete_", ""), 10);
    if (isNaN(templateId)) return;

    const tmpl = db.getTemplateById(templateId);
    if (!tmpl) {
      await ctx.answerCallbackQuery({ text: "Template not found.", show_alert: true });
      return;
    }
    if (!(await isAdminOfChat(ctx, tmpl.chat_id, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only admins can delete templates.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    const keyboard = new InlineKeyboard()
      .text("🗑 Yes, Delete", `tmpl_delete_yes_${tmpl.id}`)
      .text("⬅️ Cancel", `tmpl_pick_${tmpl.id}`);

    await ctx.editMessageText(
      `⚠️ <b>Delete template "${escapeHtml(tmpl.name)}"?</b>\n\n` +
        `This cannot be undone.`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }
}

// /savetemplate - Save a raffle configuration as a reusable template
export async function handleSaveTemplate(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "templates");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can save templates.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/savetemplate(@\w+)?/i, "").trim();
  if (args) {
    await replyPrivately(
      ctx,
      "Template setup is now wizard-based. Use the template hub and tap ➕ Create New.",
    );
  }
  await buildTemplateHub(ctx, ctx.chat.id, false);
}

// /templates - Template management hub with inline buttons
export async function handleTemplates(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "templates");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await ctx.reply("Only group admins can manage templates.");
    return;
  }

  await buildTemplateHub(ctx, ctx.chat.id, false);
}

// /deletetemplate - Delete a saved template
export async function handleDeleteTemplate(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "templates");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can delete templates.");
    return;
  }

  const text = ctx.message?.text || "";
  const name = text.replace(/^\/deletetemplate(@\w+)?/i, "").trim();

  if (!name) {
    await buildTemplateHub(ctx, ctx.chat.id, false);
    return;
  }

  await replyPrivately(ctx, "Template deletion is button-based now. Pick the template from the hub and tap Delete.");
  await buildTemplateHub(ctx, ctx.chat.id, false);
}

// /usetemplate - Create a raffle from a saved template
export async function handleUseTemplate(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "templates");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can create raffles.");
    return;
  }

  const text = ctx.message?.text || "";
  const name = text.replace(/^\/usetemplate(@\w+)?/i, "").trim();

  if (!name) {
    await buildTemplateHub(ctx, ctx.chat.id, false);
    return;
  }

  await replyPrivately(ctx, "Template use is button-based now. Pick the template from the hub and tap Use Template.");
  await buildTemplateHub(ctx, ctx.chat.id, false);
}

// /recurring - Toggle recurring on/off for a template
export async function handleRecurring(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "templates");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can manage recurring raffles.");
    return;
  }

  const text = ctx.message?.text || "";
  const args = text.replace(/^\/recurring(@\w+)?/i, "").trim();

  if (!args) {
    await buildTemplateHub(ctx, ctx.chat.id, false);
    return;
  }

  await replyPrivately(ctx, "Recurring controls are button-based now. Pick the template from the hub and use the recurring button.");
  await buildTemplateHub(ctx, ctx.chat.id, false);
}

// /editraffle - Edit an active raffle's settings
export async function handleEditRaffle(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "edit");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can edit raffles.");
    return;
  }

  await showEditForChat(ctx, ctx.chat.id);
}

async function showEditForChat(ctx: Context, chatId: number): Promise<void> {
  const openRaffles = db.getOpenRafflesForChat(chatId);
  if (openRaffles.length === 0) {
    await ctx.reply("No open raffles to edit.");
    return;
  }

  // If only one open raffle, edit it directly
  if (openRaffles.length === 1) {
    await startEditWizard(ctx, openRaffles[0].id, chatId);
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const raffle of openRaffles) {
    keyboard.text(`${raffle.title.slice(0, 34)} (#${raffle.id})`, `edit_pick_${raffle.id}`).row();
  }
  await ctx.reply("✏️ <b>Which raffle do you want to edit?</b>", {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

// /language - Set the bot language for this chat
export async function handleLanguage(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "language");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can change the language.");
    return;
  }

  await showLanguageForChat(ctx, ctx.chat.id);
}

async function showLanguageForChat(ctx: Context, chatId: number): Promise<void> {
  const current = db.getChatLanguage(chatId);
  const langs = getAvailableLanguages();
  const keyboard = new InlineKeyboard();
  for (const l of langs) {
    const marker = l.code === current ? " ✅" : "";
    keyboard.text(`${l.name}${marker}`, `langset_${chatId}_${l.code}`).row();
  }
  keyboard.text("❌ Close", "langset_close");

  await ctx.reply(`🌐 <b>${t(current, "misc.lang_current", { lang: getLanguageName(current) })}</b>\n\nPick a language:`, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

export async function handleLanguageCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  if (data === "langset_close") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  const match = data.match(/^langset_(-?\d+)_([a-z]{2})$/);
  if (!match) return;

  const chatId = parseInt(match[1], 10);
  const code = match[2];
  if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Only group admins can change language.", show_alert: true });
    return;
  }

  const supported = db.getSupportedLanguages();
  if (!supported.includes(code)) {
    await ctx.answerCallbackQuery({ text: "Language is not supported.", show_alert: true });
    return;
  }

  db.setChatLanguage(chatId, code);
  await ctx.answerCallbackQuery({ text: getLanguageName(code) });
  await ctx.editMessageText(`🌐 ${t(code, "misc.lang_set", { lang: getLanguageName(code) })}`, {
    parse_mode: "HTML",
  });
}

const COMMON_GROUP_TIMEZONES: Array<{ label: string; tz: string }> = [
  { label: "Eastern (ET)", tz: "America/New_York" },
  { label: "Central (CT)", tz: "America/Chicago" },
  { label: "Mountain (MT)", tz: "America/Denver" },
  { label: "Pacific (PT)", tz: "America/Los_Angeles" },
  { label: "Alaska (AKT)", tz: "America/Anchorage" },
  { label: "Hawaii (HST)", tz: "Pacific/Honolulu" },
  { label: "UTC", tz: "UTC" },
  { label: "London", tz: "Europe/London" },
  { label: "Paris", tz: "Europe/Paris" },
  { label: "Tokyo", tz: "Asia/Tokyo" },
  { label: "Sydney", tz: "Australia/Sydney" },
  { label: "India", tz: "Asia/Kolkata" },
];

function buildGroupTimezoneKeyboard(chatId: number, current: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let i = 0; i < COMMON_GROUP_TIMEZONES.length; i++) {
    const option = COMMON_GROUP_TIMEZONES[i];
    const marker = option.tz === current ? " ✅" : "";
    keyboard.text(`${option.label}${marker}`, `tzset_${chatId}_${option.tz}`);
    if (i % 2 === 1) keyboard.row();
  }
  if (COMMON_GROUP_TIMEZONES.length % 2 === 1) keyboard.row();
  keyboard.text("❌ Close", "tzset_close");
  return keyboard;
}

// /timezone - View or set the chat's timezone (admin only in groups)
export async function handleTimezone(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "timezone");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    await replyPrivately(ctx, "Only group admins can change the timezone.");
    return;
  }

  await showTimezoneForChat(ctx, ctx.chat.id);
}

async function showTimezoneForChat(ctx: Context, chatId: number): Promise<void> {
  const { formatInTimezone } = await import("./timezone");
  const current = db.getChatTimezone(chatId);
  const nowInTz = formatInTimezone(new Date(), current);
  await ctx.reply(
    `🕐 <b>Group timezone:</b> <code>${escapeHtml(current)}</code>\n` +
      `Current time: <b>${escapeHtml(nowInTz)}</b>\n\n` +
      `Pick the timezone this group's raffle wizards should use:`,
    {
      parse_mode: "HTML",
      reply_markup: buildGroupTimezoneKeyboard(chatId, current),
    }
  );
}

export async function handleTimezoneCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  if (data === "tzset_close") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {}
    return;
  }

  const match = data.match(/^tzset_(-?\d+)_(.+)$/);
  if (!match) return;

  const chatId = parseInt(match[1], 10);
  const timezone = match[2];
  if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Only group admins can change timezone.", show_alert: true });
    return;
  }

  const allowed = COMMON_GROUP_TIMEZONES.some((option) => option.tz === timezone);
  if (!allowed) {
    await ctx.answerCallbackQuery({ text: "Timezone option is not supported.", show_alert: true });
    return;
  }

  db.setChatTimezone(chatId, timezone);
  const { formatInTimezone } = await import("./timezone");
  await ctx.answerCallbackQuery({ text: timezone });
  await ctx.editMessageText(
    `✅ Timezone set to <code>${escapeHtml(timezone)}</code>.\n` +
      `Current time: <b>${escapeHtml(formatInTimezone(new Date(), timezone))}</b>`,
    { parse_mode: "HTML" }
  );
}

// --- Callback query handlers ---

export async function handleEnterCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace("enter_", ""), 10);
  if (isNaN(raffleId)) return;

  const userId = ctx.from!.id;
  const userName = ctx.from!.username || "";
  const displayName = getUserDisplayName(
    ctx.from!.first_name,
    ctx.from!.last_name
  );

  // --- Entry verification checks ---
  const raffle = db.getRaffleById(raffleId);
  if (raffle) {
    // Require username check
    if (raffle.require_username && !ctx.from!.username) {
      await ctx.answerCallbackQuery({
        text: "⚠️ You need a Telegram username to enter this raffle. Set one in Settings → Username.",
        show_alert: true,
      });
      return;
    }

    // Required group/channel membership check
    if (raffle.required_chat_id) {
      try {
        const member = await ctx.api.getChatMember(raffle.required_chat_id, userId);
        const allowedStatuses = ["member", "administrator", "creator"];
        const isRestrictedMember =
          member.status === "restricted" && "is_member" in member && member.is_member;
        if (!allowedStatuses.includes(member.status) && !isRestrictedMember) {
          await ctx.answerCallbackQuery({
            text: `⚠️ You must be a member of ${raffle.required_chat_title || "the required group"} to enter.`,
            show_alert: true,
          });
          return;
        }
      } catch {
        await ctx.answerCallbackQuery({
          text: "⚠️ I couldn't verify the required group membership. Ask an admin to check the raffle setup.",
          show_alert: true,
        });
        return;
      }
    }

    // Account age check (estimated from user ID)
    if (raffle.min_account_age_days > 0) {
      const estimatedAge = estimateAccountAgeDays(userId);
      if (estimatedAge !== null && estimatedAge < raffle.min_account_age_days) {
        await ctx.answerCallbackQuery({
          text: `⚠️ Your account must be at least ${raffle.min_account_age_days} day${raffle.min_account_age_days > 1 ? "s" : ""} old to enter.`,
          show_alert: true,
        });
        return;
      }
    }

    // Winner cooldown check
    if (raffle.winner_cooldown > 0) {
      const recentWin = db.getRecentWin(raffle.chat_id, userId, raffle.winner_cooldown);
      if (recentWin) {
        await ctx.answerCallbackQuery({
          text: `⚠️ Recent winners can't enter yet. You won "${recentWin}" recently. Try again after more raffles complete!`,
          show_alert: true,
        });
        return;
      }
    }
  }

  const result = db.addEntry(raffleId, userId, userName, displayName);
  const chatId = ctx.callbackQuery?.message?.chat?.id;
  const entryLang = chatId ? db.getChatLanguage(chatId) : "en";

  if (result.success) {
    await ctx.answerCallbackQuery({ text: `🎟 ${t(entryLang, "entry.success")}` });
    // Debounced — batches rapid entries into one message edit
    debouncedUpdateRafflePost(ctx, raffleId);

    // Referral link is now handled via the "Get Referral Link" button on the raffle post
    // which deep-links to the bot DM where the link is generated on demand

    // Auto-draw when max entries reached
    if (result.maxReached) {
      // Cancel pending debounce — auto-draw does a direct update
      const pending = pendingPostUpdates.get(raffleId);
      if (pending) { clearTimeout(pending.timer); pendingPostUpdates.delete(raffleId); }

      const raffle = db.getRaffleById(raffleId);
      if (raffle && raffle.status === "open") {
        const lang = db.getChatLanguage(raffle.chat_id);
        const entries = db.getEntriesForRaffle(raffleId);
        const entryNames = entries.map((e) => e.user_display_name);
        const winners = db.selectWinners(raffleId);

        // Countdown animation (if animation enabled)
        if (entryNames.length >= 1 && raffle.show_animation) {
          await sendWheelSpin(ctx.api, raffle.chat_id, raffle.thread_id);
        }

        // Announce winners with embedded "WINNERS DRAWN" banner
        await sendWinnerPost(ctx.api, raffle.chat_id, formatWinnersMessage(raffle, winners, lang), raffle.thread_id);

        db.markRaffleDrawn(raffleId);
        db.markRaffleAnnounced(raffleId);
        await revokeReferralInviteLinks(ctx.api, raffleId);
        await updateRafflePost(ctx, raffleId);
        await notifyWinnersAndCreator(ctx.api, raffle, winners);
      }
    }
  } else {
    await ctx.answerCallbackQuery({
      text: result.reason || "Could not enter.",
      show_alert: true,
    });
  }
}

export async function handleLeaveCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace("leave_", ""), 10);
  if (isNaN(raffleId)) return;

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== "open") {
    await ctx.answerCallbackQuery({
      text: "This raffle is no longer open.",
      show_alert: true,
    });
    return;
  }

  const removed = db.removeEntry(raffleId, ctx.from!.id);
  const leaveLang = raffle ? db.getChatLanguage(raffle.chat_id) : "en";

  if (removed) {
    await ctx.answerCallbackQuery({ text: t(leaveLang, "entry.left") });
    // Debounced — batches rapid leaves into one message edit
    debouncedUpdateRafflePost(ctx, raffleId);
  } else {
    await ctx.answerCallbackQuery({
      text: t(leaveLang, "entry.not_in"),
      show_alert: true,
    });
  }
}

export async function handleEntriesCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data) return;

  const raffleId = parseInt(data.replace(/^entries_/, "").split("_")[0], 10);
  if (isNaN(raffleId)) return;

  const raffle = db.getRaffleById(raffleId);

  // Anonymous mode: hide entry names until drawn
  if (raffle && raffle.anonymous && raffle.status !== "drawn") {
    const count = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : db.getEntryCount(raffleId);
    await ctx.answerCallbackQuery({
      text: count === 0
        ? "No entries yet. Be the first!"
        : `${count} entries so far. Names hidden until draw!`,
      show_alert: true,
    });
    return;
  }

  const totalParticipants = db.getEntryCount(raffleId);

  if (totalParticipants === 0) {
    await ctx.answerCallbackQuery({
      text: "No entries yet. Be the first!",
      show_alert: true,
    });
    return;
  }

  // Build entries list - Telegram popup limit is ~200 chars.
  const recentEntries = db.getRecentEntriesForRaffle(raffleId, 20);

  // If referrals are enabled, show bonus entries next to names
  const showBonus = raffle && raffle.referral_enabled;
  const names = recentEntries.map((e, i) => {
    const num = totalParticipants - i;
    if (showBonus) {
      return e.bonus_entries > 0
        ? `${num}. ${e.user_display_name} (+${e.bonus_entries})`
        : `${num}. ${e.user_display_name}`;
    }
    return `${num}. ${e.user_display_name}`;
  });

  const totalCount = raffle && raffle.referral_enabled
    ? db.getTotalEntryCount(raffleId)
    : totalParticipants;
  let message = `📋 Entries (${totalCount}) - Recent:\n`;

  for (const name of names) {
    if ((message + name + "\n").length > 195) {
      message += "...";
      break;
    }
    message += name + "\n";
  }

  await ctx.answerCallbackQuery({
    text: message.trim(),
    show_alert: true,
  });
}

// --- Utility ---

// Track which raffles are photo-based vs text-only to avoid wasted API calls
const raffleIsPhotoMsg = new Map<number, boolean>();

async function updateRafflePost(ctx: Context, raffleId: number): Promise<void> {
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || !raffle.message_id) return;

  const count = db.getEntryCount(raffleId);
  const displayCount = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : count;

  const lang = db.getChatLanguage(raffle.chat_id);
  const botUsername = ctx.me.username;

  try {
    if (raffle.status === "open") {
      const keyboard = buildRaffleKeyboard(raffle, displayCount, lang, botUsername);
      const caption = formatRaffleMessage(raffle, count, lang);
      const isPhoto = raffleIsPhotoMsg.get(raffleId);

      if (isPhoto === false) {
        // Known text-only — skip editMessageCaption entirely
        await ctx.api.editMessageText(raffle.chat_id, raffle.message_id, caption, { parse_mode: "HTML", reply_markup: keyboard });
        return;
      }

      try {
        await ctx.api.editMessageCaption(raffle.chat_id, raffle.message_id, { caption, parse_mode: "HTML", reply_markup: keyboard });
        raffleIsPhotoMsg.set(raffleId, true);
      } catch {
        try {
          await ctx.api.editMessageText(raffle.chat_id, raffle.message_id, caption, { parse_mode: "HTML", reply_markup: keyboard });
          raffleIsPhotoMsg.set(raffleId, false);
        } catch { /* unchanged or deleted */ }
      }
    } else {
      // Raffle is closed or drawn - remove entry buttons and swap banner to "closed"
      let text = formatRaffleMessage(raffle, count, lang);

      if (raffle.status === "drawn") {
        const winners = db.getWinnersForRaffle(raffleId);
        if (winners.length > 0) {
          const winnerLabel = winners.length > 1
            ? t(lang, "winner.label_plural")
            : t(lang, "winner.label");
          text += `\n\n🏆 <b>${winnerLabel}:</b>\n`;
          winners.forEach((w) => {
            const mention = `<a href="tg://user?id=${w.user_id}">${escapeHtml(w.user_display_name)}</a>`;
            if (w.prize) {
              text += `  🎁 ${mention} — ${escapeHtml(w.prize)}\n`;
            } else {
              text += `  • ${mention}\n`;
            }
          });
        }
      }

      // Try to swap the banner to "closed" using editMessageMedia
      const closedBannerFileId = await getBannerFileId(ctx.api, raffle.chat_id, "closed");
      if (closedBannerFileId) {
        try {
          await ctx.api.editMessageMedia(
            raffle.chat_id,
            raffle.message_id,
            {
              type: "photo",
              media: closedBannerFileId,
              caption: text,
              parse_mode: "HTML",
            }
          );
          return; // Success - exit early
        } catch (err) {
          console.error(`Failed to swap banner to closed:`, err);
          // editMessageMedia failed, fall back to editMessageCaption
        }
      } else {
        console.log(`No closed banner file_id available for chat ${raffle.chat_id}`);
      }

      // Fallback: just update the caption (banner stays as "open")
      await ctx.api.editMessageCaption(
        raffle.chat_id,
        raffle.message_id,
        { caption: text, parse_mode: "HTML" }
      );
    }
  } catch {
    // Message may have been deleted or too old to edit
  }
}

/**
 * Revoke all referral invite links for a raffle, if revoke_referral_links is enabled.
 * Silently skips links that are already revoked or invalid.
 */
export async function revokeReferralInviteLinks(
  api: { revokeChatInviteLink: (chatId: number, inviteLink: string) => Promise<unknown> },
  raffleId: number
): Promise<void> {
  const raffle = db.getRaffleById(raffleId);
  if (!raffle) return;
  if (!raffle.referral_enabled || !raffle.revoke_referral_links) return;

  const links = db.getReferralLinksForRaffle(raffleId);
  if (links.length === 0) return;

  // Revoke in parallel batches of 5 to avoid rate limits
  let revoked = 0;
  const BATCH_SIZE = 5;
  for (let i = 0; i < links.length; i += BATCH_SIZE) {
    const batch = links.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((link) => api.revokeChatInviteLink(link.chat_id, link.invite_link))
    );
    revoked += results.filter((r) => r.status === "fulfilled").length;
  }

  if (revoked > 0) {
    console.log(`Revoked ${revoked}/${links.length} referral invite links for raffle ${raffleId}`);
  }
}

/**
 * DM each winner telling them what they won, and DM the raffle creator
 * (and sponsor info) with the full results.
 */
export async function notifyWinnersAndCreator(
  api: { sendMessage: (chatId: number, text: string, opts?: Record<string, unknown>) => Promise<unknown>; getChat: (chatId: number) => Promise<{ title?: string; username?: string }> },
  raffle: { id: number; chat_id: number; title: string; creator_id: number; creator_name: string; sponsor_name: string | null; message_id: number | null },
  winners: Array<{ user_id: number; user_display_name: string; prize: string; position: number }>
): Promise<void> {
  const title = escapeHtml(raffle.title);

  // Resolve group title + public username (if any) for link building
  let groupTitle = "the group";
  let groupUsername: string | null = null;
  try {
    const chat = await api.getChat(raffle.chat_id);
    if (chat.title) groupTitle = chat.title;
    if (chat.username) groupUsername = chat.username;
  } catch {
    // Bot may have been kicked since the draw — we'll fall back to plain text
  }

  // Build a link straight to the raffle post.
  //   - Public groups: https://t.me/<username>/<msgId>
  //   - Private supergroups: https://t.me/c/<shortId>/<msgId>  (only opens for members)
  let raffleLink: string | null = null;
  if (raffle.message_id) {
    if (groupUsername) {
      raffleLink = `https://t.me/${groupUsername}/${raffle.message_id}`;
    } else {
      raffleLink = buildMessageLink(raffle.chat_id, raffle.message_id);
    }
  }
  const groupLink: string | null = raffleLink; // same destination; both nav to the chat

  // Sponsor contact line (optional, separate from group info)
  let sponsorLine = "";
  if (raffle.sponsor_name) {
    const sponsor = raffle.sponsor_name.trim();
    if (sponsor.startsWith("@")) {
      const username = sponsor.replace(/^@/, "");
      sponsorLine = `\n💎 <b>Sponsor:</b> <a href="https://t.me/${escapeHtml(username)}">${escapeHtml(sponsor)}</a> — contact them to claim your prize!`;
    } else {
      sponsorLine = `\n💎 <b>Sponsor:</b> ${escapeHtml(sponsor)}`;
    }
  }

  // Group line — ALWAYS present so winners know where they won, even when sponsored.
  // Includes a link to the raffle post when we can build one.
  const groupNameEsc = escapeHtml(groupTitle);
  const groupLine = groupLink
    ? `\n📍 <b>Group:</b> <a href="${groupLink}">${groupNameEsc}</a>`
    : `\n📍 <b>Group:</b> ${groupNameEsc}`;

  const raffleLinkLine = raffleLink
    ? `\n🔗 <a href="${raffleLink}">View the raffle post</a>`
    : "";

  // DM all winners concurrently
  const dmResults = await Promise.allSettled(
    winners.map(async (w) => {
      let winnerMsg = `🎉 <b>Congratulations!</b>\n\n`;
      winnerMsg += `You won in the raffle <b>${title}</b>!`;
      if (w.prize) {
        winnerMsg += `\n🎁 <b>Your prize:</b> ${escapeHtml(w.prize)}`;
      }
      winnerMsg += "\n";
      winnerMsg += groupLine;
      if (sponsorLine) winnerMsg += sponsorLine;
      winnerMsg += raffleLinkLine;
      await api.sendMessage(w.user_id, winnerMsg, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      return w.user_display_name;
    })
  );

  const failedDmWinners = dmResults
    .map((r, i) => r.status === "rejected" ? winners[i].user_display_name : null)
    .filter((name): name is string => name !== null);

  if (failedDmWinners.length > 0) {
    console.log(`Could not DM winners: ${failedDmWinners.join(", ")}`);
  }

  // DM the creator with full results
  try {
    let creatorMsg = `🏆 <b>Raffle Results: ${title}</b>\n\n`;
    if (winners.length === 0) {
      creatorMsg += `No winners were selected (no entries).`;
    } else {
      creatorMsg += `<b>Winners:</b>\n`;
      for (const w of winners) {
        const name = escapeHtml(w.user_display_name);
        if (w.prize) {
          creatorMsg += `  ${w.position}. ${name} — ${escapeHtml(w.prize)}\n`;
        } else {
          creatorMsg += `  ${w.position}. ${name}\n`;
        }
      }
    }
    if (raffle.sponsor_name) {
      creatorMsg += `\n💎 Sponsor: ${escapeHtml(raffle.sponsor_name)}`;
    }
    await api.sendMessage(raffle.creator_id, creatorMsg, { parse_mode: "HTML" });
  } catch {
    // Creator may not have started the bot
  }
}

// Build stats message — shared by /stats command and weekly auto-report
export function buildStatsMessage(): string {
  const stats = db.getBotStats();

  // Get groups from the bot_groups tracking table
  const allGroups = db.getActiveBotGroups();
  const adminGroups = db.getAdminBotGroups();

  let msg = `📊 <b>Bot Statistics</b>\n\n`;

  msg += `<b>Usage:</b>\n`;
  msg += `  👥 Groups (total): <b>${allGroups.length}</b>\n`;
  msg += `  🛡 Groups (admin): <b>${adminGroups.length}</b>\n`;
  msg += `  🧑 Unique creators: <b>${stats.totalCreators}</b>\n`;
  msg += `  🎟 Unique participants: <b>${stats.totalParticipants}</b>\n\n`;

  msg += `<b>Raffles:</b>\n`;
  msg += `  📋 Total: <b>${stats.totalRaffles}</b>\n`;
  msg += `  🟢 Active: <b>${stats.activeRaffles}</b> <i>(use /active for the list)</i>\n`;
  msg += `  🏆 Drawn: <b>${stats.drawnRaffles}</b>\n\n`;

  msg += `<b>Entries:</b>\n`;
  msg += `  📝 Total entries: <b>${stats.totalEntries}</b>\n`;
  msg += `  🏆 Total winners: <b>${stats.totalWinners}</b>\n\n`;

  msg += `<b>Last 7 days:</b>\n`;
  msg += `  📋 Raffles created: <b>${stats.rafflesLast7Days}</b>\n`;
  msg += `  📝 Entries: <b>${stats.entriesLast7Days}</b>\n`;

  if (adminGroups.length > 0) {
    msg += `\n<b>🛡 Admin Groups:</b>\n`;
    for (const g of adminGroups) {
      msg += `  • ${escapeHtml(g.title)}\n`;
    }
  }

  const memberOnly = allGroups.filter((g) => g.bot_status === "member");
  if (memberOnly.length > 0) {
    msg += `\n<b>👤 Member Only (no admin):</b>\n`;
    for (const g of memberOnly) {
      msg += `  • ${escapeHtml(g.title)}\n`;
    }
  }

  return msg;
}

/**
 * Split a long HTML-formatted message into chunks that fit within Telegram's 4096 char limit.
 * Splits at safe boundaries: blank-line section breaks first, then single newlines if needed.
 */
export function chunkMessage(text: string, maxLen = 3900): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Try to split at a blank-line boundary within the limit
    let splitAt = remaining.lastIndexOf("\n\n", maxLen);
    if (splitAt < maxLen / 2) {
      // Fall back to single newline if blank-line split would lose too much
      splitAt = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitAt < maxLen / 2) {
      // Last resort: hard split at maxLen
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// /stats - Bot-wide statistics (owner only)
export async function handleStats(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) {
    // Silently ignore — don't reveal the command exists
    return;
  }

  const msg = buildStatsMessage();
  const chunks = chunkMessage(msg);

  // Send all chunks as DMs to the owner; fall back to chat reply if DM fails
  let useFallback = false;
  for (const chunk of chunks) {
    try {
      if (useFallback) {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      } else {
        await ctx.api.sendMessage(userId, chunk, { parse_mode: "HTML" });
      }
    } catch (err) {
      // If first send fails (DM blocked), retry the rest in chat
      if (!useFallback) {
        useFallback = true;
        try {
          await ctx.reply(chunk, { parse_mode: "HTML" });
        } catch (err2) {
          console.error("Stats: failed to send chunk in chat fallback:", err2);
        }
      } else {
        console.error("Stats: failed to send chunk:", err);
      }
    }
    // Tiny gap to avoid per-chat rate limits when chunks > 1
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
}

// /health - Bot health snapshot (owner only, hidden)
export async function handleHealth(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) {
    return; // Silently ignore
  }

  const health = db.getAnnouncementHealth();
  const stats = db.getBotStats();
  const groups = db.getActiveBotGroups();
  const adminCount = groups.filter((g) => g.bot_status === "administrator").length;
  const memberCount = groups.length - adminCount;

  // Find the worst-stuck raffle (oldest unannounced)
  const worst = db.getOldestUnannouncedRaffles(5);

  // Bot uptime — process.uptime returns seconds
  const uptimeSec = Math.floor(process.uptime());
  const uptimeStr =
    uptimeSec < 60
      ? `${uptimeSec}s`
      : uptimeSec < 3600
      ? `${Math.floor(uptimeSec / 60)}m`
      : uptimeSec < 86400
      ? `${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`
      : `${Math.floor(uptimeSec / 86400)}d ${Math.floor((uptimeSec % 86400) / 3600)}h`;

  const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);

  const overall =
    health.stuckOver1h > 0 || health.permanentlyFailed > 5
      ? "🔴 <b>Issues detected</b>"
      : health.stuckOver15min > 0
      ? "🟡 <b>Minor issues</b>"
      : "🟢 <b>Healthy</b>";

  let msg = `${overall}\n\n`;
  msg += `<b>🤖 Bot</b>\n`;
  msg += `  Uptime: ${uptimeStr}\n`;
  msg += `  Memory: ${memMb} MB\n\n`;

  msg += `<b>📊 Activity</b>\n`;
  msg += `  Active raffles: ${stats.activeRaffles}\n`;
  msg += `  Tracked groups: ${groups.length} (${adminCount} admin / ${memberCount} member)\n\n`;

  msg += `<b>📣 Announcements</b>\n`;
  msg += `  Pending: ${health.totalUnannounced}\n`;
  msg += `  Stuck >15 min: ${health.stuckOver15min === 0 ? "0 ✅" : `${health.stuckOver15min} ⚠️`}\n`;
  msg += `  Stuck >1 hour: ${health.stuckOver1h === 0 ? "0 ✅" : `${health.stuckOver1h} 🔴`}\n`;
  msg += `  Gave up on: ${health.permanentlyFailed}\n\n`;

  const jobs = getJobStats();
  msg += `<b>⚙️ Background Jobs</b>\n`;
  msg += `  Pending: ${jobs.pending}\n`;
  msg += `  Running: ${jobs.running}\n`;
  msg += `  Done (24h): ${jobs.doneLast24h}\n`;
  msg += `  Failed: ${jobs.failed === 0 ? "0 ✅" : `${jobs.failed} ⚠️`}\n\n`;

  // Backup status
  const BACKUP_DIR = "/data/backups";
  msg += `<b>💾 Backups</b>\n`;
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      const files = fs
        .readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith("raffle.db.") && f.endsWith(".bak"))
        .map((f) => ({
          name: f,
          mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs,
          size: fs.statSync(path.join(BACKUP_DIR, f)).size,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (files.length === 0) {
        msg += `  ⚠️ No backups yet (waiting for first hourly run)\n`;
      } else {
        const latest = files[0];
        const ageMin = Math.floor((Date.now() - latest.mtime) / 60_000);
        const ageStr = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
        const totalMb = (files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1);
        const ageIcon = ageMin > 90 ? "🔴" : ageMin > 65 ? "🟡" : "✅";
        msg += `  Last backup: ${ageStr} ${ageIcon}\n`;
        msg += `  Count: ${files.length} files (${totalMb} MB total)\n`;
      }
    } else {
      msg += `  ⚠️ Backup directory not found\n`;
    }
  } catch (err) {
    msg += `  ⚠️ Could not read backups: ${escapeHtml(String((err as Error).message || err))}\n`;
  }

  if (worst.length > 0) {
    msg += `\n<b>🔍 Oldest pending</b>\n`;
    for (const r of worst) {
      msg += `  • <code>${r.id}</code> ${escapeHtml(r.title.slice(0, 40))} — ${r.announce_attempts} attempts\n`;
      msg += `     drawn ${r.drawn_at} UTC, chat <code>${r.chat_id}</code>\n`;
    }
  }

  const chunks = chunkMessage(msg);
  let useFallback = false;
  for (const chunk of chunks) {
    try {
      if (useFallback) {
        await ctx.reply(chunk, { parse_mode: "HTML" });
      } else {
        await ctx.api.sendMessage(userId, chunk, { parse_mode: "HTML" });
      }
    } catch {
      if (!useFallback) {
        useFallback = true;
        try {
          await ctx.reply(chunk, { parse_mode: "HTML" });
        } catch (err2) {
          console.error("Health: failed chat fallback:", err2);
        }
      }
    }
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
}

// /metrics - Bot activity counters since process start (owner only, hidden)
export async function handleMetrics(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) return;

  const snap = metrics.snapshot();

  const uptimeStr =
    snap.uptimeSec < 60
      ? `${snap.uptimeSec}s`
      : snap.uptimeSec < 3600
      ? `${Math.floor(snap.uptimeSec / 60)}m`
      : snap.uptimeSec < 86400
      ? `${Math.floor(snap.uptimeSec / 3600)}h ${Math.floor((snap.uptimeSec % 3600) / 60)}m`
      : `${Math.floor(snap.uptimeSec / 86400)}d ${Math.floor((snap.uptimeSec % 86400) / 3600)}h`;

  // Aggregate stats
  const totalApiCalls = Object.values(snap.apiCalls).reduce((a, b) => a + b, 0);
  const totalErrors = Object.values(snap.apiErrors).reduce((a, b) => a + b, 0);
  const totalCommands = Object.values(snap.commands).reduce((a, b) => a + b, 0);
  const errorRate = totalApiCalls > 0 ? ((totalErrors / totalApiCalls) * 100).toFixed(2) : "0.00";

  let msg = `📊 <b>Bot Metrics</b>\n`;
  msg += `<i>Since process start — restart to reset</i>\n\n`;

  msg += `<b>📈 Overview</b>\n`;
  msg += `  Uptime: ${uptimeStr}\n`;
  msg += `  Started: <code>${snap.startedAt}</code>\n`;
  msg += `  API calls: ${totalApiCalls.toLocaleString()}\n`;
  msg += `  API errors: ${totalErrors.toLocaleString()} (${errorRate}%)\n`;
  msg += `  Commands: ${totalCommands.toLocaleString()}\n`;
  msg += `  Rate-limit hits: ${snap.rateLimitHits}\n`;
  msg += `  Owner alerts sent: ${snap.ownerAlertsSent}\n\n`;

  // Top 8 API methods
  const apiSorted = Object.entries(snap.apiCalls).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (apiSorted.length > 0) {
    msg += `<b>🌐 Top API Calls</b>\n`;
    for (const [method, count] of apiSorted) {
      msg += `  ${method}: <b>${count.toLocaleString()}</b>\n`;
    }
    msg += `\n`;
  }

  // Top error codes
  const errSorted = Object.entries(snap.apiErrors).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (errSorted.length > 0) {
    msg += `<b>⚠️ API Errors by method:code</b>\n`;
    for (const [key, count] of errSorted) {
      msg += `  <code>${escapeHtml(key)}</code>: ${count}\n`;
    }
    msg += `\n`;
  }

  // Top commands
  const cmdSorted = Object.entries(snap.commands).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (cmdSorted.length > 0) {
    msg += `<b>💬 Top Commands</b>\n`;
    for (const [cmd, count] of cmdSorted) {
      msg += `  /${escapeHtml(cmd)}: ${count}\n`;
    }
    msg += `\n`;
  }

  // Latency stats
  const lat = computeLatencyStats(snap.apiLatencyMs);
  const latEntries = Object.entries(lat).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
  if (latEntries.length > 0) {
    msg += `<b>⚡ API Latency (recent ${snap.apiLatencyMs.length} samples)</b>\n`;
    for (const [method, stats] of latEntries) {
      const warn = stats.p95 > 2000 ? " ⚠️" : "";
      msg += `  ${method}: p50 <b>${stats.p50}ms</b>, p95 <b>${stats.p95}ms</b>${warn}\n`;
    }
  }

  try {
    await ctx.api.sendMessage(userId, msg, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}

// /active — List all active raffles across all groups (hidden, not in BotFather menu)
export async function handleActive(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const groups = db.getActiveRafflesByGroup();

  if (groups.length === 0) {
    await ctx.reply("📭 No active raffles right now.");
    return;
  }

  let totalRaffles = 0;
  const sections: string[] = [];

  for (const group of groups) {
    let groupTitle = `Chat ${group.chat_id}`;
    try {
      const chat = await ctx.api.getChat(group.chat_id);
      if ("title" in chat && chat.title) {
        groupTitle = chat.title;
      }
    } catch {
      // Can't resolve name — use chat ID
    }

    let section = `<b>📍 ${escapeHtml(groupTitle)}</b>\n`;

    for (const raffle of group.raffles) {
      totalRaffles++;
      const entryCount = db.getEntryCount(raffle.id);
      const totalCount = raffle.referral_enabled ? db.getTotalEntryCount(raffle.id) : entryCount;

      let line = `  🎟 <b>${escapeHtml(raffle.title)}</b> — ${totalCount} entries`;
      if (raffle.max_winners > 1) {
        line += ` (${raffle.max_winners} winners)`;
      }
      if (raffle.ends_at) {
        const endsDate = new Date(raffle.ends_at + "Z");
        const remaining = endsDate.getTime() - Date.now();
        if (remaining > 0) {
          line += ` — ${formatCountdown(endsDate)} left`;
        } else {
          line += ` — <i>expired, pending draw</i>`;
        }
      } else {
        line += ` — no end time`;
      }
      if (raffle.message_id) {
        const link = buildMessageLink(raffle.chat_id, raffle.message_id);
        if (link) {
          line += ` (<a href="${link}">view</a>)`;
        }
      }
      section += line + "\n";
    }

    sections.push(section);
  }

  const header = `📊 <b>Active Raffles: ${totalRaffles} across ${groups.length} group${groups.length === 1 ? "" : "s"}</b>\n\n`;
  const msg = header + sections.join("\n");

  const chunks = chunkMessage(msg);
  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (err) {
      console.error("Active: failed to send chunk:", err);
    }
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, 400));
  }
}

// /referralstats — Show referral link stats for active raffles (owner only)
export async function handleReferralStats(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;

  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);
  if (ownerId === 0 || userId !== ownerId) {
    return;
  }

  // Get all open raffles with referrals enabled
  const allOpen = db.getActiveRafflesByGroup();
  const referralRaffles: Array<{ raffle: ReturnType<typeof db.getRaffleById>; links: ReturnType<typeof db.getReferralLinksForRaffle>; entryCount: number; totalCount: number }> = [];

  for (const group of allOpen) {
    for (const raffle of group.raffles) {
      if (raffle.referral_enabled) {
        const links = db.getReferralLinksForRaffle(raffle.id);
        const entryCount = db.getEntryCount(raffle.id);
        const totalCount = db.getTotalEntryCount(raffle.id);
        referralRaffles.push({ raffle, links, entryCount, totalCount });
      }
    }
  }

  if (referralRaffles.length === 0) {
    try {
      await ctx.api.sendMessage(userId, "No active raffles with referrals enabled.", { parse_mode: "HTML" });
    } catch {
      await ctx.reply("No active raffles with referrals enabled.");
    }
    return;
  }

  let msg = `🔗 <b>Referral Stats</b>\n`;

  for (const { raffle, links, entryCount, totalCount } of referralRaffles) {
    if (!raffle) continue;
    const groupInfo = db.getActiveBotGroups().find((g) => g.chat_id === raffle.chat_id);
    const groupName = groupInfo ? groupInfo.title : `Chat ${raffle.chat_id}`;
    const totalBonuses = links.reduce((sum, l) => sum + l.bonus_entries, 0);

    msg += `\n━━━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `📝 <b>${escapeHtml(raffle.title)}</b>\n`;
    msg += `💬 ${escapeHtml(groupName)}\n`;
    msg += `👥 Entries: <b>${entryCount}</b> unique · <b>${totalCount}</b> effective\n`;
    msg += `🔗 Links created: <b>${links.length}</b>\n`;
    msg += `⭐ Bonus entries: <b>${totalBonuses}</b>\n`;

    const withReferrals = links.filter((l) => l.bonus_entries > 0);
    if (withReferrals.length > 0) {
      msg += `\n<b>Leaderboard:</b>\n`;
      for (const l of withReferrals) {
        msg += `  🏅 ${escapeHtml(l.user_display_name)} — <b>${l.bonus_entries}</b> referral${l.bonus_entries !== 1 ? "s" : ""}\n`;
      }
    }

    const noReferrals = links.filter((l) => l.bonus_entries === 0);
    if (noReferrals.length > 0) {
      msg += `\n<b>Links created (0 referrals):</b>\n`;
      for (const l of noReferrals) {
        msg += `  • ${escapeHtml(l.user_display_name)}\n`;
      }
    }
  }

  try {
    await ctx.api.sendMessage(userId, msg, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(msg, { parse_mode: "HTML" });
  }
}

// /groupstats — Show raffle stats for this group (admin only)
export async function handleGroupStats(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "stats");
    return;
  }

  const userId = ctx.from!.id;
  const isAdmin = await isAdminOfChat(ctx, ctx.chat.id, userId);
  if (!isAdmin) {
    return; // silently ignore for non-admins
  }

  await showGroupStatsForChat(ctx, ctx.chat.id);
}

async function showGroupStatsForChat(ctx: Context, chatId: number): Promise<void> {
  const stats = db.getGroupStats(chatId);

  let msg = `📊 <b>Group Raffle Stats</b>\n\n`;

  msg += `<b>Overview:</b>\n`;
  msg += `  📋 Total raffles: <b>${stats.totalRaffles}</b>\n`;
  msg += `  🟢 Active: <b>${stats.activeRaffles}</b>\n`;
  msg += `  🏆 Drawn: <b>${stats.drawnRaffles}</b>\n`;
  msg += `  👥 Unique participants: <b>${stats.uniqueParticipants}</b>\n`;
  msg += `  📊 Avg entries/raffle: <b>${stats.avgEntriesPerRaffle}</b>\n\n`;

  msg += `<b>Totals:</b>\n`;
  msg += `  📝 Entries: <b>${stats.totalEntries}</b>\n`;
  msg += `  🏆 Winners: <b>${stats.totalWinners}</b>\n\n`;

  msg += `<b>Last 7 days:</b>\n`;
  msg += `  📋 Raffles: <b>${stats.rafflesLast7Days}</b>\n`;
  msg += `  📝 Entries: <b>${stats.entriesLast7Days}</b>\n`;

  if (stats.topParticipants.length > 0) {
    msg += `\n<b>🔥 Most Active:</b>\n`;
    stats.topParticipants.forEach((p, i) => {
      msg += `  ${i + 1}. ${escapeHtml(p.name)} — ${p.count} entries\n`;
    });
  }

  if (stats.topWinners.length > 0) {
    msg += `\n<b>🏆 Top Winners:</b>\n`;
    stats.topWinners.forEach((w, i) => {
      msg += `  ${i + 1}. ${escapeHtml(w.name)} — ${w.count} win${w.count > 1 ? "s" : ""}\n`;
    });
  }

  await ctx.reply(msg, { parse_mode: "HTML" });
}

function accessModeLabel(mode: db.GroupAccessMode): string {
  if (mode === "owner_only") return "Owner Only";
  if (mode === "selected_admins") return "Selected Admins";
  return "All Admins";
}

function buildAccessSettingsKeyboard(
  chatId: number,
  mode: db.GroupAccessMode
): InlineKeyboard {
  const selected = (value: db.GroupAccessMode) => value === mode ? " ✓" : "";
  const keyboard = new InlineKeyboard()
    .text(`All Admins${selected("all_admins")}`, `access_mode_${chatId}_all_admins`).row()
    .text(`Owner Only${selected("owner_only")}`, `access_mode_${chatId}_owner_only`).row()
    .text(`Selected Admins${selected("selected_admins")}`, `access_mode_${chatId}_selected_admins`).row();
  if (mode === "selected_admins") {
    keyboard.text("Choose Allowed Admins", `access_select_${chatId}`).row();
  }
  return keyboard.text("Close", "access_close");
}

async function showAccessSettingsForChat(
  ctx: Context,
  chatId: number,
  edit = false
): Promise<void> {
  if (!ctx.from || !(await isGroupOwner(ctx.api, chatId, ctx.from.id))) {
    const message = "Only the Telegram group owner can change Admin Access.";
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: message, show_alert: true });
    } else {
      await ctx.reply(message);
    }
    return;
  }

  const mode = db.getGroupAccessMode(chatId);
  const selectedCount = db.getSelectedGroupAdminIds(chatId).length;
  const group = db.getBotGroup(chatId);
  const text =
    `🔐 <b>Admin Access: ${escapeHtml(group?.title || "Group")}</b>\n\n` +
    `Current setting: <b>${accessModeLabel(mode)}</b>\n` +
    (mode === "selected_admins"
      ? `Allowed administrators: <b>${selectedCount}</b>\n\n`
      : "\n") +
    `<b>All Admins</b> lets every Telegram administrator manage the bot.\n` +
    `<b>Owner Only</b> restricts management to the group owner.\n` +
    `<b>Selected Admins</b> lets the owner approve specific administrators.\n\n` +
    `<i>The group owner always retains access.</i>`;
  const options = {
    parse_mode: "HTML" as const,
    reply_markup: buildAccessSettingsKeyboard(chatId, mode),
  };
  if (edit) await ctx.editMessageText(text, options);
  else await ctx.reply(text, options);
}

async function showSelectedAdminsForChat(ctx: Context, chatId: number): Promise<void> {
  if (!ctx.from || !(await isGroupOwner(ctx.api, chatId, ctx.from.id))) {
    await ctx.answerCallbackQuery({
      text: "Only the Telegram group owner can choose allowed admins.",
      show_alert: true,
    });
    return;
  }

  let administrators: Awaited<ReturnType<typeof ctx.api.getChatAdministrators>>;
  try {
    administrators = await ctx.api.getChatAdministrators(chatId);
  } catch {
    await ctx.editMessageText(
      "I couldn't load this group's administrator list. Check the bot's permissions and try again."
    );
    return;
  }
  const selectable = administrators.filter(
    (member) => member.status === "administrator" && !member.user.is_bot
  );
  const allowed = new Set(db.getSelectedGroupAdminIds(chatId));
  const keyboard = new InlineKeyboard();
  for (const member of selectable) {
    const name = member.user.username
      ? `@${member.user.username}`
      : getUserDisplayName(member.user.first_name, member.user.last_name);
    keyboard
      .text(`${allowed.has(member.user.id) ? "✓ " : ""}${name}`.slice(0, 40), `access_toggle_${chatId}_${member.user.id}`)
      .row();
  }
  keyboard.text("Back", `access_back_${chatId}`);

  const text = selectable.length > 0
    ? `<b>Choose Allowed Admins</b>\n\nTap an administrator to allow or remove their bot-management access.`
    : `<b>Choose Allowed Admins</b>\n\nNo other human administrators are currently available.`;
  await ctx.editMessageText(text, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

export async function handleAccessCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  if (data === "access_close") {
    await ctx.answerCallbackQuery();
    try { await ctx.deleteMessage(); } catch {}
    return;
  }

  const modeMatch = data.match(/^access_mode_(-?\d+)_(all_admins|owner_only|selected_admins)$/);
  if (modeMatch) {
    const chatId = parseInt(modeMatch[1], 10);
    if (!(await isGroupOwner(ctx.api, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only the group owner can change this setting.", show_alert: true });
      return;
    }
    const mode = modeMatch[2] as db.GroupAccessMode;
    db.setGroupAccessMode(chatId, mode);
    await ctx.answerCallbackQuery({ text: `Access set to ${accessModeLabel(mode)}.` });
    if (mode === "selected_admins") await showSelectedAdminsForChat(ctx, chatId);
    else await showAccessSettingsForChat(ctx, chatId, true);
    return;
  }

  const selectMatch = data.match(/^access_select_(-?\d+)$/);
  if (selectMatch) {
    await ctx.answerCallbackQuery();
    await showSelectedAdminsForChat(ctx, parseInt(selectMatch[1], 10));
    return;
  }

  const toggleMatch = data.match(/^access_toggle_(-?\d+)_(\d+)$/);
  if (toggleMatch) {
    const chatId = parseInt(toggleMatch[1], 10);
    const targetUserId = parseInt(toggleMatch[2], 10);
    if (!(await isGroupOwner(ctx.api, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "Only the group owner can choose allowed admins.", show_alert: true });
      return;
    }
    let administrators: Awaited<ReturnType<typeof ctx.api.getChatAdministrators>>;
    try {
      administrators = await ctx.api.getChatAdministrators(chatId);
    } catch {
      await ctx.answerCallbackQuery({ text: "I couldn't refresh the administrator list.", show_alert: true });
      return;
    }
    const target = administrators.find(
      (member) => member.status === "administrator" && member.user.id === targetUserId && !member.user.is_bot
    );
    if (!target) {
      await ctx.answerCallbackQuery({ text: "That user is no longer a group administrator.", show_alert: true });
      return;
    }
    const currentlyAllowed = db.isSelectedGroupAdmin(chatId, targetUserId);
    db.setSelectedGroupAdmin(chatId, targetUserId, !currentlyAllowed, ctx.from.id);
    await ctx.answerCallbackQuery({ text: currentlyAllowed ? "Admin access removed." : "Admin access allowed." });
    await showSelectedAdminsForChat(ctx, chatId);
    return;
  }

  const backMatch = data.match(/^access_back_(-?\d+)$/);
  if (backMatch) {
    await ctx.answerCallbackQuery();
    await showAccessSettingsForChat(ctx, parseInt(backMatch[1], 10), true);
  }
}

function formatGroupDefaults(chatId: number): string {
  const d = db.getGroupDefaults(chatId);
  const line = (label: string, value: string) => `  ${label}: <b>${escapeHtml(value)}</b>\n`;
  let msg = `⚙️ <b>Group Raffle Defaults</b>\n\n`;
  msg += line("Raffle destination", d?.thread_id ? (d.thread_name || "Saved raffle topic") : "General (not set)");
  msg += line("Winners", d?.max_winners ? String(d.max_winners) : "ask each time");
  msg += line("Duration", d?.duration_minutes ? formatDurationHuman(d.duration_minutes * 60000) : "ask each time");
  msg += line("Max entries", d?.max_entries ? String(d.max_entries) : "no default");
  msg += line("Hidden entries", d?.anonymous === null || d?.anonymous === undefined ? "ask/default off" : d.anonymous ? "on" : "off");
  msg += line("Auto-pin", d?.auto_pin === null || d?.auto_pin === undefined ? "ask/default off" : d.auto_pin ? "on" : "off");
  msg += line("Username required", d?.require_username ? "yes" : "no");
  msg += line("Min account age", d?.min_account_age_days ? `${d.min_account_age_days}d` : "off");
  msg += line("Winner cooldown", d?.winner_cooldown ? String(d.winner_cooldown) : "off");
  msg += line("Animation", d?.show_animation === 0 ? "off" : "on");
  msg += line("Referrals", d?.referral_enabled ? `on (${d.max_referral_entries ? `max ${d.max_referral_entries}` : "unlimited"})` : "off");
  msg += line("Revoke referral links", d?.revoke_referral_links ? "yes" : "no");
  msg += `\n<i>Tap a button to change a default. These apply to new raffle wizards in this group.</i>`;
  return msg;
}

function buildDefaultsKeyboard(chatId: number): InlineKeyboard {
  const callback = (action: string) => `def_${chatId}_${action}`;
  const savedTopicName = db.getGroupDefaults(chatId)?.thread_name?.trim();
  const topicCharacters = Array.from(savedTopicName || "");
  const displayedTopicName = topicCharacters.length > 44
    ? `${topicCharacters.slice(0, 43).join("")}…`
    : savedTopicName;
  const topicButtonLabel = displayedTopicName
    ? `📍 Topic: ${displayedTopicName}`
    : "📍 Set Raffle Topic";
  return new InlineKeyboard()
    .text(topicButtonLabel, callback("pick_topic")).text("🧹 Clear Topic", callback("clear_topic")).row()
    .text("🏆 Winners", callback("pick_winners")).text("⏰ Duration", callback("pick_duration")).row()
    .text("👥 Max Entries", callback("pick_max")).row()
    .text("👁 Toggle Hidden", callback("toggle_anon")).text("📌 Toggle Pin", callback("toggle_pin")).row()
    .text("📛 Toggle Username", callback("toggle_user")).text("🎡 Toggle Animation", callback("toggle_anim")).row()
    .text("📅 Min Age", callback("pick_age")).text("🛡 Cooldown", callback("pick_cooldown")).row()
    .text("🔗 Referrals", callback("pick_referrals")).text("🗑 Toggle Revoke", callback("toggle_revoke")).row()
    .text("♻️ Clear Defaults", callback("clear")).text("❌ Close", callback("close"));
}

async function showDefaultsForChat(ctx: Context, chatId: number): Promise<void> {
  await ctx.reply(formatGroupDefaults(chatId), {
    parse_mode: "HTML",
    reply_markup: buildDefaultsKeyboard(chatId),
  });
}

export async function handleDefaults(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "defaults");
    return;
  }
  const userId = ctx.from!.id;
  if (!(await isAdminOfChat(ctx, ctx.chat.id, userId))) {
    await replyPrivately(ctx, "Only group admins can manage defaults.");
    return;
  }
  await showDefaultsForChat(ctx, ctx.chat.id);
}

export async function handleDefaultsCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;
  const match = data.match(/^def_(-?\d+)_(.+)$/);
  if (!match) return;
  const chatId = parseInt(match[1], 10);
  const action = match[2];
  if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Only group admins can manage defaults.", show_alert: true });
    return;
  }

  const current = db.getGroupDefaults(chatId);
  const update = (fields: Record<string, string | number | null>) => {
    db.upsertGroupDefaults(chatId, fields as Parameters<typeof db.upsertGroupDefaults>[1]);
  };

  await ctx.answerCallbackQuery();

  const picker = async (text: string, kb: InlineKeyboard) =>
    ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  const callback = (name: string) => `def_${chatId}_${name}`;

  if (action === "close") {
    try { await ctx.deleteMessage(); } catch {}
    return;
  }
  if (action === "clear") {
    db.clearGroupDefaults(chatId);
  } else if (action === "pick_topic") {
    const group = db.getBotGroup(chatId);
    await picker(
      buildDefaultTopicSetupText(group?.title || "this group", current?.thread_name),
      new InlineKeyboard()
        .text("🧹 Clear Saved Topic", callback("clear_topic"))
        .row()
        .text("⬅️ Back", callback("back"))
    );
    return;
  } else if (action === "clear_topic") {
    update({ thread_id: null, thread_name: null });
  } else if (action === "pick_winners") {
    await picker("🏆 <b>Default winners</b>", new InlineKeyboard()
      .text("Ask", callback("winners_null")).text("1", callback("winners_1")).text("2", callback("winners_2")).row()
      .text("3", callback("winners_3")).text("5", callback("winners_5")).text("10", callback("winners_10")).row()
      .text("⬅️ Back", callback("back")));
    return;
  } else if (action.startsWith("winners_")) {
    const val = action.replace("winners_", "");
    update({ max_winners: val === "null" ? null : parseInt(val, 10) });
  } else if (action === "pick_duration") {
    await picker("⏰ <b>Default duration</b>", new InlineKeyboard()
      .text("Ask", callback("duration_null")).text("30m", callback("duration_30")).text("1h", callback("duration_60")).row()
      .text("6h", callback("duration_360")).text("1d", callback("duration_1440")).text("7d", callback("duration_10080")).row()
      .text("⬅️ Back", callback("back")));
    return;
  } else if (action.startsWith("duration_")) {
    const val = action.replace("duration_", "");
    update({ duration_minutes: val === "null" ? null : parseInt(val, 10) });
  } else if (action === "pick_max") {
    await picker("👥 <b>Default max entries</b>", new InlineKeyboard()
      .text("None", callback("max_null")).text("50", callback("max_50")).text("100", callback("max_100")).row()
      .text("250", callback("max_250")).text("500", callback("max_500")).text("1000", callback("max_1000")).row()
      .text("⬅️ Back", callback("back")));
    return;
  } else if (action.startsWith("max_")) {
    const val = action.replace("max_", "");
    update({ max_entries: val === "null" ? null : parseInt(val, 10) });
  } else if (action === "toggle_anon") {
    update({ anonymous: current?.anonymous ? 0 : 1 });
  } else if (action === "toggle_pin") {
    update({ auto_pin: current?.auto_pin ? 0 : 1 });
  } else if (action === "toggle_user") {
    update({ require_username: current?.require_username ? 0 : 1 });
  } else if (action === "toggle_anim") {
    update({ show_animation: current?.show_animation === 0 ? 1 : 0 });
  } else if (action === "pick_age") {
    await picker("📅 <b>Default minimum account age</b>", new InlineKeyboard()
      .text("Off", callback("age_0")).text("7d", callback("age_7")).text("30d", callback("age_30")).row()
      .text("90d", callback("age_90")).text("180d", callback("age_180")).row()
      .text("⬅️ Back", callback("back")));
    return;
  } else if (action.startsWith("age_")) {
    update({ min_account_age_days: parseInt(action.replace("age_", ""), 10) });
  } else if (action === "pick_cooldown") {
    await picker("🛡 <b>Default winner cooldown</b>", new InlineKeyboard()
      .text("Off", callback("cooldown_0")).text("1", callback("cooldown_1")).text("3", callback("cooldown_3")).row()
      .text("5", callback("cooldown_5")).text("10", callback("cooldown_10")).row()
      .text("⬅️ Back", callback("back")));
    return;
  } else if (action.startsWith("cooldown_")) {
    update({ winner_cooldown: parseInt(action.replace("cooldown_", ""), 10) });
  } else if (action === "pick_referrals") {
    await picker("🔗 <b>Default referrals</b>", new InlineKeyboard()
      .text("Off", callback("ref_0")).text("Unlimited", callback("ref_on_0")).row()
      .text("Max 5", callback("ref_on_5")).text("Max 10", callback("ref_on_10")).row()
      .text("⬅️ Back", callback("back")));
    return;
  } else if (action === "ref_0") {
    update({ referral_enabled: 0, max_referral_entries: 0 });
  } else if (action.startsWith("ref_on_")) {
    update({ referral_enabled: 1, max_referral_entries: parseInt(action.replace("ref_on_", ""), 10) });
  } else if (action === "toggle_revoke") {
    update({ revoke_referral_links: current?.revoke_referral_links ? 0 : 1 });
  }

  await ctx.editMessageText(formatGroupDefaults(chatId), {
    parse_mode: "HTML",
    reply_markup: buildDefaultsKeyboard(chatId),
  });
}

export async function handleSetupCheck(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "setup");
    return;
  }
  if (!(await isAdminOfChat(ctx, ctx.chat.id, ctx.from!.id))) {
    await replyPrivately(ctx, "Only group admins can run setup checks.");
    return;
  }
  await showSetupCheckForChat(ctx, ctx.chat.id);
}

async function showSetupCheckForChat(ctx: Context, chatId: number): Promise<void> {
  let msg = `🧪 <b>Raffle Bot Setup Check</b>\n\n`;
  try {
    const member = await ctx.api.getChatMember(chatId, ctx.me.id);
    const admin = member.status === "administrator";
    msg += `Admin status: ${admin ? "✅ administrator" : "⚠️ not admin"}\n`;
    if (member.status === "administrator") {
      msg += `Delete messages: ${member.can_delete_messages ? "✅" : "⚠️ missing"}\n`;
      msg += `Invite links: ${member.can_invite_users ? "✅" : "⚠️ missing"}\n`;
      msg += `Pin messages: ${member.can_pin_messages ? "✅" : "⚠️ missing"}\n`;
      msg += `Manage chat: ${member.can_manage_chat ? "✅" : "⚠️ missing"}\n`;
    }
  } catch {
    msg += `Admin status: ⚠️ could not verify\n`;
  }
  msg += `\nTimezone: <code>${escapeHtml(db.getChatTimezone(chatId))}</code>\n`;
  msg += `Language: <code>${escapeHtml(db.getChatLanguage(chatId))}</code>\n`;
  msg += `Open raffles: <b>${db.getOpenRafflesForChat(chatId).length}</b>\n`;
  msg += `Templates: <b>${db.getTemplatesForChat(chatId).length}</b>\n`;
  msg += `\n<i>If any permission is missing, promote the bot again with the requested rights.</i>`;
  await ctx.reply(msg, { parse_mode: "HTML" });
}

export async function handleReferrals(ctx: Context): Promise<void> {
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await showAdminGroupPicker(ctx, false, "referrals");
    return;
  }
  if (!(await isAdminOfChat(ctx, ctx.chat.id, ctx.from!.id))) {
    await replyPrivately(ctx, "Only group admins can view referral stats.");
    return;
  }
  await showReferralsForChat(ctx, ctx.chat.id);
}

async function showReferralsForChat(ctx: Context, chatId: number): Promise<void> {
  const raffles = db.getOpenRafflesForChat(chatId).filter((r) => r.referral_enabled);
  if (raffles.length === 0) {
    await ctx.reply("No active referral raffles in this group.");
    return;
  }
  const kb = new InlineKeyboard();
  for (const r of raffles.slice(0, 20)) {
    kb.text(r.title.slice(0, 32), `refdash_${chatId}_${r.id}`).row();
  }
  await ctx.reply(`🔗 <b>Referral Raffles</b>\n\nPick a raffle to view this group's referral stats:`, {
    parse_mode: "HTML",
    reply_markup: kb,
  });
}

export async function handleReferralsCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;
  const match = data.match(/^refdash_(-?\d+)_(\d+)$/);
  if (!match) return;
  const chatId = parseInt(match[1], 10);
  const raffleId = parseInt(match[2], 10);

  if (!(await isAdminOfChat(ctx, chatId, ctx.from.id))) {
    await ctx.answerCallbackQuery({ text: "Only group admins can view referral stats.", show_alert: true });
    return;
  }
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.chat_id !== chatId || !raffle.referral_enabled) {
    await ctx.answerCallbackQuery({ text: "Referral raffle not found in this group.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const links = db.getReferralLinksForRaffle(raffleId);
  let msg = `🔗 <b>Referral Stats: ${escapeHtml(raffle.title)}</b>\n\n`;
  msg += `Participants: <b>${db.getEntryCount(raffleId)}</b>\n`;
  msg += `Effective entries: <b>${db.getTotalEntryCount(raffleId)}</b>\n`;
  msg += `Links created: <b>${links.length}</b>\n`;
  msg += `Bonus entries: <b>${links.reduce((s, l) => s + l.bonus_entries, 0)}</b>\n\n`;
  const leaders = links.filter((l) => l.bonus_entries > 0).slice(0, 15);
  if (leaders.length === 0) {
    msg += `<i>No successful referrals yet.</i>`;
  } else {
    msg += `<b>Leaderboard</b>\n`;
    leaders.forEach((l, i) => {
      msg += `${i + 1}. ${escapeHtml(l.user_display_name)} — <b>${l.bonus_entries}</b>\n`;
    });
  }
  await ctx.editMessageText(msg, { parse_mode: "HTML" });
}

// /bugreport — Start a bug report (works anywhere)
export async function handleBugReport(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const chatId = ctx.chat?.id || ctx.from.id;
  let chatTitle = "Direct Message";
  if (ctx.chat && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
    try {
      const chat = await ctx.api.getChat(chatId);
      if ("title" in chat) chatTitle = chat.title || chatTitle;
    } catch {}
  }

  const started = await startBugReport(ctx, chatId, chatTitle);
  if (started) {
    if (ctx.chat?.type !== "private") {
      const notice = await ctx.reply(
        `📋 Check your DMs @${ctx.from.username || ctx.from.first_name} — bug report form is there.`
      );
      setTimeout(async () => {
        try {
          await ctx.api.deleteMessage(chatId, notice.message_id);
        } catch {}
      }, 5000);
    }
  } else {
    const botInfo = await ctx.api.getMe();
    const kb = new InlineKeyboard().url(
      "Start a DM with me",
      `https://t.me/${botInfo.username}?start=help`
    );
    await ctx.reply(
      `I need to collect your bug report in a DM.\n\nTap below to start a conversation with me, then try /bugreport again.`,
      { reply_markup: kb }
    );
  }
}

// Re-export for use in index.ts auto-draw
export { updateRafflePost };
