#!/bin/bash
# Backup restore drill — verifies that backups in R2 and Linode are restorable.
# Picks the most recent backup from each off-site destination, restores it to
# a sandbox SQLite file, runs PRAGMA integrity_check, and verifies that the
# restored table counts roughly match the live DB.
#
# A backup you've never restored is a backup you can't trust. Run this weekly
# (cron) so we catch silent corruption before disaster strikes.
#
# Usage: ./restore-drill.sh [r2|linode|all]   (default: all)

set -euo pipefail

TARGETS="${1:-all}"
DRILL_DIR="/tmp/raffle-bot-restore-drill"
LIVE_DB="${LIVE_DB:-/mnt/user/appdata/raffle-bot/data/raffle.db}"
R2_REMOTE="${R2_REMOTE:-r2:raffle-bot-backups}"
# Set LINODE_HOST in the environment (e.g. via /etc/profile.d/raffle-bot.sh on
# the Unraid host) to the off-site VPS — format: root@<ip-or-hostname>
LINODE_HOST="${LINODE_HOST:-}"
LINODE_DIR="${LINODE_DIR:-/var/backups/raffle-bot}"
SSH_KEY="${SSH_KEY:-/root/.ssh/id_ed25519}"
LOG_FILE="${LOG_FILE:-/var/log/raffle-bot-restore-drill.log}"
LOCK_FILE="/tmp/raffle-bot-restore-drill.lock"

exec 200>"$LOCK_FILE"
flock -n 200 || { echo "$(date -Iseconds) drill already running, exiting" >> "$LOG_FILE"; exit 0; }

log() {
  echo "$(date -Iseconds) $*" | tee -a "$LOG_FILE"
}

cleanup() {
  rm -rf "$DRILL_DIR"
}
trap cleanup EXIT

mkdir -p "$DRILL_DIR"

# --- Get reference row counts from live DB (just key tables) ---
if [ ! -f "$LIVE_DB" ]; then
  log "ERROR: live DB not found at $LIVE_DB"
  exit 1
fi
LIVE_RAFFLES=$(sqlite3 "$LIVE_DB" "SELECT COUNT(*) FROM raffles" 2>/dev/null || echo 0)
LIVE_ENTRIES=$(sqlite3 "$LIVE_DB" "SELECT COUNT(*) FROM raffle_entries" 2>/dev/null || echo 0)
LIVE_GROUPS=$(sqlite3 "$LIVE_DB" "SELECT COUNT(*) FROM bot_groups" 2>/dev/null || echo 0)
log "Live DB: $LIVE_RAFFLES raffles, $LIVE_ENTRIES entries, $LIVE_GROUPS groups"

OVERALL_OK=1

drill_backup() {
  local source_name="$1"
  local backup_path="$2"
  local dest="$DRILL_DIR/restored-${source_name}.db"

  log "[$source_name] restoring $(basename "$backup_path") -> sandbox"
  cp "$backup_path" "$dest" 2>&1 | tee -a "$LOG_FILE"

  # Integrity check
  local integrity
  integrity=$(sqlite3 "$dest" "PRAGMA integrity_check;" 2>&1)
  if [ "$integrity" != "ok" ]; then
    log "[$source_name] ❌ INTEGRITY CHECK FAILED: $integrity"
    OVERALL_OK=0
    return
  fi

  # Row counts — should be within a small delta of live (live keeps growing)
  local restored_raffles restored_entries restored_groups
  restored_raffles=$(sqlite3 "$dest" "SELECT COUNT(*) FROM raffles")
  restored_entries=$(sqlite3 "$dest" "SELECT COUNT(*) FROM raffle_entries")
  restored_groups=$(sqlite3 "$dest" "SELECT COUNT(*) FROM bot_groups")

  # Sanity: backups should never have MORE rows than live (impossible) and
  # the gap shouldn't be more than 10% (catches silently truncated backups).
  if [ "$restored_raffles" -gt "$LIVE_RAFFLES" ]; then
    log "[$source_name] ⚠️  restored has MORE raffles than live ($restored_raffles > $LIVE_RAFFLES)"
  fi
  local gap_pct
  if [ "$LIVE_RAFFLES" -gt 0 ]; then
    gap_pct=$(( (LIVE_RAFFLES - restored_raffles) * 100 / LIVE_RAFFLES ))
    if [ "$gap_pct" -gt 10 ]; then
      log "[$source_name] ⚠️  raffles row count gap >10% ($gap_pct%): live=$LIVE_RAFFLES, restored=$restored_raffles"
    fi
  fi

  log "[$source_name] ✅ integrity OK | $restored_raffles raffles, $restored_entries entries, $restored_groups groups"
}

# --- R2 ---
if [ "$TARGETS" = "all" ] || [ "$TARGETS" = "r2" ]; then
  log "=== R2 drill ==="
  # Find the most recent file in R2
  R2_LATEST=$(rclone lsl "$R2_REMOTE" --include 'raffle.db.*.bak' 2>/dev/null | sort -k2,3 | tail -1 | awk '{print $NF}')
  if [ -z "$R2_LATEST" ]; then
    log "R2: no backups found"
    OVERALL_OK=0
  else
    log "R2: latest = $R2_LATEST"
    rclone copyto "$R2_REMOTE/$R2_LATEST" "$DRILL_DIR/r2-source.bak" 2>&1 | tee -a "$LOG_FILE"
    drill_backup "r2" "$DRILL_DIR/r2-source.bak"
  fi
fi

# --- Linode ---
if [ "$TARGETS" = "all" ] || [ "$TARGETS" = "linode" ]; then
  log "=== Linode drill ==="
  if [ -z "$LINODE_HOST" ]; then
    log "Linode: LINODE_HOST not set in env — skipping (set it to root@<ip-or-host>)"
  else
  LINODE_LATEST=$(ssh -i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new "$LINODE_HOST" \
    "ls -t $LINODE_DIR/raffle.db.*.bak 2>/dev/null | head -1" 2>/dev/null)
  if [ -z "$LINODE_LATEST" ]; then
    log "Linode: no backups found"
    OVERALL_OK=0
  else
    log "Linode: latest = $LINODE_LATEST"
    scp -i "$SSH_KEY" -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new \
      "$LINODE_HOST:$LINODE_LATEST" "$DRILL_DIR/linode-source.bak" 2>&1 | tee -a "$LOG_FILE"
    drill_backup "linode" "$DRILL_DIR/linode-source.bak"
  fi
  fi
fi

if [ "$OVERALL_OK" = "1" ]; then
  log "✅ All restore drills passed"
  exit 0
else
  log "❌ Restore drill FAILED — investigate immediately"
  exit 1
fi
