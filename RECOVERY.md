# Raffle Bot — Disaster Recovery Runbook

**Purpose:** What to do on the worst days. Each scenario below is a concrete
step-by-step procedure designed to be followed under stress, by anyone with
basic shell skills.

Last verified: 2026-05-10 (weekly restore-drill cron handles ongoing validation)

---

## Infrastructure at a Glance

| Component | Location | Access |
|---|---|---|
| Bot container | Unraid (`/mnt/user/appdata/raffle-bot/`) | `ssh unraid-cf` (Cloudflare tunnel) |
| Live database | Unraid: `/mnt/user/appdata/raffle-bot/data/raffle.db` | inside container or via host |
| Local backups | Unraid: `/mnt/user/appdata/raffle-bot/data/backups/` | 48 hourly files |
| Cloudflare R2 | Bucket: `raffle-bot-backups` | `rclone ls r2:raffle-bot-backups` |
| Linode VPS | `<LINODE_IP>` (Atlanta) | `ssh root@<LINODE_IP>` (key auth) |
| Linode backups | `/var/backups/raffle-bot/` on Linode | 30 days retention |
| Heartbeat | `https://hc-ping.com/<your-uuid>` | healthchecks.io dashboard |
| Bot token | env file: `/mnt/user/appdata/raffle-bot/.env` | created via @BotFather |

