// HTML template functions for the dashboard

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusBadge(status) {
  const colors = { active: '#00ff88', completed: '#ffd700', cancelled: '#808080' };
  const color = colors[status] || '#808080';
  return `<span style="background:${color};color:#000;padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600;">${escHtml(status)}</span>`;
}

function layout(title, content, isLoggedIn = true) {
  const nav = isLoggedIn ? `
    <nav>
      <div class="nav-left">
        <a href="/" class="logo">Ultimate Randomizer</a>
      </div>
      <div class="nav-right">
        <a href="/">Home</a>
        <a href="/servers">Servers</a>
        <a href="/logout">Logout</a>
        <form method="POST" action="/restart" style="display:inline;" onsubmit="return confirm('Restart the bot?')"><button type="submit" class="btn-restart">Restart Bot</button></form>
      </div>
    </nav>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)} — Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1a2e; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.6; }
    a { color: #00ff88; text-decoration: none; }
    a:hover { text-decoration: underline; }
    nav { background: #16213e; padding: 12px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #2a2a4a; }
    .nav-left .logo { color: #ffd700; font-weight: 700; font-size: 18px; }
    .nav-right a { margin-left: 20px; color: #aaa; font-size: 14px; }
    .nav-right a:hover { color: #fff; }
    .btn-restart { background: #ff8800; color: #000; padding: 4px 14px; border-radius: 4px; font-weight: 600; font-size: 13px; margin-left: 20px; cursor: pointer; border: none; }
    .btn-restart:hover { background: #cc6e00; text-decoration: none; }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
    h1 { color: #ffd700; margin-bottom: 20px; font-size: 24px; }
    h2 { color: #ccc; margin: 24px 0 12px; font-size: 18px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 30px; }
    .stat-card { background: #16213e; border-radius: 8px; padding: 20px; text-align: center; border: 1px solid #2a2a4a; }
    .stat-card .number { font-size: 32px; font-weight: 700; color: #00ff88; }
    .stat-card .label { font-size: 13px; color: #888; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #16213e; border-radius: 8px; overflow: hidden; }
    th { background: #0f3460; padding: 12px 16px; text-align: left; font-size: 12px; text-transform: uppercase; color: #888; }
    td { padding: 12px 16px; border-top: 1px solid #2a2a4a; font-size: 14px; }
    tr:hover td { background: #1a2744; }
    .login-box { max-width: 360px; margin: 100px auto; background: #16213e; border-radius: 8px; padding: 32px; border: 1px solid #2a2a4a; }
    .login-box h1 { text-align: center; margin-bottom: 24px; }
    .login-box input { width: 100%; padding: 10px 14px; background: #1a1a2e; border: 1px solid #2a2a4a; border-radius: 4px; color: #e0e0e0; font-size: 14px; margin-bottom: 16px; }
    .login-box button { width: 100%; padding: 10px; background: #00ff88; color: #000; border: none; border-radius: 4px; font-weight: 600; font-size: 14px; cursor: pointer; }
    .login-box button:hover { background: #00cc6a; }
    .error { color: #ff4444; font-size: 13px; margin-bottom: 12px; text-align: center; }
    .breadcrumb { font-size: 13px; color: #666; margin-bottom: 16px; }
    .breadcrumb a { color: #888; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; background: #16213e; border-radius: 8px; padding: 20px; margin-bottom: 24px; border: 1px solid #2a2a4a; }
    .detail-grid .item { }
    .detail-grid .label { font-size: 12px; color: #666; text-transform: uppercase; }
    .detail-grid .value { font-size: 14px; color: #e0e0e0; }
    .donated { color: #00ff88; }
    .not-donated { color: #ff4444; }
    .empty { color: #666; font-style: italic; }
    @media (max-width: 600px) {
      .detail-grid { grid-template-columns: 1fr; }
      .stats { grid-template-columns: 1fr 1fr; }
    }
  </style>
</head>
<body>
  ${nav}
  <div class="container">
    ${content}
  </div>
</body>
</html>`;
}

function loginPage(error = '') {
  const errorHtml = error ? `<div class="error">${escHtml(error)}</div>` : '';
  return layout('Login', `
    <div class="login-box">
      <h1>Dashboard Login</h1>
      ${errorHtml}
      <form method="POST" action="/login">
        <input type="password" name="password" placeholder="Password" autofocus required>
        <button type="submit">Login</button>
      </form>
    </div>
  `, false);
}

