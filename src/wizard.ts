import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import * as db from "./database";
import {
  getUserDisplayName,
  formatRaffleMessage,
  escapeHtml,
  isGroupAdmin,
  parseEndTime,
  formatCountdown,
  buildRaffleKeyboard,
} from "./helpers";
import { t } from "./i18n";
import { sendCustomImage, sendRafflePost } from "./banners";
import { formatInTimezone } from "./timezone";

interface WizardState {
  step:
    | "title"
    | "prize"
    | "winners"
    | "winners_custom"
    | "time"
    | "time_custom"
    | "options"
    | "options_sponsor"
    | "options_image"
    | "options_scheduled"
    | "options_scheduled_time"
    | "options_scheduled_custom_date"
    | "options_scheduled_custom_time"
    | "options_scheduled_cal"
    | "options_scheduled_hour"
    | "options_scheduled_min"
    | "options_scheduled_tz"
    | "options_minage"
    | "options_cooldown"
    | "options_referral_max";
  targetChatId: number;
  targetThreadId: number | null;
  targetChatTitle: string;
  dmChatId: number;
  userId: number;
  title?: string;
  prizes?: string[];
  maxWinners?: number;
  endsAt?: string | null;
  sponsorName?: string | null;
  anonymous?: boolean;
  imageFileId?: string | null;
  startsAt?: string | null;
  /** Date chosen in the picker before time is selected (YYYY-MM-DD in chat's timezone) */
  scheduledDate?: string;
  /** Hour chosen in the clock picker (0-23, in scheduledTimezone) */
  scheduledHour?: number;
  /**
   * Timezone the user is currently building the schedule in.
   * Defaults to the chat's stored timezone, but can be overridden per-raffle via the wizard.
   */
  scheduledTimezone?: string;
  autoPin?: boolean;
  minAccountAgeDays?: number;
  requireUsername?: boolean;
  winnerCooldown?: number;
  showAnimation?: boolean;
  referralEnabled?: boolean;
  maxReferralEntries?: number;
  revokeReferralLinks?: boolean;
  createdAt: number;
}

const wizards = new Map<number, WizardState>();
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
    state.createdAt = Date.now();
  }
  return state;
}

export function cancelWizard(userId: number): void {
  wizards.delete(userId);
}

export async function startWizard(ctx: Context): Promise<void> {
  const groupChatId = ctx.chat!.id;
  const groupTitle = ctx.chat!.title || "this group";
  const userId = ctx.from!.id;

  const isAdmin = await isGroupAdmin(ctx, userId);
  if (!isAdmin) {
    await ctx.reply("Only group admins can create raffles.");
    return;
  }

  try {
    const dmMsg = await ctx.api.sendMessage(
      userId,
      `📝 <b>Create a Raffle</b> for <b>${escapeHtml(groupTitle)}</b>\n\n` +
        `Step 1 of 4: What's the <b>title</b> of your raffle?\n\n` +
        `<i>Just type it and send. Or /cancel to stop.</i>`,
      { parse_mode: "HTML" }
    );

    wizards.set(userId, {
      step: "title",
      targetChatId: groupChatId,
      targetThreadId: ctx.message?.message_thread_id ?? null,
      targetChatTitle: groupTitle,
      dmChatId: dmMsg.chat.id,
      userId,
      createdAt: Date.now(),
    });

    const notice = await ctx.reply(
      `📝 Check your DMs @${ctx.from!.username || ctx.from!.first_name} — I sent you the raffle setup there.`
    );
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(groupChatId, notice.message_id);
      } catch {}
    }, 5000);
  } catch {
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
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(groupChatId, fallback.message_id);
      } catch {}
    }, 15000);
  }
}

