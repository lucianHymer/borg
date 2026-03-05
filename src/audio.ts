/**
 * Audio infrastructure — Speaches HTTP client for STT/TTS + Haiku distillation.
 * Uses the OpenAI-compatible API provided by the Speaches container.
 */

import fs from "fs";
import path from "path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";

// ─── Config ───

const SPEACHES_URL = process.env.SPEACHES_URL || "http://speaches:8000";
const STT_MODEL = "distil-large-v3";
const TTS_MODEL = "kokoro";
const TTS_VOICE = "bf_alice";
const SCRIPT_DIR = path.resolve(__dirname, "..");
const AUDIO_DIR = path.join(SCRIPT_DIR, ".borg/audio");
const AUDIO_INCOMING_DIR = path.join(AUDIO_DIR, "incoming");
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Ensure audio directories exist
[AUDIO_DIR, AUDIO_INCOMING_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// ─── Health Check ───

export async function isAvailable(): Promise<boolean> {
    try {
        const res = await fetch(`${SPEACHES_URL}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

// ─── STT: Transcribe OGG → text ───

export async function transcribe(oggPath: string): Promise<string> {
    const fileBuffer = fs.readFileSync(oggPath);
    const blob = new Blob([fileBuffer], { type: "audio/ogg" });

    const form = new FormData();
    form.append("file", blob, path.basename(oggPath));
    form.append("model", STT_MODEL);

    const res = await fetch(`${SPEACHES_URL}/v1/audio/transcriptions`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(120_000), // 2 min timeout for long audio
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`STT failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { text: string };
    return data.text?.trim() ?? "";
}

// ─── TTS: Text → OGG/Opus file ───

export async function synthesize(text: string, voice?: string, speed?: number): Promise<string> {
    const res = await fetch(`${SPEACHES_URL}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: TTS_MODEL,
            voice: voice ?? "bf_alice",
            input: text,
            speed: speed ?? 1.0,
            response_format: "opus",
        }),
        signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`TTS failed (${res.status}): ${body}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const filename = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.ogg`;
    const outPath = path.join(AUDIO_DIR, filename);
    const tmpPath = outPath + ".tmp";
    fs.writeFileSync(tmpPath, Buffer.from(arrayBuffer));
    fs.renameSync(tmpPath, outPath);

    return outPath;
}

// ─── Speech Distillation via Haiku ───

export async function distillForSpeech(text: string): Promise<string> {
    // Cap input length before sending to distillation
    const truncatedInput = text.length > 4096 ? text.slice(0, 4096) : text;

    try {
        const conversation = query({
            prompt: truncatedInput,
            options: {
                model: "claude-haiku-4-5-20251001",
                systemPrompt: "Distill the user's text into a brief spoken summary, 2-3 sentences. No markdown, no code, no lists, no special characters. Speak naturally as if telling someone the key takeaway. Keep it concise and conversational.",
                maxTurns: 1,
            },
        });

        let result = "";
        for await (const msg of conversation) {
            if (msg.type === "assistant") {
                const content = (msg as SDKAssistantMessage).message?.content;
                if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text" && typeof block.text === "string") {
                            result += block.text;
                        }
                    }
                }
            }
        }

        return result.trim() || (text.length > 200 ? text.slice(0, 200) + "..." : text);
    } catch {
        // Fallback to truncation on SDK error
        return text.length > 200 ? text.slice(0, 200) + "..." : text;
    }
}

// ─── File Cleanup ───

export function cleanupAudioFile(filePath: string): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch {
        // Best effort
    }
}

function sweepOldAudioFiles(): void {
    const now = Date.now();
    for (const dir of [AUDIO_DIR, AUDIO_INCOMING_DIR]) {
        try {
            for (const file of fs.readdirSync(dir)) {
                const filePath = path.join(dir, file);
                try {
                    const stat = fs.statSync(filePath);
                    if (!stat.isFile()) continue;
                    if (now - stat.mtimeMs > MAX_AGE_MS) {
                        fs.unlinkSync(filePath);
                    }
                } catch {
                    // File may have been deleted by another process
                }
            }
        } catch {
            // Directory may not exist yet
        }
    }
}

export function startPeriodicCleanup(): void {
    sweepOldAudioFiles(); // initial sweep
    setInterval(sweepOldAudioFiles, CLEANUP_INTERVAL_MS);
}

// ─── Exported Paths ───

export { AUDIO_DIR, AUDIO_INCOMING_DIR };
