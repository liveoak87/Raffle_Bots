require('dotenv').config();
const { Client, GatewayIntentBits, Events, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, UserSelectMenuBuilder, StringSelectMenuBuilder } = require('discord.js');
const db = require('./database');
const { buildBoardEmbed, buildComponents, buildExtensionComponents, getExtensionIndexesForSlots, buildWinnerEmbeds, buildWinnerAnnouncementEmbeds, buildMentionChunks, buildSettingsEmbed, buildPaymentPanel, buildPaymentHeader, buildPaymentSlotMessages, buildRemovePanel, buildRemoveHeader, buildRemoveMenuMessages, buildAdminPanel, buildHelpEmbed, buildSetupGuideEmbed } = require('./board');
const { buildCreateModal, buildRulesModal, parseModalValues } = require('./wizard');
const { generateBanner, clearBannerCache } = require('./banner');
const dashboard = require('./dashboard/server');
const { cryptoShuffle } = require('./random');
const { createSingleFlightUpdateQueue } = require('./update-queue');

const OWNER_ID = process.env.OWNER_ID;

// Temporary storage for raffle data between wizard pages
const pendingRaffles = new Map();

// Prevent duplicate clicks from running the same draw transition concurrently.
const drawOperations = new Set();

// Pending assignment sessions (raffleId -> { userId, username })
const pendingAssignments = new Map();

// Track donation panel follow-up message IDs so we can update them on toggle/mark-all
// Key: `${raffleId}_${userId}` → { headerMsgId, followUpIds: [msgId, ...] }
const paymentPanelSessions = new Map();

const queueRaffleUpdate = createSingleFlightUpdateQueue(async (raffle, slots) => {
  await Promise.all([
    updateMainBoard(raffle),
    updateExtensionMessagesForSlots(raffle, slots)
  ]);
}, 250, (err, raffle) => {
  console.error(`[BOARD] Queued update failed — raffle=${raffle.id}:`, err.message);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel] // Required for DM interactions
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  dashboard.start(client, db);
  const savedDraws = db.getAllDrawSessions();
  if (savedDraws.length > 0) {
    console.warn(`[DRAW] Recovered ${savedDraws.length} persisted draw session(s); creators can resume from Draw Winner.`);
  }
});

// ── Event Router ─────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'randomizer') {
        await handleRandomizer(interaction);
      } else if (interaction.commandName === 'pick') {
        await handlePick(interaction);
      } else if (interaction.commandName === 'help') {
        await handleHelp(interaction);
      }
    }

    // Button clicks
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('pick_')) {
        await handleButtonPick(interaction);
      } else if (id.startsWith('admin_panel_')) {
        await handleAdminPanel(interaction);
      } else if (id.startsWith('admin_draw_')) {
        await handleAdminDraw(interaction);
      } else if (id.startsWith('admin_payments_')) {
        await handleAdminPayments(interaction);
      } else if (id.startsWith('admin_settings_')) {
        await handleAdminSettings(interaction);
      } else if (id.startsWith('admin_remove_')) {
        await handleAdminRemove(interaction);
      } else if (id.startsWith('admin_repost_')) {
        await handleAdminRepost(interaction);
      } else if (id.startsWith('admin_cancel_')) {
        await handleAdminCancel(interaction);
      } else if (id.startsWith('confirm_cancel_')) {
        await handleCancelConfirm(interaction);
      } else if (id.startsWith('abort_cancel_')) {
        await handleCancelAbort(interaction);
      } else if (id.startsWith('toggle_paid_')) {
        await handleTogglePaid(interaction);
      } else if (id.startsWith('mark_all_paid_')) {
        await handleMarkAllPaid(interaction);
      } else if (id.startsWith('mark_all_unpaid_')) {
        await handleMarkAllUnpaid(interaction);
      } else if (id.startsWith('remove_pick_')) {
        await handleRemovePick(interaction);
      } else if (id.startsWith('wizard_add_rules_')) {
        await handleWizardAddRules(interaction);
      } else if (id.startsWith('wizard_lock_')) {
        await handleWizardLock(interaction);
      } else if (id.startsWith('wizard_create_')) {
        await handleWizardCreate(interaction);
      } else if (id.startsWith('draw_mode_auto_')) {
        await handleDrawModeAuto(interaction);
      } else if (id.startsWith('draw_mode_manual_')) {
        await handleDrawModeManual(interaction);
      } else if (id.startsWith('resume_draw_auto_')) {
        await handleResumeAutoDraw(interaction);
      } else if (id.startsWith('manual_draw_next_')) {
        await handleManualDrawNext(interaction);
      } else if (id.startsWith('manual_draw_finish_')) {
        await handleManualDrawFinish(interaction);
      } else if (id.startsWith('admin_early_draw_')) {
        await handleEarlyDraw(interaction);
      } else if (id.startsWith('admin_assign_')) {
        await handleAdminAssign(interaction);
      } else if (id.startsWith('admin_lock_')) {
        await handleAdminLock(interaction);
      } else if (id.startsWith('assign_slot_')) {
        await handleAssignSlotSelect(interaction);
      }
    }

    // Select menu remove picks
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('remove_select_')) {
      await handleRemoveSelect(interaction);
    }

    // User select menu for assignment
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('assign_user_')) {
      await handleAssignUserSelect(interaction);
    }

    // User select menu for direct assignment (click number → pick member)
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('assign_direct_')) {
      await handleAssignDirect(interaction);
    }

    // String select menu for slot assignment (step 2)
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('assign_slot_select_')) {
      await handleAssignSlotConfirm(interaction);
    }

    // Modal submit (wizard page 1)
    if (interaction.isModalSubmit() && interaction.customId === 'randomizer_create_modal') {
      await handleCreateModalSubmit(interaction);
    }

    // Modal submit (wizard — rules)
    if (interaction.isModalSubmit() && interaction.customId.startsWith('randomizer_rules_modal_')) {
      await handleRulesModalSubmit(interaction);
    }

  } catch (err) {
    const userId = interaction.user?.id || 'unknown';
    const customId = interaction.customId || interaction.commandName || 'unknown';
    console.error(`[ERROR] Interaction failed — type=${interaction.type} id=${customId} user=${userId}:`, err);

    // Build a user-friendly error message based on the Discord error code
    let userMsg = 'Something went wrong. Please try again.';
    if (err?.code === 50013 || err?.code === 50001) {
      userMsg =
        '⚠️ **The bot is missing permissions in this channel.**\n\n' +
        'Please ask a server admin to grant the **Ultimate Randomizer** bot these permissions in this channel:\n' +
        '• **View Channel**\n' +
        '• **Send Messages**\n' +
        '• **Embed Links**\n' +
        '• **Attach Files**\n' +
        '• **Read Message History**\n' +
        '• **Manage Messages** (needed to delete extension messages after a draw)\n\n' +
        '*Once permissions are fixed, try the command again.*';
    } else if (err?.code === 10008) {
      userMsg = 'The message this action refers to no longer exists. Please start over.';
    } else if (err?.code === 50035) {
      userMsg = 'Invalid input — please check your entries and try again.';
    }

    const reply = { content: userMsg, ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    } catch (e2) {
      console.error(`[ERROR] Could not send error reply — user=${userId}:`, e2.message);
    }
  }
});

// ── /randomizer subcommands ──────────────────────────────────────────────────

async function handleRandomizer(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const existing = db.getActiveRaffle(interaction.channelId);
    if (existing) {
      return interaction.reply({
        content: 'There is already an active randomizer in this channel. Cancel or draw it first.',
        ephemeral: true
      });
    }
    const modal = buildCreateModal();
    await interaction.showModal(modal);
  }

  if (sub === 'draw') {
    await handleDraw(interaction);
  }

  if (sub === 'cancel') {
    await handleCancel(interaction);
  }

  if (sub === 'settings') {
    await handleSettings(interaction);
  }

  if (sub === 'mark-donated') {
    await handleMarkPaid(interaction);
  }

  if (sub === 'status') {
    await handleStatus(interaction);
  }
}

// ── Draw — show mode choice ──────────────────────────────────────────────────

async function handleDraw(interaction) {
  const raffle = db.getActiveRaffle(interaction.channelId);
  if (!raffle) {
    return interaction.reply({ content: 'No active randomizer in this channel.', ephemeral: true });
  }

  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can draw a winner.', ephemeral: true });
  }
  if (await showPersistedDrawSession(interaction, raffle)) return;

  const picks = db.getPicks(raffle.id);
  if (picks.length === 0) {
    return interaction.reply({ content: 'No numbers have been picked yet.', ephemeral: true });
  }

  // Block draw if not all slots are filled
  if (picks.length < raffle.total_slots) {
    const remaining = raffle.total_slots - picks.length;
    return interaction.reply({
      content: `Cannot draw yet — ${remaining} spot(s) still open. All ${raffle.total_slots} spots must be filled before drawing.`,
      ephemeral: true
    });
  }

  // Block draw if not all marked as donated
  const notDonated = picks.filter(p => !p.paid);
  if (notDonated.length > 0) {
    const notDonatedList = notDonated.map(p => `#${p.slot_number} (${p.username})`).join(', ');
    return interaction.reply({
      content: `Cannot draw yet — ${notDonated.length} spot(s) not donated: ${notDonatedList}\n\nAll spots must be marked as donated before drawing.`,
      ephemeral: true
    });
  }

  // Show draw mode choice
  await showDrawModeChoice(interaction, raffle);
}

// ── Cancel ───────────────────────────────────────────────────────────────────

async function handleCancel(interaction) {
  const raffle = db.getActiveRaffle(interaction.channelId);
  if (!raffle) {
    return interaction.reply({ content: 'No active randomizer in this channel.', ephemeral: true });
  }

  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can cancel this randomizer.', ephemeral: true });
  }
  if (isDrawLocked(raffle.id)) {
    return interaction.reply({ content: 'The draw is in progress; this randomizer cannot be cancelled.', ephemeral: true });
  }

  // Show confirmation prompt
  await showCancelConfirmation(interaction, raffle);
}

