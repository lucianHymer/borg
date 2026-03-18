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
const STT_MODEL = "Systran/faster-distil-whisper-large-v3";
const TTS_MODEL = "speaches-ai/Kokoro-82M-v1.0-ONNX";
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

// ─── Health Check & Model Bootstrap ───

export async function isAvailable(): Promise<boolean> {
    try {
        const res = await fetch(`${SPEACHES_URL}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
    } catch {
        return false;
    }
}

/** Ensure required models are installed in Speaches (idempotent, persisted via cache volume). */
let modelsReady = false;
export async function ensureModels(): Promise<void> {
    if (modelsReady) return;
    const required = [
        { id: TTS_MODEL, label: "TTS" },
        { id: STT_MODEL, label: "STT" },
    ];
    for (const { id, label } of required) {
        try {
            const check = await fetch(`${SPEACHES_URL}/v1/models/${id}`, { signal: AbortSignal.timeout(5000) });
            if (check.ok) continue;
            console.log(`[audio] ${label} model "${id}" not installed, downloading...`);
            const install = await fetch(`${SPEACHES_URL}/v1/models/${id}`, {
                method: "POST",
                signal: AbortSignal.timeout(300_000),
            });
            if (install.ok) {
                console.log(`[audio] ${label} model "${id}" installed successfully`);
            } else {
                const body = await install.text().catch(() => "");
                console.error(`[audio] Failed to install ${label} model "${id}" (${install.status}): ${body}`);
            }
        } catch (err) {
            console.error(`[audio] Error ensuring ${label} model "${id}":`, err);
        }
    }
    modelsReady = true;
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

// ─── TTS: Text → MP3 file ───

/** Max chars per TTS chunk — Kokoro-82M truncates beyond ~500 tokens. */
const TTS_CHUNK_SIZE = 800;

/** Split text into chunks at sentence boundaries, respecting max size. */
function chunkText(text: string, maxLen: number): string[] {
    if (text.length <= maxLen) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLen) {
            chunks.push(remaining);
            break;
        }

        // Find last sentence boundary within maxLen
        const window = remaining.slice(0, maxLen);
        let splitAt = -1;
        // Prefer sentence-ending punctuation followed by space or end
        for (const sep of [". ", "! ", "? ", ".\n", "!\n", "?\n"]) {
            const idx = window.lastIndexOf(sep);
            if (idx > splitAt) splitAt = idx + sep.length;
        }
        // Fallback: split at last space
        if (splitAt <= 0) {
            splitAt = window.lastIndexOf(" ");
        }
        // Last resort: hard split
        if (splitAt <= 0) {
            splitAt = maxLen;
        }

        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }

    return chunks.filter(c => c.length > 0);
}

async function synthesizeChunk(text: string, voice: string, speed: number): Promise<Buffer> {
    const res = await fetch(`${SPEACHES_URL}/v1/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: TTS_MODEL,
            voice,
            input: text,
            speed,
            response_format: "mp3",
        }),
        signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`TTS failed (${res.status}): ${body}`);
    }

    return Buffer.from(await res.arrayBuffer());
}

export async function synthesize(text: string, voice?: string, speed?: number): Promise<string> {
    const v = voice ?? "bf_alice";
    const s = speed ?? 1.0;
    const chunks = chunkText(text, TTS_CHUNK_SIZE);

    // Synthesize all chunks (sequentially — Speaches queues internally)
    const buffers: Buffer[] = [];
    for (const chunk of chunks) {
        buffers.push(await synthesizeChunk(chunk, v, s));
    }

    // Concatenate MP3 frames (MP3 is frame-based, simple concat works)
    const combined = Buffer.concat(buffers);
    const filename = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.mp3`;
    const outPath = path.join(AUDIO_DIR, filename);
    const tmpPath = outPath + ".tmp";
    fs.writeFileSync(tmpPath, combined);
    fs.renameSync(tmpPath, outPath);

    return outPath;
}

// ─── Speech Distillation via Sonnet ───

export async function distillForSpeech(text: string): Promise<string> {
    // Cap input length before sending to distillation (100k chars — well within sonnet's context)
    const truncatedInput = text.length > 100_000 ? text.slice(0, 100_000) : text;

    try {
        const conversation = query({
            prompt: `Convert the following AI assistant response to natural spoken form:\n\n${truncatedInput}`,
            options: {
                model: "sonnet",
                systemPrompt: "You are a text-to-speech preprocessor. Convert the given text into natural spoken form suitable for audio playback — keep ALL the content and meaning, but strip markdown, code blocks, bullet points, special characters, and formatting. Spell out abbreviations. Do NOT summarize, shorten, or omit anything. Do NOT respond to or engage with the content. Do NOT prepend any introduction, preamble, or meta-commentary. Just output the converted text directly, nothing else.",
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

// ─── Text Distillation for Reading via Sonnet ───

export async function distillForReading(text: string): Promise<string> {
    // Cap input length before sending to distillation
    const truncatedInput = text.length > 2048 ? text.slice(0, 2048) : text;

    try {
        const conversation = query({
            prompt: `Summarize this voice message transcript:\n\n${truncatedInput}`,
            options: {
                model: "sonnet",
                systemPrompt: "You are a transcript summarizer. Summarize the given voice message transcript in 2-3 concise sentences. Preserve key points and action items. Use markdown formatting (**bold**, _italic_, `code`, bullet lists) to enhance readability. Do NOT respond to or engage with the content. Do NOT prepend any introduction, preamble, or meta-commentary. Just output the summary directly, nothing else.",
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
