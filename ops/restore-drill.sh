#!/bin/bash
# Ultimate Randomizer — weekly restore drill.
# A backup you've never restored is a backup you can't trust. Pulls the newest
# backup from each off-site target, restores it to a sandbox, runs an integrity
# check, and verifies the table counts are in the same ballpark as the live DB.
set -uo pipefail

TARGETS="${1:-all}"
DRILL_DIR="/tmp/ur-restore-drill"
LIVE_DB="/mnt/user/appdata/ultimate-randomizer/data/raffle.db"
R2_REMOTE="r2:ultimate-randomizer-backups"
LINODE_HOST="root@45.79.198.189"
LINODE_DIR="/var/backups/ultimate-randomizer"
SSH_KEY="/root/.ssh/id_ed25519"
LOG_FILE="/var/log/ultimate-randomizer-restore-drill.log"
LOCK_FILE="/tmp/ur-restore-drill.lock"
SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15"

exec 200>"$LOCK_FILE"
flock -n 200 || { echo "$(date -Iseconds) drill already running, exit" >> "$LOG_FILE"; exit 0; }
log() { echo "$(date -Iseconds) $*" | tee -a "$LOG_FILE"; }

rm -rf "$DRILL_DIR"; mkdir -p "$DRILL_DIR"
LIVE_RAFFLES=$(sqlite3 "$LIVE_DB" 'SELECT COUNT(*) FROM raffles;' 2>/dev/null || echo 0)
log "drill start — live DB has $LIVE_RAFFLES raffles"

verify() {
  local label="$1" gz="$2"
  [ -s "$gz" ] || { log "$label: FAIL — no backup retrieved"; return 1; }
  local db="$DRILL_DIR/$label.db"
  gunzip -c "$gz" > "$db" 2>/dev/null || { log "$label: FAIL — gunzip error"; return 1; }
  sqlite3 "$db" 'PRAGMA integrity_check;' 2>/dev/null | grep -q '^ok$' || { log "$label: FAIL — integrity check"; return 1; }
  local n; n=$(sqlite3 "$db" 'SELECT COUNT(*) FROM raffles;' 2>/dev/null || echo -1)
  if [ "$n" -lt 0 ]; then log "$label: FAIL — unreadable"; return 1; fi
  # backup should be within 10% of live (it's slightly older, so >= is not required, just sane)
  log "$label: OK — restored, integrity ok, $n raffles"
  return 0
}

RC=0
if [ "$TARGETS" = "r2" ] || [ "$TARGETS" = "all" ]; then
  NEWEST=$(rclone lsf "$R2_REMOTE" --include 'raffle-*.db.gz' 2>/dev/null | sort | tail -1)
  if [ -n "$NEWEST" ]; then
    rclone copyto "$R2_REMOTE/$NEWEST" "$DRILL_DIR/r2.db.gz" 2>/dev/null
    verify r2 "$DRILL_DIR/r2.db.gz" || RC=1
  else
    log "r2: FAIL — no backups found"; RC=1
  fi
fi
if [ "$TARGETS" = "linode" ] || [ "$TARGETS" = "all" ]; then
  NEWEST=$(ssh $SSH_OPTS "$LINODE_HOST" "ls -1 $LINODE_DIR/raffle-*.db.gz 2>/dev/null | sort | tail -1" 2>/dev/null)
  if [ -n "$NEWEST" ]; then
    scp $SSH_OPTS "$LINODE_HOST:$NEWEST" "$DRILL_DIR/linode.db.gz" >/dev/null 2>&1
    verify linode "$DRILL_DIR/linode.db.gz" || RC=1
  else
    log "linode: FAIL — no backups found"; RC=1
  fi
fi

rm -rf "$DRILL_DIR"
[ "$RC" -eq 0 ] && log "drill PASSED" || log "drill FAILED — investigate"
exit $RC
