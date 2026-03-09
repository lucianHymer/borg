# Peer messaging design iterations and lessons learned

## Design History (PR #29 → PR #30)

The peer messaging feature went through three major design iterations:

1. **Filesystem-based peers** (PR #29, now closed)
   - Config: `{ name, queueDir, threadsJsonPath }`
   - Mechanism: Write queue messages directly to peer's filesystem
   - Scope: Same-host only (trusted filesystem access)
   - Status: Complete but superceded by HTTP design

2. **HTTP + Filesystem dual transport** (intermediate, not merged)
   - Config: `{ name, url, threadsJsonUrl, expectedIp, sharedSecret }`
   - Idea: Support both same-host (filesystem) and cross-machine (HTTP)
   - Additional feature: WireGuard VPN container for network isolation
   - Issue: Overbuilt — dual transport added complexity; security model unclear (HMAC signing)

3. **HTTP-only transport** (PR #30, merged — current)
   - Config: `{ name, ip }` (WireGuard VPN IP)
   - Mechanism: POST to peer's HTTP `/incoming` endpoint; GET `/threads` for visibility
   - Scope: Cross-machine via WireGuard; also works same-host on VPN
   - Security: WireGuard handles transport; app validates peer IP + JSON schema
   - Simplicity win: One code path (no dual transport), cleaner config

## Key Lessons

### 1. Design Simplification Pays Off

**Problem:** Initial HTTP design included HMAC-256 signing, complex config with URLs and shared secrets, separate `threadsJsonUrl` endpoint.

**Root cause:** Assumed we needed transport-level security in addition to WireGuard. Not thinking deeply about what WireGuard *already* provides.

**Resolution:** Lucian pushed back on HMAC signing. Question: "What does WireGuard handle?" Answer: encryption (ChaCha20-Poly1305), identity (public key), replay protection. Adding HMAC was redundant and added code burden.

**Final design:** Just validate peer IP (is the request from a known peer?) + validate JSON schema (is the message malformed?). That's it. Both peers are on the WireGuard VPN; WireGuard owns the trust boundary.

**Takeaway:** Ruthlessly question each security requirement. What does the underlying network/system layer already handle? Don't layer redundant crypto.

### 2. Human Approval Before Worker Handoff is Non-Negotiable

**Problem:** Planner created the plan (filesystem design). Master thread borg process marked it "approved" (automatic system signal). Planner handed work to Worker. Worker spent time implementing filesystem solution. Then human (Lucian) reviewed the plan and said "actually I want HTTP design with WireGuard container." Waste.

**Root cause:** Planner confused "master thread approved" with "human approved." They're different. Master thread signals are lightweight automation — human approval means the actual project owner has read the plan and agreed it's the right approach.

**Fix in dev-team.md:** Planner now explicitly asks the human user to review the plan in the GitHub issue and reply to confirm approval. Only then does Planner tell Worker to start. This is enforced in the workflow.

**Takeaway:** Always wait for explicit human sign-off on the plan, not just automated signals.

### 3. Unified Code Paths Beat Dual Implementations

**Why not dual (filesystem + HTTP)?** Could have kept the filesystem path for same-host, added HTTP for cross-machine.

**Why unified (HTTP only)?**
- One code path in `send_message` for all peer sends (check local first, then try peer)
- Unified delivery model (atomic write, retry-safe)
- Same test matrix (no "does it work for both?")
- Same operator mental model (everything is HTTP, even same-host)
- WireGuard VPN already solves "same-host" — they're already on the VPN

**Takeaway:** If you're building infrastructure for two cases, ask if they can use the same mechanism. If yes, use it. Simplicity in code beats "flexibility" of dual implementations.

### 4. The `_tg` Suffix is Ownership-Based, Not Mechanism-Based

**Gotcha caught during review:** Original code wrote both an incoming queue entry (for peer delivery) AND an outgoing `_tg` entry (for local telegram-client display). Bug: the local telegram-client would try posting to a `message_thread_id` that belongs to the peer's Telegram supergroup — either fails or hits the wrong local topic.

**Root cause:** Thinking of `_tg` as "a display entry that follows messages" rather than "a display entry for threads owned by THIS telegram-client."

**Fix:** Skip the `_tg` entry entirely for peer sends. The peer's telegram-client gets the message via HTTP and handles its own display.

**Rule:** QUEUE_OUTGOING entries can ONLY target threadIds owned by the local telegram-client. Period.

**Takeaway:** Think about *ownership* and *responsibility*, not just mechanism. Who owns this resource? Who is responsible for updating it?

### 5. Peer Config Should Be Minimal

Original: `{ name, url, threadsJsonUrl, expectedIp, sharedSecret }`
Current: `{ name, ip }`

Derived from both:
- Port is global per instance (`settings.httpPort`)
- URL is constructed as `http://${ip}:${httpPort}`
- Peer identity is verified by IP on WireGuard VPN (no sharedSecret needed)

**Takeaway:** Config should only specify what *varies* between peers. Everything else should be derived or global.

## Related

- Issue #28: "Implement peer messaging via HTTP over WireGuard"
- PR #29: Closed (filesystem-based peers, superceded)
- PR #30: Merged (HTTP-only peers, current)
- Dev-team workflow: Human approval requirement

**Files:** src/server.ts, src/mcp-tools.ts, src/types.ts
