/**
 * Convert GitHub-Flavored Markdown (as Claude outputs) to Telegram MarkdownV2.
 *
 * Strategy: Parse the text into segments (code blocks, inline code, and regular text),
 * then escape special characters only in regular text while preserving formatting.
 *
 * Telegram MarkdownV2 special characters that must be escaped outside formatting:
 *   _ * [ ] ( ) ~ ` > # + - = | { } . !
 */

// Characters that must be escaped in regular text for MarkdownV2
const ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/** Escape a plain text string for MarkdownV2 */
export function escapeMarkdownV2(text: string): string {
    return text.replace(ESCAPE_CHARS, "\\$1");
}

/**
 * Segment types in the parsed markdown
 */
type Segment =
    | { type: "codeblock"; lang: string; content: string }
    | { type: "inline_code"; content: string }
    | { type: "bold"; content: string }
    | { type: "italic_underscore"; content: string }
    | { type: "italic_star"; content: string }
    | { type: "strikethrough"; content: string }
    | { type: "link"; text: string; url: string }
    | { type: "text"; content: string };

/**
 * Parse GFM markdown into segments, handling nesting correctly.
 *
 * We process from outermost constructs inward:
 * 1. Fenced code blocks (``` ... ```) — never nest
 * 2. Inline code (` ... `) — never nest
 * 3. Links [text](url)
 * 4. Bold **text**
 * 5. Italic _text_ or *text*
 * 6. Strikethrough ~~text~~
 * 7. Plain text (everything else)
 */
function parseSegments(text: string): Segment[] {
    const segments: Segment[] = [];
    let pos = 0;

    while (pos < text.length) {
        // 1. Fenced code block: ```lang\n...\n```
        const codeBlockMatch = text.substring(pos).match(/^```(\w*)\n?([\s\S]*?)```/);
        if (codeBlockMatch) {
            segments.push({
                type: "codeblock",
                lang: codeBlockMatch[1],
                content: codeBlockMatch[2],
            });
            pos += codeBlockMatch[0].length;
            continue;
        }

        // 2. Inline code: `...`
        const inlineCodeMatch = text.substring(pos).match(/^`([^`\n]+)`/);
        if (inlineCodeMatch) {
            segments.push({ type: "inline_code", content: inlineCodeMatch[1] });
            pos += inlineCodeMatch[0].length;
            continue;
        }

        // 3. Link: [text](url)
        const linkMatch = text.substring(pos).match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (linkMatch) {
            segments.push({ type: "link", text: linkMatch[1], url: linkMatch[2] });
            pos += linkMatch[0].length;
            continue;
        }

        // 4. Bold: **text**
        const boldMatch = text.substring(pos).match(/^\*\*(.+?)\*\*/s);
        if (boldMatch) {
            segments.push({ type: "bold", content: boldMatch[1] });
            pos += boldMatch[0].length;
            continue;
        }

        // 5. Strikethrough: ~~text~~
        const strikeMatch = text.substring(pos).match(/^~~(.+?)~~/s);
        if (strikeMatch) {
            segments.push({ type: "strikethrough", content: strikeMatch[1] });
            pos += strikeMatch[0].length;
            continue;
        }

        // 6. Italic with underscore: _text_
        // Be careful: don't match underscores in the middle of words
        const italicUnderMatch = text.substring(pos).match(/^_([^_]+)_/);
        if (italicUnderMatch && (pos === 0 || /[\s\n([]/.test(text[pos - 1]))) {
            segments.push({ type: "italic_underscore", content: italicUnderMatch[1] });
            pos += italicUnderMatch[0].length;
            continue;
        }

        // 7. Italic with star: *text* (single star, not double)
        const italicStarMatch = text.substring(pos).match(/^\*([^*]+)\*/);
        if (italicStarMatch) {
            segments.push({ type: "italic_star", content: italicStarMatch[1] });
            pos += italicStarMatch[0].length;
            continue;
        }

        // Plain text: consume until next special character
        const nextSpecial = text.substring(pos + 1).search(/[`*_~\[]/);
        if (nextSpecial === -1) {
            // Rest of string is plain text
            segments.push({ type: "text", content: text.substring(pos) });
            pos = text.length;
        } else {
            segments.push({ type: "text", content: text.substring(pos, pos + 1 + nextSpecial) });
            pos = pos + 1 + nextSpecial;
        }
    }

    return segments;
}

/**
 * Convert parsed segments to Telegram MarkdownV2 string.
 */
function renderSegments(segments: Segment[]): string {
    return segments.map(seg => {
        switch (seg.type) {
            case "codeblock": {
                // In code blocks, only backticks and backslashes need escaping
                const escaped = seg.content.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
                return seg.lang
                    ? `\`\`\`${seg.lang}\n${escaped}\`\`\``
                    : `\`\`\`\n${escaped}\`\`\``;
            }
            case "inline_code": {
                // Inline code: backticks and backslashes only
                const escaped = seg.content.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
                return `\`${escaped}\``;
            }
            case "bold":
                // Recursively process content for nested formatting
                return `*${renderSegments(parseSegments(seg.content))}*`;
            case "italic_underscore":
                return `_${renderSegments(parseSegments(seg.content))}_`;
            case "italic_star":
                return `_${renderSegments(parseSegments(seg.content))}_`;
            case "strikethrough":
                return `~${renderSegments(parseSegments(seg.content))}~`;
            case "link": {
                const escapedText = escapeMarkdownV2(seg.text);
                // URLs: escape only ) and \ inside the URL part
                const escapedUrl = seg.url.replace(/\\/g, "\\\\").replace(/\)/g, "\\)");
                return `[${escapedText}](${escapedUrl})`;
            }
            case "text":
                return escapeMarkdownV2(seg.content);
        }
    }).join("");
}

/**
 * Convert GitHub-Flavored Markdown to Telegram MarkdownV2.
 *
 * Handles: fenced code blocks, inline code, bold, italic, strikethrough, links.
 * Escapes all special characters in plain text segments.
 *
 * For headers (# Header), converts to bold since Telegram doesn't support headers.
 */
export function toTelegramMarkdownV2(text: string): string {
    // Pre-process: Convert GFM headers to bold
    // ## Header → **Header** (which will become *Header* in MarkdownV2)
    let processed = text.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");

    // Pre-process: Convert GFM bullet lists — keep the bullet, it's just text
    // (Telegram doesn't have list formatting, bullets render fine as-is)

    // Pre-process: Convert blockquotes > text to Telegram MarkdownV2 blockquotes
    // Telegram MarkdownV2 uses > for blockquotes natively, so we just need to
    // make sure the > isn't escaped
    // We handle this by leaving > at start of line as-is and not escaping it

    const segments = parseSegments(processed);
    let result = renderSegments(segments);

    // Post-process: Telegram MarkdownV2 blockquotes (> at start of line)
    // The escapeMarkdownV2 function will have escaped the > characters,
    // so we need to un-escape > at start of lines for blockquotes
    result = result.replace(/^\\>(.+)$/gm, ">$1");

    return result;
}
