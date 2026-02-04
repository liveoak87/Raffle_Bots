import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import * as db from "./database";
import {
  getUserDisplayName,
  formatRaffleMessage,
  escapeHtml,
  isGroupAdmin,
  parseEndTime,
} from "./helpers";

interface WizardState {
  step: "title" | "prize" | "winners" | "time" | "time_custom" | "require" | "sponsor";
  /** The group chat where the raffle will be posted */
  targetChatId: number;
  targetChatTitle: string;
  /** The admin's private chat ID (where the wizard runs) */
  dmChatId: number;
  userId: number;
  title?: string;
  prizes?: string[];
  maxWinners?: number;
  endsAt?: string | null;
  requiredChatId?: number | null;
  requiredChatTitle?: string | null;
  sponsorName?: string | null;
  createdAt: number;
}

// Active wizards keyed by `userId` (one wizard per user at a time)
const wizards = new Map<number, WizardState>();

// Clean up stale wizards older than 30 minutes of inactivity
const WIZARD_TIMEOUT = 30 * 60 * 1000;

function cleanStaleWizards(): void {
  const now = Date.now();
  for (const [key, state] of wizards) {
    if (now - state.createdAt > WIZARD_TIMEOUT) {
      wizards.delete(key);
    }
  }
}

export function getActiveWizard(userId: number): WizardState | undefined {
  cleanStaleWizards();
  const state = wizards.get(userId);
  if (state) {
    // Reset inactivity timer on each interaction
    state.createdAt = Date.now();
  }
  return state;
}

export function cancelWizard(userId: number): void {
  wizards.delete(userId);
}

/**
 * Start the wizard. Called from /newraffle in a group.
 * Tries to DM the admin. If it works, the wizard runs in DMs.
 */
export async function startWizard(ctx: Context): Promise<void> {
  const groupChatId = ctx.chat!.id;
  const groupTitle = ctx.chat!.title || "this group";
  const userId = ctx.from!.id;

  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await ctx.reply("Only group admins can create raffles.");
    return;
  }

  // Try to DM the admin
  try {
    const dmMsg = await ctx.api.sendMessage(
      userId,
      `📝 <b>Create a Raffle</b> for <b>${escapeHtml(groupTitle)}</b>\n\n` +
        `Step 1 of 5: What's the <b>title</b> of your raffle?\n\n` +
        `<i>Just type it and send. Or /cancel to stop.</i>`,
      { parse_mode: "HTML" }
    );

    // Store wizard state keyed by user
    wizards.set(userId, {
      step: "title",
      targetChatId: groupChatId,
      targetChatTitle: groupTitle,
      dmChatId: dmMsg.chat.id,
      userId,
      createdAt: Date.now(),
    });

    // Send a brief note in the group that disappears
    const notice = await ctx.reply(
      `📝 Check your DMs @${ctx.from!.username || ctx.from!.first_name} — I sent you the raffle setup there.`
    );
    // Auto-delete the notice after 5 seconds
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(groupChatId, notice.message_id);
      } catch {
        // Ignore
      }
    }, 5000);
  } catch {
    // DM failed — user hasn't started the bot yet
    const botInfo = await ctx.api.getMe();
    const keyboard = new InlineKeyboard().url(
      "Start a DM with me",
      `https://t.me/${botInfo.username}?start=newraffle_${groupChatId}`
    );

    const fallback = await ctx.reply(
      `I need to set up the raffle in a private message so the group stays clean.\n\n` +
        `Tap the button below to start a DM with me, then come back and try /newraffle again.`,
      { reply_markup: keyboard }
    );
    // Auto-delete after 15 seconds
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(groupChatId, fallback.message_id);
      } catch {}
    }, 15000);
  }
}

/**
 * Handle /start in private chat with a deep link for raffle creation.
 * e.g., /start newraffle_-1001234567890
 */
