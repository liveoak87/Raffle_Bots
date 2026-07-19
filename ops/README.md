# Ops — Ultimate Randomizer (Unraid host)

Operational scripts that run on the Unraid host (not inside the container). The
Docker image only contains `src/`; these live at
`/mnt/user/appdata/ultimate-randomizer/` and are scheduled via Unraid's
persistent cron (`/boot/config/plugins/dynamix/*.cron`, reloaded with `update_cron`).

## Files
- `backup-db.sh` — hourly online SQLite backup (`.backup` + `PRAGMA integrity_check`),
  gzipped to `data/../backups/`, 7-day retention. WAL-safe; runs while the bot is live.
- `monitor.sh` — every 5 min: restarts the container if it's stopped or `unhealthy`
  (gateway zombie), and posts to a Discord webhook if configured.
- `ultimate-randomizer.cron` — the schedule installed into dynamix cron.

## Alerting
Alerts are sent by `monitor.sh` (the HOST watchdog), not by the bot — so they
still fire when the bot is down. Configure Discord and/or Telegram (either, or
both). Without either, the monitor still auto-restarts and logs to `monitor.log`.

**Discord** — create a webhook (Server Settings → Integrations → Webhooks):

    echo 'https://discord.com/api/webhooks/XXX/YYY' > /mnt/user/appdata/ultimate-randomizer/.alert_webhook
    chmod 600 /mnt/user/appdata/ultimate-randomizer/.alert_webhook

**Telegram** — message @BotFather to make a bot (get its token), then message your
bot once and find your chat id (e.g. via @userinfobot). Line 1 = token, line 2 = chat id:

    printf '%s\n%s\n' '123456:ABC-bot-token' '987654321' > /mnt/user/appdata/ultimate-randomizer/.alert_telegram
    chmod 600 /mnt/user/appdata/ultimate-randomizer/.alert_telegram

### What alerting CAN'T catch on its own
The host monitor can't notify you if the **whole Unraid box (or its internet) is
down** — it'd be dead too. For that, add an external dead-man's-switch: a free
service (healthchecks.io, Better Stack, UptimeRobot) gives you a ping URL; the box
curls it every few minutes, and the service alerts YOU (email/SMS/Discord/Telegram)
if the pings stop. Example cron line once you have a ping URL:

    */5 * * * * curl -fsS -m 10 https://hc-ping.com/your-uuid > /dev/null 2>&1

That covers "everything is down"; the in-host monitor covers "the bot is down."

## Install / refresh
    scp ops/backup-db.sh ops/monitor.sh unraid-cf:/mnt/user/appdata/ultimate-randomizer/
    scp ops/ultimate-randomizer.cron unraid-cf:/boot/config/plugins/dynamix/
    ssh unraid-cf 'chmod +x /mnt/user/appdata/ultimate-randomizer/{backup-db,monitor}.sh && update_cron'

## Planned container maintenance

The host monitor will restart a deliberately stopped container unless maintenance
mode is enabled. Create the sentinel immediately before a controlled swap and
remove it as soon as the replacement is healthy:

    touch /mnt/user/appdata/ultimate-randomizer/.maintenance
    # stop/recreate/verify the container
    rm /mnt/user/appdata/ultimate-randomizer/.maintenance

Never leave the sentinel in place after maintenance; while it exists, automatic
recovery checks are intentionally disabled.

## Off-site shipping (3-2-1) — OPERATOR-ACTIVATED

`ship-backups.sh` (hourly) and `restore-drill.sh` (weekly) push the local backups
to Cloudflare R2 + a Linode VPS, mirroring the raffle-bot pipeline. These egress
user data off the host, so they must be activated by the operator (run by hand),
not by an automated assistant. To activate:

    # 1. install scripts
    scp ops/ship-backups.sh ops/restore-drill.sh unraid-cf:/mnt/user/appdata/ultimate-randomizer/
    ssh unraid-cf 'chmod +x /mnt/user/appdata/ultimate-randomizer/{ship-backups,restore-drill}.sh'

    # 2. create off-site targets
    # R2: backups go to a prefix inside the EXISTING raffle-bot-backups bucket
    #     (the rclone token can't create new buckets — 403 AccessDenied — and
    #     rclone creates the prefix implicitly on first copy, so no mkdir needed).
    #     To use a dedicated bucket instead, create it in the Cloudflare dashboard
    #     and set R2_REMOTE back to r2:ultimate-randomizer-backups in both scripts.
    ssh unraid-cf 'ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new root@45.79.198.189 "mkdir -p /var/backups/ultimate-randomizer"'

    # 3. first ship + verify
    ssh unraid-cf '/mnt/user/appdata/ultimate-randomizer/ship-backups.sh'
    ssh unraid-cf '/mnt/user/appdata/ultimate-randomizer/restore-drill.sh'

    # 4. load the full cron (adds the :30 ship + weekly drill)
    scp ops/ultimate-randomizer.cron unraid-cf:/boot/config/plugins/dynamix/
    ssh unraid-cf 'update_cron'

Until activated, backups are local-only (Unraid array, parity-protected). The
`ultimate-randomizer.cron` here already lists the ship/drill jobs, but they no-op
until the scripts and targets above exist.

## Restore from a backup
    gunzip -c backups/raffle-YYYYMMDD-HHMMSS.db.gz > /tmp/restore.db
    # stop the bot, replace data/raffle.db with /tmp/restore.db, remove stale -wal/-shm, start
