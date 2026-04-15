# Webhooks

HTTP endpoint for external webhook integrations. Runs inside infra container.

## Server

- Express server on port 3001 (configurable via `WEBHOOK_PORT`)
- Config stored in `.borg/webhooks.json` (mtime-cached)
- Delivery log in `.borg/webhook-deliveries.jsonl`

## Incoming Webhook Flow

1. POST to `/webhooks/:id` with payload
2. HMAC signature validated if `requireSignature` is true (configurable per webhook)
3. `eventFilter` checks event type (e.g. `["issues", "pull_request"]`)
4. `labelFilter` checks if issue/PR has a matching label (e.g. `["agent:triage"]`)
5. `ignoreSenders` drops events from specified sender logins (e.g. `["human-bot[bot]"]`) -- prevents bot echo loops
6. Formatter transforms payload (currently: `github`, `raw`)
7. Message queued to target thread's incoming queue
8. Optional ntfy notification with debounce

## Webhook Config

```typescript
{
  name: string;
  secret: string;
  requireSignature: boolean;
  signatureHeader: string;    // e.g. "x-hub-signature-256"
  signaturePrefix: string;    // e.g. "sha256="
  hmacAlgorithm: string;      // e.g. "sha256"
  threadId?: number;
  formatter: string;           // "github" | "raw"
  eventFilter?: string[];
  labelFilter?: string[];
  ignoreSenders?: string[];
  ntfy?: { topic: string; debounceMs?: number };
}
```

## CRUD API

Bearer token auth required (tokens from `/authcode` flow). HTTP-only, not exposed as MCP tools.

This is an intentional security boundary: webhooks grant external systems the ability to trigger agent sessions. Creating them should require explicit human authorization, not agent self-service.

## Event Coalescing

Multiple webhook events for the same issue/PR can be coalesced into a single queue message to avoid spawning separate SDK queries for rapid-fire GitHub events.

See: `src/webhook-server.ts`, `src/webhook-formatters.ts`, `src/auth.ts`
