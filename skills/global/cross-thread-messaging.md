# Cross-Thread Messaging

When communicating with agents in other Borg threads, always use absolute paths when referring to files or directories. This ensures clarity across threads working in different contexts and prevents path ambiguity.

## File References: Always Use Absolute Paths

Different threads may have different working directories. When you reference a file or ask another thread to work with a file, always specify the full absolute path.

✓ Good: "Update `/home/lucian/workspace/borg/src/main.ts` to..."
✗ Bad: "Update `src/main.ts` to..."

✓ Good: "Read the file at `/home/lucian/workspace/passport/.claude/skills/workflows/dev-team.md`"
✗ Bad: "Read `.claude/skills/workflows/dev-team.md`"

## Why It Matters

- **Different working directories**: Each thread has its own `cwd`. What's `src/main.ts` in one thread might be `../other-project/src/main.ts` in another.
- **Worktree isolation**: Team threads often run in separate git worktrees with different paths.
- **Clarity**: Absolute paths are unambiguous and work from any context.

Use the `send_message` MCP tool to communicate with other threads, and always include absolute paths in the message.
