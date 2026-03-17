/**
 * Session Pool — Persistent V1 SDK sessions per thread.
 *
 * Keeps Query instances alive across messages for the same thread.
 * First message creates the session with an AsyncIterable prompt (streaming mode).
 * Subsequent messages injected via streamInput() — near-zero latency.
 *
 * When a session is busy (background tasks consuming the iterator), new messages
 * fall back to creating a new query with resume.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
    SDKUserMessage,
    Options,
    Query,
} from "@anthropic-ai/claude-agent-sdk";
import type { UUID } from "crypto";
import { toErrorMessage } from "./types.js";

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
// Creates an async iterable that yields exactly one message (the first prompt),
// then stays open indefinitely. This keeps the SDK subprocess alive in streaming mode.

interface MessageChannel {
    iterable: AsyncIterable<SDKUserMessage>;
    close: () => void;
}

function createMessageChannel(firstPrompt: string, sessionId: string): MessageChannel {
    let closed = false;
    let resolve: (() => void) | null = null;
    let firstConsumed = false;

    const msg: SDKUserMessage = {
        type: "user",
        message: { role: "user", content: firstPrompt },
        parent_tool_use_id: null,
        session_id: sessionId,
    };

    const iterable: AsyncIterable<SDKUserMessage> = {
        [Symbol.asyncIterator]() {
            return {
                async next(): Promise<IteratorResult<SDKUserMessage, void>> {
                    if (!firstConsumed) {
                        firstConsumed = true;
                        return { done: false, value: msg };
                    }
                    // Block forever — keep the subprocess alive.
                    // New messages arrive via streamInput(), not this channel.
                    if (closed) {
                        return { done: true, value: undefined };
                    }
                    await new Promise<void>((r) => { resolve = r; });
                    return { done: true, value: undefined };
                },
            };
        },
    };

    return {
        iterable,
        close() {
            closed = true;
            resolve?.();
            resolve = null;
        },
    };
}

// ─── Session Pool ───

type LogFn = (level: string, message: string) => void;

export class SessionPool {
    private sessions = new Map<number, ManagedSession>();
    private channels = new Map<number, MessageChannel>();
    private idleTimeoutMs: number;
    private idleTimer: ReturnType<typeof setInterval> | null = null;
    private log: LogFn;

    constructor(opts: { idleTimeoutMinutes?: number; log: LogFn }) {
        this.idleTimeoutMs = (opts.idleTimeoutMinutes ?? 30) * 60 * 1000;
        this.log = opts.log;

        // Check for idle sessions every 60 seconds
        this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    }

    /**
     * Check if a thread has a reusable session (idle, matching model and cwd).
     */
    hasReusableSession(threadId: number, model: string, cwd: string): boolean {
        const session = this.sessions.get(threadId);
        if (!session) return false;
        if (session.model !== model || session.cwd !== cwd) return false;
        if (session.state !== "idle") return false;
        return true;
    }

    /**
     * Get an existing idle session for reuse. Returns the Query object.
     * The caller is responsible for calling streamInput() and consuming the response.
     */
    claimSession(threadId: number): { query: Query; sessionId: string } | null {
        const session = this.sessions.get(threadId);
        if (!session || session.state !== "idle") return null;
        session.state = "processing";
        session.lastActivity = Date.now();
        return { query: session.query, sessionId: session.sessionId };
    }

    /**
     * Create a new persistent session for a thread.
     * Returns the Query object (in streaming mode) — caller consumes the first response.
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

        // Generate a session ID for the message channel
        // (The SDK will assign the real session ID, which we capture from events)
        const placeholderSessionId = options.resume ?? crypto.randomUUID();

        const channel = createMessageChannel(firstPrompt, placeholderSessionId);
        const q = query({ prompt: channel.iterable, options });

        const session: ManagedSession = {
            threadId,
            query: q,
            sessionId: placeholderSessionId,
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
