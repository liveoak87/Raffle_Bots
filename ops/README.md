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
`monitor.sh` reads the Discord webhook URL from
`/mnt/user/appdata/ultimate-randomizer/.alert_webhook` (first line). Create the
webhook in Discord (Server Settings → Integrations → Webhooks), then:

    echo 'https://discord.com/api/webhooks/XXX/YYY' > /mnt/user/appdata/ultimate-randomizer/.alert_webhook
    chmod 600 /mnt/user/appdata/ultimate-randomizer/.alert_webhook

Without it, the monitor still auto-restarts and logs to `monitor.log`; it just
won't push a notification.

## Install / refresh
    scp ops/backup-db.sh ops/monitor.sh unraid-cf:/mnt/user/appdata/ultimate-randomizer/
    scp ops/ultimate-randomizer.cron unraid-cf:/boot/config/plugins/dynamix/
    ssh unraid-cf 'chmod +x /mnt/user/appdata/ultimate-randomizer/{backup-db,monitor}.sh && update_cron'

## Restore from a backup
    gunzip -c backups/raffle-YYYYMMDD-HHMMSS.db.gz > /tmp/restore.db
    # stop the bot, replace data/raffle.db with /tmp/restore.db, remove stale -wal/-shm, start
