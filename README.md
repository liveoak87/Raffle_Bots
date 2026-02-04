# Telegram Raffle Bot

A Telegram bot for running raffles and giveaways in group chats. Features inline buttons for easy entry, multiple prizes per raffle, automatic draws with timed raffles, group membership requirements, participant export, and re-run capability.

## Features

- **Create raffles** with customizable prizes, entry limits, and deadlines
- **Multiple prizes** - assign different prizes per winner position (1st, 2nd, 3rd...)
- **One-tap entry** via inline keyboard buttons
- **Automatic draws** when a raffle timer expires
- **Manual draws** triggered by group admins
- **Multiple winners** support (up to 50)
- **Entry limits** to cap the number of participants
- **Group membership requirement** - require entrants to be members of another group
- **Export participants** - copy the full participant list for backup
- **Re-run raffles** - create a new raffle with the same participants from a previous one
- **Live updates** - the raffle post updates in real-time as people enter
- **Fair selection** using cryptographically secure randomness
- **Raffle history** to review past raffles and winners
- **Admin-only controls** - only group admins can create, draw, and cancel raffles

## Setup

### 1. Create a Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Copy the bot token

### 2. Install & Configure

```bash
# Install dependencies
npm install

# Copy the example env file and add your bot token
cp .env.example .env
# Edit .env and set BOT_TOKEN=your_token_here
```

### 3. Run

```bash
# Development (with auto-reload)
npm run dev

# Production
npm run build
npm start
```

### 4. Add to a Group

1. Add the bot to your Telegram group
2. Make the bot an admin (so it can read messages and manage posts)
3. If using the group membership requirement feature, add the bot as admin to the required group too
4. Start creating raffles!

## Commands

| Command | Description | Who Can Use |
|---------|-------------|-------------|
| `/newraffle` | Create a new raffle | Group admins |
| `/raffles` | List open raffles in this chat | Everyone |
| `/draw [id]` | Draw winners for a raffle | Group admins |
| `/cancelraffle [id]` | Cancel a raffle | Group admins |
| `/exportentries [id]` | Export all participants | Group admins |
| `/rerun [id]` | Re-run a raffle with same participants | Group admins |
| `/myentries` | See your active entries | Everyone |
| `/rafflehistory` | View past raffles | Everyone |
| `/help` | Show help message | Everyone |

## Creating a Raffle

### Basic

```
/newraffle Title | Prize
```

### With Options

```
/newraffle Title | Prize | winners:3 | max:100 | ends:2h
```

### Multiple Prizes

Assign a different prize to each winner position. The number of winners is automatically set to match the number of prizes:

```
/newraffle Holiday Giveaway | prizes: $100 Gift Card, $50 Gift Card, $25 Gift Card | ends:1d
```

This creates a raffle with 3 winners where 1st place gets $100, 2nd gets $50, and 3rd gets $25.

### Require Group Membership

Require entrants to be members of another Telegram group. You need the chat ID of the required group (the bot must also be an admin in that group):

```
/newraffle VIP Giveaway | $500 Prize | require:-1001234567890 VIP Members Club | ends:2h
```

Users who try to enter without being a member of "VIP Members Club" will be rejected.

### All Options

| Option | Description | Example |
|--------|-------------|---------|
| `winners:N` | Number of winners (default: 1, max: 50) | `winners:3` |
| `max:N` | Maximum entries allowed | `max:100` |
| `ends:TIME` | Auto-close and draw after this time | `ends:2h` |
| `prizes: A, B, C` | Comma-separated prizes per position | `prizes: $100, $50, $25` |
| `require:CHAT_ID Name` | Require membership in another group | `require:-100123 VIP` |

### Time Formats

- `30m` - 30 minutes
- `2h` - 2 hours
- `1d` - 1 day
- `2025-12-31 23:59` - Specific date/time (UTC)

### Examples

```
/newraffle Holiday Giveaway | $50 Amazon Gift Card
/newraffle Movie Night | 2 Movie Tickets | winners:2 | ends:1d
/newraffle VIP Access | prizes: Lifetime Sub, 1-Year Sub, 6-Month Sub | ends:2h
/newraffle Members Only | $100 | require:-1001234567890 Premium Group | ends:1d
```

## Exporting Participants

Use `/exportentries` to get a full list of all participants in a raffle. This works on open, closed, and drawn raffles.

The export includes:
- Display names and usernames
- User IDs
- Entry timestamps
- A CSV file attachment for large participant lists

This is useful for:
- **Backup** - Save participant data before drawing
- **Re-running** - If something goes wrong, you have the data to start over
- **Verification** - Confirm who entered

## Re-running a Raffle

If a raffle needs to be re-done (technical issue, rule change, etc.), use `/rerun [id]`:

1. The bot creates a new raffle with the same title, prizes, and settings
2. All participants from the original raffle are automatically copied in
3. New participants can still join the re-run
4. An admin draws when ready

```
/rerun 5
```

This copies all entries from raffle #5 into a new raffle that's ready to draw.

## Data Retention / Auto-Purge

By default the bot keeps all raffle data forever. If you don't want participant data sitting on your server, set `DATA_RETENTION_HOURS` in your `.env` file:

```env
# Delete all completed raffle data after 24 hours
DATA_RETENTION_HOURS=24
```

Once a raffle is **drawn** or **cancelled**, the clock starts. After the configured number of hours, the raffle and all its entries, usernames, user IDs, and winner records are permanently deleted from the database.

| Value | Meaning |
|-------|---------|
| `0` | Keep everything forever (default) |
| `24` | Delete 24 hours after completion |
| `72` | Delete 3 days after completion |
| `168` | Delete 1 week after completion |

The purge runs once at startup and then every hour. Open raffles are never touched — only drawn or cancelled ones.

## How It Works

1. An admin creates a raffle with `/newraffle`
2. The bot posts a raffle message with **Enter** and **Leave** buttons
3. Users tap **Enter** to join - the entry count updates live
4. If a group membership requirement is set, the bot verifies membership before allowing entry
5. When ready, an admin uses `/draw` to pick winners (or they're auto-picked when the timer expires)
6. Each winner is assigned their specific prize (if multiple prizes are configured)
7. Winners are announced in the chat and mentioned by name

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **Bot Framework:** [grammY](https://grammy.dev/)
- **Database:** SQLite via better-sqlite3
- **Randomness:** Node.js `crypto.randomBytes` for fair winner selection