export async function handleStartDeepLink(
  ctx: Context,
  payload: string
): Promise<boolean> {
  // --- Referral link deep link: /start reflink_RAFFLEID ---
  const refMatch = payload.match(/^reflink_(\d+)$/);
  if (refMatch) {
    const raffleId = parseInt(refMatch[1], 10);
    const userId = ctx.from!.id;
    const displayName = getUserDisplayName(
      ctx.from!.first_name,
      ctx.from!.last_name
    );

    const raffle = db.getRaffleById(raffleId);
    if (!raffle || raffle.status !== "open") {
      await ctx.reply("This raffle is no longer open.");
      return true;
    }

    if (!raffle.referral_enabled) {
      await ctx.reply("Referrals are not enabled for this raffle.");
      return true;
    }

    // Check if user has entered the raffle
    if (!db.hasUserEntered(raffleId, userId)) {
      await ctx.reply(
        `You need to enter the raffle first before getting a referral link.\n\n` +
          `Go to the group and tap 🎟 <b>Enter Raffle</b> on <b>${escapeHtml(raffle.title)}</b>, then come back here.`,
        { parse_mode: "HTML" }
      );
      return true;
    }

    // Get or create the referral link
    let refLink = db.getReferralLink(raffleId, userId);
    if (!refLink) {
      try {
        const invite = await ctx.api.createChatInviteLink(raffle.chat_id, {
          name: `ref_${raffleId}_${userId}`,
          creates_join_request: false,
        });
        refLink = db.createReferralLink(
          raffleId,
          userId,
          displayName,
          raffle.chat_id,
          invite.invite_link
        );
      } catch {
        await ctx.reply("Failed to create your referral link. The bot may need admin permissions in the group.");
        return true;
      }
    }

    const capText = raffle.max_referral_entries > 0
      ? `(max ${raffle.max_referral_entries} bonus entries)`
      : "(no limit)";

    await ctx.reply(
      `🔗 <b>Referral Link — ${escapeHtml(raffle.title)}</b>\n\n` +
        `Share this link to earn <b>bonus entries</b>! Each person who joins the group ` +
        `through your link gives you +1 extra chance to win ${capText}.\n\n` +
        `Your link:\n${refLink.invite_link}`,
      { parse_mode: "HTML" }
    );

    return true;
  }

  // --- Template creation deep link: /start tmpl_CHATID ---
  const tmplMatch = payload.match(/^tmpl_(-?\d+)$/);
  if (tmplMatch) {
    const groupChatId = parseInt(tmplMatch[1], 10);
    const userId = ctx.from!.id;

    try {
      const member = await ctx.api.getChatMember(groupChatId, userId);
      if (member.status !== "administrator" && member.status !== "creator") {
        await ctx.reply("You must be an admin in that group to create templates.");
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
    } catch {}

    templateWizards.set(userId, {
      step: "name",
      targetChatId: groupChatId,
      targetChatTitle: groupTitle,
      dmChatId: ctx.chat!.id,
      userId,
      createdAt: Date.now(),
    });

    await ctx.reply(
      `📋 <b>Create a Template</b> for <b>${escapeHtml(groupTitle)}</b>\n\n` +
        `Step 1 of 5: What's the <b>template name</b>?\n\n` +
        `<i>This is a short name to recall it later (e.g. "Weekly" or "Daily Prize").\nType /cancel to stop.</i>`,
      { parse_mode: "HTML" }
    );

    return true;
  }

  // --- Edit raffle deep link: /start editraffle_RAFFLEID_CHATID ---
  // Fired when the group's /editraffle showed the "Start a DM with me" button
  // because the bot couldn't DM the user yet. After they tap it and a DM exists,
  // open the edit wizard right here in the DM.
  const editMatch = payload.match(/^editraffle_(\d+)_(-?\d+)$/);
  if (editMatch) {
    const raffleId = parseInt(editMatch[1], 10);
    const groupChatId = parseInt(editMatch[2], 10);
    const userId = ctx.from!.id;

    const raffle = db.getRaffleById(raffleId);
    if (!raffle || raffle.chat_id !== groupChatId) {
      await ctx.reply("That raffle wasn't found.");
      return true;
    }
    if (raffle.status !== "open") {
      await ctx.reply("That raffle is no longer open — it can't be edited.");
      return true;
    }

    // Verify the user is still an admin of the source group
    try {
      const member = await ctx.api.getChatMember(groupChatId, userId);
      if (member.status !== "administrator" && member.status !== "creator") {
        await ctx.reply("You must be an admin of that group to edit its raffles.");
        return true;
      }
    } catch {
      await ctx.reply("I couldn't verify your admin status in that group.");
      return true;
    }

    // Set up the edit wizard state and reply right here in the DM
    editWizards.set(userId, {
      raffleId,
      chatId: groupChatId,
      dmChatId: ctx.chat!.id,
      userId,
      editingField: null,
      createdAt: Date.now(),
    });

    await ctx.reply(buildEditScreenText(raffle), {
      parse_mode: "HTML",
      reply_markup: buildEditScreenKeyboard(raffle),
    });
    return true;
  }

  // --- Raffle creation deep link: /start newraffle_CHATID ---
  const match = payload.match(/^newraffle_(-?\d+)$/);
  if (!match) return false;

  const groupChatId = parseInt(match[1], 10);
  const userId = ctx.from!.id;

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
  } catch {}

  wizards.set(userId, {
    step: "title",
    targetChatId: groupChatId,
    targetThreadId: null,
    targetChatTitle: groupTitle,
    dmChatId: ctx.chat!.id,
    userId,
    createdAt: Date.now(),
  });

  await ctx.reply(
    `📝 <b>Create a Raffle</b> for <b>${escapeHtml(groupTitle)}</b>\n\n` +
      `Step 1 of 4: What's the <b>title</b> of your raffle?\n\n` +
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

  if (text.toLowerCase() === "/cancel") {
    cancelWizard(ctx.from.id);
    await ctx.reply("Raffle creation cancelled.");
    return true;
  }

  if (text.startsWith("/")) return false;

  switch (state.step) {
    case "title":
      return await handleTitleStep(ctx, state, text);
    case "prize":
      return await handlePrizeStep(ctx, state, text);
    case "winners_custom":
      return await handleCustomWinnersStep(ctx, state, text);
    case "time_custom":
      return await handleCustomTimeStep(ctx, state, text);
    case "options_image":
      return await handleOptionsImageText(ctx, state, text);
    case "options_sponsor":
      return await handleOptionsSponsorText(ctx, state, text);
    case "options_scheduled_custom_date":
      return await handleCustomScheduledDateText(ctx, state, text);
    case "options_scheduled_custom_time":
      return await handleCustomScheduledTimeText(ctx, state, text);
    case "options_minage":
      return await handleOptionsMinAgeText(ctx, state, text);
    case "options_cooldown":
      return await handleOptionsCooldownText(ctx, state, text);
    case "options_referral_max":
      return await handleOptionsReferralMaxText(ctx, state, text);
    default:
      return false;
  }
}

/** Handle a photo message in the wizard (for image upload) */
export async function handleWizardPhoto(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.message?.photo) return false;

  const state = getActiveWizard(ctx.from.id);
  if (!state || state.step !== "options_image") return false;

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];
  state.imageFileId = largest.file_id;
  state.step = "options";

  await ctx.reply(`✅ Image added!`);
  await sendOptionsScreen(ctx, state);
  return true;
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
      `Step 2 of 4: What's the <b>prize</b>?\n\n` +
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
  }
  // 1-10 quick picks in two rows of 5
  keyboard
    .text("1", "wiz_winners_1")
    .text("2", "wiz_winners_2")
    .text("3", "wiz_winners_3")
    .text("4", "wiz_winners_4")
    .text("5", "wiz_winners_5")
    .row()
    .text("6", "wiz_winners_6")
    .text("7", "wiz_winners_7")
    .text("8", "wiz_winners_8")
    .text("9", "wiz_winners_9")
    .text("10", "wiz_winners_10")
    .row()
    .text("✏️ Custom (1-50)", "wiz_winners_custom");

  await ctx.reply(
    `✅ Prizes:\n${prizeDisplay}\n\n` +
      `Step 3 of 4: How many <b>winners</b>?`,
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
      `Step 4 of 4: Set a <b>time limit</b>?\n\n` +
      `The raffle will auto-draw when time runs out.`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

export async function handleWinnersCustomCallback(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state || state.step !== "winners") {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  state.step = "winners_custom";
  await ctx.answerCallbackQuery();

  const promptText =
    `✏️ <b>Custom number of winners</b>\n\n` +
    `Type a number between <b>1</b> and <b>50</b>, then press send.`;

  // Send a fresh message — more reliable than editing across all message types
  try {
    await ctx.reply(promptText, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Failed to send custom winners prompt:", err);
  }
}

async function handleCustomWinnersStep(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  const num = parseInt(text, 10);
  if (isNaN(num) || num < 1 || num > 50) {
    await ctx.reply("Please enter a number between <b>1</b> and <b>50</b>.", { parse_mode: "HTML" });
    return true;
  }

  state.maxWinners = num;
  state.step = "time";

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

  await ctx.reply(
    `✅ Winners: <b>${num}</b>\n\n` +
      `Step 4 of 4: Set a <b>time limit</b>?\n\n` +
      `The raffle will auto-draw when time runs out.`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
  return true;
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
        `• <code>2d</code> — 2 days\n\n` +
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

  await ctx.answerCallbackQuery();
  await sendOptionsScreen(ctx, state);
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
        `Use formats like: <code>45m</code>, <code>3h</code>, <code>2d</code>`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  state.endsAt = parsed
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .split(".")[0];

  await sendOptionsScreen(ctx, state);
  return true;
}

// --- Options screen ---

function buildOptionsText(state: WizardState): string {
  let msg = `⚙️ <b>Options</b> — tap to change, then Create:\n\n`;

  const sponsor = state.sponsorName
    ? `${escapeHtml(state.sponsorName)} ✅`
    : "None";
  msg += `💎 <b>Sponsor:</b> ${sponsor}\n`;

  msg += `👁 <b>Hidden entries:</b> ${state.anonymous ? "On ✅" : "Off"}\n`;

  msg += `🖼 <b>Image:</b> ${state.imageFileId ? "Added ✅" : "None"}\n`;

  if (state.startsAt) {
    const startsDate = new Date(state.startsAt + "Z");
    const tz = state.scheduledTimezone || db.getChatTimezone(state.targetChatId);
    const wall = formatInTimezone(startsDate, tz);
    msg += `🕐 <b>Delayed start:</b> ${formatCountdown(startsDate).replace(" remaining", "")} <i>(${escapeHtml(wall)})</i> ✅\n`;
  } else {
    msg += `🕐 <b>Delayed start:</b> Opens immediately\n`;
  }

  msg += `📌 <b>Auto-pin:</b> ${state.autoPin ? "On ✅" : "Off"}\n`;

  // Entry requirements
  if (state.requireUsername) {
    msg += `📛 <b>Require username:</b> Yes ✅\n`;
  }
  if (state.minAccountAgeDays && state.minAccountAgeDays > 0) {
    msg += `📅 <b>Min account age:</b> ${state.minAccountAgeDays} day${state.minAccountAgeDays > 1 ? "s" : ""} ✅\n`;
  }
  if (state.winnerCooldown && state.winnerCooldown > 0) {
    msg += `🛡 <b>Winner cooldown:</b> Last ${state.winnerCooldown} raffle${state.winnerCooldown > 1 ? "s" : ""} ✅\n`;
  }

  if (state.referralEnabled) {
    const cap = state.maxReferralEntries && state.maxReferralEntries > 0
      ? `max ${state.maxReferralEntries}`
      : "unlimited";
    msg += `🔗 <b>Referral entries:</b> On (${cap}) ✅\n`;
    msg += `🗑 <b>Revoke links on end:</b> ${state.revokeReferralLinks ? "On ✅" : "Off"}\n`;
  }

  return msg;
}

function buildOptionsKeyboard(state: WizardState): InlineKeyboard {
  const kb = new InlineKeyboard();

  kb.text(
    state.sponsorName ? "💎 Change Sponsor" : "💎 Set Sponsor",
    "wiz_opt_sponsor"
  );
  kb.text(
    state.anonymous ? "👁 Entries: Hidden" : "👁 Entries: Visible",
    "wiz_opt_anon"
  );
  kb.row();
  kb.text(
    state.imageFileId ? "🖼 Replace Image" : "🖼 Add Image",
    "wiz_opt_image"
  );
  kb.text(
    state.startsAt ? "🕐 Change Start" : "🕐 Delay Start",
    "wiz_opt_sched"
  );
  kb.row();
  // Timezone button — shows current TZ so admins know what their times will display in.
  // Tapping opens the same picker used by Delay Start.
  const effectiveTz = state.scheduledTimezone || db.getChatTimezone(state.targetChatId);
  kb.text(`🌐 Timezone: ${effectiveTz}`, "wiz_opt_tz");
  kb.row();
  kb.text(
    state.autoPin ? "📌 Pin: On" : "📌 Pin: Off",
    "wiz_opt_pin"
  );
  kb.row();
  kb.text(
    state.requireUsername ? "📛 Username: Required" : "📛 Username: Off",
    "wiz_opt_requser"
  );
  kb.text(
    state.minAccountAgeDays ? `📅 Age: ${state.minAccountAgeDays}d` : "📅 Min Age: Off",
    "wiz_opt_minage"
  );
  kb.row();
  kb.text(
    state.winnerCooldown ? `🛡 Cooldown: ${state.winnerCooldown}` : "🛡 Cooldown: Off",
    "wiz_opt_cooldown"
  );
  kb.text(
    state.showAnimation !== false ? "🎡 Animation: On" : "🎡 Animation: Off",
    "wiz_opt_animation"
  );
  kb.row();
  kb.text(
    state.referralEnabled ? "🔗 Referrals: On" : "🔗 Referrals: Off",
    "wiz_opt_referral"
  );
  if (state.referralEnabled) {
    kb.text(
      state.revokeReferralLinks ? "🗑 Revoke Links: On" : "🗑 Revoke Links: Off",
      "wiz_opt_revoke_links"
    );
  }
  kb.row();
  kb.text("✅ Create Raffle", "wiz_opt_create");

  return kb;
}

async function sendOptionsScreen(
  ctx: Context,
  state: WizardState
): Promise<void> {
  state.step = "options";
  await ctx.reply(buildOptionsText(state), {
    parse_mode: "HTML",
    reply_markup: buildOptionsKeyboard(state),
  });
}

/**
 * Handles the scheduled-start date/time picker callbacks:
 *   wiz_sched_date:<YYYY-MM-DD>  - date selected, show time picker
 *   wiz_sched_custom_date        - prompt for custom date text input
 *   wiz_sched_skip               - clear start time, return to options
 *   wiz_sched_time:<HH:MM>       - time selected (uses chat's timezone)
 *   wiz_sched_custom_time        - prompt for custom time text input
 */
/**
 * Handles the new calendar/clock/timezone picker callbacks (prefix `wsc:`):
 *   wsc:cal:<YYYY-MM>    - render calendar for that month
 *   wsc:day:<YYYY-MM-DD> - day selected, go to hour picker
 *   wsc:hour:<HH>        - hour selected, go to minute picker
 *   wsc:min:<MM>         - minute selected, compute UTC and finalize
 *   wsc:tz               - open timezone picker
 *   wsc:tz:<IANA>        - timezone selected, return to calendar
 *   wsc:back:cal         - back to calendar from time/tz pickers
 *   wsc:back:hour        - back to hour picker from minute picker
 *   wsc:skip             - skip scheduled start
 *   wsc:noop             - no-op (header/empty cells)
 *   wsc:past             - tapped a past date — show toast
 */
export async function handleCalendarPickerCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state) {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  // Default tz if somehow missing
  if (!state.scheduledTimezone) {
    state.scheduledTimezone = db.getChatTimezone(state.targetChatId);
  }

  if (data === "wsc:noop") {
    await ctx.answerCallbackQuery();
    return;
  }
  if (data === "wsc:past") {
    await ctx.answerCallbackQuery({ text: "That date is in the past — pick a future date.", show_alert: false });
    return;
  }

  await ctx.answerCallbackQuery();

  if (data === "wsc:skip") {
    state.startsAt = null;
    state.scheduledDate = undefined;
    state.scheduledHour = undefined;
    await sendOptionsScreen(ctx, state);
    return;
  }

  if (data === "wsc:tz") {
    await sendScheduledTimezonePicker(ctx, state);
    return;
  }

  if (data === "wsc:back:cal") {
    state.scheduledHour = undefined;
    await sendScheduledCalendar(ctx, state);
    return;
  }

  if (data === "wsc:back:hour") {
    await sendScheduledHourPicker(ctx, state);
    return;
  }

  // wsc:tz:<IANA>  (must check BEFORE wsc:tz prefix)
  const tzMatch = data.match(/^wsc:tz:(.+)$/);
  if (tzMatch) {
    const { resolveTimezone } = await import("./timezone");
    const resolved = resolveTimezone(tzMatch[1]);
    if (!resolved) {
      await ctx.reply(`Unknown timezone: ${tzMatch[1]}`);
      return;
    }
    state.scheduledTimezone = resolved;
    // After picking timezone, return to calendar (which will use the new tz)
    await sendScheduledCalendar(ctx, state);
    return;
  }

  // wsc:cal:<YYYY-MM>
  const calMatch = data.match(/^wsc:cal:(\d{4})-(\d{2})$/);
  if (calMatch) {
    await sendScheduledCalendar(ctx, state, parseInt(calMatch[1], 10), parseInt(calMatch[2], 10));
    return;
  }

  // wsc:day:<YYYY-MM-DD>
  const dayMatch = data.match(/^wsc:day:(\d{4}-\d{2}-\d{2})$/);
  if (dayMatch) {
    state.scheduledDate = dayMatch[1];
    state.scheduledHour = undefined;
    await sendScheduledHourPicker(ctx, state);
    return;
  }

  // wsc:hour:<HH>
  const hourMatch = data.match(/^wsc:hour:(\d{2})$/);
  if (hourMatch) {
    state.scheduledHour = parseInt(hourMatch[1], 10);
    await sendScheduledMinutePicker(ctx, state);
    return;
  }

  // wsc:min:<MM>
  const minMatch = data.match(/^wsc:min:(\d{2})$/);
  if (minMatch) {
    if (!state.scheduledDate || state.scheduledHour === undefined) {
      await sendScheduledCalendar(ctx, state);
      return;
    }
    const { buildUtcDateFromLocal } = await import("./timezone");
    const tz = state.scheduledTimezone || "UTC";
    const timeStr = `${String(state.scheduledHour).padStart(2, "0")}:${minMatch[1]}`;
    const utc = buildUtcDateFromLocal(state.scheduledDate, timeStr, tz);
    if (!utc) {
      await ctx.reply(`Could not compute start time for ${state.scheduledDate} ${timeStr} in ${tz}.`);
      return;
    }
    if (utc.getTime() <= Date.now()) {
      await ctx.reply(
        `That time has already passed in <code>${escapeHtml(tz)}</code>. Pick a future time.`,
        { parse_mode: "HTML" }
      );
      await sendScheduledHourPicker(ctx, state);
      return;
    }
    state.startsAt = utc.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    state.scheduledDate = undefined;
    state.scheduledHour = undefined;
    // Keep scheduledTimezone so subsequent edits reuse it
    await sendOptionsScreen(ctx, state);
    return;
  }

  // Unknown — silently ignore
}

export async function handleSchedPickerCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state) {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  if (data === "wiz_sched_skip") {
    state.startsAt = null;
    state.scheduledDate = undefined;
    await sendOptionsScreen(ctx, state);
    return;
  }

  if (data === "wiz_sched_custom_date") {
    state.step = "options_scheduled_custom_date";
    const tz = db.getChatTimezone(state.targetChatId);
    await ctx.editMessageText(
      `✏️ Type the <b>date</b> in <code>YYYY-MM-DD</code> format (e.g. <code>2026-12-31</code>).\n\n` +
        `<i>Group timezone: ${escapeHtml(tz)}</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (data === "wiz_sched_custom_time") {
    if (!state.scheduledDate) {
      await ctx.reply("Date wasn't selected. Try /newraffle again.");
      return;
    }
    state.step = "options_scheduled_custom_time";
    const tz = db.getChatTimezone(state.targetChatId);
    await ctx.editMessageText(
      `📅 Date: <b>${escapeHtml(state.scheduledDate)}</b>\n\n` +
        `✏️ Type the <b>time</b> in <code>HH:MM</code> (24h, e.g. <code>18:30</code>) or <code>H:MM AM/PM</code> (e.g. <code>6:30 PM</code>).\n\n` +
        `<i>Group timezone: ${escapeHtml(tz)}</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const dateMatch = data.match(/^wiz_sched_date:(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) {
    state.scheduledDate = dateMatch[1];
    await sendScheduledTimePicker(ctx, state);
    return;
  }

  const timeMatch = data.match(/^wiz_sched_time:(\d{2}:\d{2})$/);
  if (timeMatch) {
    if (!state.scheduledDate) {
      await ctx.reply("Date wasn't selected. Try /newraffle again.");
      return;
    }
    const { buildUtcDateFromLocal } = await import("./timezone");
    const tz = db.getChatTimezone(state.targetChatId);
    const utc = buildUtcDateFromLocal(state.scheduledDate, timeMatch[1], tz);
    if (!utc) {
      await ctx.reply(`Could not compute start time for ${state.scheduledDate} ${timeMatch[1]} in ${tz}.`);
      return;
    }
    if (utc.getTime() <= Date.now()) {
      await ctx.reply(
        `That time has already passed in <code>${escapeHtml(tz)}</code>. Pick a future time.`,
        { parse_mode: "HTML" }
      );
      // Re-show the time picker
      await sendScheduledTimePicker(ctx, state);
      return;
    }
    state.startsAt = utc.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
    state.scheduledDate = undefined;
    await sendOptionsScreen(ctx, state);
    return;
  }

  // Unknown — silently ignore
}

export async function handleOptionsCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveWizard(ctx.from.id);
  if (!state || !state.step.startsWith("options")) {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  switch (data) {
    case "wiz_opt_sponsor":
      state.step = "options_sponsor";
      await ctx.editMessageText(
        `💎 Type the <b>sponsor name</b>:\n\n` +
          `Examples: <code>RedBeard Peptides</code> or <code>@SponsorUsername</code>\n\n` +
          `<i>Type <code>skip</code> to remove sponsor.</i>`,
        { parse_mode: "HTML" }
      );
      break;

    case "wiz_opt_anon":
      state.anonymous = !state.anonymous;
      await ctx.editMessageText(buildOptionsText(state), {
        parse_mode: "HTML",
        reply_markup: buildOptionsKeyboard(state),
      });
      break;

    case "wiz_opt_pin":
      state.autoPin = !state.autoPin;
      await ctx.editMessageText(buildOptionsText(state), {
        parse_mode: "HTML",
        reply_markup: buildOptionsKeyboard(state),
      });
      break;

    case "wiz_opt_image":
      state.step = "options_image";
      await ctx.editMessageText(
        `🖼 Send a <b>photo</b> for the raffle banner.\n\n` +
          `<i>Type <code>skip</code> to remove image.</i>`,
        { parse_mode: "HTML" }
      );
      break;

    case "wiz_opt_sched": {
      // Default the per-raffle timezone to the chat's stored timezone the first time
      if (!state.scheduledTimezone) {
        state.scheduledTimezone = db.getChatTimezone(state.targetChatId);
      }
      await sendScheduledCalendar(ctx, state);
      break;
    }

    case "wiz_opt_tz": {
      // Standalone timezone picker (no schedule flow) — admin just wants to set
      // the display timezone for this raffle. After picking, return to options
      // screen and save as group default too so future raffles inherit it.
      if (!state.scheduledTimezone) {
        state.scheduledTimezone = db.getChatTimezone(state.targetChatId);
      }
      await sendStandaloneTimezonePicker(ctx, state);
      break;
    }

    case "wiz_opt_requser":
      state.requireUsername = !state.requireUsername;
      await ctx.editMessageText(buildOptionsText(state), {
        parse_mode: "HTML",
        reply_markup: buildOptionsKeyboard(state),
      });
      break;

    case "wiz_opt_minage":
      state.step = "options_minage";
      await ctx.editMessageText(
        `📅 How many <b>days old</b> must a Telegram account be to enter?\n\n` +
          `Type a number (e.g. <code>7</code>, <code>30</code>, <code>90</code>)\n\n` +
          `<i>Type <code>0</code> or <code>skip</code> to disable.</i>`,
        { parse_mode: "HTML" }
      );
      break;

    case "wiz_opt_cooldown":
      state.step = "options_cooldown";
      await ctx.editMessageText(
        `🛡 <b>Winner Cooldown</b> — prevent recent winners from entering.\n\n` +
          `How many past raffles should a winner sit out?\n` +
          `Type a number (e.g. <code>1</code>, <code>3</code>, <code>5</code>)\n\n` +
          `<i>Type <code>0</code> or <code>skip</code> to disable.</i>`,
        { parse_mode: "HTML" }
      );
      break;

    case "wiz_opt_animation":
      state.showAnimation = state.showAnimation === false ? true : false;
      await ctx.editMessageText(buildOptionsText(state), {
        parse_mode: "HTML",
        reply_markup: buildOptionsKeyboard(state),
      });
      break;

    case "wiz_opt_revoke_links":
      state.revokeReferralLinks = !state.revokeReferralLinks;
      await ctx.editMessageText(buildOptionsText(state), {
        parse_mode: "HTML",
        reply_markup: buildOptionsKeyboard(state),
      });
      break;

    case "wiz_opt_referral":
      if (state.referralEnabled) {
        // Toggle off
        state.referralEnabled = false;
        state.maxReferralEntries = undefined;
        state.revokeReferralLinks = undefined;
        await ctx.editMessageText(buildOptionsText(state), {
          parse_mode: "HTML",
          reply_markup: buildOptionsKeyboard(state),
        });
      } else {
        // Toggle on — ask for max cap
        state.referralEnabled = true;
        state.step = "options_referral_max";
        await ctx.editMessageText(
          `🔗 <b>Referral Entries</b>\n\n` +
            `When enabled, users who enter will get a unique invite link DMd to them. ` +
            `Each person who joins the group via their link earns them +1 bonus entry.\n\n` +
            `Set a <b>max bonus entries</b> per user, or type <code>0</code> for unlimited:\n\n` +
            `Examples: <code>5</code>, <code>10</code>, <code>0</code> (unlimited)`,
          { parse_mode: "HTML" }
        );
      }
      break;

    case "wiz_opt_create":
      await createRaffleFromWizard(ctx, state);
      break;
  }
}

async function handleOptionsImageText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip") {
    state.imageFileId = null;
    await sendOptionsScreen(ctx, state);
    return true;
  }

  // User typed text but we need a photo
  await ctx.reply(
    `Please send a <b>photo</b>, or type <code>skip</code> to continue without an image.`,
    { parse_mode: "HTML" }
  );
  return true;
}

async function handleOptionsSponsorText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip") {
    state.sponsorName = null;
  } else {
    state.sponsorName = text;
  }
  await sendOptionsScreen(ctx, state);
  return true;
}

