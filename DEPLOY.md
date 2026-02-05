# Telegram Raffle Bot - Deployment Guide

## Architecture

- **Local machine**: macOS — source code, git repo, editing
- **Remote server**: `root@100.85.220.125` (Unraid) — Docker builds and runs
- **No Docker locally** — all builds happen on the remote server via SSH

## Git Branches

| Branch   | Purpose                  |
|----------|--------------------------|
| `dev`    | Development / testing    |
| `stable` | Production               |

Remote: `origin` → `https://github.com/liveoak87/redbeardpeptides.git`

## Server Paths

| Environment | Server Path                            | Container Name    | Image Tag          |
|-------------|----------------------------------------|-------------------|--------------------|
| Dev         | `/mnt/user/appdata/raffle-bot-dev/`    | `raffle-bot-dev`  | `raffle-bot-dev`   |
| Production  | `/mnt/user/appdata/raffle-bot/`        | `raffle-bot`      | `raffle-bot:stable`|

Both have identical structure:
```
├── Dockerfile
├── docker-compose.yml
├── package.json
├── package-lock.json
├── tsconfig.json
├── src/           ← TypeScript source
├── assets/        ← Static assets (GIFs, images)
├── data/          ← Mounted volume for SQLite DB
└── .env           ← BOT_TOKEN, DATABASE_PATH, etc.
```

## Deploy to Dev

### 1. Typecheck locally
```bash
cd /Users/dprobinson/Desktop/Projects/telegram-raffle-app && npx tsc --noEmit
```

### 2. Copy changed files to dev server
```bash
cd /Users/dprobinson/Desktop/Projects/telegram-raffle-app && scp src/*.ts root@100.85.220.125:/mnt/user/appdata/raffle-bot-dev/src/
```

If `package.json` or `package-lock.json` changed:
```bash
scp package.json package-lock.json root@100.85.220.125:/mnt/user/appdata/raffle-bot-dev/
```

If assets changed:
```bash
scp -r assets/ root@100.85.220.125:/mnt/user/appdata/raffle-bot-dev/
```

### 3. Build and restart dev container
```bash
ssh root@100.85.220.125 "cd /mnt/user/appdata/raffle-bot-dev && docker build -t raffle-bot-dev . && docker stop raffle-bot-dev && docker rm raffle-bot-dev && docker run -d --name raffle-bot-dev --restart unless-stopped --env-file .env -v /mnt/user/appdata/raffle-bot-dev/data:/data raffle-bot-dev"
```

### 4. Verify
```bash
ssh root@100.85.220.125 "docker logs raffle-bot-dev --tail 5"
```

## Deploy to Production (Stable)

### 1. Merge dev into stable
```bash
cd /Users/dprobinson/Desktop/Projects/telegram-raffle-app && git checkout stable && git merge dev && git push origin stable && git checkout dev
```

### 2. Copy changed files to production server
```bash
cd /Users/dprobinson/Desktop/Projects/telegram-raffle-app && scp src/*.ts root@100.85.220.125:/mnt/user/appdata/raffle-bot/src/
```

If `package.json` or `package-lock.json` changed:
```bash
scp package.json package-lock.json root@100.85.220.125:/mnt/user/appdata/raffle-bot/
```

If assets changed:
```bash
scp -r assets/ root@100.85.220.125:/mnt/user/appdata/raffle-bot/
```

### 3. Build and restart production container
```bash
ssh root@100.85.220.125 "cd /mnt/user/appdata/raffle-bot && docker build -t raffle-bot:stable . && docker stop raffle-bot && docker rm raffle-bot && docker run -d --name raffle-bot --restart unless-stopped --env-file .env -v /mnt/user/appdata/raffle-bot/data:/data raffle-bot:stable"
```

### 4. Verify
```bash
ssh root@100.85.220.125 "docker logs raffle-bot --tail 5"
```

## Quick Status Check
```bash
ssh root@100.85.220.125 "docker ps --filter name=raffle -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
```

## Rollback Production
```bash
# On local machine
git checkout stable
git revert HEAD
git push origin stable

# Then redeploy using production steps 2-4 above
```

## Environment Variables (.env)

Both environments use `.env` files on the server (not in git):
- `BOT_TOKEN` — Telegram bot token (different per environment)
- `DATABASE_PATH=/data/raffle.db`
- `DATA_RETENTION_HOURS` — Dev: not set (keep all), Prod: `720` (30 days)
- `BOT_OWNER_ID=7936540631`
