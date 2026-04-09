/**
 * Auth — Unified authentication system.
 * Auth codes (in-memory), rate limiting (in-memory), tokens (file-based).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

const SCRIPT_DIR = path.resolve(__dirname, "..");
const BORG_DIR = path.join(SCRIPT_DIR, ".borg");
const TOKENS_FILE = path.join(BORG_DIR, "auth-tokens.json");
const GITHUB_INSTALLATIONS_FILE = "/secrets/github-installations.json";

// ─── Types ───

export interface TokenInfo {
    token: string;
    telegramUserId: number;
    userName: string;
    orgs: string[];
    scopes: string[];
    createdAt: number;
    expiresAt: number;
}

interface AuthCode {
    telegramUserId: number;
    userName: string;
    expiresAt: number;
    claimed: boolean;
}

interface RateLimitEntry {
    attempts: number;
    resetAt: number;
}

// ─── Auth Codes (in-memory) ───

const authCodes = new Map<string, AuthCode>();

const AUTH_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function generateAuthCode(telegramUserId: number, userName: string): string {
    const code = String(crypto.randomInt(100000, 1000000));
    authCodes.set(code, {
        telegramUserId,
        userName,
        expiresAt: Date.now() + AUTH_CODE_TTL_MS,
        claimed: false,
    });
    return code;
}

export function claimAuthCode(code: string): { telegramUserId: number; userName: string } | null {
    const entry = authCodes.get(code);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        authCodes.delete(code);
        return null;
    }
    if (entry.claimed) return null;
    entry.claimed = true;
    return { telegramUserId: entry.telegramUserId, userName: entry.userName };
}

// ─── Rate Limiting (in-memory) ───

const rateLimits = new Map<string, RateLimitEntry>();

const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export function checkRateLimit(ip: string): boolean {
    const entry = rateLimits.get(ip);
    if (!entry) return true;
    if (Date.now() > entry.resetAt) {
        rateLimits.delete(ip);
        return true;
    }
    return entry.attempts < RATE_LIMIT_MAX_ATTEMPTS;
}

export function recordFailedAttempt(ip: string): void {
    const now = Date.now();
    const entry = rateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
        rateLimits.set(ip, { attempts: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    } else {
        entry.attempts++;
    }
}

// ─── Periodic Sweep ───

let sweepInterval: ReturnType<typeof setInterval> | null = null;

function sweep(): void {
    const now = Date.now();

    // Sweep expired/claimed auth codes
    for (const [code, entry] of authCodes) {
        if (now > entry.expiresAt || entry.claimed) {
            authCodes.delete(code);
        }
    }

    // Sweep expired rate limit entries
    for (const [ip, entry] of rateLimits) {
        if (now > entry.resetAt) {
            rateLimits.delete(ip);
        }
    }
}

export function startAuthSweep(): void {
    if (sweepInterval) return;
    sweepInterval = setInterval(sweep, 60_000);
    sweepInterval.unref();
}

export function stopAuthSweep(): void {
    if (sweepInterval) {
        clearInterval(sweepInterval);
        sweepInterval = null;
    }
}

// ─── Tokens (file-based) ───

function readTokens(): TokenInfo[] {
    try {
        return JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8"));
    } catch {
        return [];
    }
}

function writeTokens(tokens: TokenInfo[]): void {
    fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
    const tmpFile = TOKENS_FILE + ".tmp";
    fs.writeFileSync(tmpFile, JSON.stringify(tokens, null, 2));
    fs.renameSync(tmpFile, TOKENS_FILE);
}

function readGitHubInstallations(): Record<string, string> {
    try {
        return JSON.parse(fs.readFileSync(GITHUB_INSTALLATIONS_FILE, "utf8"));
    } catch {
        return {};
    }
}

export async function createToken(telegramUserId: number, userName: string): Promise<TokenInfo> {
    const installations = readGitHubInstallations();
    const orgs = Object.keys(installations);

    const token = "borg_tk_" + crypto.randomBytes(16).toString("hex");
    const now = Date.now();
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

    const tokenInfo: TokenInfo = {
        token,
        telegramUserId,
        userName,
        orgs,
        scopes: [],
        createdAt: now,
        expiresAt: now + THIRTY_DAYS_MS,
    };

    const tokens = readTokens();
    tokens.push(tokenInfo);
    writeTokens(tokens);

    return tokenInfo;
}

export async function validateToken(token: string): Promise<TokenInfo | null> {
    const tokens = readTokens();
    const tokenBuf = Buffer.from(token);
    let entry: TokenInfo | undefined;
    for (const t of tokens) {
        const candidateBuf = Buffer.from(t.token);
        if (tokenBuf.length === candidateBuf.length && crypto.timingSafeEqual(tokenBuf, candidateBuf)) {
            entry = t;
            break;
        }
    }
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) return null;
    return entry;
}

export async function getGitHubToken(
    borgToken: string,
    org?: string,
): Promise<{ token: string; expiresAt: number } | null> {
    const tokenInfo = await validateToken(borgToken);
    if (!tokenInfo) return null;

    const targetOrg = org || tokenInfo.orgs[0];
    if (!targetOrg) return null;

    if (!tokenInfo.orgs.includes(targetOrg)) return null;

    const installations = readGitHubInstallations();
    const installationId = installations[targetOrg];
    if (!installationId) return null;

    const brokerSecret = process.env.BROKER_SECRET;
    if (!brokerSecret) return null;

    const res = await fetch("http://broker:3000/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${brokerSecret}`,
        },
        body: JSON.stringify({ installationId }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { token: string; expiresAt: string };
    return {
        token: data.token,
        expiresAt: new Date(data.expiresAt).getTime(),
    };
}
