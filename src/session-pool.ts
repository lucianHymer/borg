/**
 * Session Pool — Persistent V1 SDK sessions per thread.
 *
 * Keeps Query instances alive across messages for the same thread.
 * First message creates the session with a string prompt (standard mode).
 * Subsequent messages injected via streamInput() for session reuse.
 * If streamInput() fails (e.g., not in streaming mode), falls back to
 * creating a new query with resume — functionally identical, just slower.
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

// ─── Session Pool ───

type LogFn = (level: string, message: string) => void;

export class SessionPool {
    private sessions = new Map<number, ManagedSession>();
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
     * Returns the Query object if a reusable session exists, null otherwise.
     */
    tryClaimSession(threadId: number, model: string, cwd: string): { query: Query; sessionId: string } | null {
        const session = this.sessions.get(threadId);
        if (!session) return null;
        if (session.model !== model || session.cwd !== cwd) return null;
        if (session.state !== "idle") return null;
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

        // Use string prompt (not AsyncIterable) — the SDK emits result normally
        // with string prompts. The Query object stays alive after result for
        // subsequent streamInput() calls.
        const q = query({ prompt: firstPrompt, options });

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
