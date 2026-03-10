import { describe, it, expect } from "vitest";
import { escapeMarkdownV2, toTelegramMarkdownV2 } from "../markdown-v2.js";

describe("escapeMarkdownV2", () => {
    it("escapes all special characters", () => {
        expect(escapeMarkdownV2("hello.world!")).toBe("hello\\.world\\!");
        expect(escapeMarkdownV2("foo-bar")).toBe("foo\\-bar");
        expect(escapeMarkdownV2("a(b)c")).toBe("a\\(b\\)c");
        expect(escapeMarkdownV2("1+2=3")).toBe("1\\+2\\=3");
    });

    it("leaves normal text unchanged", () => {
        expect(escapeMarkdownV2("hello world")).toBe("hello world");
    });
});

describe("toTelegramMarkdownV2", () => {
    it("converts fenced code blocks", () => {
        const input = "Here is code:\n```ts\nconst x = 1;\n```\nDone.";
        const result = toTelegramMarkdownV2(input);
        expect(result).toContain("```ts\nconst x = 1;\n```");
        expect(result).toContain("Here is code:");
        expect(result).toContain("Done\\.");
    });

    it("does not escape content inside code blocks", () => {
        const input = "```\nfoo.bar! [test]\n```";
        const result = toTelegramMarkdownV2(input);
        // Inside code block, only backticks and backslashes are escaped
        expect(result).toContain("foo.bar! [test]");
    });

    it("converts inline code", () => {
        const input = "Use `npm install` to install";
        const result = toTelegramMarkdownV2(input);
        expect(result).toBe("Use `npm install` to install");
    });

    it("converts bold **text** to *text*", () => {
        const input = "This is **bold** text";
        const result = toTelegramMarkdownV2(input);
        expect(result).toBe("This is *bold* text");
    });

    it("converts GFM headers to bold", () => {
        const input = "## My Header\nSome text";
        const result = toTelegramMarkdownV2(input);
        expect(result).toContain("*My Header*");
        expect(result).toContain("Some text");
    });

    it("converts links", () => {
        const input = "Check [this link](https://example.com) out";
        const result = toTelegramMarkdownV2(input);
        expect(result).toBe("Check [this link](https://example.com) out");
    });

    it("converts strikethrough", () => {
        const input = "This is ~~deleted~~ text";
        const result = toTelegramMarkdownV2(input);
        expect(result).toBe("This is ~deleted~ text");
    });

    it("escapes dots and exclamation marks in plain text", () => {
        const input = "Version 1.2.3 is ready!";
        const result = toTelegramMarkdownV2(input);
        expect(result).toBe("Version 1\\.2\\.3 is ready\\!");
    });

    it("escapes parentheses in plain text", () => {
        const input = "Call foo() to start";
        const result = toTelegramMarkdownV2(input);
        expect(result).toBe("Call foo\\(\\) to start");
    });

    it("handles bullet lists", () => {
        const input = "Items:\n- First\n- Second";
        const result = toTelegramMarkdownV2(input);
        expect(result).toContain("\\- First");
        expect(result).toContain("\\- Second");
    });

    it("handles mixed formatting", () => {
        const input = "**Bold** and `code` and _italic_";
        const result = toTelegramMarkdownV2(input);
        expect(result).toContain("*Bold*");
        expect(result).toContain("`code`");
        expect(result).toContain("_italic_");
    });

    it("handles real Claude-style output", () => {
        const input = `Here's what I found:

**Problem:** The \`parse_mode\` is set to "Markdown" (v1).

\`\`\`typescript
const x: number = 42;
console.log(x);
\`\`\`

This should fix issue #123.`;
        const result = toTelegramMarkdownV2(input);
        // Should not throw and should produce valid MarkdownV2
        expect(result).toBeTruthy();
        // Code block preserved
        expect(result).toContain("```typescript\nconst x: number = 42;\nconsole.log(x);\n```");
        // Bold converted
        expect(result).toContain("*Problem:*");
        // Inline code preserved
        expect(result).toContain("`parse_mode`");
        // Special chars escaped in text
        expect(result).toContain("\\#123");
    });

    it("handles empty string", () => {
        expect(toTelegramMarkdownV2("")).toBe("");
    });

    it("handles string with only special chars", () => {
        expect(toTelegramMarkdownV2("...")).toBe("\\.\\.\\.");
    });
});