export async function handleStartDeepLink(
  ctx: Context,
  payload: string
): Promise<boolean> {
  const match = payload.match(/^newraffle_(-?\d+)$/);
  if (!match) return false;

  const groupChatId = parseInt(match[1], 10);
  const userId = ctx.from!.id;

  // Verify user is admin in that group
  try {
    const member = await ctx.api.getChatMember(groupChatId, userId);
    if (member.status !== "administrator" && member.status !== "creator") {
      await ctx.reply("You must be an admin in that group to create raffles.");
      return true;
    }
  } catch {
    await ctx.reply("I couldn't verify your admin status in that group.");
    return true;
  }

  let groupTitle = "the group";
  try {
    const chat = await ctx.api.getChat(groupChatId);
    if ("title" in chat) {
      groupTitle = chat.title || groupTitle;
    }
  } catch {
    // Use default
  }

  wizards.set(userId, {
    step: "title",
    targetChatId: groupChatId,
    targetChatTitle: groupTitle,
    dmChatId: ctx.chat!.id,
    userId,
    createdAt: Date.now(),
  });

  await ctx.reply(
    `📝 <b>Create a Raffle</b> for <b>${escapeHtml(groupTitle)}</b>\n\n` +
      `Step 1 of 5: What's the <b>title</b> of your raffle?\n\n` +
      `<i>Just type it and send. Or /cancel to stop.</i>`,
    { parse_mode: "HTML" }
  );

  return true;
}

/** Handle a text message in the bot's DMs during the wizard */
export async function handleWizardMessage(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.message?.text) return false;

  const state = getActiveWizard(ctx.from.id);
  if (!state) return false;

  const text = ctx.message.text.trim();

  // Allow cancellation at any step
  if (text.toLowerCase() === "/cancel") {
    cancelWizard(ctx.from.id);
    await ctx.reply("Raffle creation cancelled.");
    return true;
  }

  // Ignore other commands during wizard
  if (text.startsWith("/")) return false;

  switch (state.step) {
    case "title":
      return await handleTitleStep(ctx, state, text);
    case "prize":
      return await handlePrizeStep(ctx, state, text);
    case "time_custom":
      return await handleCustomTimeStep(ctx, state, text);
    case "require":
      return await handleRequireText(ctx, state, text);
    case "sponsor":
      return await handleSponsorText(ctx, state, text);
    default:
      return false;
  }
}

async function handleTitleStep(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  state.title = text;
  state.step = "prize";

  await ctx.reply(
    `✅ Title: <b>${escapeHtml(text)}</b>\n\n` +
      `Step 2 of 5: What's the <b>prize</b>?\n\n` +
      `Send one prize, or <b>multiple prizes separated by commas</b> for different winner positions.\n\n` +
      `Examples:\n` +
      `• <code>$50 Gift Card</code>\n` +
      `• <code>$100, $50, $25</code>`,
    { parse_mode: "HTML" }
  );
  return true;
}

