# Telegram Raffle Bot - Deployment Guide

## Architecture

- **Local machine**: macOS — source code, git repo, editing
- **Remote server**: `unraid-cf` (Unraid) — Docker builds and runs
- **No Docker locally** — all builds happen on the remote server via SSH

## Git Branches

| Branch   | Purpose                  |
|----------|--------------------------|
| `dev`    | Development / testing    |
| `stable` | Production               |

Git remote `origin` points to `https://github.com/liveoak87/Raffle_Bots.git`.

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
cd /Users/dprobinson/Desktop/Projects/telegram-raffle-app && scp src/*.ts unraid-cf:/mnt/user/appdata/raffle-bot-dev/src/
```

If `package.json` or `package-lock.json` changed:
```bash
scp package.json package-lock.json unraid-cf:/mnt/user/appdata/raffle-bot-dev/
```

If assets changed:
```bash
scp -r assets/ unraid-cf:/mnt/user/appdata/raffle-bot-dev/
```

### 3. Build and restart dev container
```bash
ssh unraid-cf "cd /mnt/user/appdata/raffle-bot-dev && docker build -t raffle-bot-dev . && docker stop raffle-bot-dev && docker rm raffle-bot-dev && docker run -d --name raffle-bot-dev --restart unless-stopped --env-file .env -e ADMIN_PORT=8787 -v /mnt/user/appdata/raffle-bot-dev/data:/data -p 8789:8787 raffle-bot-dev"
```

### 4. Verify
```bash
ssh unraid-cf "docker logs raffle-bot-dev --tail 5"
```

## Deploy to Production (Stable)

### 1. Build the published stable commit

Run this from the repository after the tested changes reach `stable`. The build context comes from that commit, including the forum-topic and recurring-raffle modules. The image tag records the commit used for the build.

```bash
set -eo pipefail
git fetch origin stable
release_commit=$(git rev-parse origin/stable)
git archive "$release_commit" Dockerfile .dockerignore package.json package-lock.json tsconfig.json src assets scripts/load-simulate.js |
  ssh unraid-cf "docker build -t raffle-bot:$release_commit -"
```

### 2. Start the built image

Production uses the private Telegram Bot API container on the `raffle-telegram-api` Docker network. Check that it is running before replacing the bot. A normal raffle bot deploy keeps the same API endpoint and does not require a Telegram session handoff.

```bash
ssh unraid-cf sh -s -- "$release_commit" <<'REMOTE'
set -eu
cd /mnt/user/appdata/raffle-bot
test "$(docker inspect --format '{{.State.Running}}' raffle-telegram-api)" = true
docker network inspect raffle-telegram-api >/dev/null
release_image="raffle-bot:$1"
docker image inspect "$release_image" >/dev/null
docker stop -t 15 raffle-bot
docker rm raffle-bot
docker run -d --name raffle-bot --restart unless-stopped \
  --network raffle-telegram-api --env-file .env \
  -e TELEGRAM_API_ROOT=http://raffle-telegram-api:8081 -e ADMIN_PORT=8787 \
  -v /mnt/user/appdata/raffle-bot/data:/data -p 8788:8787 \
  --log-opt max-size=50m --log-opt max-file=1 "$release_image"
REMOTE
```

### 3. Verify and tag the healthy image
```bash
ssh unraid-cf "docker logs raffle-bot --tail 5"
curl -fsS https://raffle-admin.dundermifflinserver.com/health
ssh unraid-cf sh -s -- "$release_commit" <<'REMOTE'
set -eu
release_image="raffle-bot:$1"
test "$(docker inspect --format '{{.State.Health.Status}}' raffle-bot)" = healthy
test "$(docker inspect --format '{{.Image}}' raffle-bot)" = "$(docker image inspect --format '{{.Id}}' "$release_image")"
docker tag "$release_image" raffle-bot:stable
REMOTE
```

HTTP 200 confirms that the bot has successfully polled Telegram. See [Bot API handoffs](RECOVERY.md#bot-api-handoffs) before changing the API endpoint or starting the saved rollback container.

## Quick Status Check
```bash
ssh unraid-cf "docker ps --filter name=raffle -a --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
curl -fsS https://raffle-admin.dundermifflinserver.com/health
```

## Rollback Production
```bash
# On local machine
git checkout stable
git revert HEAD
git push origin stable

# Then rebuild and redeploy using production steps 1–3 above
```

## Environment Variables (.env)

Both environments use `.env` files on the server (not in git):
- `BOT_TOKEN` — Telegram bot token (different per environment)
- `DATABASE_PATH=/data/raffle.db`
- `DATA_RETENTION_HOURS` — Dev: not set (keep all), Prod: `720` (30 days)
- `BOT_OWNER_ID=7936540631`