/**
 * Custom-date text input — accepts "YYYY-MM-DD" or short forms like "12/31",
 * "Dec 31", "tomorrow", or "next Friday". Once we have a date, advance to time picker.
 */
async function handleCustomScheduledDateText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  const { resolveTimezone } = await import("./timezone");
  const tz = db.getChatTimezone(state.targetChatId);

  // Accept strict YYYY-MM-DD
  const ymd = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymd) {
    const m = String(ymd[2]).padStart(2, "0");
    const d = String(ymd[3]).padStart(2, "0");
    state.scheduledDate = `${ymd[1]}-${m}-${d}`;
    await sendScheduledTimePicker(ctx, state);
    return true;
  }

  await ctx.reply(
    `Couldn't parse "<code>${escapeHtml(text)}</code>" as a date.\n\n` +
      `Type the date in <code>YYYY-MM-DD</code> format (e.g., <code>2026-12-31</code>).\n` +
      `<i>Group timezone: ${escapeHtml(tz)}</i>`,
    { parse_mode: "HTML" }
  );
  // Silence unused-import warning (resolveTimezone reserved for future fuzzy parsing)
  void resolveTimezone;
  return true;
}

/**
 * Custom-time text input — accepts "HH:MM" (24h) or "H:MM AM/PM".
 * Combines with state.scheduledDate to compute the UTC start time.
 */