// Build a confirmation prompt before actually cancelling
async function showCancelConfirmation(interaction, raffle) {
  const picks = db.getPicks(raffle.id);
  const claimedCount = picks.filter(p => p.user_id).length;
  const paidCount = picks.filter(p => p.paid).length;
  const prizeName = raffle.prize.split('\n')[0];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_cancel_${raffle.id}`)
      .setLabel('Yes, Cancel It')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('⚠️'),
    new ButtonBuilder()
      .setCustomId(`abort_cancel_${raffle.id}`)
      .setLabel('No, Keep It')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('❌')
  );

  await interaction.reply({
    content: `⚠️ **Are you sure you want to cancel this randomizer?**\n\n**${prizeName}**\n• ${claimedCount}/${raffle.total_slots} spots claimed\n• ${paidCount} donations marked\n\n*This will delete the board and all extension messages. Picks are preserved but the board cannot be easily recovered.*`,
    components: [row],
    ephemeral: true
  });
}

// Actually perform the cancel (called after confirmation)
async function performCancel(raffle, byUserId) {
  console.log(`[ADMIN] Cancelling raffle — id=${raffle.id} by=${byUserId}`);
  if (!db.cancelRaffle(raffle.id)) return false;
  clearBannerCache(raffle.id);

  try {
    const channel = await client.channels.fetch(raffle.channel_id);
    if (channel) {
      try {
        const boardMsg = await channel.messages.fetch(raffle.message_id);
        if (boardMsg) await boardMsg.delete();
      } catch (err) {
        console.warn(`[ADMIN] Cancel: board message already gone — raffle=${raffle.id}:`, err.message);
      }

      const extIds = db.getExtensionMessages(raffle.id);
      for (const extId of extIds) {
        try {
          const extMsg = await channel.messages.fetch(extId);
          if (extMsg) await extMsg.delete();
        } catch (err) {
          console.warn(`[ADMIN] Cancel: extension already gone — ext=${extId}:`, err.message);
        }
      }

      const cancelPrizeName = raffle.prize.split('\n')[0];
      await channel.send({ content: `Randomizer for **${cancelPrizeName}** has been cancelled.` });
    }
  } catch (err) {
    console.error(`[ADMIN] Cancel: failed to clean up — raffle=${raffle.id}:`, err.message);
  }

  console.log(`[ADMIN] Raffle cancelled — id=${raffle.id}`);
  return true;
}

async function handleCancelConfirm(interaction) {
  const raffleId = parseInt(interaction.customId.replace('confirm_cancel_', ''), 10);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.update({ content: 'This randomizer is no longer active.', components: [] });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.update({ content: 'Only the creator can cancel this randomizer.', components: [] });
  }
  if (isDrawLocked(raffle.id)) {
    return interaction.update({ content: 'The draw is in progress; this randomizer cannot be cancelled.', components: [] });
  }

  await interaction.update({ content: 'Cancelling randomizer...', components: [] });
  const cancelled = await performCancel(raffle, interaction.user.id);
  await interaction.editReply({
    content: cancelled ? '✅ Randomizer cancelled.' : 'This randomizer changed before it could be cancelled.',
    components: []
  });
}

async function handleCancelAbort(interaction) {
  await interaction.update({
    content: '✅ Cancel aborted — the randomizer is still active.',
    components: []
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────

async function handleSettings(interaction) {
  const raffle = db.getActiveRaffle(interaction.channelId);
  if (!raffle) {
    return interaction.reply({ content: 'No active randomizer in this channel.', ephemeral: true });
  }

  const picks = db.getPicks(raffle.id);
  const embed = buildSettingsEmbed(raffle, picks);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Mark Donated ─────────────────────────────────────────────────────────────

async function handleMarkPaid(interaction) {
  const raffle = db.getActiveRaffle(interaction.channelId);
  if (!raffle) {
    return interaction.reply({ content: 'No active randomizer in this channel.', ephemeral: true });
  }

  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can mark donations.', ephemeral: true });
  }
  if (isDrawLocked(raffle.id)) {
    return interaction.reply({ content: 'The draw is in progress; donation changes are temporarily locked.', ephemeral: true });
  }

  const input = interaction.options.getString('numbers');
  const numbers = [...new Set(input
    .split(/[,\s]+/)
    .map(n => parseInt(n.trim(), 10))
    .filter(n => !isNaN(n) && n >= 1 && n <= raffle.total_slots))];

  if (numbers.length === 0) {
    return interaction.reply({
      content: 'No valid numbers provided. Use format: `5,12,23`',
      ephemeral: true
    });
  }

  const results = db.markPaid(raffle.id, numbers);
  const summary = results.map(r =>
    r.updated ? `#${r.slot} \u2014 \u2705 marked donated` : `#${r.slot} \u2014 not found or unclaimed`
  ).join('\n');

  // Acknowledge first (3s deadline), then update the board.
  await interaction.reply({ content: fitMessageContent(summary), ephemeral: true });
  updateBoardMessage(raffle);
}

// ── /pick command ────────────────────────────────────────────────────────────

async function handlePick(interaction) {
  const raffle = db.getActiveRaffle(interaction.channelId);
  if (!raffle) {
    return interaction.reply({ content: 'No active randomizer in this channel.', ephemeral: true });
  }
  if (isDrawLocked(raffle.id)) {
    return interaction.reply({ content: 'The draw is in progress; picks are temporarily locked.', ephemeral: true });
  }

  // Block picks when board is locked (admin assign only)
  if (raffle.assign_only && !isCreator(raffle, interaction.user.id)) {
    console.log(`[PICK] Blocked locked board pick — user=${interaction.user.id} raffle=${raffle.id}`);
    return interaction.reply({ content: '\uD83D\uDD12 This board is locked. Only the admin can assign spots.', ephemeral: true });
  }

  const input = interaction.options.getString('numbers');
  const numbers = [...new Set(input
    .split(/[,\s]+/)
    .map(n => parseInt(n.trim(), 10))
    .filter(n => !isNaN(n)))];

  if (numbers.length === 0) {
    return interaction.reply({
      content: 'Please provide valid number(s). Example: `/pick 5` or `/pick 3,7,12`',
      ephemeral: true
    });
  }

  const username = interaction.member?.displayName || interaction.user.username;
  const results = [];
  const claimedSlots = [];

  console.log(`[PICK] /pick command — user=${username}(${interaction.user.id}) raffle=${raffle.id} numbers=[${numbers.join(',')}]`);

  for (const num of numbers) {
    if (num < 1 || num > raffle.total_slots) {
      results.push(`#${num} \u2014 invalid (must be 1\u2013${raffle.total_slots})`);
      continue;
    }

    const result = db.pickSlotWithLimit(raffle.id, num, interaction.user.id, username, raffle.max_picks_per_user);

    if (result.error === 'limit_reached') {
      console.log(`[PICK] Limit reached — user=${username} raffle=${raffle.id} slot=#${num} max=${raffle.max_picks_per_user}`);
      results.push(`#${num} \u2014 you've reached the max of ${raffle.max_picks_per_user} picks`);
      break;
    } else if (result.error === 'taken') {
      const taken = db.getSlot(raffle.id, num);
      console.log(`[PICK] Slot taken — raffle=${raffle.id} slot=#${num} by=${taken ? taken.username : 'unknown'}`);
      results.push(`#${num} \u2014 already taken by ${taken ? taken.username : 'someone'}`);
    } else if (result.success) {
      console.log(`[PICK] Claimed — user=${username}(${interaction.user.id}) raffle=${raffle.id} slot=#${num}`);
      results.push(`#${num} \u2014 \u2705 claimed!`);
      claimedSlots.push(num);
    } else if (result.error === 'inactive') {
      results.push('The randomizer is no longer active.');
      break;
    } else if (result.error === 'drawing') {
      results.push('The draw is in progress; picks are temporarily locked.');
      break;
    }
  }

  // Acknowledge the interaction first (3s deadline), then do the slower board
  // edit. Editing before replying risked a 10062 "Unknown interaction" under load.
  await interaction.reply({ content: fitMessageContent(results.join('\n')), ephemeral: true });
  if (claimedSlots.length > 0) queueRaffleUpdate(raffle, claimedSlots);
}

// ── Button click handler ─────────────────────────────────────────────────────

