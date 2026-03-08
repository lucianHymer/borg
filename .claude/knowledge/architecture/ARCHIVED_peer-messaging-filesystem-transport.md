# Peer messaging: multi-Borg cross-instance routing

Borg supports sending messages to threads on *other* Borg instances running on the same host, via a shared filesystem queue.

## Configuration

In `.borg/settings.json`, add a `peers` array:
```json
{
  "peers": [
    {
      "name": "borg-b",
      "queueDir": "/home/user/workspace/other-repo/.borg/queue",
      "threadsJsonPath": "/home/user/workspace/other-repo/.borg/threads.json"
    }
  ]
}
```

The `Peer` interface is defined in `src/types.ts`:
```ts
export interface Peer {
  name: string;
  queueDir: string;        // absolute path to peer's .borg/queue directory
  threadsJsonPath: string; // absolute path to peer's .borg/threads.json
}
```

`peers?: Peer[]` is added to the `Settings` interface in `src/session-manager.ts`. The field is optional — defaults to empty (no peers).

## Routing logic in send_message

`send_message` uses local-first routing:
1. Check local `threads.json` for the target threadId
2. If not found locally, load settings and scan each peer's `threadsJsonPath`
3. If found in a peer, write the incoming queue message to `peer.queueDir/incoming/` (atomic tmp+rename, `mkdirSync` with recursive)
4. If not found anywhere, error message lists both local and peer threads

Local threads always take priority — no ambiguity if thread IDs collide across instances.

## Critical: no outgoing display for peer messages

For **local** cross-thread messages, `send_message` writes two queue entries:
- Incoming (for queue-processor to run) → `QUEUE_INCOMING`
- Outgoing `_tg` display copy (for telegram-client to post in the target topic) → `QUEUE_OUTGOING`

For **peer** messages, **only the incoming entry is written** — the outgoing display is skipped entirely. The peer's own telegram-client handles display when it processes the incoming message from its own queue. Writing a peer threadId to the local `QUEUE_OUTGOING` would cause the local bot to try posting to a `message_thread_id` that belongs to the peer's Telegram supergroup — either failing or hitting a wrong local topic.

The guard in `mcp-tools.ts`: `if (!peerLabel) { /* write outgoing display */ }`

## list_threads also reads peers

`list_threads` appends peer threads to its output, labeled `(peer: {name})`. This is read-only — it's for visibility only, not routing.

## Error handling

Peer `threadsJsonPath` read errors are silently skipped — the peer may be offline. This prevents peer unavailability from breaking local operation.

## No ACK from peer

`send_message` returns success once the file is atomically written to the peer's incoming queue. There is no round-trip confirmation that the peer processed it — the tool response is all the sender gets. This is fire-and-forget by design.

## Scope

- Same-host only: uses filesystem paths, no network auth
- Peers config is optional: if `peers` is absent or empty, behavior is unchanged from single-instance mode

**Related files:** src/types.ts, src/mcp-tools.ts, src/session-manager.ts