function homePage(stats, recentRaffles, resolver) {
  const statsHtml = `
    <div class="stats">
      <div class="stat-card"><div class="number">${stats.total_guilds}</div><div class="label">Servers</div></div>
      <div class="stat-card"><div class="number">${stats.total_raffles}</div><div class="label">Total Raffles</div></div>
      <div class="stat-card"><div class="number" style="color:#00ff88">${stats.active_raffles}</div><div class="label">Active</div></div>
      <div class="stat-card"><div class="number" style="color:#ffd700">${stats.completed_raffles}</div><div class="label">Completed</div></div>
      <div class="stat-card"><div class="number" style="color:#808080">${stats.cancelled_raffles}</div><div class="label">Cancelled</div></div>
    </div>`;

  let tableRows = '';
  for (const r of recentRaffles) {
    const guildName = resolver.getCached(r.guild_id) || r.guild_id;
    tableRows += `<tr>
      <td><a href="/server/${r.guild_id}">${escHtml(guildName)}</a></td>
      <td><a href="/raffle/${r.id}">${escHtml(r.prize)}</a></td>
      <td>${statusBadge(r.status)}</td>
      <td>${r.total_slots}</td>
      <td>${escHtml(r.created_at)}</td>
    </tr>`;
  }

  return layout('Home', `
    <h1>Dashboard</h1>
    ${statsHtml}
    <h2>Recent Raffles</h2>
    <table>
      <tr><th>Server</th><th>Prize</th><th>Status</th><th>Slots</th><th>Created</th></tr>
      ${tableRows || '<tr><td colspan="5" class="empty">No raffles yet.</td></tr>'}
    </table>
  `);
}

function serversPage(guilds, resolver) {
  let rows = '';
  for (const g of guilds) {
    const name = resolver.getCached(g.guild_id) || g.guild_id;
    rows += `<tr>
      <td><a href="/server/${g.guild_id}">${escHtml(name)}</a></td>
      <td>${g.raffle_count}</td>
      <td>${g.active_count}</td>
      <td>${g.completed_count}</td>
      <td>${escHtml(g.last_raffle)}</td>
    </tr>`;
  }

  return layout('Servers', `
    <h1>Servers</h1>
    <table>
      <tr><th>Server</th><th>Total Raffles</th><th>Active</th><th>Completed</th><th>Last Raffle</th></tr>
      ${rows || '<tr><td colspan="5" class="empty">No servers yet.</td></tr>'}
    </table>
  `);
}

function serverPage(guildId, guildName, raffles) {
  let rows = '';
  for (const r of raffles) {
    rows += `<tr>
      <td><a href="/raffle/${r.id}">${escHtml(r.prize)}</a></td>
      <td>${statusBadge(r.status)}</td>
      <td>${r.total_slots}</td>
      <td>${escHtml(r.price || '—')}</td>
      <td>${escHtml(r.created_at)}</td>
    </tr>`;
  }

  return layout(guildName, `
    <div class="breadcrumb"><a href="/servers">Servers</a> / ${escHtml(guildName)}</div>
    <h1>${escHtml(guildName)}</h1>
    <table>
      <tr><th>Prize</th><th>Status</th><th>Slots</th><th>Donation</th><th>Created</th></tr>
      ${rows || '<tr><td colspan="5" class="empty">No raffles in this server.</td></tr>'}
    </table>
  `);
}