async function handleButtonPick(interaction) {
  const parts = interaction.customId.split('_');
  const raffleId = parseInt(parts[1], 10);
  const slotNumber = parseInt(parts[2], 10);

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || raffle.channel_id !== interaction.channelId) {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  const extIds = db.getExtensionMessages(raffle.id);
  if (interaction.message.id !== raffle.message_id && !extIds.includes(interaction.message.id)) {
    return interaction.reply({ content: 'This is an old randomizer board. Use the current board instead.', ephemeral: true });
  }
  if (!Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > raffle.total_slots) {
    return interaction.reply({ content: 'That spot is invalid.', ephemeral: true });
  }
  if (isDrawLocked(raffle.id)) {
    return interaction.reply({ content: 'The draw is in progress; picks are temporarily locked.', ephemeral: true });
  }

  // Locked board: block regular users, show user picker for admin
  if (raffle.assign_only) {
    if (!isCreator(raffle, interaction.user.id)) {
      console.log(`[PICK] Blocked locked board click — user=${interaction.user.id} raffle=${raffle.id} slot=#${slotNumber}`);
      return interaction.reply({ content: '\uD83D\uDD12 This board is locked. Only the admin can assign spots.', ephemeral: true });
    }

    // Admin clicked a number on a locked board — show member picker for this slot
    const existing = db.getSlot(raffle.id, slotNumber);
    if (existing) {
      return interaction.reply({ content: `Spot #${slotNumber} is already taken by ${existing.username}.`, ephemeral: true });
    }
    console.log(`[ASSIGN] Admin direct assign started — raffle=${raffle.id} slot=#${slotNumber}`);

    const userMenu = new UserSelectMenuBuilder()
      .setCustomId(`assign_direct_${raffle.id}_${slotNumber}`)
      .setPlaceholder(`Assign spot #${slotNumber} to...`)
      .setMinValues(1)
      .setMaxValues(1);

    const row = new ActionRowBuilder().addComponents(userMenu);

    return interaction.reply({
      content: `**Assign spot #${slotNumber}** — select a member:`,
      components: [row],
      ephemeral: true
    });
  }

  const username = interaction.member?.displayName || interaction.user.username;
  const result = db.pickSlotWithLimit(raffle.id, slotNumber, interaction.user.id, username, raffle.max_picks_per_user);

  if (result.error === 'limit_reached') {
    console.log(`[PICK] Button limit reached — user=${username}(${interaction.user.id}) raffle=${raffle.id} slot=#${slotNumber}`);
    return interaction.reply({
      content: `You've reached the maximum of ${raffle.max_picks_per_user} picks.`,
      ephemeral: true
    });
  }

  if (result.error === 'taken') {
    console.log(`[PICK] Button slot taken — raffle=${raffle.id} slot=#${slotNumber}`);
    return interaction.reply({
      content: `Spot #${slotNumber} is already taken.`,
      ephemeral: true
    });
  }

  if (result.error === 'inactive') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }

  if (result.error === 'drawing') {
    return interaction.reply({ content: 'The draw is in progress; picks are temporarily locked.', ephemeral: true });
  }

  console.log(`[PICK] Button claimed — user=${username}(${interaction.user.id}) raffle=${raffle.id} slot=#${slotNumber}`);
  const picks = db.getPicks(raffle.id);
  console.log(`[PICK] Raffle ${raffle.id} progress: ${picks.length}/${raffle.total_slots} slots filled`);

  // Determine if this button was on the main board or an extension
  const clickedExtIndex = extIds.indexOf(interaction.message.id);

  if (clickedExtIndex >= 0) {
    // Clicked on an extension — update that extension in place, fire other updates in background
    const allExtSets = buildExtensionComponents(raffle, picks);
    if (allExtSets[clickedExtIndex]) {
      await interaction.update({ components: allExtSets[clickedExtIndex] });
    } else {
      await interaction.deferUpdate();
    }
    // The clicked extension is current; only the summary on the main board changed.
    queueRaffleUpdate(raffle);
  } else {
    // Clicked on main board — update main board in place, fire extension updates debounced
    const embed = buildBoardEmbed(raffle, picks);
    const components = buildComponents(raffle, picks);
    await interaction.update({ embeds: [embed], components });
  }
}

// ── Modal submit handler ─────────────────────────────────────────────────────

