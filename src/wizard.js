const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder
} = require('discord.js');

const MAX_PRIZE_LENGTH = 400;
const MAX_RULES_LENGTH = 300;

// ── Main settings modal ─────────────────────────────────────────────────────

function buildCreateModal() {
  const modal = new ModalBuilder()
    .setCustomId('randomizer_create_modal')
    .setTitle('Create a Randomizer Board');

  const prizeInput = new TextInputBuilder()
    .setCustomId('prize')
    .setLabel('Prize(s) — commas or new lines (400 max)')
    .setPlaceholder('PS5 Bundle  or  PS5, Gift Card, T-Shirt')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_PRIZE_LENGTH);

  const slotsInput = new TextInputBuilder()
    .setCustomId('slots')
    .setLabel('Number of Spots (2-200)')
    .setPlaceholder('25')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(3);

  const priceInput = new TextInputBuilder()
    .setCustomId('price')
    .setLabel('Donation per Pick (optional)')
    .setPlaceholder('$10 per spot')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(50);

  const maxPicksInput = new TextInputBuilder()
    .setCustomId('max_picks')
    .setLabel('Max Picks per Person (0 = unlimited)')
    .setPlaceholder('0')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(3);

  const winnersInput = new TextInputBuilder()
    .setCustomId('num_winners')
    .setLabel('Number of Winners')
    .setPlaceholder('1')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(3);

  modal.addComponents(
    new ActionRowBuilder().addComponents(prizeInput),
    new ActionRowBuilder().addComponents(slotsInput),
    new ActionRowBuilder().addComponents(priceInput),
    new ActionRowBuilder().addComponents(maxPicksInput),
    new ActionRowBuilder().addComponents(winnersInput)
  );

  return modal;
}

// ── Rules modal ─────────────────────────────────────────────────────────────

function buildRulesModal(pendingKey) {
  const modal = new ModalBuilder()
    .setCustomId(`randomizer_rules_modal_${pendingKey}`)
    .setTitle('Rules / Restrictions');

  const rulesInput = new TextInputBuilder()
    .setCustomId('rules')
    .setLabel('Rules / Restrictions (300 max)')
    .setPlaceholder('Must be 18+, one entry per household, etc.')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setMaxLength(MAX_RULES_LENGTH);

  modal.addComponents(
    new ActionRowBuilder().addComponents(rulesInput)
  );

  return modal;
}

// ── Parse and validate modal values ─────────────────────────────────────────

function parseModalValues(interaction) {
  const prizeRaw = interaction.fields.getTextInputValue('prize').trim();
  const slotsRaw = interaction.fields.getTextInputValue('slots').trim();
  const price = interaction.fields.getTextInputValue('price')?.trim() || null;
  const maxPicksRaw = interaction.fields.getTextInputValue('max_picks')?.trim() || '0';
  const numWinnersRaw = interaction.fields.getTextInputValue('num_winners')?.trim() || '1';

  if (prizeRaw.length > MAX_PRIZE_LENGTH) {
    return { error: `Prizes must be ${MAX_PRIZE_LENGTH} characters or fewer.` };
  }

  if (!prizeRaw) {
    return { error: 'Prize is required.' };
  }

  const totalSlots = /^\d+$/.test(slotsRaw) ? Number(slotsRaw) : NaN;
  if (!Number.isSafeInteger(totalSlots) || totalSlots < 2 || totalSlots > 200) {
    return { error: 'Number of spots must be between 2 and 200.' };
  }

  const maxPicksPerUser = /^\d+$/.test(maxPicksRaw) ? Number(maxPicksRaw) : NaN;
  if (!Number.isSafeInteger(maxPicksPerUser) || maxPicksPerUser < 0 || maxPicksPerUser > totalSlots) {
    return { error: `Max picks must be between 0 (unlimited) and ${totalSlots}.` };
  }

  const numWinners = /^\d+$/.test(numWinnersRaw) ? Number(numWinnersRaw) : NaN;
  if (!Number.isSafeInteger(numWinners) || numWinners < 1) {
    return { error: 'Number of winners must be at least 1.' };
  }
  if (numWinners > totalSlots) {
    return { error: `Number of winners (${numWinners}) can't exceed total spots (${totalSlots}).` };
  }

  // Normalize comma-separated or multiline prizes to one prize per line.
  const prizes = prizeRaw.split(/[,\r\n]/).map(p => p.trim()).filter(Boolean);
  if (prizes.length === 0) {
    return { error: 'Enter at least one prize.' };
  }
  const prize = prizes.join('\n');

  return { prize, totalSlots, price, maxPicksPerUser, numWinners };
}

module.exports = { buildCreateModal, buildRulesModal, parseModalValues, MAX_RULES_LENGTH };
