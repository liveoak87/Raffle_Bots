require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const db = require('./database');
const { buildBoardEmbed, buildButtons, buildWinnerEmbed } = require('./board');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === 'raffle') {
      await handleRaffle(interaction);
    } else if (interaction.commandName === 'pick') {
      await handlePick(interaction);
    }
  }

  if (interaction.isButton() && interaction.customId.startsWith('pick_')) {
    await handleButtonPick(interaction);
  }
});

// ── /raffle create | draw | cancel ──────────────────────────────────────────

async function handleRaffle(interaction) {
  const sub = interaction.options.getSubcommand();

  if (sub === 'create') {
    const existing = db.getActiveRaffle(interaction.channelId);
    if (existing) {
      return interaction.reply({
        content: 'There is already an active raffle in this channel. Cancel or draw it first.',
        ephemeral: true
      });
    }

    const prize = interaction.options.getString('prize');
    const slots = interaction.options.getInteger('slots');
    const price = interaction.options.getString('price');

    const raffleId = db.createRaffle(
      interaction.guildId, interaction.channelId,
      prize, price, slots, interaction.user.id
    );

    const raffle = db.getActiveRaffle(interaction.channelId);
    const picks = db.getPicks(raffleId);
    const embed = buildBoardEmbed(raffle, picks);
    const buttons = buildButtons(raffle, picks);

    const msg = await interaction.reply({
      embeds: [embed],
      components: buttons,
      fetchReply: true
    });

    db.setRaffleMessage(raffleId, msg.id);
  }

  if (sub === 'draw') {
    const raffle = db.getActiveRaffle(interaction.channelId);
    if (!raffle) {
      return interaction.reply({ content: 'No active raffle in this channel.', ephemeral: true });
    }

    const picks = db.getPicks(raffle.id);
    if (picks.length === 0) {
      return interaction.reply({ content: 'No numbers have been picked yet.', ephemeral: true });
    }

    const winnerPick = picks[Math.floor(Math.random() * picks.length)];
    db.completeRaffle(raffle.id, winnerPick.slot_number, winnerPick.user_id);

    // Update the original board message
    try {
      const channel = await client.channels.fetch(raffle.channel_id);
      const boardMsg = await channel.messages.fetch(raffle.message_id);
      const embed = buildWinnerEmbed(raffle, picks, winnerPick.slot_number, winnerPick);
      await boardMsg.edit({ embeds: [embed], components: [] });
    } catch (_) {
      // Original message may have been deleted — that's fine
    }

    await interaction.reply({
      content: `\uD83C\uDF89 **The winning number is #${winnerPick.slot_number}!** Congratulations <@${winnerPick.user_id}>!`
    });
  }

  if (sub === 'cancel') {
    const raffle = db.getActiveRaffle(interaction.channelId);
    if (!raffle) {
      return interaction.reply({ content: 'No active raffle in this channel.', ephemeral: true });
    }

    db.cancelRaffle(raffle.id);

    try {
      const channel = await client.channels.fetch(raffle.channel_id);
      const boardMsg = await channel.messages.fetch(raffle.message_id);
      const picks = db.getPicks(raffle.id);
      const embed = buildBoardEmbed(raffle, picks);
      embed.setTitle('\u274C RAFFLE CANCELLED');
      embed.setColor(0x808080);
      await boardMsg.edit({ embeds: [embed], components: [] });
    } catch (_) {
      // Ignore edit failures
    }

    await interaction.reply({ content: 'Raffle has been cancelled.' });
  }
}

// ── /pick <numbers> ─────────────────────────────────────────────────────────

async function handlePick(interaction) {
  const raffle = db.getActiveRaffle(interaction.channelId);
  if (!raffle) {
    return interaction.reply({ content: 'No active raffle in this channel.', ephemeral: true });
  }

  const input = interaction.options.getString('numbers');
  const numbers = input
    .split(/[,\s]+/)
    .map(n => parseInt(n.trim(), 10))
    .filter(n => !isNaN(n));

  if (numbers.length === 0) {
    return interaction.reply({
      content: 'Please provide valid number(s). Example: `/pick 5` or `/pick 3,7,12`',
      ephemeral: true
    });
  }

  const username = interaction.member?.displayName || interaction.user.username;
  const results = [];

  for (const num of numbers) {
    if (num < 1 || num > raffle.total_slots) {
      results.push(`#${num} \u2014 invalid (must be 1\u2013${raffle.total_slots})`);
      continue;
    }

    const taken = db.getSlot(raffle.id, num);
    if (taken) {
      results.push(`#${num} \u2014 already taken by ${taken.username}`);
      continue;
    }

    const ok = db.pickSlot(raffle.id, num, interaction.user.id, username);
    if (ok) {
      results.push(`#${num} \u2014 \u2705 claimed!`);
    } else {
      results.push(`#${num} \u2014 already taken (just grabbed by someone else)`);
    }
  }

  await updateBoardMessage(raffle);
  await interaction.reply({ content: results.join('\n'), ephemeral: true });
}

// ── Button click handler ────────────────────────────────────────────────────

async function handleButtonPick(interaction) {
  // customId format: pick_{raffleId}_{slotNumber}
  const parts = interaction.customId.split('_');
  const slotNumber = parseInt(parts[2], 10);

  const raffle = db.getActiveRaffle(interaction.channelId);
  if (!raffle) {
    return interaction.reply({ content: 'This raffle is no longer active.', ephemeral: true });
  }

  const existing = db.getSlot(raffle.id, slotNumber);
  if (existing) {
    return interaction.reply({
      content: `Slot #${slotNumber} is already taken by ${existing.username}.`,
      ephemeral: true
    });
  }

  const username = interaction.member?.displayName || interaction.user.username;
  const ok = db.pickSlot(raffle.id, slotNumber, interaction.user.id, username);

  if (!ok) {
    return interaction.reply({
      content: `Slot #${slotNumber} was just claimed by someone else.`,
      ephemeral: true
    });
  }

  // Update the board embed + buttons in place
  const picks = db.getPicks(raffle.id);
  const embed = buildBoardEmbed(raffle, picks);
  const buttons = buildButtons(raffle, picks);
  await interaction.update({ embeds: [embed], components: buttons });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function updateBoardMessage(raffle) {
  try {
    const channel = await client.channels.fetch(raffle.channel_id);
    const msg = await channel.messages.fetch(raffle.message_id);
    const picks = db.getPicks(raffle.id);
    const embed = buildBoardEmbed(raffle, picks);
    const buttons = buildButtons(raffle, picks);
    await msg.edit({ embeds: [embed], components: buttons });
  } catch (_) {
    // Ignore if message can't be updated
  }
}

process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