async function handleCreateModalSubmit(interaction) {
  console.log('[CREATE] Page 1 submitted by', interaction.user.id);
  const parsed = parseModalValues(interaction);

  if (parsed.error) {
    console.log('[CREATE] Validation error:', parsed.error);
    return interaction.reply({ content: parsed.error, ephemeral: true });
  }

  const { prize, totalSlots, price, maxPicksPerUser, numWinners } = parsed;

  // Store pending data for page 2
  const pendingKey = `${interaction.guildId}_${interaction.channelId}_${interaction.user.id}`;
  pendingRaffles.set(pendingKey, {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    prize, totalSlots, price, maxPicksPerUser, numWinners,
    timestamp: Date.now()
  });

  // Auto-expire after 60 minutes
  setTimeout(() => pendingRaffles.delete(pendingKey), 60 * 60 * 1000);

  // Show page 2: Add Rules, Lock toggle, or Create
  const isLocked = false; // Fresh creation is always unlocked
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_add_rules_${pendingKey}`)
      .setLabel('Add Rules')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83D\uDCDD'),
    new ButtonBuilder()
      .setCustomId(`wizard_lock_${pendingKey}`)
      .setLabel(isLocked ? 'Locked — Admin Only' : 'Lock Board')
      .setStyle(isLocked ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji(isLocked ? '\uD83D\uDD12' : '\uD83D\uDD13'),
    new ButtonBuilder()
      .setCustomId(`wizard_create_${pendingKey}`)
      .setLabel('Create Raffle')
      .setStyle(ButtonStyle.Success)
      .setEmoji('\u2705')
  );

  const summary = [
    `**Prize:** ${prize}`,
    `**Spots:** ${totalSlots}`,
    price ? `**Donation:** ${price}` : null,
    maxPicksPerUser > 0 ? `**Max Picks:** ${maxPicksPerUser}` : `**Max Picks:** Unlimited`,
    numWinners > 1 ? `**Winners:** ${numWinners}` : null,
    isLocked ? '\uD83D\uDD12 **Board Locked** — Admin assignment only' : null
  ].filter(Boolean).join('\n');

  await interaction.reply({
    content: summary,
    components: [row1],
    ephemeral: true
  });
}

// ── Wizard: Add Rules button → show rules modal ─────────────────────────────

async function handleWizardAddRules(interaction) {
  const pendingKey = interaction.customId.replace('wizard_add_rules_', '');
  const pending = pendingRaffles.get(pendingKey);
  if (!pending) {
    return interaction.reply({ content: 'This setup has expired. Please run `/randomizer create` again.', ephemeral: true });
  }

  const modal = buildRulesModal(pendingKey);
  await interaction.showModal(modal);
}

// ── Wizard: Lock toggle → toggle assign_only in pending data ─────────────────

async function handleWizardLock(interaction) {
  const pendingKey = interaction.customId.replace('wizard_lock_', '');
  const pending = pendingRaffles.get(pendingKey);
  if (!pending) {
    return interaction.reply({ content: 'This setup has expired. Please run `/randomizer create` again.', ephemeral: true });
  }

  // Toggle the lock
  pending.assignOnly = !pending.assignOnly;
  const isLocked = pending.assignOnly;

  const { prize, totalSlots, price, maxPicksPerUser, numWinners } = pending;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`wizard_add_rules_${pendingKey}`)
      .setLabel('Add Rules')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83D\uDCDD'),
    new ButtonBuilder()
      .setCustomId(`wizard_lock_${pendingKey}`)
      .setLabel(isLocked ? 'Locked — Admin Only' : 'Lock Board')
      .setStyle(isLocked ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji(isLocked ? '\uD83D\uDD12' : '\uD83D\uDD13'),
    new ButtonBuilder()
      .setCustomId(`wizard_create_${pendingKey}`)
      .setLabel('Create Raffle')
      .setStyle(ButtonStyle.Success)
      .setEmoji('\u2705')
  );

  const summary = [
    `**Prize:** ${prize}`,
    `**Spots:** ${totalSlots}`,
    price ? `**Donation:** ${price}` : null,
    maxPicksPerUser > 0 ? `**Max Picks:** ${maxPicksPerUser}` : `**Max Picks:** Unlimited`,
    numWinners > 1 ? `**Winners:** ${numWinners}` : null,
    pending.rules ? `**Rules:** ${pending.rules}` : null,
    isLocked ? '\uD83D\uDD12 **Board Locked** — Admin assignment only' : null
  ].filter(Boolean).join('\n');

  await interaction.update({
    content: summary,
    components: [row1]
  });
}

// ── Wizard: Create button → create raffle without rules ──────────────────────

async function handleWizardCreate(interaction) {
  const pendingKey = interaction.customId.replace('wizard_create_', '');
  const pending = pendingRaffles.get(pendingKey);
  if (!pending) {
    return interaction.reply({ content: 'This setup has expired. Please run `/randomizer create` again.', ephemeral: true });
  }

  pendingRaffles.delete(pendingKey);
  await interaction.update({ content: 'Creating board...', components: [] });
  await createRaffleFromPending(interaction, pending, null);
}

// ── Wizard: Rules modal submitted → create raffle ────────────────────────────

async function handleRulesModalSubmit(interaction) {
  const pendingKey = interaction.customId.replace('randomizer_rules_modal_', '');
  const pending = pendingRaffles.get(pendingKey);
  if (!pending) {
    return interaction.reply({ content: 'This setup has expired. Please run `/randomizer create` again.', ephemeral: true });
  }

  pendingRaffles.delete(pendingKey);
  const rules = interaction.fields.getTextInputValue('rules')?.trim() || null;
  await interaction.deferReply({ ephemeral: true });
  await createRaffleFromPending(interaction, pending, rules);
}

// ── Shared raffle creation from pending data ─────────────────────────────────

async function createRaffleFromPending(interaction, pending, rules) {
  const { prize, totalSlots, price, maxPicksPerUser, numWinners } = pending;

  // Re-check at insert time. The "one active per channel" guard runs when the
  // modal opens, but two setup flows can race between then and here. Re-checking
  // closes that window so a channel can't end up with two live boards.
  const alreadyActive = db.getCreatingOrActiveRaffle(pending.channelId);
  if (alreadyActive) {
    console.log(`[CREATE] Aborted — channel already has active raffle ${alreadyActive.id} (channel=${pending.channelId})`);
    try {
      const msg = { content: 'There is already an active randomizer in this channel. Cancel or draw it first.', components: [], embeds: [] };
      if (interaction.replied || interaction.deferred) await interaction.editReply(msg);
      else await interaction.reply({ ...msg, ephemeral: true });
    } catch (_) { /* ephemeral cleanup */ }
    return;
  }

  console.log('[CREATE] Creating raffle...');
  const raffleId = db.createRaffle(
    pending.guildId,
    pending.channelId,
    prize,
    price,
    totalSlots,
    pending.userId,
    maxPicksPerUser,
    rules,
    numWinners || 1
  );
  console.log('[CREATE] Raffle created, ID:', raffleId);

  // Apply lock mode if set in wizard
  if (pending.assignOnly) {
    db.toggleAssignOnly(raffleId);
  }

  const raffle = db.getRaffleById(raffleId);
  const picks = [];
  const postedIds = [];
  let channel;
  try {
    const embed = buildBoardEmbed(raffle, picks);
    const components = buildComponents(raffle, picks);
    const bannerPrize = prize.split('\n')[0];
    const bannerBuffer = await generateBanner(bannerPrize, raffleId);
    const attachment = new AttachmentBuilder(bannerBuffer, { name: 'banner.png' });

    channel = await client.channels.fetch(pending.channelId);
    const msg = await channel.send({ embeds: [embed], components, files: [attachment] });
    postedIds.push(msg.id);

    const extIds = [];
    const extMessageSets = buildExtensionComponents(raffle, picks);
    for (let ei = 0; ei < extMessageSets.length; ei++) {
      const extMsg = await channel.send({ components: extMessageSets[ei] });
      extIds.push(extMsg.id);
      postedIds.push(extMsg.id);
    }

    if (!db.replaceRaffleMessages(raffleId, msg.id, extIds) || !db.activateRaffle(raffleId)) {
      throw new Error('Could not activate the new randomizer');
    }
    console.log(`[CREATE] Board activated — raffle=${raffleId} message=${msg.id} extensions=${extIds.length}`);

    try {
      await interaction.editReply({ content: 'Board created!', components: [] });
    } catch (_) { /* ephemeral cleanup */ }
  } catch (err) {
    db.cancelRaffle(raffleId);
    clearBannerCache(raffleId);
    if (channel) {
      await Promise.allSettled(postedIds.map(messageId => channel.messages.delete(messageId)));
    }
    console.error(`[CREATE] Publication rolled back — raffle=${raffleId}:`, err.message);
    try {
      await interaction.editReply({ content: `Board creation failed: ${err.message}`, components: [] });
    } catch (_) { /* original interaction may have expired */ }
  }
}

// ── Draw mode choice ─────────────────────────────────────────────────────────

async function showDrawModeChoice(interaction, raffle, drawMode = 'normal') {
  const numWinners = raffle.num_winners || 1;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`draw_mode_auto_${raffle.id}_${drawMode}`)
      .setLabel(`Draw All at Once (${numWinners})`)
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83C\uDFB0'),
    new ButtonBuilder()
      .setCustomId(`draw_mode_manual_${raffle.id}_${drawMode}`)
      .setLabel('Draw One at a Time')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('\uD83C\uDFB2')
  );

  const replyOptions = {
    content: '**How would you like to draw?**\n\n\uD83C\uDFB0 **All at Once** — draws all winners immediately\n\uD83C\uDFB2 **One at a Time** — draw winners one by one (supports bonus picks)',
    components: [row],
    ephemeral: true
  };

  // Handle both slash command and button interactions
  if (interaction.deferred) {
    await interaction.followUp(replyOptions);
  } else if (interaction.replied) {
    await interaction.followUp(replyOptions);
  } else {
    await interaction.reply(replyOptions);
  }
}

// ── Draw mode: All at Once ───────────────────────────────────────────────────

async function publishCompletedDraw(raffle, picks, winners, channel) {
  const embeds = buildWinnerEmbeds(raffle, picks, winners);
  const boardResult = await Promise.allSettled([
    editDiscordMessageWithRetry(channel, raffle.message_id, { embeds, components: [] }, raffle.id)
  ]);
  if (boardResult[0].status === 'rejected') {
    console.error(`[DRAW] Failed to update completed board — raffle=${raffle.id}:`, boardResult[0].reason?.message);
  }

  const extIds = db.getExtensionMessages(raffle.id);
  const deleteResults = await Promise.allSettled(extIds.map(extId => channel.messages.delete(extId)));
  const deleteFailures = deleteResults.filter(result => result.status === 'rejected').length;
  if (deleteFailures > 0) {
    console.warn(`[DRAW] Failed to delete ${deleteFailures}/${extIds.length} extensions — raffle=${raffle.id}`);
  }
}

async function handleDrawModeAuto(interaction) {
  const { raffleId, drawMode } = parseDrawModeId(interaction.customId, 'draw_mode_auto_');
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || raffle.channel_id !== interaction.channelId) {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can draw a winner.', ephemeral: true });
  }
  await runAutomaticDraw(interaction, raffle, drawMode);
}

// ── Draw mode: One at a Time (start manual draw) ─────────────────────────────

async function handleDrawModeManual(interaction) {
  const { raffleId, drawMode } = parseDrawModeId(interaction.customId, 'draw_mode_manual_');
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || raffle.channel_id !== interaction.channelId) {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can draw a winner.', ephemeral: true });
  }

  if (!beginDrawOperation(raffleId)) {
    return interaction.reply({ content: 'A draw is already in progress for this randomizer.', ephemeral: true });
  }

  try {
    const started = db.startDrawSession(raffleId, interaction.user.id, 'manual', drawMode);
    if (started.error && started.error !== 'already_drawing') {
      return interaction.reply({ content: drawStartErrorMessage(started), ephemeral: true });
    }
    if (started.session?.kind === 'auto') {
      return interaction.update(buildAutomaticResumePayload(raffleId));
    }

    await interaction.update({
      content: started.success ? 'Starting manual draw...' : 'Resuming manual draw...',
      components: []
    });
    let session = started.session || db.getDrawSession(raffleId);
    let initializedNow = false;
    const picks = started.picks || db.getPicks(raffleId);
    if (!session?.pool) {
      const initialized = db.initializeDrawSession(raffleId, cryptoShuffle(picks), 1);
      if (!initialized.success) throw new Error(`Could not initialize draw session: ${initialized.error}`);
      session = initialized.session;
      initializedNow = !initialized.existing;
    }

    console.log(`[DRAW] Manual draw ready — raffle=${raffle.id} winners=${session.drawnWinners.length} remaining=${session.remainingPicks.length} by=${interaction.user.id}`);
    const channel = client.channels.cache.get(raffle.channel_id) || await client.channels.fetch(raffle.channel_id);
    if (initializedNow) {
      try {
        await playDrawAnimationInChannel(channel, raffle, picks, [session.drawnWinners[0]], 1);
      } catch (err) {
        console.error(`[DRAW] First manual announcement failed — raffle=${raffleId}:`, err.message);
      }
    }
    await interaction.editReply(buildManualDrawPayload(raffleId, session));
  } catch (err) {
    console.error(`[DRAW] Manual draw start/resume failed — raffle=${raffleId}:`, err.message);
    try { await interaction.editReply({ content: `Draw session is saved, but Discord presentation failed: ${err.message}`, components: [] }); } catch (_) {}
  } finally {
    endDrawOperation(raffleId);
  }
}

// ── Manual draw: Draw next winner ────────────────────────────────────────────

async function handleManualDrawNext(interaction) {
  const raffleId = parseInt(interaction.customId.replace('manual_draw_next_', ''), 10);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can continue this draw.', ephemeral: true });
  }
  if (!beginDrawOperation(raffleId)) {
    return interaction.reply({ content: 'The previous draw action is still running.', ephemeral: true });
  }
  try {
    let session = db.getDrawSession(raffleId);
    if (!session || session.kind !== 'manual') {
      return interaction.reply({ content: 'No manual draw session is available.', ephemeral: true });
    }
    let recoveredFirstWinner = false;
    if (!session.pool) {
      const initialized = db.initializeDrawSession(raffleId, cryptoShuffle(db.getPicks(raffleId)), 1);
      if (!initialized.success) throw new Error(`Could not recover draw session: ${initialized.error}`);
      session = initialized.session;
      recoveredFirstWinner = !initialized.existing;
    }
    if (!recoveredFirstWinner && session.remainingPicks.length === 0) {
      return finishManualDraw(interaction, raffleId, true);
    }

    await interaction.update({
      content: recoveredFirstWinner ? 'Recovering first winner...' : 'Drawing next winner...',
      components: []
    });
    if (recoveredFirstWinner) {
      const firstWinner = session.drawnWinners[0];
      const channel = client.channels.cache.get(raffle.channel_id) || await client.channels.fetch(raffle.channel_id);
      try {
        await playDrawAnimationInChannel(channel, raffle, session.pool, [firstWinner], 1);
      } catch (err) {
        console.error(`[DRAW] Recovered first winner announcement failed — raffle=${raffleId}:`, err.message);
      }
      if (session.remainingPicks.length === 0) {
        await finishManualDraw(interaction, raffleId, true);
        return;
      }
      await interaction.editReply(buildManualDrawPayload(raffleId, session));
      return;
    }

    const advanced = db.advanceDrawSession(raffleId);
    if (!advanced.success) throw new Error(`Could not persist next winner: ${advanced.error}`);
    session = advanced.session;
    const winner = advanced.winner;
    console.log(`[DRAW] Winner #${session.drawnWinners.length} persisted — raffle=${raffleId} slot=#${winner.slot_number} remaining=${session.remainingPicks.length}`);

    const channel = client.channels.cache.get(raffle.channel_id) || await client.channels.fetch(raffle.channel_id);
    const winnerNumber = session.drawnWinners.length;
    try {
      await playDrawAnimationInChannel(channel, raffle, session.pool, [winner], winnerNumber);
    } catch (err) {
      console.error(`[DRAW] Manual winner announcement failed — raffle=${raffleId} winner=${winnerNumber}:`, err.message);
    }

    if (session.remainingPicks.length === 0) {
      await finishManualDraw(interaction, raffleId, true);
      return;
    }
    await interaction.editReply(buildManualDrawPayload(raffleId, session));
  } catch (err) {
    console.error(`[DRAW] Manual next failed — raffle=${raffleId}:`, err.message);
    try { await interaction.editReply({ content: `The draw is saved, but this action failed: ${err.message}`, components: [buildManualDrawRow(raffleId)] }); } catch (_) {}
  } finally {
    endDrawOperation(raffleId);
  }
}

