#!/bin/bash
# Ultimate Randomizer — Weekly Health Check
# Runs on the Unraid server via cron

LOG_FILE="/mnt/user/appdata/ultimate-randomizer/health-check.log"
CONTAINER="ultimate-randomizer"
DB="/mnt/user/appdata/ultimate-randomizer/data/raffle.db"

echo "========================================" >> "$LOG_FILE"
echo "Health Check — $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG_FILE"
echo "========================================" >> "$LOG_FILE"

# 1. Container status
STATUS=$(docker inspect "$CONTAINER" --format='{{.State.Status}}' 2>&1)
RESTARTS=$(docker inspect "$CONTAINER" --format='{{.RestartCount}}' 2>&1)
STARTED=$(docker inspect "$CONTAINER" --format='{{.State.StartedAt}}' 2>&1)
echo "[CONTAINER] Status: $STATUS | Restarts: $RESTARTS | Started: $STARTED" >> "$LOG_FILE"

# 2. Memory usage
MEM=$(docker stats "$CONTAINER" --no-stream --format='{{.MemUsage}} ({{.MemPerc}})' 2>&1)
echo "[MEMORY] $MEM" >> "$LOG_FILE"

# 3. Database stats
RAFFLE_COUNTS=$(sqlite3 "$DB" "SELECT status, COUNT(*) FROM raffles GROUP BY status;" 2>&1)
TOTAL_PICKS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM picks;" 2>&1)
ACTIVE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM raffles WHERE status = 'active';" 2>&1)
echo "[DATABASE] Raffles: $RAFFLE_COUNTS | Total picks: $TOTAL_PICKS | Active: $ACTIVE" >> "$LOG_FILE"

# 4. Database file size
DB_SIZE=$(du -h "$DB" 2>&1 | cut -f1)
echo "[DATABASE] File size: $DB_SIZE" >> "$LOG_FILE"

# 5. Error count since last container start
ERROR_COUNT=$(docker logs "$CONTAINER" 2>&1 | grep -ciE '\[ERROR\]|DiscordAPIError|Missing Permissions|Unknown Message')
echo "[ERRORS] $ERROR_COUNT error(s) in current logs" >> "$LOG_FILE"

# 6. List any errors
if [ "$ERROR_COUNT" -gt 0 ]; then
  echo "[ERROR DETAILS]" >> "$LOG_FILE"
  docker logs "$CONTAINER" 2>&1 | grep -iE '\[ERROR\]|DiscordAPIError|Missing Permissions|Unknown Message' | tail -20 >> "$LOG_FILE"
fi

# 7. Auto-restart if container is not running
if [ "$STATUS" != "running" ]; then
  echo "[ACTION] Container not running! Attempting restart..." >> "$LOG_FILE"
  docker start "$CONTAINER" >> "$LOG_FILE" 2>&1
  sleep 5
  NEW_STATUS=$(docker inspect "$CONTAINER" --format='{{.State.Status}}' 2>&1)
  echo "[ACTION] Restart result: $NEW_STATUS" >> "$LOG_FILE"
fi

echo "" >> "$LOG_FILE"
