const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder
} = require('discord.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildProgressBar(current, total) {
  const segments = 10;
  const filled = Math.round((current / total) * segments);
  const empty = segments - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  return `${bar}  ${current}/${total}`;
}

function getStatus(raffle, picks) {
  if (raffle.status === 'completed') return 'completed';
  if (raffle.status === 'cancelled') return 'cancelled';
  if (picks.length >= raffle.total_slots) return 'closed';
  return 'open';
}

function getStatusColor(status) {
  switch (status) {
    case 'open':      return 0x00FF88;
    case 'closed':    return 0xFF4444;
    case 'completed': return 0xFFD700;
    case 'cancelled': return 0x808080;
    default:          return 0x00FF88;
  }
}

function getStatusTitle(status) {
  switch (status) {
    case 'open':      return '\uD83C\uDFB0  ULTIMATE RANDOMIZER  \uD83C\uDFB0';
    case 'closed':    return '\uD83D\uDD12  RANDOMIZER \u2014 CLOSED  \uD83D\uDD12';
    case 'completed': return '\uD83C\uDF89  RANDOMIZER COMPLETE  \uD83C\uDF89';
    case 'cancelled': return '\u274C  RANDOMIZER CANCELLED  \u274C';
    default:          return '\uD83C\uDFB0  ULTIMATE RANDOMIZER  \uD83C\uDFB0';
  }
}

// ── Board Embed ──────────────────────────────────────────────────────────────

function buildBoardEmbed(raffle, picks) {
  const picksMap = new Map();
  for (const pick of picks) {
    picksMap.set(pick.slot_number, pick);
  }

  const status = getStatus(raffle, picks);
  const color = getStatusColor(status);
  const title = getStatusTitle(status);

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(color);

  // Description block
  const prizes = raffle.prize.split('\n').filter(Boolean);
  let desc = '\u2501'.repeat(28) + '\n';
  if (prizes.length <= 1) {
    desc += `\uD83C\uDFC6  **Prize:**  ${raffle.prize}\n`;
  } else {
    desc += `\uD83C\uDFC6  **Prizes:**\n${prizes.map((p, i) => `\u2003${i + 1}. ${p}`).join('\n')}\n`;
  }
  if (raffle.price) {
    desc += `\uD83D\uDCB0  **Donation:**  ${raffle.price}\n`;
  }
  desc += `\uD83D\uDCCA  **Spots:**  ${buildProgressBar(picks.length, raffle.total_slots)}\n`;
  if (raffle.max_picks_per_user > 0) {
    desc += `\uD83D\uDC64  **Max Picks:**  ${raffle.max_picks_per_user} per person\n`;
  }
  if ((raffle.num_winners || 1) > 1) {
    desc += `\uD83C\uDFC6  **Winners:**  ${raffle.num_winners}\n`;
  }
  if (raffle.rules) {
    desc += `\uD83D\uDCDC  **Rules:**  ${raffle.rules}\n`;
  }
  desc += '\u2501'.repeat(28);
  embed.setDescription(desc);

  // Number grid — split into columns (max 1024 chars per embed field)
  const pad = raffle.total_slots >= 100 ? 3 : (raffle.total_slots >= 10 ? 2 : 1);
  // Truncate usernames in grid to keep fields under 1024 chars
  const maxNameLen = raffle.total_slots > 60 ? 10 : 14;

  let columns;
  if (raffle.total_slots <= 20) {
    columns = 2;
  } else if (raffle.total_slots <= 60) {
    columns = 3;
  } else {
    columns = 6; // 2 visual rows of 3 inline fields
  }

  const perCol = Math.ceil(raffle.total_slots / columns);
  const cols = Array.from({ length: columns }, () => '');

  for (let i = 1; i <= raffle.total_slots; i++) {
    const colIdx = Math.floor((i - 1) / perCol);
    const num = String(i).padStart(pad, '0');
    const pick = picksMap.get(i);

    let indicator, name;
    if (!pick) {
      indicator = '\uD83D\uDFE2';
      name = '\u2014';
    } else if (pick.paid) {
      indicator = '\u2B50';
      name = (pick.username || 'Unknown').toUpperCase();
    } else {
      indicator = '\uD83D\uDD34';
      name = (pick.username || 'Unknown').toUpperCase();
    }

    // Truncate long names to stay under field char limit
    if (name.length > maxNameLen) {
      name = name.substring(0, maxNameLen - 1) + '\u2026';
    }

    cols[colIdx] += `${indicator} \`${num}.\` ${name}\n`;
  }

  // Add fields — for 6 columns, Discord renders inline fields 3 per row
  for (let c = 0; c < columns; c++) {
    embed.addFields({
      name: '\u200b',
      value: cols[c] || '\u200b',
      inline: true
    });
  }

  // Footer
  if (status === 'open') {
    embed.setFooter({ text: '\uD83D\uDFE2 Available  \uD83D\uDD34 Claimed  \u2B50 Donated  \u2502  Use buttons or /pick to claim a spot' });
  } else if (status === 'closed') {
    embed.setFooter({ text: 'All spots have been claimed!' });
  }

  embed.setImage('attachment://banner.png');

  return embed;
}