// ── Manual draw: Finish ──────────────────────────────────────────────────────

async function handleManualDrawFinish(interaction) {
  const raffleId = parseInt(interaction.customId.replace('manual_draw_finish_', ''), 10);
  await finishManualDraw(interaction, raffleId);
}

async function finishManualDraw(interaction, raffleId, alreadyBusy = false) {
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can finish this draw.', ephemeral: true });
  }
  if (!alreadyBusy && !beginDrawOperation(raffleId)) {
    return interaction.reply({ content: 'The previous draw action is still running.', ephemeral: true });
  }
  let committed = false;
  try {
    const session = db.getDrawSession(raffleId);
    if (!session || session.kind !== 'manual') {
      return interaction.reply({ content: 'No manual draw session is available.', ephemeral: true });
    }
    if (!interaction.replied && !interaction.deferred) {
      await interaction.update({ content: 'Finishing draw...', components: [] });
    }
    const completed = db.completeDrawSession(raffleId);
    if (!completed.success) throw new Error(`Could not complete persisted draw: ${completed.error}`);
    committed = true;
    const winners = completed.winners;
    clearBannerCache(raffleId);
    console.log(`[DRAW] Manual draw committed — raffle=${raffle.id} winners=${winners.length}`);

    try {
      const channel = client.channels.cache.get(raffle.channel_id) || await client.channels.fetch(raffle.channel_id);
      await publishCompletedDraw(raffle, db.getPicks(raffleId), winners, channel);
    } catch (err) {
      console.error(`[DRAW] Manual draw committed but board publication failed — raffle=${raffleId}:`, err.message);
    }

    const replyContent = fitMessageContent(`\u2705 **Raffle Complete!** ${winners.length} winner(s) drawn.\n\n${formatManualWinnerList(winners)}`);
    try {
      await interaction.editReply({ content: replyContent, components: [] });
    } catch (err) {
      console.error(`[DRAW] Manual draw committed but confirmation failed — raffle=${raffleId}:`, err.message);
    }
  } catch (err) {
    console.error(`[DRAW] Failed to finish manual draw — raffle=${raffle.id} committed=${committed}:`, err.message);
    if (!committed) {
      try { await interaction.editReply({ content: `Could not finish draw: ${err.message}`, components: [] }); } catch (_) {}
    }
  } finally {
    if (!alreadyBusy) endDrawOperation(raffleId);
  }
}

function buildManualDrawRow(raffleId, canDrawNext = true, canFinish = true) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`manual_draw_next_${raffleId}`)
      .setLabel('Draw Next Winner')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83C\uDFB0')
      .setDisabled(!canDrawNext),
    new ButtonBuilder()
      .setCustomId(`manual_draw_finish_${raffleId}`)
      .setLabel('Finish')
      .setStyle(ButtonStyle.Success)
      .setEmoji('\u2705')
      .setDisabled(!canFinish)
  );
}

function buildManualDrawPayload(raffleId, session) {
  if (!session.pool) {
    return {
      content: 'This manual draw was saved before the first winner was finalized. Resume it to continue safely.',
      components: [buildManualDrawRow(raffleId, true, false)]
    };
  }
  return {
    content: `**Winners Drawn:**\n${formatManualWinnerList(session.drawnWinners)}\n\n*${session.remainingPicks.length} spot(s) remaining to draw from.*`,
    components: [buildManualDrawRow(raffleId, session.remainingPicks.length > 0)]
  };
}

function buildAutomaticResumePayload(raffleId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`resume_draw_auto_${raffleId}`)
      .setLabel('Resume Automatic Draw')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83C\uDFB0')
  );
  return { content: 'An automatic draw is saved and ready to resume.', components: [row] };
}

async function handleResumeAutoDraw(interaction) {
  const raffleId = parseInt(interaction.customId.replace('resume_draw_auto_', ''), 10);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || raffle.channel_id !== interaction.channelId) {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can resume this draw.', ephemeral: true });
  }
  const session = db.getDrawSession(raffleId);
  await runAutomaticDraw(interaction, raffle, session?.validation_mode || 'normal');
}

async function runAutomaticDraw(interaction, raffle, drawMode) {
  const raffleId = raffle.id;
  if (!beginDrawOperation(raffleId)) {
    return interaction.reply({ content: 'The previous draw action is still running.', ephemeral: true });
  }

  let completed = false;
  try {
    const started = db.startDrawSession(raffleId, interaction.user.id, 'auto', drawMode);
    if (started.error && started.error !== 'already_drawing') {
      return interaction.reply({ content: drawStartErrorMessage(started), ephemeral: true });
    }
    if (started.session?.kind === 'manual') {
      return interaction.update(buildManualDrawPayload(raffleId, started.session));
    }

    await interaction.update({
      content: started.success ? 'Drawing winners...' : 'Resuming saved automatic draw...',
      components: []
    });
    let session = started.session || db.getDrawSession(raffleId);
    const picks = started.picks || session?.pool || db.getPicks(raffleId);
    if (!session?.pool) {
      const numWinners = Math.min(raffle.num_winners || 1, picks.length);
      const initialized = db.initializeDrawSession(raffleId, cryptoShuffle(picks), numWinners);
      if (!initialized.success) throw new Error(`Could not initialize draw session: ${initialized.error}`);
      session = initialized.session;
    }

    const result = db.completeDrawSession(raffleId);
    if (!result.success) throw new Error(`Could not commit draw: ${result.error}`);
    completed = true;
    const winners = result.winners;
    clearBannerCache(raffleId);
    console.log(`[DRAW] Automatic winners committed — raffle=${raffleId} winners=${winners.length}`);

    const channel = client.channels.cache.get(raffle.channel_id) || await client.channels.fetch(raffle.channel_id);
    try {
      await playDrawAnimationInChannel(channel, raffle, picks, winners);
    } catch (err) {
      console.error(`[DRAW] Winner announcement failed — raffle=${raffleId}:`, err.message);
    }
    await publishCompletedDraw(raffle, picks, winners, channel);
    await interaction.editReply({ content: `\u2705 Drew ${winners.length} winner(s)!`, components: [] });
  } catch (err) {
    console.error(`[DRAW] Automatic draw failed — raffle=${raffleId} completed=${completed}:`, err.message);
    try {
      await interaction.editReply({
        content: completed
          ? '\u26A0\uFE0F Winners were recorded, but part of the Discord announcement failed. Check the completed board.'
          : `Draw progress was saved but did not finish: ${err.message}`,
        components: completed ? [] : buildAutomaticResumePayload(raffleId).components
      });
    } catch (_) { /* interaction token expired */ }
  } finally {
    endDrawOperation(raffleId);
  }
}

function drawStartErrorMessage(result) {
  switch (result.error) {
    case 'inactive': return 'This randomizer is no longer active.';
    case 'no_picks': return 'No numbers have been picked yet.';
    case 'open_slots': return `Cannot draw yet — ${result.remaining} spot(s) are still open.`;
    case 'unpaid': return `Cannot draw yet — ${result.unpaidCount} spot(s) are not marked donated.`;
    default: return 'The draw could not be started.';
  }
}

function beginDrawOperation(raffleId) {
  if (drawOperations.has(raffleId)) return false;
  drawOperations.add(raffleId);
  return true;
}

function endDrawOperation(raffleId) {
  drawOperations.delete(raffleId);
}

function isDrawLocked(raffleId) {
  return drawOperations.has(raffleId) || db.hasDrawSession(raffleId);
}

async function showPersistedDrawSession(interaction, raffle) {
  const session = db.getDrawSession(raffle.id);
  if (!session) return false;
  const payload = session.kind === 'manual'
    ? buildManualDrawPayload(raffle.id, session)
    : buildAutomaticResumePayload(raffle.id);
  await interaction.reply({ ...payload, ephemeral: true });
  return true;
}

// ── Admin button handlers (on the board itself) ─────────────────────────────

function extractRaffleId(customId) {
  const parts = customId.split('_');
  return parseInt(parts[parts.length - 1], 10);
}

function isCreator(raffle, userId) {
  return raffle.created_by === userId || userId === OWNER_ID;
}

function fitMessageContent(content, maxLength = 1900) {
  if (content.length <= maxLength) return content;
  return `${content.slice(0, maxLength - 40)}\n...additional results omitted.`;
}

function formatManualWinnerList(winners) {
  const lines = winners.map((winner, index) =>
    `**${getOrdinal(index + 1)} Winner:** \uD83C\uDFC6 Spot #${winner.slot_number} — ${winner.username}`
  );
  while (lines.join('\n').length > 1500 && lines.length > 1) lines.shift();
  const omitted = winners.length - lines.length;
  return `${omitted > 0 ? `*${omitted} earlier winner(s) omitted from this panel.*\n` : ''}${lines.join('\n')}`;
}

function parseDrawModeId(customId, prefix) {
  const [raffleIdText, drawMode = 'normal'] = customId.slice(prefix.length).split('_');
  return { raffleId: parseInt(raffleIdText, 10), drawMode: drawMode === 'early' ? 'early' : 'normal' };
}

async function handleAdminPanel(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can access the admin panel.', ephemeral: true });
  }

  const panel = buildAdminPanel(raffle);
  await interaction.reply({ ...panel, ephemeral: true });
}

