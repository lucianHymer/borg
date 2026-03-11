/**
 * Shared types and utilities used across Borg modules.
 */

import { z } from "zod/v4";
import type { MessageSource } from "./message-history.js";
import type { Tier } from "./router/types.js";

// ─── Queue Message Types ───

export interface IncomingMessage {
    channel: string;
    source?: MessageSource;
    threadId: number;
    sourceThreadId?: number;
    sender: string;
    senderId?: string;
    message: string;
    isReply?: boolean;
    replyToText?: string;
    replyToModel?: string;
    topicName?: string;
    timestamp: number;
    messageId: string;
    audioPath?: string;         // path to downloaded OGG file (voice messages)
    voiceDuration?: number;     // duration in seconds
    imagePath?: string;         // path to downloaded image file (photo messages)
    telegramMessageId?: number; // Telegram message_id (for voice transcript cache)
}

export interface OutgoingMessage {
    channel: string;
    threadId: number;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
    model: string;
    targetThreadId?: number;
    sourceThreadId?: number;  // threadId of the sender (for cross-thread messages)
    routingMetadata?: RoutingMetadata;
    replyToMessageId?: number; // Telegram message_id being replied to
    replyToVoice?: boolean;    // true if replying to a voice message
    crossZonePending?: boolean; // true if this is a cross-zone message awaiting approval
    crossThread?: boolean;       // true if this outgoing message needs cross-thread routing by infra
}

// ─── Cross-Zone Pending Approval ───

export interface PendingApproval {
    id: string;                // unique ID for this pending message
    sourceThreadId: number;    // sender's thread
    targetThreadId: number;    // recipient's thread
    sourceZone: string;        // sender's zone name
    targetZone: string;        // recipient's zone name
    senderName: string;        // human-readable sender name
    targetName: string;        // human-readable target name
    message: string;           // the actual message content
    timestamp: number;         // when the message was sent
    telegramMessageId?: number; // Telegram message_id of the approval keyboard message
}

// ─── Routing Metadata ───

export interface RoutingMetadata {
    tier: Tier;
    model: string;
    confidence: number;
    signals: string[];
    tokens: number;
    prompt: string;
}

export const RoutingMetadataSchema = z.object({
    tier: z.enum(["SIMPLE", "MEDIUM", "COMPLEX"]),
    model: z.string(),
    confidence: z.number().min(0).max(1),
    signals: z.array(z.string()).max(50),
    tokens: z.number().nonnegative(),
    prompt: z.string().max(8192),
});

// ─── Task List Mapping (shared between queue-processor and telegram-client) ───

export interface TaskListMapping {
    [taskListId: string]: {
        threadIds: number[];
        team?: string;
    };
}

export const TASK_LISTS_FILENAME = "task-lists.json";

// ─── Validation Utilities ───

/**
 * Validate that a sessionId is a well-formed UUID (hex + hyphens, 36 chars).
 * Session IDs from the Claude SDK are UUIDs; anything else is suspicious.
 */
export function isValidSessionId(sessionId: string): boolean {
    return /^[a-f0-9-]{36}$/.test(sessionId);
}

// ─── Error Utility ───

/**
 * Error subclass for user-facing validation failures (e.g., invalid input).
 * Handlers can use `instanceof ValidationError` to distinguish client errors (400)
 * from upstream/infrastructure errors (502) without string matching.
 */
export class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ValidationError";
    }
}

/**
 * Safely extract an error message from an unknown thrown value.
 */
export function toErrorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return String(err);
}

// ─── Branded Types for Dev Container Provisioning ───

/** Validated SSH public key (ed25519, RSA, or ECDSA) */
export type SSHPublicKey = string & { readonly __brand: "SSHPublicKey" };

/** Validated developer name (lowercase alphanumeric + hyphens) */
export type DevName = string & { readonly __brand: "DevName" };

/** Validated developer email */
export type DevEmail = string & { readonly __brand: "DevEmail" };

/**
 * Validate and parse an SSH public key string.
 * Checks key type, base64 prefix match, single line, max 8KB.
 * Rejects private keys with a clear error.
 */
export function parseSSHPublicKey(raw: string): SSHPublicKey {
    const trimmed = raw.trim();

    if (trimmed.includes("PRIVATE KEY") || trimmed.includes("-----BEGIN")) {
        throw new ValidationError(
            "This looks like a PRIVATE key. Paste your PUBLIC key (.pub file).",
        );
    }

    if (Buffer.byteLength(trimmed, "utf8") > 8192) {
        throw new ValidationError("SSH key exceeds 8KB limit.");
    }

    if (trimmed.split("\n").filter(l => l.length > 0).length !== 1) {
        throw new ValidationError("SSH public key must be a single line.");
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) {
        throw new ValidationError("Invalid SSH key format.");
    }

    const [keyType, base64Data] = parts;
    const validTypes: Record<string, string> = {
        "ssh-ed25519": "AAAAC3NzaC1lZDI1NTE5",
        "ssh-rsa": "AAAAB3NzaC1yc2E",
        "ecdsa-sha2-nistp256": "AAAAE2VjZHNhLXNoYTItbmlzdHAyNT",
        "ecdsa-sha2-nistp384": "AAAAE2VjZHNhLXNoYTItbmlzdHAzODQ",
        "ecdsa-sha2-nistp521": "AAAAE2VjZHNhLXNoYTItbmlzdHA1MjE",
        "sk-ssh-ed25519@openssh.com": "AAAAGnNrLXNzaC1lZDI1NTE5QG9wZW5zc2guY29t",
        "sk-ecdsa-sha2-nistp256@openssh.com": "AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20",
    };

    if (!validTypes[keyType]) {
        throw new ValidationError(`Unrecognized key type "${keyType}".`);
    }

    if (!base64Data.startsWith(validTypes[keyType])) {
        throw new ValidationError(
            "Key data does not match type. The key may be corrupted.",
        );
    }

    return trimmed as SSHPublicKey;
}

/**
 * Validate and parse a developer email address.
 * Basic format validation — must match their GitHub account for commit attribution.
 */
export function parseDevEmail(raw: string): DevEmail {
    const trimmed = raw.trim().toLowerCase();

    if (trimmed.length === 0) {
        throw new ValidationError("Email cannot be empty.");
    }

    if (trimmed.length > 254) {
        throw new ValidationError("Email exceeds maximum length.");
    }

    // Basic email format check (not exhaustive — GitHub will be the ultimate validator)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new ValidationError("Invalid email format.");
    }

    return trimmed as DevEmail;
}

/** Validate and parse a developer name. Lowercase alphanumeric + hyphens, 1-32 chars. */
export function parseDevName(raw: string): DevName {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) {
        throw new ValidationError("Name cannot be empty.");
    }
    if (trimmed.length > 32) {
        throw new ValidationError("Name must be 32 characters or less.");
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
        throw new ValidationError(
            "Name must be lowercase alphanumeric (hyphens allowed, must start with letter/number).",
        );
    }
    return trimmed as DevName;
}

// ─── Message Model Cache Entry ───

/** Message model cache entry (for routing feedback and TTS) */
export interface MessageModelEntry {
    model: string;
    threadId: number;
    fullText?: string;  // only stored for multi-segment messages (for TTS)
}
