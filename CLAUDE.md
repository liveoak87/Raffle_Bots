# CLAUDE.md — AI Assistant Guide for redbeardpeptides

> Last updated: 2026-02-04

## Project Overview

**Repository:** `liveoak87/redbeardpeptides`
**Status:** New project — repository initialized, no application code yet.
**Purpose:** Red Beard Peptides project repository.

## Repository State

This repository is currently empty and awaiting initial project scaffolding. When the project is bootstrapped, this document should be updated to reflect the chosen technology stack, directory structure, and development workflows.

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code (protected) |
| `claude/*` | AI-assisted development branches |
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

- Once the project is scaffolded, document the directory structure here.
- Keep related code co-located.
- Place tests alongside or mirroring the source files they cover.

## Build & Development Commands

> To be documented once the project stack is chosen. Example format:

```bash
# Install dependencies
# npm install / yarn / pnpm install

# Start development server
# npm run dev

# Run tests
# npm test

# Build for production
# npm run build

# Lint / format
# npm run lint
# npm run format
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

- Repository is freshly initialized with no code or configuration yet.
- This CLAUDE.md should be updated as the project evolves to reflect actual structure, commands, and conventions.

---

*This file is intended for AI coding assistants (Claude, etc.) to understand the project context quickly. Keep it up to date as the project grows.*