async function handleAdminDraw(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can draw a winner.', ephemeral: true });
  }
  if (await showPersistedDrawSession(interaction, raffle)) return;

  const picks = db.getPicks(raffle.id);
  if (picks.length === 0) {
    return interaction.reply({ content: 'No numbers have been picked yet.', ephemeral: true });
  }

  // Block draw if not all slots are filled
  if (picks.length < raffle.total_slots) {
    const remaining = raffle.total_slots - picks.length;
    return interaction.reply({
      content: `Cannot draw yet — ${remaining} spot(s) still open. All ${raffle.total_slots} spots must be filled before drawing.\n\nUse **Early Draw** in the admin panel to draw before the board is full.`,
      ephemeral: true
    });
  }

  // Block draw if not all marked as donated
  const notDonated = picks.filter(p => !p.paid);
  if (notDonated.length > 0) {
    const notDonatedList = notDonated.map(p => `#${p.slot_number} (${p.username})`).join(', ');
    return interaction.reply({
      content: `Cannot draw yet — ${notDonated.length} spot(s) not donated: ${notDonatedList}\n\nAll spots must be marked as donated before drawing.`,
      ephemeral: true
    });
  }

  // Show draw mode choice
  await showDrawModeChoice(interaction, raffle);
}

async function handleEarlyDraw(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can draw a winner.', ephemeral: true });
  }
  if (await showPersistedDrawSession(interaction, raffle)) return;

  const picks = db.getPicks(raffle.id);
  const claimedPicks = picks.filter(p => p.user_id);
  if (claimedPicks.length === 0) {
    return interaction.reply({ content: 'No numbers have been picked yet.', ephemeral: true });
  }

  console.log(`[DRAW] Early draw initiated — raffle=${raffle.id} claimed=${claimedPicks.length}/${raffle.total_slots} by=${interaction.user.id}`);

  // Show draw mode choice (draws from claimed picks only)
  await showDrawModeChoice(interaction, raffle, 'early');
}

async function handleAdminPayments(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can manage donations.', ephemeral: true });
  }

  const picks = db.getPicks(raffle.id);
  const claimedCount = picks.filter(p => p.slot_number >= 1).length;

  if (claimedCount === 0) {
    return interaction.reply({ content: 'No numbers have been claimed yet.', ephemeral: true });
  }

  // Send header with embed + Mark All controls
  const header = buildPaymentHeader(raffle, picks);
  await interaction.reply({ ...header, ephemeral: true });

  // Send slot button messages as follow-ups (25 slots each)
  const slotMessages = buildPaymentSlotMessages(raffle, picks);
  const followUpIds = [];

  for (const msg of slotMessages) {
    const followUp = await interaction.followUp({ ...msg, ephemeral: true });
    followUpIds.push(followUp.id);
  }

  // Store session so toggle/mark-all can update all messages
  const sessionKey = `${raffleId}_${interaction.user.id}`;
  paymentPanelSessions.set(sessionKey, { followUpIds, interaction });

  // Auto-expire after 14 minutes — Discord ephemeral webhook tokens die at 15 min
  setTimeout(() => paymentPanelSessions.delete(sessionKey), 14 * 60 * 1000);
}

async function handleAdminSettings(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle) {
    return interaction.reply({ content: 'Randomizer not found.', ephemeral: true });
  }

  const picks = db.getPicks(raffle.id);
  const embed = buildSettingsEmbed(raffle, picks);
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAdminRepost(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can repost the board.', ephemeral: true });
  }
  if (isDrawLocked(raffle.id)) {
    return interaction.reply({ content: 'The draw is in progress; the board cannot be reposted.', ephemeral: true });
  }

  console.log(`[ADMIN] Repost started — raffle=${raffle.id} by=${interaction.user.id}`);
  await interaction.deferUpdate();

  const newMessageIds = [];
  let channel;
  try {
    channel = client.channels.cache.get(raffle.channel_id) || await client.channels.fetch(raffle.channel_id);

    // Save old message IDs before doing anything
    const oldMainMsgId = raffle.message_id;
    const oldExtIds = db.getExtensionMessages(raffle.id);

    // Publish a complete replacement before switching message IDs.
    const picks = db.getPicks(raffle.id);
    const embed = buildBoardEmbed(raffle, picks);
    const components = buildComponents(raffle, picks);
    const bannerBuffer = await generateBanner(raffle.prize, raffle.id);
    const attachment = new AttachmentBuilder(bannerBuffer, { name: 'banner.png' });

    const newMsg = await channel.send({
      embeds: [embed],
      components,
      files: [attachment]
    });
    newMessageIds.push(newMsg.id);

    // Post extension messages if needed
    const extMessageSets = buildExtensionComponents(raffle, picks);
    if (extMessageSets.length > 0) {
      const newExtIds = [];
      for (const extSet of extMessageSets) {
        const extMsg = await channel.send({ components: extSet });
        newExtIds.push(extMsg.id);
      }
      newMessageIds.push(...newExtIds);
    }

    const newExtIds = newMessageIds.slice(1);
    if (!db.replaceRaffleMessages(raffle.id, newMsg.id, newExtIds)) {
      throw new Error('The randomizer changed before the replacement was ready');
    }
    const oldIds = [oldMainMsgId, ...oldExtIds].filter(Boolean);
    const cleanup = await Promise.allSettled(oldIds.map(messageId => channel.messages.delete(messageId)));
    const cleanupFailures = cleanup.filter(result => result.status === 'rejected').length;
    if (cleanupFailures > 0) {
      console.warn(`[ADMIN] Repost: ${cleanupFailures}/${oldIds.length} old messages could not be deleted — raffle=${raffle.id}`);
    }
    console.log(`[ADMIN] Repost complete — raffle=${raffle.id}`);
  } catch (err) {
    if (channel && newMessageIds.length > 0) {
      await Promise.allSettled(newMessageIds.map(messageId => channel.messages.delete(messageId)));
    }
    console.error(`[ADMIN] Repost failed — raffle=${raffle.id}:`, err);
    try {
      await interaction.followUp({ content: `Repost failed: ${err.message}`, ephemeral: true });
    } catch (e2) {
      console.error(`[ADMIN] Repost: couldn't send error followUp:`, e2.message);
    }
  }
}

async function handleAdminCancel(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can cancel this randomizer.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) {
    return interaction.reply({ content: 'The draw is in progress; this randomizer cannot be cancelled.', ephemeral: true });
  }

  console.log(`[ADMIN] Admin panel cancel requested — raffle=${raffle.id} by=${interaction.user.id}`);
  await showCancelConfirmation(interaction, raffle);
}

// ── Donation panel button handlers (ephemeral toggle buttons) ────────────────

// Helper: update all payment panel messages (header + follow-up slot messages)
async function refreshPaymentPanel(interaction, raffle, refreshAllSlots = false) {
  const picks = db.getPicks(raffle.id);
  const sessionKey = `${raffle.id}_${interaction.user.id}`;
  const session = paymentPanelSessions.get(sessionKey);

  if (session && session.followUpIds.length > 0) {
    // Multi-message mode: update the clicked message in place
    const slotMessages = buildPaymentSlotMessages(raffle, picks);

    // Figure out which message was clicked
    const clickedMsgId = interaction.message.id;
    const followUpIndex = session.followUpIds.indexOf(clickedMsgId);

    if (followUpIndex >= 0 && slotMessages[followUpIndex]) {
      // Clicked a slot message — update it in place
      await interaction.update(slotMessages[followUpIndex]);
    } else {
      // Clicked the header — update it in place
      const header = buildPaymentHeader(raffle, picks);
      await interaction.update(header);
    }

    // A single toggle only changes its own slot message plus the header count.
    const origInteraction = session.interaction;
    if (followUpIndex >= 0) {
      try {
        await origInteraction.editReply(buildPaymentHeader(raffle, picks));
      } catch (err) {
        console.warn(`[ADMIN] Failed to update payment header:`, err.message);
      }
    }

    if (refreshAllSlots) {
      const updates = session.followUpIds.map((fid, index) => {
        if (fid === clickedMsgId || !slotMessages[index]) return Promise.resolve();
        return origInteraction.webhook.editMessage(fid, slotMessages[index]);
      });
      const results = await Promise.allSettled(updates);
      const failed = results.filter(result => result.status === 'rejected').length;
      if (failed > 0) {
        console.warn(`[ADMIN] Failed to update ${failed} payment follow-up message(s)`);
      }
    }
  } else {
    // Fallback: single-message mode (small raffles or expired session)
    const panel = buildPaymentPanel(raffle, picks);
    await interaction.update(panel);
  }
}

async function handleTogglePaid(interaction) {
  const parts = interaction.customId.split('_');
  const raffleId = parseInt(parts[2], 10);
  const slotNumber = parseInt(parts[3], 10);

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || !isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can manage donations.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  db.togglePaid(raffleId, slotNumber);
  console.log(`[ADMIN] Toggled donation — raffle=${raffleId} slot=#${slotNumber}`);

  await refreshPaymentPanel(interaction, raffle);
  updateBoardMessage(raffle);
}

async function handleMarkAllPaid(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || !isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can manage donations.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  db.markAllPaid(raffleId);
  console.log(`[ADMIN] Marked all donated — raffle=${raffleId}`);

  await refreshPaymentPanel(interaction, raffle, true);
  updateBoardMessage(raffle);
}

async function handleMarkAllUnpaid(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || !isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can manage donations.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  db.markAllUnpaid(raffleId);
  console.log(`[ADMIN] Marked all not donated — raffle=${raffleId}`);

  await refreshPaymentPanel(interaction, raffle, true);
  updateBoardMessage(raffle);
}

// ── Remove picks handlers ────────────────────────────────────────────────────

async function handleAdminRemove(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can remove picks.', ephemeral: true });
  }

  const picks = db.getPicks(raffle.id);
  const claimedPicks = picks.filter(p => p.slot_number >= 1 && p.user_id);

  if (claimedPicks.length === 0) {
    return interaction.reply({ content: 'No numbers have been claimed yet.', ephemeral: true });
  }

  // Send header with embed
  const header = buildRemoveHeader(raffle, picks);
  await interaction.reply({ ...header, ephemeral: true });

  // Send menu messages as follow-ups (125 slots each)
  const menuMessages = buildRemoveMenuMessages(raffle, picks);
  for (const msg of menuMessages) {
    await interaction.followUp({ ...msg, ephemeral: true });
  }
}