// ── Admin action buttons row ─────────────────────────────────────────────────

function buildAdminRow(raffleId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_draw_${raffleId}`)
      .setLabel('Draw Winner')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83C\uDFB2'),
    new ButtonBuilder()
      .setCustomId(`admin_payments_${raffleId}`)
      .setLabel('Manage Donations')
      .setStyle(ButtonStyle.Success)
      .setEmoji('\uD83D\uDCB0'),
    new ButtonBuilder()
      .setCustomId(`admin_remove_${raffleId}`)
      .setLabel('Remove Picks')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('\uD83D\uDDD1\uFE0F'),
    new ButtonBuilder()
      .setCustomId(`admin_repost_${raffleId}`)
      .setLabel('Repost')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('\uD83D\uDD04'),
    new ButtonBuilder()
      .setCustomId(`admin_cancel_${raffleId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('\u274C')
  );
}

// ── Components (buttons + admin for main board) ─────────────────────────────
// For ≤20 slots: up to 4 rows of number buttons + full admin row (5 buttons)
// For >20 slots: ⚙ Admin Panel button in top-left, then number buttons 1-24
//   Extension messages handle slots 25+

function buildComponents(raffle, picks) {
  const status = getStatus(raffle, picks);
  if (status === 'completed' || status === 'cancelled') return [];

  const picksMap = new Map();
  for (const pick of picks) {
    picksMap.set(pick.slot_number, true);
  }

  const needsExtension = raffle.total_slots > 20;

  if (needsExtension) {
    // Admin button first, then number buttons 1-24
    const maxSlotOnMain = Math.min(raffle.total_slots, 24);
    const rows = [];
    let currentRow = new ActionRowBuilder();

    // Admin panel button goes first (top-left)
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`admin_panel_${raffle.id}`)
        .setLabel('Admin')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('\u2699\uFE0F')
    );

    for (let i = 1; i <= maxSlotOnMain; i++) {
      const taken = picksMap.has(i);
      const button = new ButtonBuilder()
        .setCustomId(`pick_${raffle.id}_${i}`)
        .setLabel(String(i))
        .setStyle(taken ? ButtonStyle.Danger : ButtonStyle.Success)
        .setDisabled(taken);

      currentRow.addComponents(button);

      if (currentRow.components.length === 5 || i === maxSlotOnMain) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
      }
    }

    return rows;
  } else {
    // ≤20 slots: admin panel button first, then number buttons
    const rows = [];
    let currentRow = new ActionRowBuilder();

    // Admin panel button goes first (top-left), same as >20 slot boards
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`admin_panel_${raffle.id}`)
        .setLabel('Admin')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('\u2699\uFE0F')
    );

    for (let i = 1; i <= raffle.total_slots; i++) {
      const taken = picksMap.has(i);
      const button = new ButtonBuilder()
        .setCustomId(`pick_${raffle.id}_${i}`)
        .setLabel(String(i))
        .setStyle(taken ? ButtonStyle.Danger : ButtonStyle.Success)
        .setDisabled(taken);

      currentRow.addComponents(button);

      if (currentRow.components.length === 5 || i === raffle.total_slots) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
      }
    }

    return rows;
  }
}

// ── Extension components (overflow number buttons for slots 25+) ─────────────
// Returns an array of component arrays — one per extension message.
// Each message can hold up to 5 rows of 5 buttons = 25 slots.
// Main board handles slots 1-24 (with admin panel button), extensions handle 25+.
// Example for 100 slots: [[rows for 25-49], [rows for 50-74], [rows for 75-99], [rows for 100]]