> **Concrete values** (Linode IP, heartbeat UUID, R2 keys, bot token) are
> kept out of this repo (it's public). Real values live in:
> - `/mnt/user/appdata/raffle-bot/.env` on Unraid (BOT_TOKEN, BOT_OWNER_ID, HEARTBEAT_URL)
> - `/root/.config/rclone/rclone.conf` on Unraid (R2 access keys)
> - `~/CLAUDE.md` on the operator's laptop (master reference)
> - Cloudflare dashboard (R2 token management) and Linode dashboard (VPS IP)

---

## Scenario 1 — Database is corrupted or accidentally wiped

**Symptoms:** Bot won't start, "/health" shows zero groups, integrity check fails.

**Recovery (5 commands, ~3 minutes):**

```bash
# 1. Stop the bot (prevents writes during restore)
ssh unraid-cf "docker stop raffle-bot"

# 2. Move the bad DB out of the way (don't delete — for forensics)
ssh unraid-cf "mv /mnt/user/appdata/raffle-bot/data/raffle.db /mnt/user/appdata/raffle-bot/data/raffle.db.broken-$(date +%s)"

# 3. Find the most recent local backup
ssh unraid-cf "ls -t /mnt/user/appdata/raffle-bot/data/backups/raffle.db.*.bak | head -3"

# 4. Restore (replace TIMESTAMP with the file you chose)
ssh unraid-cf "cp /mnt/user/appdata/raffle-bot/data/backups/raffle.db.TIMESTAMP.bak /mnt/user/appdata/raffle-bot/data/raffle.db"

# 5. Start the bot
ssh unraid-cf "docker start raffle-bot && docker logs raffle-bot --tail 20"
```

**Verify in Telegram:** DM the bot `/health` — counts should match recent history.

**Data loss window:** Up to 1 hour (since last hourly backup).

---

## Scenario 2 — Local backups are also gone (server fire, disk wipe)

**Symptoms:** Unraid backup folder empty or unreadable.

**Recovery from R2 (~5 minutes):**

```bash
# 1. List recent backups in R2
ssh unraid-cf "rclone ls r2:raffle-bot-backups | sort | tail -10"

# 2. Stop the bot
ssh unraid-cf "docker stop raffle-bot"

# 3. Move any corrupted DB aside
ssh unraid-cf "mv /mnt/user/appdata/raffle-bot/data/raffle.db /mnt/user/appdata/raffle-bot/data/raffle.db.broken-$(date +%s) 2>/dev/null || true"

# 4. Download the latest backup from R2
ssh unraid-cf "rclone copyto r2:raffle-bot-backups/raffle.db.TIMESTAMP.bak /mnt/user/appdata/raffle-bot/data/raffle.db"

# 5. Restart
ssh unraid-cf "docker start raffle-bot && docker logs raffle-bot --tail 20"
```

**Recovery from Linode (alternative):**

```bash
# 1. Find latest backup on Linode
ssh root@<LINODE_IP> "ls -t /var/backups/raffle-bot/raffle.db.*.bak | head -3"

# 2. Pull it to Unraid
ssh unraid-cf "scp -i /root/.ssh/id_ed25519 root@<LINODE_IP>:/var/backups/raffle-bot/raffle.db.TIMESTAMP.bak /mnt/user/appdata/raffle-bot/data/raffle.db"

# 3. Restart bot (steps 2 and 5 above)
```

---

## Scenario 3 — Unraid server completely lost (fire, theft, total failure)

**You still have:** Cloudflare R2 + Linode (off-site copies of the DB and bot code is in git).

**Recovery on any new Docker host (~30 minutes):**

```bash
# 1. Provision the new host. Install Docker + Docker Compose + rclone if not present.

# 2. Clone the repo
git clone <your-repo-url> raffle-bot
cd raffle-bot

# 3. Create the data directory and pull the latest DB from R2
mkdir -p data/backups
# Configure rclone with R2 access key (see CLAUDE.md for current credentials)
rclone config  # or copy /root/.config/rclone/rclone.conf if you have a backup
rclone copyto r2:raffle-bot-backups/raffle.db.LATEST.bak data/raffle.db

# 4. Create .env with secrets
cat > .env <<EOF
BOT_TOKEN=<token from @BotFather or Telegram bot settings>
BOT_OWNER_ID=7936540631
DATABASE_PATH=/data/raffle.db
HEARTBEAT_URL=https://hc-ping.com/<your-uuid>
EOF

# 5. Build and run
docker build -t raffle-bot:stable .
docker run -d --name raffle-bot --restart unless-stopped \
  --log-opt max-size=50m --log-opt max-file=5 \
  --env-file .env \
  -v $(pwd)/data:/data \
  raffle-bot:stable

# 6. Verify
docker logs raffle-bot --tail 30
```

Telegram bot will reconnect automatically. No DNS or webhook changes needed (still polling-based).

**Data loss window:** Up to 1 hour (last R2 sync).

---

## Scenario 4 — Cloudflare R2 account compromised or inaccessible

**You still have:** Linode (independent provider).

**Action:** Don't panic. Linode backups are independent. Skip R2 in `ship-backups.sh` until R2 access is restored.

```bash
# Disable R2 portion temporarily:
ssh unraid-cf "sed -i 's|^rclone copy|#rclone copy|' /mnt/user/appdata/raffle-bot/scripts/ship-backups.sh"

# When R2 is restored: edit out the `#` and rotate R2 API credentials:
# 1. Cloudflare dashboard → R2 → API Tokens → delete old token, create new
# 2. Update /root/.config/rclone/rclone.conf on Unraid with new keys
```

---

## Scenario 5 — Linode VPS lost or inaccessible

**You still have:** R2 + local Unraid. Lowest impact scenario.

**Action:** Spin up replacement Linode (or any SSH-accessible Linux VPS), point `LINODE_HOST` in `ship-backups.sh` at it. Install the SSH public key from Unraid `/root/.ssh/id_ed25519.pub` into the new host's `~/.ssh/authorized_keys`. Create `/var/backups/raffle-bot/` directory.

---

## Scenario 6 — Bot token compromised

**Symptoms:** Unauthorized messages from the bot, strangers in DMs claiming the bot did something.

**Recovery:**

1. Open Telegram, message `@BotFather`
2. `/mybots` → select your bot → `API Token` → `Revoke current token`
3. Copy the new token
4. SSH to Unraid: `ssh unraid-cf "nano /mnt/user/appdata/raffle-bot/.env"`
5. Replace `BOT_TOKEN=...` with the new value
6. Restart: `ssh unraid-cf "docker restart raffle-bot"`
7. **Audit:** Check `/health` and `/metrics` for spikes; review group activity for the past hour.

---

## Scenario 7 — Bot is running but raffles are stuck

**Symptoms:** Multiple raffles in `/health` showing "Stuck >15 min" or "Stuck >1 hour."

**Diagnose:**

```bash
# Latest errors
ssh unraid-cf "docker logs raffle-bot --tail 200 | jq -c 'select(.level == \"error\" or .level == \"warn\")'"

# API error breakdown (DM /metrics to the bot)

# Check Telegram API status: https://core.telegram.org/api/status
```

**Common causes & fixes:**
- **429 cluster** → wait it out, the 90s autoRetry + per-chat throttle will work through it
- **403 on specific chat** → bot was kicked from that chat; the retry will mark as failed in 24h
- **400 "message too long"** → check if you recently added new long output; bump `chunkMessage` boundary

**Manual force-announce (if needed):**
```bash
# Use the throttled script from earlier (still on the host):
# Adapt the time window in scripts/process-stuck-announcements.js if needed
```

---

## Routine Verifications

| Check | Cadence | What to look at |
|---|---|---|
| `/health` from Telegram | Daily | "Pending" should be 0, "Last backup" should be <90 min |
| `/metrics` from Telegram | Weekly | error rate <1%, no method with p95 >2s |
| healthchecks.io dashboard | Set alerts | Email/SMS if no ping in 10 min |
| Restore drill (auto) | Weekly Sun 5 AM | Check `/var/log/raffle-bot-restore-drill.log` after |
| R2 storage size | Quarterly | Free tier = 10 GB. Currently ~7 MB/hour = ~6 GB/quarter. Adjust retention if approaching limit. |

---

## Emergency Contact Cheat Sheet

- **Telegram BotFather:** `@BotFather` in Telegram (for token issues)
- **Cloudflare:** https://dash.cloudflare.com → R2 → buckets
- **Linode:** https://cloud.linode.com → Linodes → list (use `Lish Console` if SSH dies)
- **Healthchecks.io:** https://healthchecks.io/checks/ (uptime alerting)

---

## Optional: Switch to Webhook Mode

By default the bot uses **long-polling** (asks Telegram for updates every ~1s).
Webhooks invert this: Telegram pushes updates to a public URL. Lower latency,
less bandwidth, scales further.

**Trade-offs:**
- ✅ Button clicks feel snappier (~200ms vs ~500-800ms)
- ✅ Less Telegram API quota burned on `getUpdates`
- ❌ Requires a public HTTPS endpoint
- ❌ One more moving piece to break

The code already supports webhooks — flip on by setting env vars and
configuring a Cloudflare Tunnel (or any HTTPS reverse proxy):

```bash
# 1. Generate a random secret for webhook validation
WEBHOOK_SECRET=$(openssl rand -hex 32)

# 2. Add env vars to /mnt/user/appdata/raffle-bot/.env:
WEBHOOK_URL=https://your-public-hostname.example.com/webhook
WEBHOOK_SECRET=<the secret above>
WEBHOOK_PORT=3001

# 3. Configure Cloudflare Tunnel to route the public hostname → container:3001
#    (Add an ingress rule for the hostname in the existing tunnel config)

# 4. Restart the container with the port exposed:
docker run -d --name raffle-bot --restart unless-stopped \
  --log-opt max-size=50m --log-opt max-file=5 \
  -p 3001:3001 \
  --env-file .env \
  -v /mnt/user/appdata/raffle-bot/data:/data \
  raffle-bot:stable

# 5. Verify in logs:
docker logs raffle-bot | grep -i webhook
# Should show "Starting in webhook mode" and "Webhook registered with Telegram"
```

**Rollback to polling:** Remove `WEBHOOK_URL` from `.env` and restart.
On startup the bot will detect the empty URL and use polling instead.

---

## Test This Runbook Annually

Plan a recovery drill once a year:
1. Spin up a sandbox machine
2. Follow Scenario 3 from scratch
3. Time how long it takes
4. Update this doc with anything that surprised you

A runbook nobody has practiced is a runbook that fails when it matters.
