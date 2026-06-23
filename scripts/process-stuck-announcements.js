// One-shot script: announce stuck "drawn but not announced" raffles with proper throttling.
// Reads raffles from the past 36h (the recent-rate-limited batch), groups by chat,
// sends winner announcements one at a time per chat with a 6s delay, and marks them announced.

const Database = require("better-sqlite3");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("BOT_TOKEN not set");
  process.exit(1);
}

const db = new Database("/data/raffle.db");

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  return json;
}

function buildMessage(raffle, winners) {
  let msg = `🎉 <b>Winners drawn — ${escapeHtml(raffle.title)}</b>\n\n`;

  let prizes = [];
  if (raffle.prizes) {
    try {
      prizes = JSON.parse(raffle.prizes);
    } catch {
      prizes = [raffle.prize].filter(Boolean);
    }
  } else if (raffle.prize) {
    prizes = [raffle.prize];
  }
  const hasMulti = prizes.length > 1;

  if (winners.length === 0) {
    msg += "No entries — no winners drawn.";
  } else {
    msg += winners.length > 1 ? "🏆 <b>Winners:</b>\n" : "🏆 <b>Winner:</b>\n";
    winners.forEach((w, i) => {
      const mention = `<a href="tg://user?id=${w.user_id}">${escapeHtml(w.user_display_name)}</a>`;
      if (hasMulti) {
        const pos = i + 1;
        const label = pos === 1 ? "🥇" : pos === 2 ? "🥈" : pos === 3 ? "🥉" : `${pos}.`;
        msg += `  ${label} ${mention}\n`;
        if (w.prize) msg += `      🎁 ${escapeHtml(w.prize)}\n`;
      } else {
        msg += `  ${i + 1}. ${mention}\n`;
      }
    });
    if (!hasMulti && prizes[0]) {
      msg += `\n🎁 <b>Prize:</b> ${escapeHtml(prizes[0])}`;
    }
    msg += `\nCongratulations! 🥳`;
  }
  return msg;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function announceRaffle(raffle) {
  const winners = db
    .prepare("SELECT * FROM raffle_winners WHERE raffle_id = ? ORDER BY id ASC")
    .all(raffle.id);

  const text = buildMessage(raffle, winners);
  const payload = {
    chat_id: raffle.chat_id,
    text,
    parse_mode: "HTML",
  };
  if (raffle.thread_id) payload.message_thread_id = raffle.thread_id;

  const result = await tg("sendMessage", payload);

  if (result.ok) {
    db.prepare("UPDATE raffles SET announced = 1 WHERE id = ?").run(raffle.id);
    console.log(`✓ ${raffle.id} announced — ${raffle.title}`);
    return { ok: true };
  }

  const code = result.error_code;
  if (code === 403) {
    db.prepare("UPDATE raffles SET announced = 1 WHERE id = ?").run(raffle.id);
    console.log(`⊘ ${raffle.id} 403 (kicked) — marked announced to stop retries`);
    return { ok: true, skipped: true };
  }
  if (code === 429) {
    const retryAfter = (result.parameters && result.parameters.retry_after) || 30;
    console.log(`⏳ ${raffle.id} rate limited, waiting ${retryAfter + 2}s and retrying`);
    await sleep((retryAfter + 2) * 1000);
    return await announceRaffle(raffle);
  }
  console.log(`✗ ${raffle.id} failed: ${code} ${result.description}`);
  return { ok: false };
}

(async () => {
  // Pull recent unannounced (last 36 hours)
  const raffles = db
    .prepare(
      "SELECT * FROM raffles WHERE status = 'drawn' AND announced = 0 AND drawn_at >= datetime('now', '-36 hours') ORDER BY chat_id, drawn_at"
    )
    .all();

  console.log(`Found ${raffles.length} recent unannounced raffles to process.\n`);

  let processed = 0;
  let lastChatId = null;

  for (const raffle of raffles) {
    // Per-chat throttle: 6 seconds between messages to the same chat
    if (lastChatId !== null && lastChatId === raffle.chat_id) {
      await sleep(6000);
    } else if (lastChatId !== null) {
      // Switching to a new chat — short pause is fine
      await sleep(1500);
    }

    await announceRaffle(raffle);
    lastChatId = raffle.chat_id;
    processed++;
  }

  console.log(`\nDone. Processed ${processed} raffle(s).`);

  // Final stats
  const remaining = db
    .prepare("SELECT COUNT(*) as c FROM raffles WHERE status='drawn' AND announced=0")
    .get().c;
  console.log(`Total still unannounced: ${remaining}`);

  process.exit(0);
})();