async function handleCustomScheduledTimeText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  const { buildUtcDateFromLocal } = await import("./timezone");
  const tz = db.getChatTimezone(state.targetChatId);

  if (!state.scheduledDate) {
    // Shouldn't happen — defensive fallback
    await sendOptionsScreen(ctx, state);
    return true;
  }

  // Normalize: accept "6pm", "6 PM", "18:00", "6:30 PM", "6:30pm"
  let normalized = text.trim().toLowerCase();
  let hh: number | null = null;
  let mm: number | null = null;

  const hm24 = normalized.match(/^(\d{1,2}):(\d{2})$/);
  if (hm24) {
    hh = parseInt(hm24[1], 10);
    mm = parseInt(hm24[2], 10);
  } else {
    const hm12 = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
    if (hm12) {
      let h = parseInt(hm12[1], 10);
      const m = hm12[2] ? parseInt(hm12[2], 10) : 0;
      const period = hm12[3];
      if (h === 12) h = 0;
      if (period === "pm") h += 12;
      hh = h;
      mm = m;
    }
  }

  if (hh === null || mm === null || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    await ctx.reply(
      `Couldn't parse "<code>${escapeHtml(text)}</code>" as a time.\n\n` +
        `Use 24h <code>HH:MM</code> (e.g. <code>18:30</code>) or 12h <code>H:MM AM/PM</code> (e.g. <code>6:30 PM</code>).\n` +
        `<i>Group timezone: ${escapeHtml(tz)}</i>`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  const timeStr = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  const utc = buildUtcDateFromLocal(state.scheduledDate, timeStr, tz);
  if (!utc) {
    await ctx.reply(
      `Could not compute start time for ${escapeHtml(state.scheduledDate)} ${escapeHtml(timeStr)} in ${escapeHtml(tz)}.`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  if (utc.getTime() <= Date.now()) {
    await ctx.reply(
      `That time is in the past in <code>${escapeHtml(tz)}</code>. Pick a future time.`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  state.startsAt = utc.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
  state.scheduledDate = undefined;
  await sendOptionsScreen(ctx, state);
  return true;
}

/** Render the time picker keyboard after the date is chosen. */
async function sendScheduledTimePicker(ctx: Context, state: WizardState): Promise<void> {
  // Legacy fallback path — defer to new clock picker
  await sendScheduledHourPicker(ctx, state);
}

// ============================================================
// Calendar / Clock / Timezone Picker
// ============================================================
//
// Three stages:
//   1. Calendar — month grid, navigate prev/next, tap a day
//   2. Clock — 24 hour-buttons (12 AM..11 PM) in a 3-col grid
//   3. Minute — :00 / :05 / .. / :55 in a 4-col grid
//
// A "[🌐 Change timezone]" button on every screen swaps to the timezone
// picker, which returns the user to the same stage with their pick applied.
//
// All callback data uses the `wsc:` (wizard schedule calendar) prefix to
// avoid clashes with the older `wiz_sched_*` callbacks.

/** Render the calendar for the given year/month (defaults to current month in user's tz). */
async function sendScheduledCalendar(
  ctx: Context,
  state: WizardState,
  year?: number,
  month?: number
): Promise<void> {
  const { buildCalendar } = await import("./calendar");
  const { getNextNDates, formatInTimezone } = await import("./timezone");
  const tz = state.scheduledTimezone || "UTC";
  state.step = "options_scheduled_cal";

  // Determine today's wall clock in the target tz
  const [todayYmd] = getNextNDates(tz, 1);
  let viewYear = year;
  let viewMonth = month;
  if (viewYear === undefined || viewMonth === undefined) {
    const [y, m] = todayYmd.split("-").map(Number);
    viewYear = y;
    viewMonth = m;
  }

  const grid = buildCalendar(viewYear, viewMonth, todayYmd, 12);

  const kb = new InlineKeyboard();
  for (const row of grid.rows) {
    for (const cell of row) {
      switch (cell.kind) {
        case "nav-prev":
          kb.text(cell.label, `wsc:cal:${cell.toYear}-${String(cell.toMonth).padStart(2, "0")}`);
          break;
        case "nav-next":
          kb.text(cell.label, `wsc:cal:${cell.toYear}-${String(cell.toMonth).padStart(2, "0")}`);
          break;
        case "nav-title":
          kb.text(cell.label, "wsc:noop");
          break;
        case "weekday-header":
          kb.text(cell.label, "wsc:noop");
          break;
        case "empty":
          kb.text(" ", "wsc:noop");
          break;
        case "day":
          if (cell.inPast) {
            kb.text("·", "wsc:past");
          } else {
            kb.text(cell.label, `wsc:day:${cell.date}`);
          }
          break;
      }
    }
    kb.row();
  }
  kb.text("🌐 Change timezone", "wsc:tz").row();
  kb.text("⏭ Skip (open now)", "wsc:skip");

  const nowStr = formatInTimezone(new Date(), tz);
  const body =
    `🗓 <b>Schedule the raffle start</b>\n\n` +
    `Timezone: <code>${escapeHtml(tz)}</code> (now: ${escapeHtml(nowStr)})\n\n` +
    `Pick a <b>date</b>:`;

  try {
    await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
  }
}

/** Render hour picker (24 hours in AM/PM labels, 3 columns). */
async function sendScheduledHourPicker(ctx: Context, state: WizardState): Promise<void> {
  if (!state.scheduledDate) {
    await sendScheduledCalendar(ctx, state);
    return;
  }
  const tz = state.scheduledTimezone || "UTC";
  state.step = "options_scheduled_hour";

  const kb = new InlineKeyboard();
  // 24 hours in 3 columns
  for (let h = 0; h < 24; h++) {
    const label = formatHourLabel(h);
    kb.text(label, `wsc:hour:${String(h).padStart(2, "0")}`);
    if ((h + 1) % 3 === 0) kb.row();
  }
  kb.text("🌐 Change timezone", "wsc:tz").row();
  kb.text("⬅️ Back to calendar", "wsc:back:cal");

  const body =
    `📅 Date: <b>${escapeHtml(state.scheduledDate)}</b>\n` +
    `Timezone: <code>${escapeHtml(tz)}</code>\n\n` +
    `Pick the <b>hour</b>:`;

  try {
    await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
  }
}

/** Render minute picker (5-minute increments). */
async function sendScheduledMinutePicker(ctx: Context, state: WizardState): Promise<void> {
  if (!state.scheduledDate || state.scheduledHour === undefined) {
    await sendScheduledHourPicker(ctx, state);
    return;
  }
  const tz = state.scheduledTimezone || "UTC";
  state.step = "options_scheduled_min";

  const kb = new InlineKeyboard();
  // 5-min increments in 4 columns
  for (let m = 0; m < 60; m += 5) {
    kb.text(`:${String(m).padStart(2, "0")}`, `wsc:min:${String(m).padStart(2, "0")}`);
    if (((m / 5) + 1) % 4 === 0) kb.row();
  }
  kb.text("🌐 Change timezone", "wsc:tz").row();
  kb.text("⬅️ Back to hour", "wsc:back:hour");

  const body =
    `📅 Date: <b>${escapeHtml(state.scheduledDate)}</b>\n` +
    `🕐 Hour: <b>${escapeHtml(formatHourLabel(state.scheduledHour))}</b>\n` +
    `Timezone: <code>${escapeHtml(tz)}</code>\n\n` +
    `Pick the <b>minute</b>:`;

  try {
    await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
  }
}

/** Render timezone picker (common ones first). */
async function sendScheduledTimezonePicker(ctx: Context, state: WizardState): Promise<void> {
  const { formatInTimezone } = await import("./timezone");
  state.step = "options_scheduled_tz";

  const current = state.scheduledTimezone || "UTC";
  const commonTzs: Array<{ label: string; tz: string }> = [
    { label: "🇺🇸 Eastern (ET)", tz: "America/New_York" },
    { label: "🇺🇸 Central (CT)", tz: "America/Chicago" },
    { label: "🇺🇸 Mountain (MT)", tz: "America/Denver" },
    { label: "🇺🇸 Pacific (PT)", tz: "America/Los_Angeles" },
    { label: "🇺🇸 Alaska (AKT)", tz: "America/Anchorage" },
    { label: "🇺🇸 Hawaii (HST)", tz: "Pacific/Honolulu" },
    { label: "🌍 UTC", tz: "UTC" },
    { label: "🇬🇧 London (GMT/BST)", tz: "Europe/London" },
    { label: "🇪🇺 Paris (CET)", tz: "Europe/Paris" },
    { label: "🇯🇵 Tokyo (JST)", tz: "Asia/Tokyo" },
    { label: "🇦🇺 Sydney (AET)", tz: "Australia/Sydney" },
    { label: "🇮🇳 India (IST)", tz: "Asia/Kolkata" },
  ];

  const kb = new InlineKeyboard();
  for (let i = 0; i < commonTzs.length; i++) {
    const t = commonTzs[i];
    const marker = t.tz === current ? " ✓" : "";
    kb.text(`${t.label}${marker}`, `wsc:tz:${t.tz}`);
    if (i % 2 === 1) kb.row();
  }
  if (commonTzs.length % 2 === 1) kb.row();
  kb.text("⬅️ Back", "wsc:back:cal");

  const nowStr = formatInTimezone(new Date(), current);
  const body =
    `🌐 <b>Pick a timezone for this raffle</b>\n\n` +
    `Current: <code>${escapeHtml(current)}</code> (now: ${escapeHtml(nowStr)})\n\n` +
    `<i>Don't see yours? Set it for the whole group with /timezone.</i>`;

  try {
    await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
  }
}

function formatHourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

/**
 * Standalone timezone picker reachable from the options screen (not from the
 * schedule flow). After a tz is picked, also save it as the group's default
 * so the admin doesn't need to set it again for every raffle.
 *
 * Callback prefix: `wotz:` (wizard options timezone) so it doesn't collide
 * with the schedule-flow tz picker.
 */
async function sendStandaloneTimezonePicker(ctx: Context, state: WizardState): Promise<void> {
  const { formatInTimezone } = await import("./timezone");
  state.step = "options_scheduled_tz";

  const current = state.scheduledTimezone || db.getChatTimezone(state.targetChatId);
  const commonTzs: Array<{ label: string; tz: string }> = [
    { label: "🇺🇸 Eastern (ET)", tz: "America/New_York" },
    { label: "🇺🇸 Central (CT)", tz: "America/Chicago" },
    { label: "🇺🇸 Mountain (MT)", tz: "America/Denver" },
    { label: "🇺🇸 Pacific (PT)", tz: "America/Los_Angeles" },
    { label: "🇺🇸 Alaska (AKT)", tz: "America/Anchorage" },
    { label: "🇺🇸 Hawaii (HST)", tz: "Pacific/Honolulu" },
    { label: "🌍 UTC", tz: "UTC" },
    { label: "🇬🇧 London (GMT/BST)", tz: "Europe/London" },
    { label: "🇪🇺 Paris (CET)", tz: "Europe/Paris" },
    { label: "🇯🇵 Tokyo (JST)", tz: "Asia/Tokyo" },
    { label: "🇦🇺 Sydney (AET)", tz: "Australia/Sydney" },
    { label: "🇮🇳 India (IST)", tz: "Asia/Kolkata" },
  ];

  const kb = new InlineKeyboard();
  for (let i = 0; i < commonTzs.length; i++) {
    const t = commonTzs[i];
    const marker = t.tz === current ? " ✓" : "";
    kb.text(`${t.label}${marker}`, `wotz:${t.tz}`);
    if (i % 2 === 1) kb.row();
  }
  if (commonTzs.length % 2 === 1) kb.row();
  kb.text("⬅️ Back to options", "wotz:back");

  const nowStr = formatInTimezone(new Date(), current);
  const body =
    `🌐 <b>Group timezone</b>\n\n` +
    `Current: <code>${escapeHtml(current)}</code> (now: ${escapeHtml(nowStr)})\n\n` +
    `Pick a timezone — it'll apply to <b>this raffle</b> and become the group's default for future raffles.\n\n` +
    `<i>Don't see yours? Admins can also use /timezone &lt;name&gt; in the group.</i>`;

  try {
    await ctx.editMessageText(body, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    await ctx.reply(body, { parse_mode: "HTML", reply_markup: kb });
  }
}

/**
 * Handle the `wotz:*` callbacks: pick a timezone, persist it as the group default,
 * apply to this raffle's wizard state, and return to the options screen.
 */
export async function handleStandaloneTzCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;
  const state = getActiveWizard(ctx.from.id);
  if (!state) {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();

  if (data === "wotz:back") {
    await sendOptionsScreen(ctx, state);
    return;
  }

  const m = data.match(/^wotz:(.+)$/);
  if (!m) return;
  const { resolveTimezone } = await import("./timezone");
  const resolved = resolveTimezone(m[1]);
  if (!resolved) {
    await ctx.reply(`Unknown timezone: ${m[1]}`);
    return;
  }

  // Apply to this raffle AND persist as the group's default
  state.scheduledTimezone = resolved;
  try {
    db.setChatTimezone(state.targetChatId, resolved);
  } catch (err) {
    console.error("Failed to persist chat timezone:", err);
  }
  await sendOptionsScreen(ctx, state);
}

async function handleOptionsMinAgeText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip" || text === "0") {
    state.minAccountAgeDays = 0;
    await sendOptionsScreen(ctx, state);
    return true;
  }

  const days = parseInt(text, 10);
  if (isNaN(days) || days < 0 || days > 3650) {
    await ctx.reply("Enter a number between 0 and 3650 (10 years max).");
    return true;
  }

  state.minAccountAgeDays = days;
  await sendOptionsScreen(ctx, state);
  return true;
}

async function handleOptionsCooldownText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip" || text === "0") {
    state.winnerCooldown = 0;
    await sendOptionsScreen(ctx, state);
    return true;
  }

  const count = parseInt(text, 10);
  if (isNaN(count) || count < 0 || count > 100) {
    await ctx.reply("Enter a number between 0 and 100.");
    return true;
  }

  state.winnerCooldown = count;
  await sendOptionsScreen(ctx, state);
  return true;
}

async function handleOptionsReferralMaxText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  const num = parseInt(text, 10);
  if (isNaN(num) || num < 0) {
    await ctx.reply("Enter a number (0 for unlimited, or a positive number for the cap).");
    return true;
  }

  state.maxReferralEntries = num;
  await sendOptionsScreen(ctx, state);
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
    thread_id: state.targetThreadId,
    creator_id: state.userId,
    creator_name: displayName,
    title: state.title || "Raffle",
    description: "",
    prize: singlePrize,
    prizes: prizesJson,
    max_entries: null,
    max_winners: state.maxWinners || 1,
    ends_at: state.endsAt || null,
    starts_at: state.startsAt || null,
    // Snapshot the timezone the admin picked (or the group's default) onto
    // the raffle. This way every raffle has a concrete display timezone and
    // changing the group default later doesn't retroactively shift existing
    // raffles' wall-clock displays.
    display_timezone: state.scheduledTimezone || db.getChatTimezone(state.targetChatId),
    required_chat_id: null,
    required_chat_title: null,
    sponsor_name: state.sponsorName || null,
    anonymous: state.anonymous ? 1 : 0,
    image_file_id: state.imageFileId || null,
    auto_pin: state.autoPin ? 1 : 0,
    min_account_age_days: state.minAccountAgeDays || 0,
    require_username: state.requireUsername ? 1 : 0,
    winner_cooldown: state.winnerCooldown || 0,
    show_animation: state.showAnimation !== false ? 1 : 0,
    referral_enabled: state.referralEnabled ? 1 : 0,
    max_referral_entries: state.maxReferralEntries || 0,
    revoke_referral_links: state.revokeReferralLinks ? 1 : 0,
  });

  cancelWizard(state.userId);

  const lang = db.getChatLanguage(state.targetChatId);
  const botUsername = ctx.me.username;
  const keyboard = buildRaffleKeyboard(raffle, 0, lang, botUsername);

  const msgId = await sendRafflePost(
    ctx.api,
    state.targetChatId,
    "open",
    formatRaffleMessage(raffle, 0, lang),
    keyboard,
    raffle.image_file_id,
    raffle.thread_id
  );

  if (!msgId) {
    // Failed to post - delete the raffle from database and notify user
    db.deleteRaffle(raffle.id);
    await ctx.reply(
      `❌ Failed to post raffle to <b>${escapeHtml(state.targetChatTitle)}</b>.\n\n` +
        `This can happen if:\n` +
        `• The topic/thread is closed\n` +
        `• The bot was removed from the group\n` +
        `• The bot doesn't have permission to post\n\n` +
        `Please check the group settings and try again.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  db.updateRaffleMessageId(raffle.id, msgId);

  // Auto-pin the raffle message if enabled
  if (raffle.auto_pin) {
    try {
      await ctx.api.pinChatMessage(state.targetChatId, msgId, {
        disable_notification: true,
      });
    } catch {
      // Bot may not have pin permission
    }
  }

  await ctx.reply(
    `✅ Raffle <b>${escapeHtml(raffle.title)}</b> has been posted to <b>${escapeHtml(state.targetChatTitle)}</b>!`,
    { parse_mode: "HTML" }
  );

}

// ===================================================================
// EDIT WIZARD — Interactive DM-based raffle editor
// ===================================================================

interface EditWizardState {
  raffleId: number;
  chatId: number;
  dmChatId: number;
  userId: number;
  editingField: "title" | "prize" | "ends" | "max" | "sponsor" | null;
  createdAt: number;
}

const editWizards = new Map<number, EditWizardState>();

function cleanStaleEditWizards(): void {
  const now = Date.now();
  for (const [key, state] of editWizards) {
    if (now - state.createdAt > WIZARD_TIMEOUT) {
      editWizards.delete(key);
    }
  }
}

export function getActiveEditWizard(userId: number): EditWizardState | undefined {
  cleanStaleEditWizards();
  const state = editWizards.get(userId);
  if (state) {
    state.createdAt = Date.now();
  }
  return state;
}

export function cancelEditWizard(userId: number): void {
  editWizards.delete(userId);
}

export async function startEditWizard(
  ctx: Context,
  raffleId: number,
  chatId: number
): Promise<void> {
  const userId = ctx.from!.id;

  const raffle = db.getRaffleById(raffleId);
  if (!raffle) return;

  try {
    const state: EditWizardState = {
      raffleId,
      chatId,
      dmChatId: 0,
      userId,
      editingField: null,
      createdAt: Date.now(),
    };

    editWizards.set(userId, state);

    const msg = await ctx.api.sendMessage(
      userId,
      buildEditScreenText(raffle),
      { parse_mode: "HTML", reply_markup: buildEditScreenKeyboard(raffle) }
    );

    state.dmChatId = msg.chat.id;

    // Notify in group
    const notice = await ctx.reply(
      `✏️ Check your DMs @${ctx.from!.username || ctx.from!.first_name} — editing raffle there.`
    );
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(chatId, notice.message_id);
      } catch {}
    }, 5000);
  } catch {
    const botInfo = await ctx.api.getMe();
    const keyboard = new InlineKeyboard().url(
      "Start a DM with me",
      `https://t.me/${botInfo.username}?start=editraffle_${raffleId}_${chatId}`
    );
    const fallback = await ctx.reply(
      `I need to edit the raffle in a private message.\n\n` +
        `Tap the button below to start a DM with me, then try /editraffle again.`,
      { reply_markup: keyboard }
    );
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(chatId, fallback.message_id);
      } catch {}
    }, 15000);
  }
}

