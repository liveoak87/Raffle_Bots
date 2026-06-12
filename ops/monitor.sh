#!/bin/bash
# Ultimate Randomizer — health monitor + auto-heal.
# Runs every 5 min (dynamix cron). Restarts the bot if it's stopped or has gone
# "unhealthy" (gateway zombie, per the container HEALTHCHECK) and alerts a Discord
# webhook if one is configured. `restart: unless-stopped` only recovers crashes,
# not zombies — this covers the gap.
set -uo pipefail

BASE="/mnt/user/appdata/ultimate-randomizer"
CONTAINER="ultimate-randomizer"
LOG="$BASE/monitor.log"
WEBHOOK_FILE="$BASE/.alert_webhook"   # optional: first line = Discord webhook URL
HOSTPORT=3100
ALERT_STAMP="/tmp/ur-last-alert"
ALERT_COOLDOWN=1800                   # max one webhook alert per 30 min (logs are always written)

ts() { date '+%F %T'; }

send_alert() {
  local msg="$1"
  echo "$(ts) ALERT: $msg" >> "$LOG"
  [ -f "$WEBHOOK_FILE" ] || return 0
  # de-dupe webhook spam
  if [ -f "$ALERT_STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$ALERT_STAMP" 2>/dev/null || echo 0) )) -lt "$ALERT_COOLDOWN" ]; then
    return 0
  fi
  local url; url=$(head -n1 "$WEBHOOK_FILE")
  [ -n "$url" ] || return 0
  curl -s -m 10 -H 'Content-Type: application/json' -X POST \
    -d "{\"content\":\"🚨 **Ultimate Randomizer** ($(hostname)): $msg\"}" "$url" >/dev/null 2>&1 || true
  touch "$ALERT_STAMP"
}

STATUS=$(docker inspect "$CONTAINER" --format '{{.State.Status}}' 2>/dev/null || echo missing)
HEALTH=$(docker inspect "$CONTAINER" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none)

if [ "$STATUS" != "running" ]; then
  send_alert "container is '$STATUS' — starting it"
  docker start "$CONTAINER" >/dev/null 2>&1
  exit 0
fi

if [ "$HEALTH" = "unhealthy" ]; then
  send_alert "container reports UNHEALTHY (gateway down?) — restarting"
  docker restart "$CONTAINER" >/dev/null 2>&1
  exit 0
fi

# Belt-and-suspenders: external HTTP probe (skip while the healthcheck is still in start-period).
if [ "$HEALTH" != "starting" ]; then
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "http://localhost:$HOSTPORT/health" 2>/dev/null || echo 000)
  if [ "$CODE" != "200" ]; then
    send_alert "external /health probe returned $CODE — restarting"
    docker restart "$CONTAINER" >/dev/null 2>&1
  fi
fi