async function handleRemovePick(interaction) {
  const parts = interaction.customId.split('_');
  const raffleId = parseInt(parts[2], 10);
  const slotNumber = parseInt(parts[3], 10);

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || !isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can remove picks.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  db.removePick(raffleId, slotNumber);
  console.log(`[ADMIN] Removed pick — raffle=${raffleId} slot=#${slotNumber}`);

  // Refresh the remove panel
  const picks = db.getPicks(raffleId);
  const panel = buildRemovePanel(raffle, picks);

  if (picks.filter(p => p.user_id).length === 0) {
    await interaction.update({ content: 'All picks have been removed.', embeds: [], components: [] });
  } else {
    await interaction.update(panel);
  }

  queueRaffleUpdate(raffle, [slotNumber]);
}

async function handleRemoveSelect(interaction) {
  const parts = interaction.customId.split('_');
  // remove_select_{raffleId}_{menuIndex}
  const raffleId = parseInt(parts[2], 10);
  const slotNumber = parseInt(interaction.values[0], 10);

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active' || !isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can remove picks.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  db.removePick(raffleId, slotNumber);
  console.log(`[ADMIN] Removed pick (select) — raffle=${raffleId} slot=#${slotNumber}`);

  // Refresh the menu message that was interacted with
  const picks = db.getPicks(raffleId);
  const menuMessages = buildRemoveMenuMessages(raffle, picks);

  // Figure out which message index was clicked based on menuIndex in customId
  const menuIndex = parseInt(parts[3], 10);
  const msgIndex = Math.floor(menuIndex / 5); // 5 menus per message

  if (menuMessages[msgIndex]) {
    await interaction.update(menuMessages[msgIndex]);
  } else {
    // This message has no more picks — clear it
    await interaction.update({ content: `✅ Removed #${slotNumber}. No more picks in this range.`, components: [] });
  }

  queueRaffleUpdate(raffle, [slotNumber]);
}

// ── Admin: Assign Spot (step 1 — show user select menu) ─────────────────────

async function handleAdminAssign(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can assign spots.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  const userMenu = new UserSelectMenuBuilder()
    .setCustomId(`assign_user_${raffleId}`)
    .setPlaceholder('Search and select a member...')
    .setMinValues(1)
    .setMaxValues(1);

  const row = new ActionRowBuilder().addComponents(userMenu);

  await interaction.reply({
    content: '**Step 1:** Select the member to assign a spot to:',
    components: [row],
    ephemeral: true
  });
}

// ── Admin: Assign Spot (step 2 — user selected, show available slots) ───────

async function handleAssignUserSelect(interaction) {
  const raffleId = parseInt(interaction.customId.replace('assign_user_', ''), 10);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can assign spots.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  const selectedUser = interaction.users.first();
  if (!selectedUser) {
    return interaction.reply({ content: 'No user selected.', ephemeral: true });
  }

  // Get the member's display name from the guild
  let displayName = selectedUser.username;
  try {
    const guild = await client.guilds.fetch(raffle.guild_id);
    const member = await guild.members.fetch(selectedUser.id);
    displayName = member.displayName || selectedUser.username;
  } catch (_) { /* fallback to username */ }

  // Store the pending assignment
  pendingAssignments.set(raffleId, {
    userId: selectedUser.id,
    username: displayName,
    adminId: interaction.user.id
  });

  // Auto-expire after 60 minutes
  setTimeout(() => pendingAssignments.delete(raffleId), 60 * 60 * 1000);

  // Build available slots dropdown(s)
  const picks = db.getPicks(raffleId);
  const takenSlots = new Set(picks.map(p => p.slot_number));
  const available = [];
  for (let i = 1; i <= raffle.total_slots; i++) {
    if (!takenSlots.has(i)) {
      available.push(i);
    }
  }

  if (available.length === 0) {
    pendingAssignments.delete(raffleId);
    return interaction.update({ content: 'All spots are taken — no available slots to assign.', components: [] });
  }

  // Split available slots into select menus (max 25 options each, max 5 menus)
  const rows = [];
  const chunkSize = 25;
  for (let i = 0; i < available.length && rows.length < 5; i += chunkSize) {
    const chunk = available.slice(i, i + chunkSize);
    const menuIndex = Math.floor(i / chunkSize);
    const rangeLabel = chunk.length > 1
      ? `#${chunk[0]}–#${chunk[chunk.length - 1]}`
      : `#${chunk[0]}`;

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`assign_slot_select_${raffleId}_${menuIndex}`)
      .setPlaceholder(`Pick a slot — ${rangeLabel}`)
      .addOptions(
        chunk.map(slot => ({
          label: `Spot #${slot}`,
          value: String(slot),
          emoji: '🟢'
        }))
      );

    rows.push(new ActionRowBuilder().addComponents(menu));
  }

  await interaction.update({
    content: `**Step 2:** Assigning to **${displayName}** — select a spot:`,
    components: rows
  });
}

// ── Admin: Assign Spot (step 3 — slot selected, complete assignment) ────────

async function handleAssignSlotConfirm(interaction) {
  const parts = interaction.customId.split('_');
  // assign_slot_select_{raffleId}_{menuIndex}
  const raffleId = parseInt(parts[3], 10);
  const slotNumber = parseInt(interaction.values[0], 10);

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.update({ content: 'This randomizer is no longer active.', components: [] });
  }
  if (!isCreator(raffle, interaction.user.id) || isDrawLocked(raffleId)) {
    return interaction.update({ content: 'This assignment can no longer be completed.', components: [] });
  }

  const assignment = pendingAssignments.get(raffleId);
  if (!assignment) {
    return interaction.update({ content: 'Assignment session expired. Please start over.', components: [] });
  }
  if (assignment.adminId !== interaction.user.id) {
    return interaction.update({ content: 'This assignment belongs to another admin session.', components: [] });
  }

  // Perform the pick (bypass max_picks limit for admin assignment)
  const result = db.pickSlot(raffle.id, slotNumber, assignment.userId, assignment.username);

  pendingAssignments.delete(raffleId);

  if (!result) {
    return interaction.update({ content: `Spot #${slotNumber} is already taken.`, components: [] });
  }

  await interaction.update({
    content: `\u2705 **Assigned spot #${slotNumber}** to **${assignment.username}**`,
    components: []
  });

  // Update the board
  queueRaffleUpdate(raffle, [slotNumber]);
}

// ── Admin: Direct assign (click number → pick member → done) ────────────────

async function handleAssignDirect(interaction) {
  const parts = interaction.customId.split('_');
  // assign_direct_{raffleId}_{slotNumber}
  const raffleId = parseInt(parts[2], 10);
  const slotNumber = parseInt(parts[3], 10);

  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.update({ content: 'This randomizer is no longer active.', components: [] });
  }
  if (!isCreator(raffle, interaction.user.id) || isDrawLocked(raffleId)) {
    return interaction.update({ content: 'This assignment can no longer be completed.', components: [] });
  }

  const selectedUser = interaction.users.first();
  if (!selectedUser) {
    return interaction.update({ content: 'No user selected.', components: [] });
  }

  // Get display name from guild
  let displayName = selectedUser.username;
  try {
    const guild = await client.guilds.fetch(raffle.guild_id);
    const member = await guild.members.fetch(selectedUser.id);
    displayName = member.displayName || selectedUser.username;
  } catch (err) {
    console.warn(`[ASSIGN] Failed to fetch guild member display name — user=${selectedUser.id}:`, err.message);
  }

  // Assign the slot
  const result = db.pickSlot(raffle.id, slotNumber, selectedUser.id, displayName);

  if (!result) {
    console.log(`[ASSIGN] Direct assign failed (taken) — raffle=${raffle.id} slot=#${slotNumber}`);
    return interaction.update({ content: `Spot #${slotNumber} is already taken.`, components: [] });
  }
  console.log(`[ASSIGN] Direct assign success — raffle=${raffle.id} slot=#${slotNumber} user=${displayName}(${selectedUser.id})`);

  await interaction.update({
    content: `\u2705 **Spot #${slotNumber}** assigned to **${displayName}**`,
    components: []
  });

  // Auto-dismiss the confirmation after 3 seconds
  setTimeout(async () => {
    try {
      await interaction.deleteReply();
    } catch (_) { /* already dismissed */ }
  }, 3000);

  // Update the board
  queueRaffleUpdate(raffle, [slotNumber]);
}

// ── Admin: Lock/Unlock board toggle ─────────────────────────────────────────

async function handleAdminLock(interaction) {
  const raffleId = extractRaffleId(interaction.customId);
  const raffle = db.getRaffleById(raffleId);
  if (!raffle || raffle.status !== 'active') {
    return interaction.reply({ content: 'This randomizer is no longer active.', ephemeral: true });
  }
  if (!isCreator(raffle, interaction.user.id)) {
    return interaction.reply({ content: 'Only the creator can lock/unlock the board.', ephemeral: true });
  }
  if (isDrawLocked(raffleId)) return interaction.reply({ content: 'The draw is in progress.', ephemeral: true });

  db.toggleAssignOnly(raffleId);
  const updated = db.getRaffleById(raffleId);
  const isLocked = updated.assign_only === 1;
  console.log(`[ADMIN] Board lock toggled — raffle=${raffleId} locked=${isLocked}`);

  // Refresh the admin panel with updated lock state
  const panel = buildAdminPanel(updated);
  await interaction.update(panel);
}

// ── Channel-based draw animation (for button-triggered draws) ────────────────

