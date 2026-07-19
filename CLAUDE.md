# CLAUDE.md — AI Assistant Guide for Ultimate Randomizer

> Last updated: 2026-07-19

## Project Overview

**Repository:** `liveoak87/Raffle_Bots`
**Status:** Active development
**Purpose:** Discord raffle bot — "Ultimate Random" — a number board where users claim slots and admins draw a random winner.

## Technology Stack

- **Runtime:** Node.js
- **Discord library:** discord.js v14
- **Database:** SQLite via better-sqlite3
- **Config:** dotenv for environment variables

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `claude/discord-raffle-app-60csT` | Deployed Discord bot production lineage |
| `codex/*` | AI-assisted development branches |
| Feature branches | Human-initiated feature work |

- The repository's `stable` default branch is an unrelated Telegram raffle bot
  with separate Git history. Never merge Discord production changes into it.
- Always develop on a designated feature branch and merge through a pull request
  targeting `claude/discord-raffle-app-60csT`.
- Use descriptive commit messages that explain *why* a change was made, not just *what* changed.
- Keep commits atomic — one logical change per commit.

## Getting Started (for AI assistants)

1. **Read this file first** before making any changes.
2. **Check the current branch** — ensure you are on the correct feature branch before committing.
3. **Explore existing code** before proposing changes — never modify files you haven't read.
4. **Run existing tests and builds** after making changes to verify nothing is broken.

## Development Conventions

### General Principles

- Keep solutions simple and focused — avoid over-engineering.
- Do not add features, refactoring, or "improvements" beyond what was explicitly requested.
- Prefer editing existing files over creating new ones.
- Do not introduce security vulnerabilities (XSS, SQL injection, command injection, etc.).
- Validate inputs at system boundaries; trust internal code and framework guarantees.

### Code Style

- Follow the existing code style and conventions found in the project (once established).
- Respect any linter/formatter configurations (ESLint, Prettier, etc.) present in the repo.
- Do not add comments, docstrings, or type annotations to code you did not change.
- Only add comments where logic is not self-evident.

### File Organization

```
src/
  index.js          — Bot entry point, interactions, draw and board workflows
  commands.js       — Slash command definitions (/randomizer, /pick, /help)
  board.js          — Embed, component, winner, and admin-panel rendering
  database.js       — SQLite schema, migrations, transactions, and queries
  random.js         — Cryptographic shuffle implementation
  update-queue.js   — Per-raffle serialized Discord board updates
  dashboard/        — Authenticated dashboard and health endpoint
  deploy.js         — One-time slash command registration script
test/               — Node test runner coverage
ops/                — Unraid backup, monitor, and restore scripts
```

- Keep related code co-located.
- Place tests alongside or mirroring the source files they cover.

## Build & Development Commands

```bash
# Install dependencies
npm install

# Register slash commands with Discord (run once, or after changing command definitions)
npm run deploy

# Start the bot
npm start

# Run the full test suite
npm test
```

## Testing

- Run the full test suite before pushing changes.
- Add tests for new functionality.
- Do not remove or skip existing tests without explicit approval.

## Environment & Secrets

- Never commit `.env` files, API keys, credentials, or secrets.
- Use `.env.example` (or equivalent) to document required environment variables without values.
- If you encounter files that may contain secrets, warn the user before staging them.

## Dependencies

- Do not add new dependencies without explicit approval.
- Prefer well-maintained, widely-used packages.
- Keep dependency upgrades in separate commits from feature work.

## Known Issues / Notes

- Bot requires `DISCORD_TOKEN` and `CLIENT_ID` in `.env`.
- One active raffle per channel at a time.
- Boards support up to 200 slots by publishing additional component messages.
- Automatic and manual draw state is persisted transactionally for restart recovery.
- The default SQLite path is `data/raffle.db` (gitignored).

---

*This file is intended for AI coding assistants (Claude, etc.) to understand the project context quickly. Keep it up to date as the project grows.*
