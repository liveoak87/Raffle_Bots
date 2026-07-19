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
WEBHOOK_FILE="$BASE/.alert_webhook"     # optional: line 1 = Discord webhook URL
TELEGRAM_FILE="$BASE/.alert_telegram"   # optional: line 1 = bot token, line 2 = chat id
HOSTPORT=3100
ALERT_STAMP="/tmp/ur-last-alert"
ALERT_COOLDOWN=1800                     # max one outbound alert per 30 min (logs are always written)
MAINTENANCE_FILE="$BASE/.maintenance"  # present only during an intentional container swap

ts() { date '+%F %T'; }

if [ -f "$MAINTENANCE_FILE" ]; then
  echo "$(ts) maintenance mode: monitor restart checks skipped" >> "$LOG"
  exit 0
fi

# Alerts are sent by THIS script (the host monitor), not the bot — so they still
# fire when the bot itself is down. Sends to Discord and/or Telegram, whichever
# is configured. (If the whole host/its internet is down, use an external
# dead-man's-switch heartbeat instead — see ops/README.md.)
send_alert() {
  local msg="$1"
  echo "$(ts) ALERT: $msg" >> "$LOG"
  # de-dupe outbound notifications (the log line above is always written)
  if [ -f "$ALERT_STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$ALERT_STAMP" 2>/dev/null || echo 0) )) -lt "$ALERT_COOLDOWN" ]; then
    return 0
  fi
  local sent=0 text="🚨 Ultimate Randomizer ($(hostname)): $msg"
  if [ -f "$WEBHOOK_FILE" ]; then
    local url; url=$(head -n1 "$WEBHOOK_FILE")
    [ -n "$url" ] && curl -s -m 10 -H 'Content-Type: application/json' -X POST \
      -d "{\"content\":\"$text\"}" "$url" >/dev/null 2>&1 && sent=1
  fi
  if [ -f "$TELEGRAM_FILE" ]; then
    local tok cid; tok=$(sed -n 1p "$TELEGRAM_FILE"); cid=$(sed -n 2p "$TELEGRAM_FILE")
    [ -n "$tok" ] && [ -n "$cid" ] && curl -s -m 10 \
      -d "chat_id=$cid" --data-urlencode "text=$text" \
      "https://api.telegram.org/bot$tok/sendMessage" >/dev/null 2>&1 && sent=1
  fi
  [ "$sent" = 1 ] && touch "$ALERT_STAMP"
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
