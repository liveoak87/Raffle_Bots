#!/bin/bash
# Ultimate Randomizer — ship local hourly backups off-site (3-2-1: local + R2 + Linode).
# Idempotent: rclone/rsync only transfer files not already at the destination.
# Runs hourly, offset from the local backup so a fresh file exists to ship.
set -uo pipefail

LOCAL_BACKUP_DIR="/mnt/user/appdata/ultimate-randomizer/backups"
GLOB='raffle-*.db.gz'
R2_REMOTE="r2:ultimate-randomizer-backups"
LINODE_HOST="root@45.79.198.189"
LINODE_DIR="/var/backups/ultimate-randomizer"
SSH_KEY="/root/.ssh/id_ed25519"
LOG_FILE="/var/log/ultimate-randomizer-ship.log"
LOCK_FILE="/tmp/ur-ship.lock"

exec 200>"$LOCK_FILE"
flock -n 200 || { echo "$(date -Iseconds) ship already running, exit" >> "$LOG_FILE"; exit 0; }

log() { echo "$(date -Iseconds) $*" | tee -a "$LOG_FILE"; }

[ -d "$LOCAL_BACKUP_DIR" ] || { log "ERROR: $LOCAL_BACKUP_DIR missing"; exit 1; }
COUNT=$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name "$GLOB" -type f | wc -l | tr -d ' ')
[ "$COUNT" -gt 0 ] || { log "no local backups to ship"; exit 0; }

# ── Cloudflare R2 (off-site, long-term) ──────────────────────────────────────
log "R2: syncing $COUNT file(s) to $R2_REMOTE"
if rclone copy "$LOCAL_BACKUP_DIR" "$R2_REMOTE" --include "$GLOB" \
     --transfers 2 --checkers 4 --log-level INFO --log-file "$LOG_FILE" --stats 0; then
  R2N=$(rclone size "$R2_REMOTE" --json 2>/dev/null | grep -o '"count":[0-9]*' | cut -d: -f2)
  log "R2: ok — $R2N files"
else
  log "R2: FAILED"
fi

# ── Linode VPS (geographic redundancy) ───────────────────────────────────────
log "Linode: syncing to $LINODE_HOST:$LINODE_DIR"
if rsync -az --include="$GLOB" --include='*/' --exclude='*' \
     -e "ssh -i $SSH_KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15" \
     "$LOCAL_BACKUP_DIR/" "$LINODE_HOST:$LINODE_DIR/" >> "$LOG_FILE" 2>&1; then
  LN=$(ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 \
        "$LINODE_HOST" "find $LINODE_DIR -maxdepth 1 -name '$GLOB' -type f | wc -l" 2>/dev/null || echo '?')
  log "Linode: ok — $LN files"
else
  log "Linode: FAILED"
fi

log "ship complete"
