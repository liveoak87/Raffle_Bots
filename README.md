# Telegram Raffle Bot

A Telegram bot for running raffles and giveaways in group chats. Features inline buttons for easy entry, automatic draws with timed raffles, multiple winner support, and admin-only controls.

## Features

- **Create raffles** with customizable prizes, entry limits, and deadlines
- **One-tap entry** via inline keyboard buttons
- **Automatic draws** when a raffle timer expires
- **Manual draws** triggered by group admins
- **Multiple winners** support (up to 50)
- **Entry limits** to cap the number of participants
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
3. Start creating raffles!

## Commands

| Command | Description | Who Can Use |
|---------|-------------|-------------|
| `/newraffle` | Create a new raffle | Group admins |
| `/raffles` | List open raffles in this chat | Everyone |
| `/draw [id]` | Draw winners for a raffle | Group admins |
| `/cancelraffle [id]` | Cancel a raffle | Group admins |
| `/myentries` | See your active entries | Everyone |
| `/rafflehistory` | View past raffles | Everyone |
| `/help` | Show help message | Everyone |

## Creating a Raffle

### Quick Format

```
/newraffle Title | Prize
/newraffle Title | Prize | winners:3
/newraffle Title | Prize | winners:3 | max:100 | ends:2h
```

### Options

- **winners:N** - Number of winners to draw (default: 1, max: 50)
- **max:N** - Maximum number of entries allowed
- **ends:TIME** - Auto-close and draw after this time

### Time Formats

- `30m` - 30 minutes
- `2h` - 2 hours
- `1d` - 1 day
- `2025-12-31 23:59` - Specific date/time (UTC)

### Examples

```
/newraffle Holiday Giveaway | $50 Amazon Gift Card
/newraffle Movie Night | 2 Movie Tickets | winners:2 | ends:1d
/newraffle VIP Access | Premium Subscription | max:50 | winners:5 | ends:2h
```

## How It Works

1. An admin creates a raffle with `/newraffle`
2. The bot posts a raffle message with **Enter** and **Leave** buttons
3. Users tap **Enter** to join - the entry count updates live
4. When ready, an admin uses `/draw` to pick winners (or they're auto-picked when the timer expires)
5. Winners are announced in the chat and mentioned by name

## Tech Stack

- **Runtime:** Node.js
- **Language:** TypeScript
- **Bot Framework:** [grammY](https://grammy.dev/)
- **Database:** SQLite via better-sqlite3
- **Randomness:** Node.js `crypto.randomBytes` for fair winner selection
