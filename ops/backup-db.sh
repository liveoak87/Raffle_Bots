#!/bin/bash
# Ultimate Randomizer — hourly WAL-safe SQLite backup with integrity check + pruning.
# Installed on the Unraid host; scheduled via /boot/config/plugins/dynamix/ultimate-randomizer.cron
set -uo pipefail

BASE="/mnt/user/appdata/ultimate-randomizer"
DB="$BASE/data/raffle.db"
DEST="$BASE/backups"
RETAIN_HOURS=168            # keep 7 days of hourly backups
LOCK="/tmp/ur-backup.lock"

ts() { date '+%F %T'; }
mkdir -p "$DEST"

# Prevent overlapping runs.
exec 9>"$LOCK"
flock -n 9 || { echo "$(ts) skip: backup already running"; exit 0; }

[ -f "$DB" ] || { echo "$(ts) ERROR: db not found at $DB"; exit 1; }

STAMP=$(date '+%Y%m%d-%H%M%S')
OUT="$DEST/raffle-$STAMP.db"

# .backup is a consistent online snapshot, safe while the bot is writing (WAL).
if ! sqlite3 "$DB" ".backup '$OUT'"; then
  echo "$(ts) ERROR: sqlite .backup failed"; rm -f "$OUT"; exit 1
fi

# Verify the snapshot is a valid, uncorrupted database before we trust it.
if ! sqlite3 "$OUT" 'PRAGMA integrity_check;' | grep -q '^ok$'; then
  echo "$(ts) ERROR: integrity check failed on snapshot"; rm -f "$OUT"; exit 1
fi

gzip -f "$OUT"
[ -s "$OUT.gz" ] || { echo "$(ts) ERROR: gzip produced empty file"; exit 1; }

# Prune backups older than the retention window.
find "$DEST" -name 'raffle-*.db.gz' -mmin +$((RETAIN_HOURS * 60)) -delete

KEPT=$(find "$DEST" -name 'raffle-*.db.gz' | wc -l | tr -d ' ')
echo "$(ts) ok: $(basename "$OUT").gz ($(du -h "$OUT.gz" | cut -f1)), $KEPT kept"
