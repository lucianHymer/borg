/**
 * Webhook Formatters — transform incoming webhook payloads into human-readable messages.
 */

export type Formatter = (headers: Record<string, string>, body: unknown) => string | null;

// ─── GitHub Event Interfaces ───

interface GitHubEntity {
    title?: string;
    number?: number;
    html_url?: string;
    user?: { login?: string };
    labels?: Array<{ name?: string }>;
    body?: string;
}

interface GitHubCommit {
    id?: string;
    message?: string;
    author?: { name?: string };
}

interface GitHubPayload {
    action?: string;
    repository?: { full_name?: string };
    issue?: GitHubEntity;
    pull_request?: GitHubEntity;
    comment?: GitHubEntity & { user?: { login?: string } };
    ref?: string;
    commits?: GitHubCommit[];
    compare?: string;
}

function formatEntity(type: string, entity: GitHubEntity, repo: string, action: string): string {
    const title = entity.title || "";
    const number = entity.number ?? 0;
    const url = entity.html_url || "";
    const author = entity.user?.login || "";
    const labels = (entity.labels || []).map(l => l.name || "").filter(Boolean).join(", ");
    const bodyText = (entity.body || "").slice(0, 500);
    return `[GitHub] ${type} #${number} ${action}: ${title}\nRepo: ${repo}\nAuthor: ${author}${labels ? `\nLabels: ${labels}` : ""}${bodyText ? `\n${bodyText}` : ""}\n${url}`;
}

function formatGitHub(headers: Record<string, string>, body: unknown): string | null {
    const event = headers["x-github-event"];
    const payload = body as GitHubPayload;
    const action = payload.action || "";
    const repo = payload.repository?.full_name || "unknown";

    if (event === "issues" && payload.issue) {
        return formatEntity("Issue", payload.issue, repo, action);
    }

    if (event === "pull_request" && payload.pull_request) {
        return formatEntity("PR", payload.pull_request, repo, action);
    }

    if (event === "issue_comment") {
        const issue = payload.issue;
        const comment = payload.comment;
        if (!issue || !comment) return null;
        const title = issue.title || "";
        const number = issue.number ?? 0;
        const url = comment.html_url || "";
        const author = comment.user?.login || "";
        const bodyText = (comment.body || "").slice(0, 500);
        return `[GitHub] Comment on #${number} (${title})\nRepo: ${repo}\nAuthor: ${author}\n${bodyText}\n${url}`;
    }

    if (event === "push") {
        const ref = payload.ref || "unknown";
        const commits = payload.commits || [];
        const compare = payload.compare || "";
        const lines: string[] = [`[GitHub] Push to ${ref} in ${repo}: ${commits.length} commit(s)`];
        for (const c of commits.slice(0, 5)) {
            const sha = (c.id || "").slice(0, 7);
            const message = (c.message || "").split("\n")[0];
            const authorName = c.author?.name || "unknown";
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