function buildEditScreenText(raffle: ReturnType<typeof db.getRaffleById>): string {
  if (!raffle) return "Raffle not found.";

  const count = db.getEntryCount(raffle.id);
  const maxStr = raffle.max_entries ? `${raffle.max_entries}` : "No limit";

  let msg = `✏️ <b>Editing: ${escapeHtml(raffle.title)}</b>\n\n`;
  msg += `🎁 <b>Prize:</b> ${escapeHtml(raffle.prize)}\n`;
  msg += `🏆 <b>Winners:</b> ${raffle.max_winners}\n`;
  msg += `👥 <b>Entries:</b> ${count} (max: ${maxStr})\n`;

  if (raffle.ends_at) {
    const endsDate = new Date(raffle.ends_at + "Z");
    msg += `⏰ <b>Ends:</b> ${formatCountdown(endsDate)}\n`;
  } else {
    msg += `⏰ <b>Ends:</b> No time limit\n`;
  }

  if (raffle.sponsor_name) {
    msg += `💎 <b>Sponsor:</b> ${escapeHtml(raffle.sponsor_name)}\n`;
  } else {
    msg += `💎 <b>Sponsor:</b> None\n`;
  }

  msg += `👁 <b>Hidden entries:</b> ${raffle.anonymous ? "On" : "Off"}\n`;
  msg += `📌 <b>Auto-pin:</b> ${raffle.auto_pin ? "On" : "Off"}\n`;

  msg += `\n<i>Tap a button to edit that field:</i>`;
  return msg;
}

function buildEditScreenKeyboard(raffle: ReturnType<typeof db.getRaffleById>): InlineKeyboard {
  if (!raffle) return new InlineKeyboard();

  const kb = new InlineKeyboard();
  kb.text("✏️ Title", "edit_title");
  kb.text("🎁 Prize", "edit_prize");
  kb.row();
  kb.text("⏰ End Time", "edit_time");
  kb.text("👥 Max Entries", "edit_max");
  kb.row();
  kb.text("🏆 Winners", "edit_winners");
  kb.text("💎 Sponsor", "edit_sponsor");
  kb.row();
  kb.text(
    raffle.anonymous ? "👁 Entries: Hidden" : "👁 Entries: Visible",
    "edit_anon"
  );
  kb.text(
    raffle.auto_pin ? "📌 Pin: On" : "📌 Pin: Off",
    "edit_pin"
  );
  kb.row();
  kb.text("✅ Done", "edit_done");

  return kb;
}