async function handlePrizeStep(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  const prizes = text
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (prizes.length === 0) {
    await ctx.reply("Please enter at least one prize.");
    return true;
  }

  state.prizes = prizes;
  state.step = "winners";

  let prizeDisplay: string;
  if (prizes.length > 1) {
    prizeDisplay = prizes
      .map((p, i) => {
        const label = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        return `${label} ${escapeHtml(p)}`;
      })
      .join("\n");
  } else {
    prizeDisplay = `🎁 ${escapeHtml(prizes[0])}`;
  }

  const keyboard = new InlineKeyboard();

  if (prizes.length > 1) {
    keyboard
      .text(`${prizes.length} (match prizes)`, `wiz_winners_${prizes.length}`)
      .row();
    const options = [1, 2, 3, 5, 10].filter((n) => n !== prizes.length);
    for (const n of options.slice(0, 4)) {
      keyboard.text(`${n}`, `wiz_winners_${n}`);
    }
  } else {
    keyboard
      .text("1", "wiz_winners_1")
      .text("2", "wiz_winners_2")
      .text("3", "wiz_winners_3")
      .text("5", "wiz_winners_5")
      .text("10", "wiz_winners_10");
  }

  await ctx.reply(
    `✅ Prizes:\n${prizeDisplay}\n\n` +
      `Step 3 of 5: How many <b>winners</b>?`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
  return true;
}

export async function handleWinnersCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state || state.step !== "winners") {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  const num = parseInt(data.replace("wiz_winners_", ""), 10);
  if (isNaN(num) || num < 1) return;

  state.maxWinners = num;
  state.step = "time";

  await ctx.answerCallbackQuery();

  const keyboard = new InlineKeyboard()
    .text("15 min", "wiz_time_15m")
    .text("30 min", "wiz_time_30m")
    .text("1 hour", "wiz_time_1h")
    .row()
    .text("2 hours", "wiz_time_2h")
    .text("6 hours", "wiz_time_6h")
    .text("1 day", "wiz_time_1d")
    .row()
    .text("⏱ Custom time", "wiz_time_custom")
    .row()
    .text("No time limit", "wiz_time_none");

  await ctx.editMessageText(
    `✅ Winners: <b>${num}</b>\n\n` +
      `Step 4 of 5: Set a <b>time limit</b>?\n\n` +
      `The raffle will auto-draw when time runs out.`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

export async function handleTimeCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state || state.step !== "time") {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  const timeValue = data.replace("wiz_time_", "");

  if (timeValue === "custom") {
    state.step = "time_custom";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `⏱ <b>Custom Time Limit</b>\n\n` +
        `Type a duration like:\n` +
        `• <code>45m</code> — 45 minutes\n` +
        `• <code>3h</code> — 3 hours\n` +
        `• <code>12h</code> — 12 hours\n` +
        `• <code>2d</code> — 2 days\n` +
        `• <code>2025-12-31 23:59</code> — specific date/time (UTC)\n\n` +
        `<i>Or type /cancel to stop.</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (timeValue === "none") {
    state.endsAt = null;
  } else {
    const now = new Date();
    let ms = 0;
    switch (timeValue) {
      case "15m": ms = 15 * 60 * 1000; break;
      case "30m": ms = 30 * 60 * 1000; break;
      case "1h": ms = 60 * 60 * 1000; break;
      case "2h": ms = 2 * 60 * 60 * 1000; break;
      case "6h": ms = 6 * 60 * 60 * 1000; break;
      case "1d": ms = 24 * 60 * 60 * 1000; break;
    }
    const endDate = new Date(now.getTime() + ms);
    state.endsAt = endDate
      .toISOString()
      .replace("T", " ")
      .replace("Z", "")
      .split(".")[0];
  }

  state.step = "require";

  await ctx.answerCallbackQuery();

  const timeDisplay = timeValue === "none" ? "No limit (manual draw)" : timeValue;

  const keyboard = new InlineKeyboard()
    .text("No requirement", "wiz_require_none")
    .row()
    .text("Yes — I'll type the group ID", "wiz_require_yes");

  await ctx.editMessageText(
    `✅ Time limit: <b>${timeDisplay}</b>\n\n` +
      `Step 5 of 6: Require members to be in <b>another group</b> to enter?\n\n` +
      `<i>This blocks anyone who isn't a member of a specific group.</i>`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

export async function handleRequireCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state || state.step !== "require") {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  if (data === "wiz_require_none") {
    state.requiredChatId = null;
    state.requiredChatTitle = null;
    await promptSponsorStep(ctx, state);
  } else if (data === "wiz_require_yes") {
    await ctx.editMessageText(
      `Type the group's <b>@username</b> or <b>chat ID</b>:\n\n` +
        `• <code>@VIPGroup</code>\n` +
        `• <code>-1001234567890</code>\n\n` +
        `💡 Use <code>/groupid</code> in the target group to find its ID.\n\n` +
        `<i>Type <code>skip</code> to skip.</i>`,
      { parse_mode: "HTML" }
    );
  }
}

async function handleCustomTimeStep(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  const parsed = parseEndTime(text);
  if (!parsed) {
    await ctx.reply(
      `Could not parse "<code>${escapeHtml(text)}</code>".\n\n` +
        `Use formats like: <code>45m</code>, <code>3h</code>, <code>2d</code>, or <code>2025-12-31 23:59</code>`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  state.endsAt = parsed
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .split(".")[0];

  state.step = "require";

  const keyboard = new InlineKeyboard()
    .text("No requirement", "wiz_require_none")
    .row()
    .text("Yes — I'll type the group ID", "wiz_require_yes");

  await ctx.reply(
    `✅ Time limit: <b>${escapeHtml(text)}</b>\n\n` +
      `Step 5 of 6: Require members to be in <b>another group</b> to enter?\n\n` +
      `<i>This blocks anyone who isn't a member of a specific group.</i>`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
  return true;
}

async function handleRequireText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip") {
    state.requiredChatId = null;
    state.requiredChatTitle = null;
    await promptSponsorStep(ctx, state);
    return true;
  }

  // Handle @username — resolve via Telegram API
  if (text.startsWith("@")) {
    try {
      const chat = await ctx.api.getChat(text);
      if ("id" in chat) {
        const title = ("title" in chat && chat.title) ? chat.title : text;
        state.requiredChatId = chat.id;
        state.requiredChatTitle = title;
        await ctx.reply(
          `✅ Found: <b>${escapeHtml(title)}</b>`,
          { parse_mode: "HTML" }
        );
        await promptSponsorStep(ctx, state);
        return true;
      }
    } catch {
      await ctx.reply(
        `Could not find <b>${escapeHtml(text)}</b>. Make sure the username is correct and the group is public.\n\n` +
          `Or type <code>skip</code> to skip.`,
        { parse_mode: "HTML" }
      );
      return true;
    }
  }

  // Handle bare numeric ID or "ID name" format
  const matchWithName = text.match(/^(-?\d+)\s+(.+)$/);
  const matchBareId = text.match(/^(-?\d+)$/);

  if (matchWithName) {
    state.requiredChatId = parseInt(matchWithName[1], 10);
    state.requiredChatTitle = matchWithName[2].trim();
    await promptSponsorStep(ctx, state);
    return true;
  }

  if (matchBareId) {
    const chatId = parseInt(matchBareId[1], 10);
    let title = `Group ${chatId}`;
    try {
      const chat = await ctx.api.getChat(chatId);
      if ("title" in chat && chat.title) title = chat.title;
    } catch {
      // Can't resolve — use generic name
    }
    state.requiredChatId = chatId;
    state.requiredChatTitle = title;
    await ctx.reply(
      `✅ Set: <b>${escapeHtml(title)}</b>`,
      { parse_mode: "HTML" }
    );
    await promptSponsorStep(ctx, state);
    return true;
  }

  await ctx.reply(
    `Type a <b>@username</b> or <b>chat ID</b>.\n\nOr type <code>skip</code> to skip.`,
    { parse_mode: "HTML" }
  );
  return true;
}

async function promptSponsorStep(
  ctx: Context,
  state: WizardState
): Promise<void> {
  state.step = "sponsor";

  const keyboard = new InlineKeyboard()
    .text("No sponsor", "wiz_sponsor_none")
    .row()
    .text("Yes — I'll type the name", "wiz_sponsor_yes");

  await ctx.reply(
    `Step 6 of 6: Add a <b>sponsor</b> to this raffle?\n\n` +
      `<i>The sponsor's name will be displayed on the raffle post.</i>`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

export async function handleSponsorCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state || state.step !== "sponsor") {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  if (data === "wiz_sponsor_none") {
    state.sponsorName = null;
    await createRaffleFromWizard(ctx, state);
  } else if (data === "wiz_sponsor_yes") {
    await ctx.editMessageText(
      `Type the <b>sponsor name</b>:\n\n` +
        `Examples:\n` +
        `• <code>RedBeard Peptides</code>\n` +
        `• <code>@SponsorUsername</code>\n\n` +
        `<i>Or type <code>skip</code> to skip.</i>`,
      { parse_mode: "HTML" }
    );
  }
}

async function handleSponsorText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip") {
    state.sponsorName = null;
  } else {
    state.sponsorName = text;
  }
  await createRaffleFromWizard(ctx, state);
  return true;
}

// --- Create the raffle and post it to the group ---

async function createRaffleFromWizard(
  ctx: Context,
  state: WizardState
): Promise<void> {
  const displayName = getUserDisplayName(
    ctx.from!.first_name,
    ctx.from!.last_name
  );

  const prizes = state.prizes || ["Prize"];
  const singlePrize = prizes[0];
  const prizesJson = prizes.length > 1 ? JSON.stringify(prizes) : null;

  const raffle = db.createRaffle({
    chat_id: state.targetChatId,
    creator_id: state.userId,
    creator_name: displayName,
    title: state.title || "Raffle",
    description: "",
    prize: singlePrize,
    prizes: prizesJson,
    max_entries: null,
    max_winners: state.maxWinners || 1,
    ends_at: state.endsAt || null,
    required_chat_id: state.requiredChatId || null,
    required_chat_title: state.requiredChatTitle || null,
    sponsor_name: state.sponsorName || null,
  });

  cancelWizard(state.userId);

  const keyboard = new InlineKeyboard()
    .text("🎟 Enter Raffle", `enter_${raffle.id}`)
    .text("❌ Leave", `leave_${raffle.id}`)
    .row()
    .text(`👥 Entries (0)`, `entries_${raffle.id}`);

  // Post the raffle to the GROUP (not the DM)
  const msg = await ctx.api.sendMessage(
    state.targetChatId,
    formatRaffleMessage(raffle, 0),
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );

  db.updateRaffleMessageId(raffle.id, msg.message_id);

  // Confirm to the admin in DMs
  await ctx.reply(
    `✅ Raffle <b>${escapeHtml(raffle.title)}</b> has been posted to <b>${escapeHtml(state.targetChatTitle)}</b>!`,
    { parse_mode: "HTML" }
  );
}