function rafflePage(data, guildName, channelName) {
  const r = data;
  const picks = data.picks || [];

  const detailHtml = `
    <div class="detail-grid">
      <div class="item"><div class="label">Server</div><div class="value"><a href="/server/${r.guild_id}">${escHtml(guildName)}</a></div></div>
      <div class="item"><div class="label">Channel</div><div class="value">${escHtml(channelName)}</div></div>
      <div class="item"><div class="label">Prize</div><div class="value">${escHtml(r.prize)}</div></div>
      <div class="item"><div class="label">Status</div><div class="value">${statusBadge(r.status)}</div></div>
      <div class="item"><div class="label">Donation</div><div class="value">${escHtml(r.price || '—')}</div></div>
      <div class="item"><div class="label">Slots</div><div class="value">${picks.length} / ${r.total_slots}</div></div>
      <div class="item"><div class="label">Max Picks/Person</div><div class="value">${r.max_picks_per_user || 'Unlimited'}</div></div>
      <div class="item"><div class="label">Created</div><div class="value">${escHtml(r.created_at)}</div></div>
      ${r.rules ? `<div class="item"><div class="label">Rules</div><div class="value">${escHtml(r.rules)}</div></div>` : ''}
      ${r.winner_slot ? `<div class="item"><div class="label">Winner</div><div class="value">Slot #${r.winner_slot}</div></div>` : ''}
    </div>`;

  let pickRows = '';
  for (let i = 1; i <= r.total_slots; i++) {
    const pick = picks.find(p => p.slot_number === i);
    if (pick) {
      const donatedClass = pick.paid ? 'donated' : 'not-donated';
      const donatedText = pick.paid ? 'Yes' : 'No';
      const isWinner = r.winner_slot === i ? ' style="background:#2a2a00;"' : '';
      pickRows += `<tr${isWinner}>
        <td>${i}${r.winner_slot === i ? ' 🏆' : ''}</td>
        <td>${escHtml(pick.username)}</td>
        <td>${pick.user_id}</td>
        <td class="${donatedClass}">${donatedText}</td>
        <td>${escHtml(pick.picked_at)}</td>
      </tr>`;
    } else {
      pickRows += `<tr><td>${i}</td><td class="empty">— open —</td><td></td><td></td><td></td></tr>`;
    }
  }

  return layout(r.prize, `
    <div class="breadcrumb"><a href="/servers">Servers</a> / <a href="/server/${r.guild_id}">${escHtml(guildName)}</a> / ${escHtml(r.prize)}</div>
    <h1>${escHtml(r.prize)}</h1>
    ${detailHtml}
    <h2>Picks</h2>
    <table>
      <tr><th>#</th><th>Username</th><th>User ID</th><th>Donated</th><th>Picked At</th></tr>
      ${pickRows}
    </table>
  `);
}

function restartingPage() {
  return layout('Restarting', `
    <div style="text-align:center;margin-top:80px;">
      <h1 style="color:#ff8800;">Restarting Bot...</h1>
      <p style="color:#888;margin-top:12px;">The bot is restarting. This page will reload automatically.</p>
      <p style="color:#666;margin-top:8px;font-size:13px;">If it doesn't reload, <a href="/">click here</a>.</p>
    </div>
    <script>setTimeout(function(){ window.location.href = '/'; }, 5000);</script>
  `);
}

function legalContact() {
  return process.env.SUPPORT_CONTACT || 'the app owner or administrator who invited Ultimate Randomizer to your Discord server';
}

function termsPage() {
  return layout('Terms of Service', `
    <h1>Ultimate Randomizer Terms of Service</h1>
    <p class="empty">Last updated: June 11, 2026</p>

    <h2>Use of the Bot</h2>
    <p>Ultimate Randomizer is a Discord bot that helps server administrators create number-board randomizers, let users claim slots, track administrator-marked donation status, and draw randomized winners.</p>

    <h2>Server Administrator Responsibility</h2>
    <p>Server owners and administrators are responsible for how they use the bot, including raffle rules, prize fulfillment, payment or donation handling, eligibility requirements, and compliance with any laws, Discord rules, and community rules that apply to their server.</p>

    <h2>No Payment Processing</h2>
    <p>Ultimate Randomizer does not process payments, collect financial account information, hold funds, escrow prizes, or verify that donations were actually made. Donation status in the bot is only an administrative marker controlled by server administrators.</p>

    <h2>Acceptable Use</h2>
    <p>You may not use the bot for illegal activity, fraud, harassment, spam, platform abuse, or activity that violates Discord's Terms of Service, Discord's Developer Policy, or applicable community rules.</p>

    <h2>Availability and Changes</h2>
    <p>The bot is provided as-is and may be changed, interrupted, limited, or discontinued at any time. No guarantee is made that the bot will be error-free or available at all times.</p>

    <h2>Contact</h2>
    <p>Questions about these terms can be directed to ${escHtml(legalContact())}.</p>
  `, false);
}

function privacyPage() {
  return layout('Privacy Policy', `
    <h1>Ultimate Randomizer Privacy Policy</h1>
    <p class="empty">Last updated: June 11, 2026</p>

    <h2>Information Collected</h2>
    <p>Ultimate Randomizer stores the information needed to operate number-board randomizers in Discord servers. This may include Discord server IDs, channel IDs, message IDs, user IDs, usernames, raffle settings, prize names, donation labels or amounts entered by administrators, rules entered by administrators, slot selections, timestamps, administrator-marked donation status, and winner results.</p>

    <h2>Information Not Collected</h2>
    <p>The bot does not request Discord Message Content intent, does not read general message contents, does not collect payment card numbers, bank details, crypto wallet keys, passwords, or other financial account credentials.</p>

    <h2>How Information Is Used</h2>
    <p>Stored information is used to create and update raffle boards, prevent duplicate slot claims, enforce pick limits, display raffle status, draw winners, provide an administrator dashboard, troubleshoot issues, and maintain bot reliability.</p>

    <h2>Sharing</h2>
    <p>Stored information is not sold. It may be processed by the hosting provider or database services used to run the bot, shown inside Discord as part of raffle boards or bot responses, or disclosed if required by law or necessary to protect the bot, users, or Discord communities.</p>

    <h2>Retention</h2>
    <p>Raffle records may be retained for operational history, troubleshooting, and administrator dashboard access. Server administrators may contact the bot owner to request deletion of stored data associated with their server where technically feasible.</p>

    <h2>Contact</h2>
    <p>Privacy questions or deletion requests can be directed to ${escHtml(legalContact())}.</p>
  `, false);
}

function notFoundPage() {
  return layout('Not Found', '<h1>404 — Not Found</h1><p>That page doesn\'t exist.</p>');
}

module.exports = { loginPage, homePage, serversPage, serverPage, rafflePage, restartingPage, termsPage, privacyPage, notFoundPage };
