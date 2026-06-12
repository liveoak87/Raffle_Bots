#!/bin/bash
cd "$(dirname "$0")"

# Kill any running bot instance
pkill -f "node src/index.js" 2>/dev/null
sleep 2

# Start fresh
nohup node src/index.js > /tmp/bot.log 2>&1 &

echo "Bot restarted. Logs at /tmp/bot.log"
echo "Dashboard at http://localhost:3000"