function buildExtensionComponents(raffle, picks) {
  const status = getStatus(raffle, picks);
  if (status === 'completed' || status === 'cancelled') return [];
  if (raffle.total_slots <= 24) return [];

  const picksMap = new Map();
  for (const pick of picks) {
    picksMap.set(pick.slot_number, true);
  }

  const allMessages = [];
  let currentMessageRows = [];
  let currentRow = new ActionRowBuilder();

  for (let i = 25; i <= raffle.total_slots; i++) {
    const taken = picksMap.has(i);
    const button = new ButtonBuilder()
      .setCustomId(`pick_${raffle.id}_${i}`)
      .setLabel(String(i))
      .setStyle(taken ? ButtonStyle.Danger : ButtonStyle.Success)
      .setDisabled(taken);

    currentRow.addComponents(button);

    if (currentRow.components.length === 5 || i === raffle.total_slots) {
      currentMessageRows.push(currentRow);
      currentRow = new ActionRowBuilder();

      // Each message can hold 5 rows max
      if (currentMessageRows.length >= 5) {
        allMessages.push(currentMessageRows);
        currentMessageRows = [];
      }
    }
  }

  // Push any remaining rows as a final message
  if (currentMessageRows.length > 0) {
    allMessages.push(currentMessageRows);
  }

  return allMessages;
}

function getExtensionIndexesForSlots(slotNumbers) {
  return [...new Set(slotNumbers
    .filter(slot => Number.isInteger(slot) && slot >= 25)
    .map(slot => Math.floor((slot - 25) / 25)))];
}

// ── Payment management panel (ephemeral, shown only to creator) ──────────────

// Builds the main header message for the donation manager (embed + Mark All controls)
function buildPaymentHeader(raffle, picks) {
  const claimedPicks = picks.filter(p => p.slot_number >= 1)
    .sort((a, b) => a.slot_number - b.slot_number);

  const paidCount = claimedPicks.filter(p => p.paid).length;
  const allPaid = claimedPicks.length > 0 && claimedPicks.every(p => p.paid);
  const anyPaid = claimedPicks.some(p => p.paid);

  const embed = new EmbedBuilder()
    .setTitle('\uD83D\uDCB0  Donation Manager')
    .setDescription(
      `Click a number to toggle its donation status.\n\uD83D\uDD34 = Not Donated, \u2705 = Donated\n\n` +
      `**${paidCount}/${claimedPicks.length}** donations received`
    )
    .setColor(0x00FF88);

  const controlRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mark_all_paid_${raffle.id}`)
      .setLabel('Mark All Donated')
      .setStyle(ButtonStyle.Success)
      .setEmoji('\u2705')
      .setDisabled(allPaid),
    new ButtonBuilder()
      .setCustomId(`mark_all_unpaid_${raffle.id}`)
      .setLabel('Mark All Not Donated')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('\uD83D\uDD34')
      .setDisabled(!anyPaid)
  );

  return { embeds: [embed], components: [controlRow] };
}

// Builds an array of component sets for donation toggle follow-up messages (25 buttons each)
function buildPaymentSlotMessages(raffle, picks) {
  const claimedPicks = picks.filter(p => p.slot_number >= 1)
    .sort((a, b) => a.slot_number - b.slot_number);

  if (claimedPicks.length === 0) return [];

  const messages = [];
  const slotsPerMessage = 25; // 5 rows × 5 buttons

  for (let chunk = 0; chunk < claimedPicks.length; chunk += slotsPerMessage) {
    const slots = claimedPicks.slice(chunk, chunk + slotsPerMessage);
    const rows = [];
    let currentRow = new ActionRowBuilder();

    for (const pick of slots) {
      const button = new ButtonBuilder()
        .setCustomId(`toggle_paid_${raffle.id}_${pick.slot_number}`)
        .setLabel(`#${pick.slot_number} ${pick.username}`)
        .setStyle(pick.paid ? ButtonStyle.Success : ButtonStyle.Danger)
        .setEmoji(pick.paid ? '\u2705' : '\uD83D\uDD34');

      currentRow.addComponents(button);

      if (currentRow.components.length === 5) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
      }
    }

    if (currentRow.components.length > 0) {
      rows.push(currentRow);
    }

    messages.push({ components: rows });
  }

  return messages;
}

// Legacy single-message version (kept for compatibility, uses first 20 slots)
function buildPaymentPanel(raffle, picks) {
  const header = buildPaymentHeader(raffle, picks);
  const slotMessages = buildPaymentSlotMessages(raffle, picks);

  if (slotMessages.length === 0) {
    return { content: 'No numbers have been claimed yet.', components: [], embeds: [] };
  }

  // Merge first slot message into header (up to 5 rows total)
  const combined = [...slotMessages[0].components.slice(0, 4), ...header.components];
  return { embeds: header.embeds, components: combined };
}

