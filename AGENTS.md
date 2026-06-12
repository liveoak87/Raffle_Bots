# AGENTS.md — AI Assistant Guide for redbeardpeptides

> Last updated: 2026-02-07

## Project Overview

**Repository:** `liveoak87/redbeardpeptides`
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
| `main` | Production-ready code (protected) |
| `Codex/*` | AI-assisted development branches |
| Feature branches | Human-initiated feature work |

- Always develop on the designated feature branch, never push directly to `main`.
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
  index.js      — Bot entry point, event handlers, command logic
  commands.js   — Slash command definitions (/raffle, /pick)
  board.js      — Embed board rendering + button grid
  database.js   — SQLite schema and queries
  deploy.js     — One-time slash command registration script
.env.example    — Required environment variables template
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

- Bot requires `DISCORD_TOKEN` and `CLIENT_ID` in `.env` (see `.env.example`).
- One active raffle per channel at a time.
- Button grid supports up to 25 slots (Discord component limit).
- The `raffle.db` SQLite file is created at runtime in the project root (gitignored).

---

*This file is intended for AI coding assistants (Codex, etc.) to understand the project context quickly. Keep it up to date as the project grows.*
