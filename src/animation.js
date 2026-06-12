const { EmbedBuilder } = require('discord.js');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pick random elements from claimed slots for the cycling effect
function getRandomClaimedSlots(picks, count) {
  const slots = picks.map(p => p.slot_number);
  const result = [];
  for (let i = 0; i < count; i++) {
    result.push(slots[Math.floor(Math.random() * slots.length)]);
  }
  return result;
}

async function playDrawAnimation(interaction, raffle, picks, winnerPick) {
  // Phase 1: Countdown
  const countdownFrames = [
    { text: '\uD83E\uDD41\uD83E\uDD41\uD83E\uDD41  Drawing winner in...  **5**  \uD83E\uDD41\uD83E\uDD41\uD83E\uDD41', color: 0xFF4444 },
    { text: '\uD83E\uDD41\uD83E\uDD41\uD83E\uDD41  Drawing winner in...  **4**  \uD83E\uDD41\uD83E\uDD41\uD83E\uDD41', color: 0xFF6622 },
    { text: '\uD83E\uDD41\uD83E\uDD41  Drawing winner in...  **3**  \uD83E\uDD41\uD83E\uDD41', color: 0xFFAA00 },
    { text: '\uD83E\uDD41\uD83E\uDD41  Drawing winner in...  **2**  \uD83E\uDD41\uD83E\uDD41', color: 0xFFCC00 },
    { text: '\uD83E\uDD41  Drawing winner in...  **1**  \uD83E\uDD41', color: 0xFFD700 },
  ];

  // Send the first frame as the initial reply
  const firstEmbed = new EmbedBuilder()
    .setTitle(countdownFrames[0].text)
    .setColor(countdownFrames[0].color);

  await interaction.reply({ embeds: [firstEmbed] });
  await sleep(1000);

  // Remaining countdown frames
  for (let i = 1; i < countdownFrames.length; i++) {
    const embed = new EmbedBuilder()
      .setTitle(countdownFrames[i].text)
      .setColor(countdownFrames[i].color);

    try {
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      if (err.status === 429) {
        await sleep(err.retry_after || 1000);
        await interaction.editReply({ embeds: [embed] });
      }
    }
    await sleep(1000);
  }

  // Brief pause before reveal
  await sleep(800);

  // Phase 2: Winner reveal
  const winnerEmbed = new EmbedBuilder()
    .setColor(0xFFD700);

  // winnerPick can be a single pick or first of multiple (animation always shows first winner)
  winnerEmbed
    .setTitle('\uD83C\uDF89\uD83C\uDF89\uD83C\uDF89  THE WINNING NUMBER  \uD83C\uDF89\uD83C\uDF89\uD83C\uDF89')
    .setDescription(
      `\n\uD83C\uDFB0  **# ${winnerPick.slot_number}**  \uD83C\uDFB0\n\n` +
      `\uD83C\uDFC6  Congratulations <@${winnerPick.user_id}>!  \uD83C\uDFC6\n` +
      `\n**${winnerPick.username}** wins **${raffle.prize}**!`
    );

  try {
    await interaction.editReply({ embeds: [winnerEmbed] });
  } catch (err) {
    if (err.status === 429) {
      await sleep(err.retry_after || 1000);
      await interaction.editReply({ embeds: [winnerEmbed] });
    }
  }
}

module.exports = { playDrawAnimation };