// ── Winner Embed ─────────────────────────────────────────────────────────────

// Helper: get ordinal suffix (1st, 2nd, 3rd, 4th, etc.)
function getOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function getEmbedTextLength(embed) {
  const data = embed.toJSON();
  return (data.title?.length || 0) +
    (data.description?.length || 0) +
    (data.footer?.text?.length || 0) +
    (data.author?.name?.length || 0) +
    (data.fields || []).reduce((total, field) => total + field.name.length + field.value.length, 0);
}

function chunkLines(lines, maxLength) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildWinnerEmbeds(raffle, picks, winners) {
  if (!Array.isArray(winners)) winners = [winners];

  const embed = buildBoardEmbed({ ...raffle, status: 'completed' }, picks)
    .setTitle('\uD83C\uDF89  RANDOMIZER COMPLETE  \uD83C\uDF89')
    .setColor(0xFFD700);
  const fieldName = winners.length === 1 ? '\uD83C\uDFC6 WINNER' : `\uD83C\uDFC6 WINNERS (${winners.length})`;
  const winnerLines = winners.map((w, i) =>
    `**${getOrdinal(i + 1)}:** #${w.slot_number} \u2014 <@${w.user_id}> (${w.username})`
  );

  const available = Math.max(80, Math.min(1024, 6000 - getEmbedTextLength(embed) - fieldName.length - 20));
  let summary = '';
  let shown = 0;
  for (const line of winnerLines) {
    const remaining = winners.length - shown - 1;
    const suffix = remaining > 0 ? `\n*...and ${remaining} more announced below.*` : '';
    const next = summary ? `${summary}\n${line}` : line;
    if (`${next}${suffix}`.length > available) break;
    summary = next;
    shown++;
  }
  if (shown < winners.length) {
    const suffix = `*...and ${winners.length - shown} more announced below.*`;
    summary = summary ? `${summary}\n${suffix}` : suffix;
  }
  embed.addFields({ name: fieldName, value: summary, inline: false });

  return [embed];
}

function buildWinnerAnnouncementEmbeds(winners, winnerStartNumber = 1) {
  if (!Array.isArray(winners)) winners = [winners];
  const lines = winners.map((winner, index) => {
    const ordinal = getOrdinal(winnerStartNumber + index);
    return `**${ordinal} Winner:** \uD83C\uDFB0 **# ${winner.slot_number}** \u2014 **${winner.username}**`;
  });

  return chunkLines(lines, 3800).map((description, index) => {
    const embed = new EmbedBuilder().setColor(0xFFD700).setDescription(description);
    if (index === 0) {
      embed.setTitle(winners.length === 1
        ? '\uD83C\uDF89\uD83C\uDF89\uD83C\uDF89  THE WINNING NUMBER  \uD83C\uDF89\uD83C\uDF89\uD83C\uDF89'
        : '\uD83C\uDF89\uD83C\uDF89\uD83C\uDF89  THE WINNING NUMBERS  \uD83C\uDF89\uD83C\uDF89\uD83C\uDF89');
    }
    return embed;
  });
}

function buildMentionChunks(userIds, maxLength = 1900) {
  const chunks = [];
  let ids = [];
  let content = '';
  for (const userId of new Set(userIds)) {
    const mention = `<@${userId}>`;
    const next = content ? `${content} ${mention}` : mention;
    if (next.length > maxLength && ids.length > 0) {
      chunks.push({ ids, content });
      ids = [userId];
      content = mention;
    } else {
      ids.push(userId);
      content = next;
    }
  }
  if (ids.length > 0) chunks.push({ ids, content });
  return chunks;
}

// ── Settings Embed ───────────────────────────────────────────────────────────

