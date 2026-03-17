/**
 * Session Pool — Persistent V1 SDK sessions per thread.
 *
 * Keeps Query instances alive across messages for the same thread using
 * AsyncIterable prompt mode. The generator stays open between turns, keeping
 * the SDK subprocess alive. New messages are pushed into the channel; the
 * generator yields them to the SDK.
 *
 * Key insight: the consumer (collectPrimaryResponse) must use manual
 * iterator.next(), NOT for-await-of with break — the latter calls
 * iterator.return() which kills the generator and the subprocess.
 *
 * When a session is busy (background tasks consuming the iterator), new
 * messages fall back to creating a new query with resume.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
    SDKUserMessage,
    Options,
    Query,
} from "@anthropic-ai/claude-agent-sdk";

export type SessionState = "idle" | "processing" | "monitoring_background";

export interface ManagedSession {
    threadId: number;
    query: Query;
    sessionId: string;
    model: string;
    cwd: string;
    state: SessionState;
    lastActivity: number;
    createdAt: number;
}

// ─── Message Channel ───
// A controllable async generator that yields SDKUserMessage objects.
// Push a message → generator yields it to the SDK subprocess.
// The generator stays open between turns, keeping the subprocess alive.

interface MessageChannel {
    push: (text: string, sessionId: string) => void;
    close: () => void;
}

function createMessageChannel(firstPrompt: string): { iterable: AsyncIterable<SDKUserMessage>; channel: MessageChannel } {
    let resolve: ((msg: SDKUserMessage | null) => void) | null = null;
    const pending: (SDKUserMessage | null)[] = [];
    let closed = false;

    function makeMsg(text: string, sessionId: string): SDKUserMessage {
        return {
            type: "user",
            session_id: sessionId,
            message: { role: "user", content: [{ type: "text", text }] },
            parent_tool_use_id: null,
        } as SDKUserMessage;
    }

    // Queue the first message immediately
    pending.push(makeMsg(firstPrompt, ""));

    async function* generator(): AsyncGenerator<SDKUserMessage> {
        while (!closed) {
            if (pending.length > 0) {
                const msg = pending.shift()!;
                if (msg === null) return;
                yield msg;
                continue;
            }
            // Block until a message is pushed or channel is closed
            const msg = await new Promise<SDKUserMessage | null>((r) => { resolve = r; });
            resolve = null;
            if (msg === null) return;
            yield msg;
        }
    }

    const channel: MessageChannel = {
        push(text: string, sessionId: string) {
            const msg = makeMsg(text, sessionId);
            if (resolve) {
                resolve(msg);
            } else {
                pending.push(msg);
            }
        },
        close() {
            closed = true;
            if (resolve) {
                resolve(null);
            } else {
                pending.push(null);
            }
        },
    };

    return { iterable: generator(), channel };
}

// ─── Session Pool ───

type LogFn = (level: string, message: string) => void;

export class SessionPool {
    private sessions = new Map<number, ManagedSession>();
    private channels = new Map<number, MessageChannel>();
    private idleTimeoutMs: number;
    private maxSessions: number;
    private idleTimer: ReturnType<typeof setInterval> | null = null;
    private log: LogFn;

    constructor(opts: { idleTimeoutMinutes?: number; maxSessions?: number; log: LogFn }) {
        this.idleTimeoutMs = (opts.idleTimeoutMinutes ?? 30) * 60 * 1000;
        this.maxSessions = opts.maxSessions ?? 8;
        this.log = opts.log;

        // Check for idle sessions every 60 seconds
        this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    }

    /**
     * Atomically check and claim an idle session matching the given model and cwd.
     * Pushes the new message into the session's input channel.
     * Returns the Query object for consuming the response.
     */
    tryClaimSession(threadId: number, model: string, cwd: string, prompt: string): { query: Query; sessionId: string } | null {
        const session = this.sessions.get(threadId);
        if (!session) return null;
        if (session.model !== model || session.cwd !== cwd) return null;
        if (session.state !== "idle") return null;

        const channel = this.channels.get(threadId);
        if (!channel) return null;

        // Push the message into the channel — the generator will yield it
        channel.push(prompt, session.sessionId);
        session.state = "processing";
        session.lastActivity = Date.now();
        this.log("INFO", `Session pool: reusing session for thread ${threadId}`);
        return { query: session.query, sessionId: session.sessionId };
    }

    /**
     * Create a new persistent session for a thread.
     * Uses AsyncIterable prompt (streaming mode) so the subprocess stays alive
     * across turns. Returns the Query object — caller consumes the first response.
     *
     * Note: closing the previous session (if any) intentionally terminates its
     * background monitor — user messages take priority over background monitoring.
     */
    createSession(
        threadId: number,
        firstPrompt: string,
        options: Options,
        model: string,
        cwd: string,
    ): Query {
        // Close any existing session for this thread
        this.close(threadId);

        // Evict oldest idle session if at capacity
        if (this.sessions.size >= this.maxSessions) {
            let oldestIdle: { threadId: number; lastActivity: number } | null = null;
            for (const [tid, s] of this.sessions) {
                if (s.state === "idle" && (!oldestIdle || s.lastActivity < oldestIdle.lastActivity)) {
                    oldestIdle = { threadId: tid, lastActivity: s.lastActivity };
                }
            }
            if (oldestIdle) {
                this.log("INFO", `Session pool: evicting idle session for thread ${oldestIdle.threadId} (at capacity ${this.maxSessions})`);
                this.close(oldestIdle.threadId);
            }
        }

        // Create message channel with first prompt pre-queued
        const { iterable, channel } = createMessageChannel(firstPrompt);

        // AsyncIterable prompt enables streaming mode — subprocess stays alive
        const q = query({ prompt: iterable, options });

        const session: ManagedSession = {
            threadId,
            query: q,
            sessionId: options.resume ?? "",
            model,
            cwd,
            state: "processing",
            lastActivity: Date.now(),
            createdAt: Date.now(),
        };

        this.sessions.set(threadId, session);
        this.channels.set(threadId, channel);

        this.log("INFO", `Session pool: created session for thread ${threadId} (model=${model})`);
        return q;
    }

    /**
     * Mark a session as idle (ready for next message).
     * Called after primary response is collected and no background tasks.
     */
    markIdle(threadId: number, sessionId?: string): void {
        const session = this.sessions.get(threadId);
        if (!session) return;
        session.state = "idle";
        session.lastActivity = Date.now();
        if (sessionId) {
            session.sessionId = sessionId;
        }
    }

    /**
     * Mark a session as monitoring background tasks.
     * The session can't accept new messages while monitoring.
     */
    markMonitoring(threadId: number): void {
        const session = this.sessions.get(threadId);
        if (!session) return;
        session.state = "monitoring_background";
    }

    /**
     * Close and remove a session.
     */
    close(threadId: number): void {
        const session = this.sessions.get(threadId);
        if (!session) return;

        const channel = this.channels.get(threadId);
        if (channel) {
            channel.close();
            this.channels.delete(threadId);
        }

        try {
            session.query.close();
        } catch {
            // Process may already be gone
        }

        this.sessions.delete(threadId);
        this.log("INFO", `Session pool: closed session for thread ${threadId}`);
    }

    /**
     * Close all sessions (for shutdown or budget mode toggle).
     */
    closeAll(): void {
        for (const threadId of [...this.sessions.keys()]) {
            this.close(threadId);
        }
        if (this.idleTimer) {
            clearInterval(this.idleTimer);
            this.idleTimer = null;
        }
    }

    /**
     * Get the current state of a session (for logging/debugging).
     */
    getState(threadId: number): SessionState | null {
        return this.sessions.get(threadId)?.state ?? null;
    }

    /**
     * Get session count (for shutdown logging).
     */
    get size(): number {
        return this.sessions.size;
    }

    /**
     * Remove idle sessions that have been inactive longer than the timeout.
     */
    private reapIdle(): void {
        const now = Date.now();
        for (const [threadId, session] of this.sessions) {
            if (session.state === "idle" && now - session.lastActivity > this.idleTimeoutMs) {
                this.log("INFO", `Session pool: closing idle session for thread ${threadId} (inactive ${Math.round((now - session.lastActivity) / 60_000)}m)`);
                this.close(threadId);
            }
        }
    }
}
