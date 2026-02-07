const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function buildBoardEmbed(raffle, picks) {
  const picksMap = new Map();
  for (const pick of picks) {
    picksMap.set(pick.slot_number, pick.username);
  }

  const embed = new EmbedBuilder()
    .setTitle('\uD83C\uDFB0 RAFFLE BOARD')
    .setColor(0xff4500);

  let desc = `**Prize:** ${raffle.prize}\n`;
  if (raffle.price) {
    desc += `**Price:** ${raffle.price} per line\n`;
  }
  desc += `**Slots:** ${picks.length}/${raffle.total_slots} claimed\n`;
  desc += '\u2500'.repeat(30);
  embed.setDescription(desc);

  const mid = Math.ceil(raffle.total_slots / 2);
  let leftCol = '';
  let rightCol = '';

  for (let i = 1; i <= raffle.total_slots; i++) {
    const name = picksMap.has(i) ? picksMap.get(i).toUpperCase() : '\u2014';
    const num = String(i).padStart(2, ' ');
    const line = `\`${num}.\` ${name}\n`;

    if (i <= mid) {
      leftCol += line;
    } else {
      rightCol += line;
    }
  }

  embed.addFields(
    { name: '\u200b', value: leftCol || '\u200b', inline: true },
    { name: '\u200b', value: rightCol || '\u200b', inline: true }
  );

  return embed;
}

function buildButtons(raffle, picks) {
  if (raffle.total_slots > 25) return [];

  const picksMap = new Map();
  for (const pick of picks) {
    picksMap.set(pick.slot_number, true);
  }

  const rows = [];
  let currentRow = new ActionRowBuilder();

  for (let i = 1; i <= raffle.total_slots; i++) {
    const taken = picksMap.has(i);
    const button = new ButtonBuilder()
      .setCustomId(`pick_${raffle.id}_${i}`)
      .setLabel(String(i))
      .setStyle(taken ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(taken);

    currentRow.addComponents(button);

    if (currentRow.components.length === 5 || i === raffle.total_slots) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
  }

  return rows;
}

function buildWinnerEmbed(raffle, picks, winnerSlot, winnerPick) {
  const embed = buildBoardEmbed(raffle, picks);

  embed.setTitle('\uD83C\uDF89 RAFFLE COMPLETE \uD83C\uDF89');
  embed.setColor(0xffd700);
  embed.addFields({
    name: '\uD83C\uDFC6 WINNER',
    value: `**Slot #${winnerSlot}** \u2014 <@${winnerPick.user_id}> (${winnerPick.username})`,
    inline: false
  });

  return embed;
}

module.exports = { buildBoardEmbed, buildButtons, buildWinnerEmbed };