async function playDrawAnimationInChannel(channel, raffle, picks, winners, winnerStartNumber = 1) {
  const { EmbedBuilder } = require('discord.js');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  if (!Array.isArray(winners)) winners = [winners];
  const drawWord = winners.length > 1 ? 'winners' : 'winner';

  const countdownFrames = [
    { text: `\uD83E\uDD41\uD83E\uDD41\uD83E\uDD41  Drawing ${drawWord} in...  **5**  \uD83E\uDD41\uD83E\uDD41\uD83E\uDD41`, color: 0xFF4444 },
    { text: `\uD83E\uDD41\uD83E\uDD41\uD83E\uDD41  Drawing ${drawWord} in...  **4**  \uD83E\uDD41\uD83E\uDD41\uD83E\uDD41`, color: 0xFF6622 },
    { text: `\uD83E\uDD41\uD83E\uDD41  Drawing ${drawWord} in...  **3**  \uD83E\uDD41\uD83E\uDD41`, color: 0xFFAA00 },
    { text: `\uD83E\uDD41\uD83E\uDD41  Drawing ${drawWord} in...  **2**  \uD83E\uDD41\uD83E\uDD41`, color: 0xFFCC00 },
    { text: `\uD83E\uDD41  Drawing ${drawWord} in...  **1**  \uD83E\uDD41`, color: 0xFFD700 },
  ];

  const firstEmbed = new EmbedBuilder().setTitle(countdownFrames[0].text).setColor(countdownFrames[0].color);
  const animMsg = await channel.send({ embeds: [firstEmbed] });
  await sleep(1000);

  for (let i = 1; i < countdownFrames.length; i++) {
    const embed = new EmbedBuilder().setTitle(countdownFrames[i].text).setColor(countdownFrames[i].color);
    try {
      await animMsg.edit({ embeds: [embed] });
    } catch (err) {
      console.error('Animation frame edit failed:', err.message);
      break;
    }
    await sleep(1000);
  }

  await sleep(800);

  const mentionChunks = buildMentionChunks(winners.map(winner => winner.user_id));

  const announcementEmbeds = buildWinnerAnnouncementEmbeds(winners, winnerStartNumber);
  const firstMentions = mentionChunks.shift() || { ids: [], content: '' };
  await animMsg.edit({
    content: firstMentions.content,
    embeds: [announcementEmbeds[0]],
    allowedMentions: { users: firstMentions.ids }
  });
  for (const embed of announcementEmbeds.slice(1)) {
    await channel.send({ embeds: [embed] });
  }
  for (const mentions of mentionChunks) {
    await channel.send({ content: mentions.content, allowedMentions: { users: mentions.ids } });
  }
  return animMsg; // Return so callers can delete it later
}

// Helper: get ordinal suffix (1st, 2nd, 3rd, 4th, etc.)
function getOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── /randomizer status (owner only) ──────────────────────────────────────────

async function handleStatus(interaction) {
  console.log(`[STATUS] User: ${interaction.user.id} | OWNER_ID: ${OWNER_ID} | Match: ${interaction.user.id === OWNER_ID}`);
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: `This command is owner-only. Your ID: ${interaction.user.id}`, ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const { EmbedBuilder } = require('discord.js');

  // Get all servers the bot is in
  const guilds = client.guilds.cache;
  const stats = db.getStats();
  const activeRaffles = db.getAllActiveRaffles();

  // Build server list
  const serverLines = guilds.map(g => {
    const memberCount = g.memberCount;
    return `• **${g.name}** — ${memberCount} members`;
  });

  const embed = new EmbedBuilder()
    .setTitle('📊  Bot Status')
    .setColor(0x5865F2)
    .setDescription(
      `**Servers:** ${guilds.size}\n` +
      `**Total Raffles:** ${stats.total_raffles || 0}\n` +
      `**Completed:** ${stats.completed_raffles || 0}\n` +
      `**Active:** ${stats.active_raffles || 0}\n` +
      `**Cancelled:** ${stats.cancelled_raffles || 0}`
    )
    .setTimestamp();

  // Server list
  if (serverLines.length > 0) {
    embed.addFields({
      name: '🌐 Servers',
      value: serverLines.join('\n').substring(0, 1024),
      inline: false
    });
  }

  // Active raffles
  if (activeRaffles.length > 0) {
    const raffleLines = [];
    for (const r of activeRaffles) {
      const guild = guilds.get(r.guild_id);
      const serverName = guild ? guild.name : `Unknown (${r.guild_id})`;
      const prize = r.prize.split('\n')[0]; // first prize line
      const prizeDisplay = prize.length > 30 ? prize.substring(0, 27) + '...' : prize;
      raffleLines.push(
        `• **#${r.id}** in **${serverName}**\n` +
        `  Prize: ${prizeDisplay} — ${r.pick_count}/${r.total_slots} spots — ${r.num_winners || 1} winner(s)`
      );
    }
    embed.addFields({
      name: '🎲 Active Raffles',
      value: raffleLines.join('\n').substring(0, 1024) || 'None',
      inline: false
    });
  } else {
    embed.addFields({
      name: '🎲 Active Raffles',
      value: 'None',
      inline: false
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ── /help command ─────────────────────────────────────────────────────────────

async function handleHelp(interaction) {
  const embed = buildHelpEmbed();
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// ── Auto-guide on server join ────────────────────────────────────────────────

client.on(Events.GuildCreate, async (guild) => {
  try {
    const { ChannelType, PermissionsBitField } = require('discord.js');
    const channel = guild.channels.cache.find(ch =>
      ch.type === ChannelType.GuildText &&
      ch.permissionsFor(guild.members.me).has([
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks
      ])
    );

    if (channel) {
      const embed = buildSetupGuideEmbed();
      await channel.send({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Failed to send setup guide:', err.message);
  }
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function updateBoardMessage(raffle) {
  queueRaffleUpdate(raffle);
}

async function updateBoardMessageFull(raffle, slotNumbers = []) {
  await Promise.all([
    updateMainBoard(raffle),
    updateExtensionMessagesForSlots(raffle, slotNumbers)
  ]);
}

// Update just the main board embed + components (no banner)
async function updateMainBoard(raffle) {
  const start = Date.now();
  try {
    const freshRaffle = db.getRaffleById(raffle.id);
    if (!freshRaffle || freshRaffle.status !== 'active') return;

    const channel = client.channels.cache.get(freshRaffle.channel_id) || await client.channels.fetch(freshRaffle.channel_id);
    if (!channel) return;

    const picks = db.getPicks(freshRaffle.id);
    const embed = buildBoardEmbed(freshRaffle, picks);
    const components = buildComponents(freshRaffle, picks);

    await editDiscordMessageWithRetry(
      channel,
      freshRaffle.message_id,
      { embeds: [embed], components },
      freshRaffle.id
    );
    console.log(`[BOARD] Main update — raffle=${freshRaffle.id} took=${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[BOARD] Main update failed — raffle=${raffle.id} took=${Date.now() - start}ms:`, err.message);
    throw err;
  }
}

// A slot occurs on exactly one overflow message, so unrelated messages never need edits.
async function updateExtensionMessagesForSlots(raffle, slotNumbers) {
  const start = Date.now();
  try {
    const indexes = getExtensionIndexesForSlots(slotNumbers);
    if (indexes.length === 0) return;

    const freshRaffle = db.getRaffleById(raffle.id);
    if (!freshRaffle || freshRaffle.status !== 'active') return;

    const extIds = db.getExtensionMessages(freshRaffle.id);
    if (extIds.length === 0) return;

    const channel = client.channels.cache.get(freshRaffle.channel_id) || await client.channels.fetch(freshRaffle.channel_id);
    if (!channel) return;

    const picks = db.getPicks(freshRaffle.id);
    const allExtSets = buildExtensionComponents(freshRaffle, picks);

    const results = await Promise.allSettled(indexes.map(index => {
      if (!extIds[index] || !allExtSets[index]) return Promise.resolve('missing');
      return editDiscordMessageWithRetry(
        channel,
        extIds[index],
        { components: allExtSets[index] },
        freshRaffle.id
      );
    }));

    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(`${failed.length}/${indexes.length} targeted extension updates failed`, {
        cause: failed[0].reason
      });
    }
    console.log(`[EXT] Targeted ${indexes.length} extension(s) — raffle=${raffle.id} took=${Date.now() - start}ms`);
  } catch (err) {
    console.error(`[EXT] Targeted update failed — raffle=${raffle.id} took=${Date.now() - start}ms:`, err.message);
    throw err;
  }
}

const PERMANENT_DISCORD_EDIT_CODES = new Set([10003, 10008, 50001, 50013, 50035]);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT']);

function isTransientDiscordEditError(err) {
  const discordCode = Number(err?.rawError?.code ?? err?.code);
  if (PERMANENT_DISCORD_EDIT_CODES.has(discordCode)) return false;

  const status = Number(err?.status);
  if (status === 429 || status >= 500) return true;
  return TRANSIENT_NETWORK_CODES.has(err?.code) || err?.name === 'AbortError';
}

async function editDiscordMessageWithRetry(channel, messageId, payload, raffleId) {
  try {
    return await channel.messages.edit(messageId, payload);
  } catch (err) {
    if (!isTransientDiscordEditError(err)) throw err;
    console.warn(`[DISCORD] Retrying message edit — raffle=${raffleId} message=${messageId} error=${err.code || err.status || err.name}`);
    await new Promise(resolve => setTimeout(resolve, 300));
    return channel.messages.edit(messageId, payload);
  }
}

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// Graceful shutdown. Docker/compose sends SIGTERM on stop/recreate; only SIGINT
// was handled before, so container swaps killed the process without closing the
// DB or the Discord connection. Handle both, and guard against double-invocation.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] Received ${signal} — closing dashboard, DB, and Discord client...`);
  try { dashboard.stop(); } catch (err) { console.error('[SHUTDOWN] dashboard.stop failed:', err.message); }
  try { db.close(); } catch (err) { console.error('[SHUTDOWN] db.close failed:', err.message); }
  try { client.destroy(); } catch (err) { console.error('[SHUTDOWN] client.destroy failed:', err.message); }
  // Force-exit if something hangs so the container doesn't wait for SIGKILL.
  setTimeout(() => process.exit(0), 2000).unref();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);
