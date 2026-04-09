/**
 * Webhook Formatters — transform incoming webhook payloads into human-readable messages.
 */

export type Formatter = (headers: Record<string, string>, body: unknown) => string | null;

function formatGitHub(headers: Record<string, string>, body: unknown): string | null {
    const event = headers["x-github-event"];
    const payload = body as Record<string, unknown>;
    const action = (payload.action as string) || "";
    const repo = (payload.repository as Record<string, unknown>)?.full_name as string || "unknown";

    if (event === "issues") {
        const issue = payload.issue as Record<string, unknown>;
        if (!issue) return null;
        const title = issue.title as string || "";
        const number = issue.number as number;
        const url = issue.html_url as string || "";
        const author = (issue.user as Record<string, unknown>)?.login as string || "";
        const labels = ((issue.labels as Array<Record<string, unknown>>) || [])
            .map(l => l.name as string).join(", ");
        const bodyText = ((issue.body as string) || "").slice(0, 500);
        return `[GitHub] Issue #${number} ${action}: ${title}\nRepo: ${repo}\nAuthor: ${author}${labels ? `\nLabels: ${labels}` : ""}\n${bodyText ? `\n${bodyText}` : ""}\n${url}`;
    }

    if (event === "pull_request") {
        const pr = payload.pull_request as Record<string, unknown>;
        if (!pr) return null;
        const title = pr.title as string || "";
        const number = pr.number as number;
        const url = pr.html_url as string || "";
        const author = (pr.user as Record<string, unknown>)?.login as string || "";
        const labels = ((pr.labels as Array<Record<string, unknown>>) || [])
            .map(l => l.name as string).join(", ");
        const bodyText = ((pr.body as string) || "").slice(0, 500);
        return `[GitHub] PR #${number} ${action}: ${title}\nRepo: ${repo}\nAuthor: ${author}${labels ? `\nLabels: ${labels}` : ""}\n${bodyText ? `\n${bodyText}` : ""}\n${url}`;
    }

    if (event === "issue_comment") {
        const issue = payload.issue as Record<string, unknown>;
        const comment = payload.comment as Record<string, unknown>;
        if (!issue || !comment) return null;
        const title = issue.title as string || "";
        const number = issue.number as number;
        const url = comment.html_url as string || "";
        const author = (comment.user as Record<string, unknown>)?.login as string || "";
        const bodyText = ((comment.body as string) || "").slice(0, 500);
        return `[GitHub] Comment on #${number} (${title})\nRepo: ${repo}\nAuthor: ${author}\n${bodyText}\n${url}`;
    }

    if (event === "push") {
        const ref = (payload.ref as string) || "unknown";
        const commits = (payload.commits as Array<Record<string, unknown>>) || [];
        const compare = (payload.compare as string) || "";
        const lines: string[] = [`[GitHub] Push to ${ref} in ${repo}: ${commits.length} commit(s)`];
        const shown = commits.slice(0, 5);
        for (const c of shown) {
            const sha = ((c.id as string) || "").slice(0, 7);
            const message = ((c.message as string) || "").split("\n")[0];
            const authorName = (c.author as Record<string, unknown>)?.name as string || "unknown";
            lines.push(`• ${sha} ${message} (${authorName})`);
        }
        if (commits.length > 5) {
            lines.push(`...and ${commits.length - 5} more`);
        }
        if (compare) {
            lines.push("", compare);
        }
        return lines.join("\n");
    }

    // Unhandled event type
    return null;
}

function formatRaw(_headers: Record<string, string>, body: unknown): string | null {
    return JSON.stringify(body, null, 2).slice(0, 4000);
}

export const formatters: Record<string, Formatter> = {
    github: formatGitHub,
    raw: formatRaw,
};