function buildSettingsEmbed(raffle, picks) {
  const status = getStatus(raffle, picks);
  const embed = new EmbedBuilder()
    .setTitle('\u2699\uFE0F  Randomizer Settings')
    .setColor(getStatusColor(status))
  const settingsPrizes = raffle.prize.split('\n').filter(Boolean);
  const prizeDisplay = settingsPrizes.length <= 1
    ? raffle.prize
    : settingsPrizes.map((p, i) => `${i + 1}. ${p}`).join('\n');

  embed.addFields(
      { name: settingsPrizes.length > 1 ? 'Prizes' : 'Prize', value: prizeDisplay, inline: settingsPrizes.length <= 1 },
      { name: 'Spots', value: `${picks.length}/${raffle.total_slots}`, inline: true },
      { name: 'Status', value: status.toUpperCase(), inline: true },
      { name: 'Donation', value: raffle.price || 'Free', inline: true },
      { name: 'Max Picks/Person', value: raffle.max_picks_per_user > 0 ? String(raffle.max_picks_per_user) : 'Unlimited', inline: true },
      { name: 'Winners', value: String(raffle.num_winners || 1), inline: true },
      { name: 'Rules', value: raffle.rules || 'None', inline: true },
      { name: 'Created By', value: `<@${raffle.created_by}>`, inline: true }
    );

  return embed;
}

// ── Remove Picks panel (ephemeral, shown only to creator) ────────────────────

// Builds the header for the remove panel
function buildRemoveHeader(raffle, picks) {
  const claimedPicks = picks.filter(p => p.slot_number >= 1 && p.user_id);
  const embed = new EmbedBuilder()
    .setTitle('\uD83D\uDDD1\uFE0F  Remove Picks')
    .setDescription(`Select a number to remove that pick and free up the spot.\n${claimedPicks.length} claimed spot(s).`)
    .setColor(0xFF4444);

  return { embeds: [embed], components: [] };
}

// Builds an array of component sets for remove menu follow-up messages (125 slots each = 5 menus × 25 options)
function buildRemoveMenuMessages(raffle, picks) {
  const claimedPicks = picks.filter(p => p.slot_number >= 1 && p.user_id)
    .sort((a, b) => a.slot_number - b.slot_number);

  if (claimedPicks.length === 0) return [];

  const chunkSize = 25;
  const menusPerMessage = 5;
  const slotsPerMessage = chunkSize * menusPerMessage; // 125
  const messages = [];

  for (let msgStart = 0; msgStart < claimedPicks.length; msgStart += slotsPerMessage) {
    const msgSlots = claimedPicks.slice(msgStart, msgStart + slotsPerMessage);
    const rows = [];

    for (let i = 0; i < msgSlots.length; i += chunkSize) {
      const chunk = msgSlots.slice(i, i + chunkSize);
      const menuIndex = Math.floor((msgStart + i) / chunkSize);
      const rangeLabel = chunk.length > 1
        ? `Spots #${chunk[0].slot_number}–#${chunk[chunk.length - 1].slot_number}`
        : `Spot #${chunk[0].slot_number}`;

      const menu = new StringSelectMenuBuilder()
        .setCustomId(`remove_select_${raffle.id}_${menuIndex}`)
        .setPlaceholder(`Remove pick — ${rangeLabel}`)
        .addOptions(
          chunk.map(p => ({
            label: `#${p.slot_number} — ${p.username}`,
            value: String(p.slot_number),
            emoji: '🗑️'
          }))
        );

      rows.push(new ActionRowBuilder().addComponents(menu));
    }

    messages.push({ components: rows });
  }

  return messages;
}

// Legacy single-message version (kept for small raffles ≤125 claimed)
function buildRemovePanel(raffle, picks) {
  const claimedPicks = picks.filter(p => p.slot_number >= 1 && p.user_id);
  if (claimedPicks.length === 0) {
    return { content: 'No numbers have been claimed yet.', components: [], embeds: [] };
  }

  const header = buildRemoveHeader(raffle, picks);
  const menuMessages = buildRemoveMenuMessages(raffle, picks);

  if (menuMessages.length === 0) {
    return { ...header };
  }

  // Merge first menu message into header
  return { embeds: header.embeds, components: menuMessages[0].components };
}

// ── Admin Panel (ephemeral, for 21-25 slot boards) ───────────────────────────

