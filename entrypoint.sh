#!/bin/bash
set -e

PID_FILE=/app/.borg/borg.pid

if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "ERROR: Borg already running (PID $OLD_PID). Exiting."
        exit 0
    fi
fi
echo $$ > "$PID_FILE"

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
