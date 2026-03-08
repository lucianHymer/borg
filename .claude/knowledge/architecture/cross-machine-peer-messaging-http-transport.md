# Peer messaging: HTTP transport over WireGuard

Borg instances communicate via lightweight HTTP endpoint (`:7743`) over a WireGuard VPN. This unified approach handles both same-host and cross-machine scenarios cleanly with a single code path.

## Architecture

Each Borg instance:
- Exposes a lightweight HTTP server listening on configurable port (default: off, requires `settings.httpPort`)
- Only communicates over a WireGuard VPN where only bot Docker containers are members
- WireGuard runs in a container (`linuxserver/wireguard`), not on the host
- No public internet exposure — weird port (`:7743`) keeps it off the beaten path

**Why unified HTTP (not dual filesystem+HTTP)?**
- One code path is simpler to maintain than two parallel implementations
- HTTP handles both same-host and cross-machine seamlessly
- No intermediate step of filesystem-based peers needed

## Security Model

**Trust assumption:** HTTP endpoint is ONLY accessible on WireGuard VPN. Exposure to untrusted networks means arbitrary message injection.

WireGuard handles all transport security: encryption (ChaCha20-Poly1305), identity (public key), and replay protection. HMAC signing is redundant and not used.

**Application-level safeguards:**
1. **Peer IP validation:** POST `/incoming` rejects requests from IPs not listed in `settings.peers` (403)
2. **Input validation:** Validate JSON schema + enforce max payload size (100KB); reject malformed messages with 400

Adding a peer is a human-controlled dashboard operation — not something that can happen automatically.

## Peer Config

```json
{
  "httpPort": 7743,
  "peers": [
    {
      "name": "borg-b",
      "ip": "10.8.0.2"
    }
  ]
}
```

- `httpPort`: Port to listen on (opt-in; undefined = no HTTP server). Shared across all peers.
- `ip`: Peer's WireGuard VPN IP address. URLs are constructed as `http://${ip}:${httpPort}`.

## HTTP API

- `POST /incoming` — Accept queue message; validate peer IP + schema; write atomically to `QUEUE_INCOMING/`
  - Responses: 200 OK, 400 Bad Request, 403 Forbidden (unknown IP), 500 Internal Error
- `GET /threads` — Return local `threads.json`

## Lifecycle

- HTTP server starts in queue-processor if `settings.httpPort` is configured
- Graceful shutdown on SIGTERM (close listeners, no dropped messages)
- Network errors (peer offline) skip that peer; don't crash queue-processor

## Why WireGuard + weird port

- Telegram bots cannot message each other via Telegram (bots can't initiate conversations with other bots)
- Public internet exposure is unnecessary and increases attack surface
- WireGuard VPN with bot containers as sole members gives network-layer isolation with minimal config + no per-request auth overhead

**Related files:** src/server.ts, src/mcp-tools.ts, src/session-manager.ts, src/types.ts
