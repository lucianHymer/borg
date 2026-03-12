#!/bin/bash
set -e

PID_FILE=/app/.borg/borg.pid

if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cut -d: -f1 "$PID_FILE")
    OLD_START=$(cut -d: -f2 "$PID_FILE")
    CUR_START=$(awk '{print $22}' /proc/"$OLD_PID"/stat 2>/dev/null)
    if [ -n "$CUR_START" ] && [ "$CUR_START" = "$OLD_START" ]; then
        echo "ERROR: Borg already running (PID $OLD_PID). Exiting."
        exit 0
    fi
    rm -f "$PID_FILE"
fi
MY_START=$(awk '{print $22}' /proc/$$/stat)
echo "$$:$MY_START" > "$PID_FILE"

trap 'kill $PROXY_PID $QUEUE_PID 2>/dev/null; wait $PROXY_PID $QUEUE_PID 2>/dev/null; rm -f "$PID_FILE"; exit 0' SIGTERM SIGINT

# Always start budget mode proxy (lightweight, used only when budgetMode=true in settings)
npx tsx scripts/minimax-proxy.ts &
PROXY_PID=$!
sleep 2

# Zone containers only run queue-processor (heartbeats are built-in, zone-filtered)
node dist/queue-processor.js &
QUEUE_PID=$!

wait $QUEUE_PID
exit 1