async function refreshEditScreen(ctx: Context, state: EditWizardState): Promise<void> {
  state.editingField = null;
  const raffle = db.getRaffleById(state.raffleId);
  if (!raffle) return;

  try {
    await ctx.editMessageText(
      buildEditScreenText(raffle),
      { parse_mode: "HTML", reply_markup: buildEditScreenKeyboard(raffle) }
    );
  } catch {
    // If edit fails, send new message
    await ctx.api.sendMessage(
      state.dmChatId,
      buildEditScreenText(raffle),
      { parse_mode: "HTML", reply_markup: buildEditScreenKeyboard(raffle) }
    );
  }
}

export async function handleEditCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  // Handle raffle selection (before edit session exists)
  if (data.startsWith("edit_pick_")) {
    const raffleId = parseInt(data.replace("edit_pick_", ""), 10);
    if (isNaN(raffleId)) return;
    const raffle = db.getRaffleById(raffleId);
    if (!raffle || raffle.status !== "open") {
      await ctx.answerCallbackQuery({ text: "This raffle is no longer editable.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();

    // Create the edit wizard state
    const editState: EditWizardState = {
      raffleId,
      chatId: raffle.chat_id,
      dmChatId: ctx.chat!.id,
      userId: ctx.from.id,
      editingField: null,
      createdAt: Date.now(),
    };
    editWizards.set(ctx.from.id, editState);

    // Show the edit screen
    await ctx.editMessageText(
      buildEditScreenText(raffle),
      { parse_mode: "HTML", reply_markup: buildEditScreenKeyboard(raffle) }
    );
    return;
  }

  const state = getActiveEditWizard(ctx.from.id);
  if (!state) {
    await ctx.answerCallbackQuery({ text: "This edit session has expired.", show_alert: true });
    return;
  }

  const raffle = db.getRaffleById(state.raffleId);
  if (!raffle || raffle.status !== "open") {
    await ctx.answerCallbackQuery({ text: "This raffle is no longer editable.", show_alert: true });
    cancelEditWizard(ctx.from.id);
    return;
  }

  await ctx.answerCallbackQuery();

  if (data === "edit_title") {
    state.editingField = "title";
    await ctx.editMessageText(
      `✏️ <b>Edit Title</b>\n\n` +
        `Current: <b>${escapeHtml(raffle.title)}</b>\n\n` +
        `Type the new title:`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (data === "edit_prize") {
    state.editingField = "prize";
    await ctx.editMessageText(
      `🎁 <b>Edit Prize</b>\n\n` +
        `Current: <b>${escapeHtml(raffle.prize)}</b>\n\n` +
        `Type the new prize (separate multiple with commas):`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (data === "edit_sponsor") {
    state.editingField = "sponsor";
    await ctx.editMessageText(
      `💎 <b>Edit Sponsor</b>\n\n` +
        `Current: <b>${raffle.sponsor_name ? escapeHtml(raffle.sponsor_name) : "None"}</b>\n\n` +
        `Type the sponsor name (or <code>none</code> to remove):`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (data === "edit_max") {
    state.editingField = "max";
    await ctx.editMessageText(
      `👥 <b>Edit Max Entries</b>\n\n` +
        `Current: <b>${raffle.max_entries || "No limit"}</b>\n\n` +
        `Type a number (or <code>none</code> for no limit):`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (data === "edit_time") {
    state.editingField = "ends";
    const kb = new InlineKeyboard()
      .text("30 min", "edit_time_30m")
      .text("1 hour", "edit_time_1h")
      .text("2 hours", "edit_time_2h")
      .row()
      .text("6 hours", "edit_time_6h")
      .text("1 day", "edit_time_1d")
      .text("3 days", "edit_time_3d")
      .row()
      .text("7 days", "edit_time_7d")
      .text("14 days", "edit_time_14d")
      .text("❌ No limit", "edit_time_none")
      .row()
      .text("⬅️ Back", "edit_back");

    await ctx.editMessageText(
      `⏰ <b>Edit End Time</b>\n\n` +
        `Current: <b>${raffle.ends_at ? formatCountdown(new Date(raffle.ends_at + "Z")) : "No limit"}</b>\n\n` +
        `Pick a new duration or type one (e.g. <code>5d</code>, <code>12h</code>):`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    return;
  }

  if (data.startsWith("edit_time_")) {
    const timeValue = data.replace("edit_time_", "");

    if (timeValue === "none") {
      db.updateRaffleFields(state.raffleId, { ends_at: null });
    } else {
      let ms = 0;
      switch (timeValue) {
        case "15m": ms = 15 * 60 * 1000; break;
        case "30m": ms = 30 * 60 * 1000; break;
        case "1h": ms = 60 * 60 * 1000; break;
        case "2h": ms = 2 * 60 * 60 * 1000; break;
        case "6h": ms = 6 * 60 * 60 * 1000; break;
        case "1d": ms = 24 * 60 * 60 * 1000; break;
        case "3d": ms = 3 * 24 * 60 * 60 * 1000; break;
        case "7d": ms = 7 * 24 * 60 * 60 * 1000; break;
        case "14d": ms = 14 * 24 * 60 * 60 * 1000; break;
      }
      const endDate = new Date(Date.now() + ms);
      const endsAt = endDate.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
      db.updateRaffleFields(state.raffleId, { ends_at: endsAt });
    }

    await updateRafflePostById(ctx, state.raffleId, state.chatId);
    await refreshEditScreen(ctx, state);
    return;
  }

  if (data === "edit_winners") {
    const kb = new InlineKeyboard()
      .text("1", "edit_win_1")
      .text("2", "edit_win_2")
      .text("3", "edit_win_3")
      .text("5", "edit_win_5")
      .text("10", "edit_win_10")
      .row()
      .text("⬅️ Back", "edit_back");

    await ctx.editMessageText(
      `🏆 <b>Edit Winners Count</b>\n\n` +
        `Current: <b>${raffle.max_winners}</b>\n\n` +
        `Pick a new count:`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    return;
  }

  if (data.startsWith("edit_win_")) {
    const num = parseInt(data.replace("edit_win_", ""), 10);
    if (!isNaN(num) && num >= 1) {
      db.updateRaffleFields(state.raffleId, { max_winners: num });
      await updateRafflePostById(ctx, state.raffleId, state.chatId);
    }
    await refreshEditScreen(ctx, state);
    return;
  }

  if (data === "edit_anon") {
    db.updateRaffleFields(state.raffleId, { anonymous: raffle.anonymous ? 0 : 1 });
    await updateRafflePostById(ctx, state.raffleId, state.chatId);
    await refreshEditScreen(ctx, state);
    return;
  }

  if (data === "edit_pin") {
    db.updateRaffleFields(state.raffleId, { auto_pin: raffle.auto_pin ? 0 : 1 });
    // Pin/unpin the message
    if (!raffle.auto_pin && raffle.message_id) {
      try {
        await ctx.api.pinChatMessage(state.chatId, raffle.message_id, { disable_notification: true });
      } catch {}
    } else if (raffle.auto_pin && raffle.message_id) {
      try {
        await ctx.api.unpinChatMessage(state.chatId, raffle.message_id);
      } catch {}
    }
    await refreshEditScreen(ctx, state);
    return;
  }

  if (data === "edit_back") {
    await refreshEditScreen(ctx, state);
    return;
  }

  if (data === "edit_done") {
    cancelEditWizard(ctx.from.id);
    const updatedRaffle = db.getRaffleById(state.raffleId);
    await ctx.editMessageText(
      `✅ Done editing <b>${escapeHtml(updatedRaffle?.title || "raffle")}</b>. Changes are live!`,
      { parse_mode: "HTML" }
    );
    return;
  }
}

export async function handleEditTextMessage(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.message?.text) return false;

  const state = getActiveEditWizard(ctx.from.id);
  if (!state || !state.editingField) return false;

  const text = ctx.message.text.trim();

  if (text.toLowerCase() === "/cancel") {
    cancelEditWizard(ctx.from.id);
    await ctx.reply("Edit session cancelled.");
    return true;
  }

  if (text.startsWith("/")) return false;

  const raffle = db.getRaffleById(state.raffleId);
  if (!raffle || raffle.status !== "open") {
    cancelEditWizard(ctx.from.id);
    await ctx.reply("This raffle is no longer editable.");
    return true;
  }

  switch (state.editingField) {
    case "title":
      db.updateRaffleFields(state.raffleId, { title: text });
      break;

    case "prize": {
      const prizes = text.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
      if (prizes.length === 0) {
        await ctx.reply("Please enter at least one prize.");
        return true;
      }
      const updates: Record<string, unknown> = { prize: prizes[0] };
      if (prizes.length > 1) {
        updates.prizes = JSON.stringify(prizes);
      } else {
        updates.prizes = null;
      }
      db.updateRaffleFields(state.raffleId, updates);
      break;
    }

    case "ends": {
      const parsed = parseEndTime(text);
      if (!parsed) {
        await ctx.reply(
          `Could not parse "<code>${escapeHtml(text)}</code>". Use formats like: <code>45m</code>, <code>3h</code>, <code>2d</code>`,
          { parse_mode: "HTML" }
        );
        return true;
      }
      const endsAt = parsed.toISOString().replace("T", " ").replace("Z", "").split(".")[0];
      db.updateRaffleFields(state.raffleId, { ends_at: endsAt });
      break;
    }

    case "max": {
      if (text.toLowerCase() === "none") {
        db.updateRaffleFields(state.raffleId, { max_entries: null });
      } else {
        const num = parseInt(text, 10);
        if (isNaN(num) || num < 1) {
          await ctx.reply("Please enter a number or <code>none</code>.", { parse_mode: "HTML" });
          return true;
        }
        db.updateRaffleFields(state.raffleId, { max_entries: num });
      }
      break;
    }

    case "sponsor": {
      if (text.toLowerCase() === "none") {
        db.updateRaffleFields(state.raffleId, { sponsor_name: null });
      } else {
        db.updateRaffleFields(state.raffleId, { sponsor_name: text });
      }
      break;
    }
  }

  // Update the live raffle post
  await updateRafflePostById(ctx, state.raffleId, state.chatId);

  // Show updated edit screen
  state.editingField = null;
  const updatedRaffle = db.getRaffleById(state.raffleId);
  if (updatedRaffle) {
    await ctx.reply(
      buildEditScreenText(updatedRaffle),
      { parse_mode: "HTML", reply_markup: buildEditScreenKeyboard(updatedRaffle) }
    );
  }

  return true;
}

async function updateRafflePostById(
  ctx: Context,
  raffleId: number,
  chatId: number
): Promise<void> {
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || !raffle.message_id) return;

  const count = db.getEntryCount(raffleId);
  const displayCount = raffle.referral_enabled ? db.getTotalEntryCount(raffleId) : count;
  const lang = db.getChatLanguage(chatId);
  const botUsername = ctx.me.username;

  const keyboard = buildRaffleKeyboard(raffle, displayCount, lang, botUsername);

  try {
    await ctx.api.editMessageText(
      chatId,
      raffle.message_id,
      formatRaffleMessage(raffle, count, lang),
      { parse_mode: "HTML", reply_markup: keyboard }
    );
  } catch {}
}

// ===================================================================
// TEMPLATE WIZARD — DM-based step-by-step template creation
// ===================================================================

interface TemplateWizardState {
  step:
    | "name"
    | "title"
    | "prize"
    | "winners"
    | "winners_custom"
    | "time"
    | "time_custom"
    | "options"
    | "options_sponsor"
    | "options_recurring";
  targetChatId: number;
  targetChatTitle: string;
  dmChatId: number;
  userId: number;
  name?: string;
  title?: string;
  prizes?: string[];
  maxWinners?: number;
  durationMinutes?: number | null;
  sponsorName?: string | null;
  anonymous?: boolean;
  recurringMinutes?: number | null;
  createdAt: number;
}

const templateWizards = new Map<number, TemplateWizardState>();

function cleanStaleTemplateWizards(): void {
  const now = Date.now();
  for (const [key, state] of templateWizards) {
    if (now - state.createdAt > WIZARD_TIMEOUT) {
      templateWizards.delete(key);
    }
  }
}

export function getActiveTemplateWizard(
  userId: number
): TemplateWizardState | undefined {
  cleanStaleTemplateWizards();
  const state = templateWizards.get(userId);
  if (state) {
    state.createdAt = Date.now();
  }
  return state;
}

export function cancelTemplateWizard(userId: number): void {
  templateWizards.delete(userId);
}

/** Start the template creation wizard via DM */
export async function startTemplateWizard(
  api: {
    sendMessage: (
      chatId: number,
      text: string,
      opts?: Record<string, unknown>
    ) => Promise<{ chat: { id: number }; message_id: number }>;
    getMe: () => Promise<{ username?: string }>;
  },
  userId: number,
  groupChatId: number,
  groupTitle: string
): Promise<boolean> {
  try {
    const dmMsg = await api.sendMessage(
      userId,
      `📋 <b>Create a Template</b> for <b>${escapeHtml(groupTitle)}</b>\n\n` +
        `Step 1 of 5: What's the <b>template name</b>?\n\n` +
        `<i>This is a short name to recall it later (e.g. "Weekly" or "Daily Prize").\nType /cancel to stop.</i>`,
      { parse_mode: "HTML" }
    );

    templateWizards.set(userId, {
      step: "name",
      targetChatId: groupChatId,
      targetChatTitle: groupTitle,
      dmChatId: dmMsg.chat.id,
      userId,
      createdAt: Date.now(),
    });

    return true;
  } catch {
    return false;
  }
}

/** Handle a text message in the template wizard */
export async function handleTemplateWizardMessage(
  ctx: Context
): Promise<boolean> {
  if (!ctx.from || !ctx.message?.text) return false;

  const state = getActiveTemplateWizard(ctx.from.id);
  if (!state) return false;

  const text = ctx.message.text.trim();

  if (text.toLowerCase() === "/cancel") {
    cancelTemplateWizard(ctx.from.id);
    await ctx.reply("Template creation cancelled.");
    return true;
  }

  if (text.startsWith("/")) return false;

  switch (state.step) {
    case "name":
      return await handleTmplNameStep(ctx, state, text);
    case "title":
      return await handleTmplTitleStep(ctx, state, text);
    case "prize":
      return await handleTmplPrizeStep(ctx, state, text);
    case "winners_custom":
      return await handleTmplCustomWinnersStep(ctx, state, text);
    case "time_custom":
      return await handleTmplCustomTimeStep(ctx, state, text);
    case "options_sponsor":
      return await handleTmplSponsorText(ctx, state, text);
    case "options_recurring":
      return await handleTmplRecurringText(ctx, state, text);
    default:
      return false;
  }
}

async function handleTmplNameStep(
  ctx: Context,
  state: TemplateWizardState,
  text: string
): Promise<boolean> {
  // Check if name already exists
  const existing = db.getTemplateByName(state.targetChatId, text);
  if (existing) {
    await ctx.reply(
      `A template named "<b>${escapeHtml(text)}</b>" already exists. Choose a different name:`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  state.name = text;
  state.step = "title";

  await ctx.reply(
    `✅ Name: <b>${escapeHtml(text)}</b>\n\n` +
      `Step 2 of 5: What's the <b>raffle title</b>?\n\n` +
      `<i>This is what appears on the raffle post.</i>`,
    { parse_mode: "HTML" }
  );
  return true;
}

async function handleTmplTitleStep(
  ctx: Context,
  state: TemplateWizardState,
  text: string
): Promise<boolean> {
  state.title = text;
  state.step = "prize";

  await ctx.reply(
    `✅ Title: <b>${escapeHtml(text)}</b>\n\n` +
      `Step 3 of 5: What's the <b>prize</b>?\n\n` +
      `Send one prize, or <b>multiple prizes separated by commas</b>.\n\n` +
      `Examples:\n` +
      `• <code>$50 Gift Card</code>\n` +
      `• <code>$100, $50, $25</code>`,
    { parse_mode: "HTML" }
  );
  return true;
}

async function handleTmplPrizeStep(
  ctx: Context,
  state: TemplateWizardState,
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

  const keyboard = new InlineKeyboard();

  if (prizes.length > 1) {
    keyboard
      .text(`${prizes.length} (match prizes)`, `twiz_winners_${prizes.length}`)
      .row();
  }
  // 1-10 quick picks in two rows of 5
  keyboard
    .text("1", "twiz_winners_1")
    .text("2", "twiz_winners_2")
    .text("3", "twiz_winners_3")
    .text("4", "twiz_winners_4")
    .text("5", "twiz_winners_5")
    .row()
    .text("6", "twiz_winners_6")
    .text("7", "twiz_winners_7")
    .text("8", "twiz_winners_8")
    .text("9", "twiz_winners_9")
    .text("10", "twiz_winners_10")
    .row()
    .text("✏️ Custom (1-50)", "twiz_winners_custom");

  let prizeDisplay: string;
  if (prizes.length > 1) {
    prizeDisplay = prizes
      .map((p, i) => {
        const label =
          i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
        return `${label} ${escapeHtml(p)}`;
      })
      .join("\n");
  } else {
    prizeDisplay = `🎁 ${escapeHtml(prizes[0])}`;
  }

  await ctx.reply(
    `✅ Prizes:\n${prizeDisplay}\n\n` +
      `Step 4 of 5: How many <b>winners</b>?`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
  return true;
}

export async function handleTmplWinnersCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveTemplateWizard(ctx.from.id);
  if (!state || state.step !== "winners") {
    await ctx.answerCallbackQuery({
      text: "This wizard has expired.",
      show_alert: true,
    });
    return;
  }

  const num = parseInt(data.replace("twiz_winners_", ""), 10);
  if (isNaN(num) || num < 1) return;

  state.maxWinners = num;
  state.step = "time";

  await ctx.answerCallbackQuery();

  const keyboard = new InlineKeyboard()
    .text("15 min", "twiz_time_15m")
    .text("30 min", "twiz_time_30m")
    .text("1 hour", "twiz_time_1h")
    .row()
    .text("2 hours", "twiz_time_2h")
    .text("6 hours", "twiz_time_6h")
    .text("1 day", "twiz_time_1d")
    .row()
    .text("⏱ Custom time", "twiz_time_custom")
    .row()
    .text("No time limit", "twiz_time_none");

  await ctx.editMessageText(
    `✅ Winners: <b>${num}</b>\n\n` +
      `Step 5 of 5: Set a <b>default duration</b>?\n\n` +
      `Each raffle created from this template will run for this long.`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
}

export async function handleTmplWinnersCustomCallback(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const state = getActiveTemplateWizard(ctx.from.id);
  if (!state || state.step !== "winners") {
    await ctx.answerCallbackQuery({ text: "This wizard has expired.", show_alert: true });
    return;
  }

  state.step = "winners_custom";
  await ctx.answerCallbackQuery();

  const promptText =
    `✏️ <b>Custom number of winners</b>\n\n` +
    `Type a number between <b>1</b> and <b>50</b>, then press send.`;

  try {
    await ctx.reply(promptText, { parse_mode: "HTML" });
  } catch (err) {
    console.error("Failed to send template custom winners prompt:", err);
  }
}

async function handleTmplCustomWinnersStep(
  ctx: Context,
  state: TemplateWizardState,
  text: string
): Promise<boolean> {
  const num = parseInt(text, 10);
  if (isNaN(num) || num < 1 || num > 50) {
    await ctx.reply("Please enter a number between <b>1</b> and <b>50</b>.", { parse_mode: "HTML" });
    return true;
  }

  state.maxWinners = num;
  state.step = "time";

  const keyboard = new InlineKeyboard()
    .text("15 min", "twiz_time_15m")
    .text("30 min", "twiz_time_30m")
    .text("1 hour", "twiz_time_1h")
    .row()
    .text("2 hours", "twiz_time_2h")
    .text("6 hours", "twiz_time_6h")
    .text("1 day", "twiz_time_1d")
    .row()
    .text("⏱ Custom time", "twiz_time_custom")
    .row()
    .text("No time limit", "twiz_time_none");

  await ctx.reply(
    `✅ Winners: <b>${num}</b>\n\n` +
      `Step 5 of 5: Set a <b>default duration</b>?\n\n` +
      `Each raffle created from this template will run for this long.`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
  return true;
}

export async function handleTmplTimeCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveTemplateWizard(ctx.from.id);
  if (!state || state.step !== "time") {
    await ctx.answerCallbackQuery({
      text: "This wizard has expired.",
      show_alert: true,
    });
    return;
  }

  const timeValue = data.replace("twiz_time_", "");

  if (timeValue === "custom") {
    state.step = "time_custom";
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `⏱ <b>Custom Duration</b>\n\n` +
        `Type a duration like:\n` +
        `• <code>45m</code> — 45 minutes\n` +
        `• <code>3h</code> — 3 hours\n` +
        `• <code>12h</code> — 12 hours\n` +
        `• <code>2d</code> — 2 days`,
      { parse_mode: "HTML" }
    );
    return;
  }

  if (timeValue === "none") {
    state.durationMinutes = null;
  } else {
    switch (timeValue) {
      case "15m": state.durationMinutes = 15; break;
      case "30m": state.durationMinutes = 30; break;
      case "1h": state.durationMinutes = 60; break;
      case "2h": state.durationMinutes = 120; break;
      case "6h": state.durationMinutes = 360; break;
      case "1d": state.durationMinutes = 1440; break;
    }
  }

  await ctx.answerCallbackQuery();
  await sendTmplOptionsScreen(ctx, state);
}

async function handleTmplCustomTimeStep(
  ctx: Context,
  state: TemplateWizardState,
  text: string
): Promise<boolean> {
  const parsed = parseEndTime(text);
  if (!parsed) {
    await ctx.reply(
      `Could not parse "<code>${escapeHtml(text)}</code>".\n\n` +
        `Use formats like: <code>45m</code>, <code>3h</code>, <code>2d</code>`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  // Convert absolute date back to duration in minutes
  const durationMs = parsed.getTime() - Date.now();
  state.durationMinutes = Math.round(durationMs / 60000);

  await sendTmplOptionsScreen(ctx, state);
  return true;
}

// --- Template options screen ---

function buildTmplOptionsText(state: TemplateWizardState): string {
  let msg = `⚙️ <b>Template Options</b> — tap to change, then Create:\n\n`;

  const sponsor = state.sponsorName
    ? `${escapeHtml(state.sponsorName)} ✅`
    : "None";
  msg += `💎 <b>Sponsor:</b> ${sponsor}\n`;
  msg += `👁 <b>Hidden entries:</b> ${state.anonymous ? "On ✅" : "Off"}\n`;

  if (state.recurringMinutes) {
    const hours = Math.floor(state.recurringMinutes / 60);
    const mins = state.recurringMinutes % 60;
    const parts: string[] = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    msg += `🔄 <b>Recurring:</b> every ${parts.join(" ")} ✅\n`;
  } else {
    msg += `🔄 <b>Recurring:</b> Off\n`;
  }

  return msg;
}

function buildTmplOptionsKeyboard(state: TemplateWizardState): InlineKeyboard {
  const kb = new InlineKeyboard();

  kb.text(
    state.sponsorName ? "💎 Change Sponsor" : "💎 Set Sponsor",
    "twiz_opt_sponsor"
  );
  kb.text(
    state.anonymous ? "👁 Entries: Hidden" : "👁 Entries: Visible",
    "twiz_opt_anon"
  );
  kb.row();
  kb.text(
    state.recurringMinutes ? "🔄 Change Recurring" : "🔄 Set Recurring",
    "twiz_opt_recurring"
  );
  kb.row();
  kb.text("✅ Create Template", "twiz_opt_create");

  return kb;
}

async function sendTmplOptionsScreen(
  ctx: Context,
  state: TemplateWizardState
): Promise<void> {
  state.step = "options";
  await ctx.reply(buildTmplOptionsText(state), {
    parse_mode: "HTML",
    reply_markup: buildTmplOptionsKeyboard(state),
  });
}

export async function handleTmplOptionsCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data || !ctx.from) return;

  const state = getActiveTemplateWizard(ctx.from.id);
  if (!state || !state.step.startsWith("options")) {
    await ctx.answerCallbackQuery({
      text: "This wizard has expired.",
      show_alert: true,
    });
    return;
  }

  await ctx.answerCallbackQuery();

  switch (data) {
    case "twiz_opt_sponsor":
      state.step = "options_sponsor";
      await ctx.editMessageText(
        `💎 Type the <b>sponsor name</b>:\n\n` +
          `Examples: <code>RedBeard Peptides</code> or <code>@SponsorUsername</code>\n\n` +
          `<i>Type <code>skip</code> to remove sponsor.</i>`,
        { parse_mode: "HTML" }
      );
      break;

    case "twiz_opt_anon":
      state.anonymous = !state.anonymous;
      await ctx.editMessageText(buildTmplOptionsText(state), {
        parse_mode: "HTML",
        reply_markup: buildTmplOptionsKeyboard(state),
      });
      break;

    case "twiz_opt_recurring":
      state.step = "options_recurring";
      await ctx.editMessageText(
        `🔄 <b>Recurring Interval</b>\n\n` +
          `How often should this template auto-create a new raffle?\n\n` +
          `Type a duration like: <code>6h</code>, <code>12h</code>, <code>1d</code>, <code>7d</code>\n\n` +
          `<i>Type <code>skip</code> to disable recurring.</i>`,
        { parse_mode: "HTML" }
      );
      break;

    case "twiz_opt_create":
      await createTemplateFromWizard(ctx, state);
      break;
  }
}

async function handleTmplSponsorText(
  ctx: Context,
  state: TemplateWizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip") {
    state.sponsorName = null;
  } else {
    state.sponsorName = text;
  }
  await sendTmplOptionsScreen(ctx, state);
  return true;
}

async function handleTmplRecurringText(
  ctx: Context,
  state: TemplateWizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip") {
    state.recurringMinutes = null;
    await sendTmplOptionsScreen(ctx, state);
    return true;
  }

  const parsed = parseEndTime(text);
  if (!parsed) {
    await ctx.reply(
      `Could not parse "<code>${escapeHtml(text)}</code>".\n\n` +
        `Use formats like: <code>6h</code>, <code>12h</code>, <code>1d</code>, <code>7d</code>`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  const durationMs = parsed.getTime() - Date.now();
  state.recurringMinutes = Math.round(durationMs / 60000);

  await sendTmplOptionsScreen(ctx, state);
  return true;
}

async function createTemplateFromWizard(
  ctx: Context,
  state: TemplateWizardState
): Promise<void> {
  const prizes = state.prizes || ["Prize"];
  const singlePrize = prizes[0];
  const prizesJson = prizes.length > 1 ? JSON.stringify(prizes) : null;

  try {
    db.createTemplate({
      chat_id: state.targetChatId,
      thread_id: null,
      creator_id: state.userId,
      name: state.name || "Template",
      title: state.title || state.name || "Raffle",
      prize: singlePrize,
      prizes: prizesJson,
      max_entries: null,
      max_winners: state.maxWinners || 1,
      duration_minutes: state.durationMinutes || null,
      sponsor_name: state.sponsorName || null,
      anonymous: state.anonymous ? 1 : 0,
      recurring_interval_minutes: state.recurringMinutes || null,
    });

    cancelTemplateWizard(state.userId);

    await ctx.reply(
      `✅ Template <b>${escapeHtml(state.name || "Template")}</b> saved!\n\n` +
        `Use /templates in <b>${escapeHtml(state.targetChatTitle)}</b> to manage it.`,
      { parse_mode: "HTML" }
    );
  } catch (err: unknown) {
    const sqliteErr = err as { code?: string };
    if (sqliteErr.code === "SQLITE_CONSTRAINT_UNIQUE") {
      await ctx.reply(
        `A template named "${escapeHtml(state.name || "")}" already exists in that chat. Choose a different name or delete the existing one first.`,
        { parse_mode: "HTML" }
      );
    } else {
      throw err;
    }
  }
}

// ===================================================================
// BUG REPORT — DM-based bug report flow
// ===================================================================

interface BugReportState {
  step: "description" | "screenshot";
  userId: number;
  userName: string;
  fromChatId: number;
  fromChatTitle: string;
  description?: string;
  createdAt: number;
}

const bugReports = new Map<number, BugReportState>();

export function getActiveBugReport(userId: number): BugReportState | null {
  const state = bugReports.get(userId);
  if (!state) return null;
  if (Date.now() - state.createdAt > WIZARD_TIMEOUT) {
    bugReports.delete(userId);
    return null;
  }
  return state;
}

function cancelBugReport(userId: number): void {
  bugReports.delete(userId);
}

export async function startBugReport(
  ctx: Context,
  fromChatId: number,
  fromChatTitle: string
): Promise<boolean> {
  const userId = ctx.from!.id;
  const userName = ctx.from!.username
    ? `@${ctx.from!.username}`
    : getUserDisplayName(ctx.from!.first_name, ctx.from!.last_name);

  try {
    await ctx.api.sendMessage(
      userId,
      `🐛 <b>Bug Report</b>\n\n` +
        `Describe the issue you encountered:\n\n` +
        `<i>Be as specific as possible — what were you doing, what happened, what did you expect?\nType /cancel to stop.</i>`,
      { parse_mode: "HTML" }
    );

    bugReports.set(userId, {
      step: "description",
      userId,
      userName,
      fromChatId,
      fromChatTitle,
      createdAt: Date.now(),
    });

    return true;
  } catch {
    return false;
  }
}

export async function handleBugReportMessage(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.message?.text) return false;

  const state = getActiveBugReport(ctx.from.id);
  if (!state) return false;

  const text = ctx.message.text.trim();

  if (text.toLowerCase() === "/cancel") {
    cancelBugReport(ctx.from.id);
    await ctx.reply("Bug report cancelled.");
    return true;
  }

  if (text.startsWith("/")) return false;

  if (state.step === "description") {
    state.description = text;
    state.step = "screenshot";

    const kb = new InlineKeyboard()
      .text("📷 Skip — Send Report", "bugreport_skip");

    await ctx.reply(
      `Got it. Want to attach a <b>screenshot</b>?\n\n` +
        `Send a photo now, or tap below to skip and submit.`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    return true;
  }

  return false;
}

export async function handleBugReportPhoto(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.message?.photo) return false;

  const state = getActiveBugReport(ctx.from.id);
  if (!state || state.step !== "screenshot") return false;

  const photos = ctx.message.photo;
  const largest = photos[photos.length - 1];

  await sendBugReportToOwner(ctx, state, largest.file_id);
  return true;
}

export async function handleBugReportSkip(ctx: Context): Promise<void> {
  if (!ctx.from) return;

  const state = getActiveBugReport(ctx.from.id);
  if (!state) {
    await ctx.answerCallbackQuery({ text: "No active bug report.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();
  try { await ctx.deleteMessage(); } catch {}

  await sendBugReportToOwner(ctx, state, null);
}

async function sendBugReportToOwner(
  ctx: Context,
  state: BugReportState,
  photoFileId: string | null
): Promise<void> {
  const ownerId = parseInt(process.env.BOT_OWNER_ID || "0", 10);

  if (ownerId === 0) {
    await ctx.reply("Bug report system is not configured. Sorry!");
    cancelBugReport(state.userId);
    return;
  }

  const reportText =
    `🐛 <b>Bug Report</b>\n\n` +
    `<b>From:</b> ${escapeHtml(state.userName)} (ID: <code>${state.userId}</code>)\n` +
    `<b>Group:</b> ${escapeHtml(state.fromChatTitle)} (<code>${state.fromChatId}</code>)\n\n` +
    `<b>Description:</b>\n${escapeHtml(state.description || "(no description)")}`;

  try {
    if (photoFileId) {
      await ctx.api.sendPhoto(ownerId, photoFileId, {
        caption: reportText,
        parse_mode: "HTML",
      });
    } else {
      await ctx.api.sendMessage(ownerId, reportText, {
        parse_mode: "HTML",
      });
    }

    await ctx.reply(
      `✅ Bug report sent! Thank you for the feedback.`
    );
  } catch (err) {
    console.error(`Failed to send bug report to owner (${ownerId}):`, err);
    await ctx.reply("Failed to send bug report. Please try again later.");
  }

  cancelBugReport(state.userId);
}
