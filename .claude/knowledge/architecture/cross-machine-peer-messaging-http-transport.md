# Peer messaging: HTTP transport over WireGuard

Borg instances communicate via lightweight HTTP endpoint (`:7743`) over a WireGuard VPN. This unified approach handles both same-host and cross-machine scenarios cleanly with a single code path.

## Architecture

Each Borg instance:
- Exposes a lightweight HTTP server listening on configurable port (default: off, requires `settings.httpPort`)
- Only communicates over a WireGuard VPN where only bot Docker containers are members
- No public internet exposure — weird port (`:7743`) keeps it off the beaten path

**Why unified HTTP (not dual filesystem+HTTP)?**
- One code path is simpler to maintain than two parallel implementations
- HTTP handles both same-host and cross-machine seamlessly
- No intermediate step of filesystem-based peers needed

## Security Model

**Trust assumption:** HTTP endpoint is ONLY accessible on WireGuard VPN. Exposure to untrusted networks means arbitrary message injection.

**Security requirements:**
1. **Peer IP validation:** POST `/incoming` validates request source IP matches expected peer IP (from config)
2. **Message signing:** HMAC-SHA256 signing for all cross-peer messages (defense-in-depth). Peers share a secret; `X-Signature` header on all requests
3. **Input validation:** Validate JSON schema + enforce max payload size (e.g., 100KB); reject malformed messages with 400 Bad Request
4. **Source validation:** Verify `sourceThreadId` belongs to the sending peer; reject spoofed origins

## Peer Config

```json
{
  "httpPort": 7743,
  "peers": [
    {
      "name": "borg-b",
      "url": "http://10.8.0.2:7743",
      "threadsJsonUrl": "http://10.8.0.2:7743/threads",
      "expectedIp": "10.8.0.2",
      "sharedSecret": "base64-encoded-secret"
    }
  ]
}
```

- `httpPort`: Port to listen on (opt-in; undefined = no HTTP server)
- `url`: Peer's HTTP endpoint
- `threadsJsonUrl`: Peer's thread list endpoint
- `expectedIp`: Optional IP validation (required for untrusted networks)
- `sharedSecret`: HMAC-SHA256 secret (required for cross-machine)

## HTTP API

- `POST /incoming` — Accept queue message; validate IP + HMAC + schema; write atomically
  - Headers: `X-Signature: HMAC-SHA256(body, sharedSecret)` (if sharedSecret configured)
  - Responses: 200 OK, 400 Bad Request, 401 Unauthorized, 403 Forbidden, 404 Not Found, 500 Internal Error
- `GET /threads` — Return local `threads.json`; optionally filter to peer-associated threads only

## Lifecycle

- HTTP server starts in queue-processor if `settings.httpPort` is configured
- Graceful shutdown on SIGTERM (close listeners, no dropped messages)
- Network errors (peer offline) skip that peer; don't crash queue-processor

## Why WireGuard + weird port

- Telegram bots cannot message each other via Telegram (bots can't initiate conversations with other bots)
- Public internet exposure is unnecessary and increases attack surface
- WireGuard VPN with bot containers as sole members gives network-layer isolation with minimal config + no per-request auth overhead

**Related files:** src/server.ts, src/mcp-tools.ts, src/session-manager.ts, src/types.ts
