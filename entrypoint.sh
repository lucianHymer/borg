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

trap 'kill $TELEGRAM_PID $QUEUE_PID $HEARTBEAT_PID 2>/dev/null; wait $TELEGRAM_PID $QUEUE_PID $HEARTBEAT_PID 2>/dev/null; rm -f "$PID_FILE"; exit 0' SIGTERM SIGINT

node dist/telegram-client.js &
TELEGRAM_PID=$!
node dist/queue-processor.js &
QUEUE_PID=$!
./heartbeat-cron.sh &
HEARTBEAT_PID=$!

# Wait for any process to exit
wait -n $TELEGRAM_PID $QUEUE_PID $HEARTBEAT_PID
# If one exits, kill the others and wait for graceful shutdown
kill $TELEGRAM_PID $QUEUE_PID $HEARTBEAT_PID 2>/dev/null
wait $TELEGRAM_PID $QUEUE_PID $HEARTBEAT_PID 2>/dev/null
exit 1