function buildAdminPanel(raffle) {
  const isLocked = raffle.assign_only === 1;
  const embed = new EmbedBuilder()
    .setTitle('\u2699\uFE0F  Admin Panel')
    .setDescription(
      `**${raffle.prize}** \u2014 Select an action below.` +
      (isLocked ? '\n\uD83D\uDD12 **Board is locked** — Admin assignment only' : '')
    )
    .setColor(0x5865F2);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_draw_${raffle.id}`)
      .setLabel('Draw Winner')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83C\uDFB2'),
    new ButtonBuilder()
      .setCustomId(`admin_payments_${raffle.id}`)
      .setLabel('Manage Donations')
      .setStyle(ButtonStyle.Success)
      .setEmoji('\uD83D\uDCB0'),
    new ButtonBuilder()
      .setCustomId(`admin_remove_${raffle.id}`)
      .setLabel('Remove Picks')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('\uD83D\uDDD1\uFE0F'),
    new ButtonBuilder()
      .setCustomId(`admin_repost_${raffle.id}`)
      .setLabel('Repost')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('\uD83D\uDD04'),
    new ButtonBuilder()
      .setCustomId(`admin_cancel_${raffle.id}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('\u274C')
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`admin_assign_${raffle.id}`)
      .setLabel('Assign Spot')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\uD83D\uDCCC'),
    new ButtonBuilder()
      .setCustomId(`admin_lock_${raffle.id}`)
      .setLabel(isLocked ? 'Unlock Board' : 'Lock Board')
      .setStyle(isLocked ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji(isLocked ? '\uD83D\uDD13' : '\uD83D\uDD12'),
    new ButtonBuilder()
      .setCustomId(`admin_early_draw_${raffle.id}`)
      .setLabel('Early Draw')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('\u26A1')
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ── Help Embed ────────────────────────────────────────────────────────────────

function buildHelpEmbed() {
  return new EmbedBuilder()
    .setTitle('🎲  Ultimate Randomizer — Help')
    .setColor(0x00FF88)
    .addFields(
      {
        name: '🚀  Getting Started',
        value: 'Use `/randomizer create` to open the setup wizard.\nFill in the prize, number of spots, donation amount, pick limits, and rules.',
        inline: false
      },
      {
        name: '🔢  Picking Numbers',
        value: 'Click the numbered buttons on the board, or use:\n`/pick 5` — pick one number\n`/pick 3,7,12` — pick multiple numbers',
        inline: false
      },
      {
        name: '🛠️  Admin Controls (Board Buttons)',
        value: '**Draw Winner** — Randomly pick a winner\n**Manage Donations** — Toggle donation status per number\n**Remove Picks** — Remove a claimed number\n**Repost** — Repost the board to the bottom of chat\n**Cancel** — Cancel the active randomizer',
        inline: false
      },
      {
        name: '📋  Slash Commands',
        value: '`/randomizer create` — Create a new board\n`/randomizer draw` — Draw a winner\n`/randomizer cancel` — Cancel the board\n`/randomizer settings` — View current settings\n`/randomizer mark-donated` — Mark numbers as donated\n`/pick` — Pick number(s)\n`/help` — Show this guide',
        inline: false
      },
      {
        name: '🎯  Board Legend',
        value: '🟢 Available — Open for picking\n🔴 Claimed — Taken but not yet donated\n⭐ Donated — Claimed and donation confirmed',
        inline: false
      },
      {
        name: '⚠️  Draw Rules',
        value: 'All spots must be **filled** and all donations must be **marked** before a winner can be drawn.',
        inline: false
      }
    );
}

// ── Setup Guide Embed (sent on server join) ──────────────────────────────────

function buildSetupGuideEmbed() {
  return new EmbedBuilder()
    .setTitle('🎲  Ultimate Randomizer — Setup Guide')
    .setColor(0xFFD700)
    .setDescription('Thanks for adding **Ultimate Randomizer**! Here\'s how to get started.')
    .addFields(
      {
        name: '🔑  Required Bot Permissions',
        value: '• Send Messages\n• Manage Messages\n• Embed Links\n• Attach Files\n• Read Message History\n• Use External Emojis\n• Use Application Commands\n\nMake sure the bot has these permissions in any channel where you want to use it.',
        inline: false
      },
      {
        name: '⚡  Quick Start',
        value: '1. Go to the channel you want to use\n2. Type `/randomizer create`\n3. Fill out the setup wizard\n4. The board will appear — members can start picking numbers!',
        inline: false
      },
      {
        name: '❓  Need Help?',
        value: 'Use `/help` anytime to see all commands and features.',
        inline: false
      }
    );
}

module.exports = {
  buildBoardEmbed,
  buildComponents,
  buildExtensionComponents,
  getExtensionIndexesForSlots,
  buildWinnerEmbeds,
  buildWinnerAnnouncementEmbeds,
  buildMentionChunks,
  buildSettingsEmbed,
  buildPaymentPanel,
  buildPaymentHeader,
  buildPaymentSlotMessages,
  buildRemovePanel,
  buildRemoveHeader,
  buildRemoveMenuMessages,
  buildAdminRow,
  buildAdminPanel,
  buildHelpEmbed,
  buildSetupGuideEmbed
};
