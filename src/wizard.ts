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
} from "./helpers";
import { t } from "./i18n";
import { sendBanner } from "./banners";

interface WizardState {
  step:
    | "title"
    | "prize"
    | "winners"
    | "time"
    | "time_custom"
    | "options"
    | "options_sponsor"
    | "options_image"
    | "options_scheduled";
  targetChatId: number;
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
  autoPin?: boolean;
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
    case "time_custom":
      return await handleCustomTimeStep(ctx, state, text);
    case "options_image":
      return await handleOptionsImageText(ctx, state, text);
    case "options_sponsor":
      return await handleOptionsSponsorText(ctx, state, text);
    case "options_scheduled":
      return await handleOptionsScheduledText(ctx, state, text);
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
    msg += `🕐 <b>Delayed start:</b> ${formatCountdown(startsDate).replace(" remaining", "")} ✅\n`;
  } else {
    msg += `🕐 <b>Delayed start:</b> Opens immediately\n`;
  }

  msg += `📌 <b>Auto-pin:</b> ${state.autoPin ? "On ✅" : "Off"}\n`;

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
  kb.text(
    state.autoPin ? "📌 Pin: On" : "📌 Pin: Off",
    "wiz_opt_pin"
  );
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

    case "wiz_opt_sched":
      state.step = "options_scheduled";
      await ctx.editMessageText(
        `🕐 When should the raffle <b>open for entries</b>?\n\n` +
          `Type a delay like: <code>30m</code>, <code>2h</code>, <code>1d</code>\n` +
          `Or a specific time: <code>2025-12-31 18:00</code>\n\n` +
          `<i>Type <code>skip</code> to open immediately.</i>`,
        { parse_mode: "HTML" }
      );
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

async function handleOptionsScheduledText(
  ctx: Context,
  state: WizardState,
  text: string
): Promise<boolean> {
  if (text.toLowerCase() === "skip") {
    state.startsAt = null;
    await sendOptionsScreen(ctx, state);
    return true;
  }

  const parsed = parseEndTime(text);
  if (!parsed) {
    await ctx.reply(
      `Could not parse "<code>${escapeHtml(text)}</code>".\n\n` +
        `Use formats like: <code>30m</code>, <code>2h</code>, <code>1d</code>`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  state.startsAt = parsed
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .split(".")[0];

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
    required_chat_id: null,
    required_chat_title: null,
    sponsor_name: state.sponsorName || null,
    anonymous: state.anonymous ? 1 : 0,
    image_file_id: state.imageFileId || null,
    auto_pin: state.autoPin ? 1 : 0,
  });

  cancelWizard(state.userId);

  // Send branded banner (or custom image if one was uploaded)
  await sendBanner(ctx.api, state.targetChatId, "open", raffle.image_file_id);

  const lang = db.getChatLanguage(state.targetChatId);
  const keyboard = new InlineKeyboard()
    .text(`🎟 ${t(lang, "btn.enter")}`, `enter_${raffle.id}`)
    .text(`❌ ${t(lang, "btn.leave")}`, `leave_${raffle.id}`)
    .row()
    .text(`👥 ${t(lang, "btn.entries", { count: 0 })}`, `entries_${raffle.id}`);

  const msg = await ctx.api.sendMessage(
    state.targetChatId,
    formatRaffleMessage(raffle, 0, lang),
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );

  db.updateRaffleMessageId(raffle.id, msg.message_id);

  // Auto-pin the raffle message if enabled
  if (raffle.auto_pin) {
    try {
      await ctx.api.pinChatMessage(state.targetChatId, msg.message_id, {
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
    const kb = new InlineKeyboard()
      .text("15 min", "edit_time_15m")
      .text("30 min", "edit_time_30m")
      .text("1 hour", "edit_time_1h")
      .row()
      .text("2 hours", "edit_time_2h")
      .text("6 hours", "edit_time_6h")
      .text("1 day", "edit_time_1d")
      .row()
      .text("⏱ Custom", "edit_time_custom")
      .text("❌ No limit", "edit_time_none")
      .row()
      .text("⬅️ Back", "edit_back");

    await ctx.editMessageText(
      `⏰ <b>Edit End Time</b>\n\n` +
        `Current: <b>${raffle.ends_at ? formatCountdown(new Date(raffle.ends_at + "Z")) : "No limit"}</b>\n\n` +
        `Pick a new duration:`,
      { parse_mode: "HTML", reply_markup: kb }
    );
    return;
  }

  if (data.startsWith("edit_time_")) {
    const timeValue = data.replace("edit_time_", "");

    if (timeValue === "custom") {
      state.editingField = "ends";
      await ctx.editMessageText(
        `⏱ <b>Custom End Time</b>\n\n` +
          `Type a duration like: <code>45m</code>, <code>3h</code>, <code>12h</code>, <code>2d</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

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
  const lang = db.getChatLanguage(chatId);

  const keyboard = new InlineKeyboard()
    .text(`🎟 ${t(lang, "btn.enter")}`, `enter_${raffle.id}`)
    .text(`❌ ${t(lang, "btn.leave")}`, `leave_${raffle.id}`)
    .row()
    .text(`👥 ${t(lang, "btn.entries", { count })}`, `entries_${raffle.id}`);

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
    const options = [1, 2, 3, 5, 10].filter((n) => n !== prizes.length);
    for (const n of options.slice(0, 4)) {
      keyboard.text(`${n}`, `twiz_winners_${n}`);
    }
  } else {
    keyboard
      .text("1", "twiz_winners_1")
      .text("2", "twiz_winners_2")
      .text("3", "twiz_winners_3")
      .text("5", "twiz_winners_5")
      .text("10", "twiz_winners_10");
  }

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
