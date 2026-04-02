---
name: persistent-storage
description: Managing state that survives container resets via /app/.borg/persistent/. Use when storing SSH keys, credentials, config files, or any lightweight infrastructure state that must persist across restarts.
---

# Persistent Storage

State that needs to survive container resets (restarts, rebuilds, redeployments).

## Location

`/app/.borg/persistent/` — this directory is mounted as a Docker volume and persists across container lifecycle events.

Subdirectory conventions:
- `ssh/` — SSH keys, config, known_hosts
- `env/` — environment files, dotfiles
- Other subdirectories as needed

## Usage

When you need persistent state (SSH keys, credentials, config files):

1. Store the files under `/app/.borg/persistent/<category>/`
2. Copy or symlink them into the expected location at session start
3. Fix permissions as needed (e.g., `chmod 700 ~/.ssh && chmod 600 ~/.ssh/*`)
4. Install any required packages (e.g., `apt-get install -y openssh-client`)

## Example: SSH Setup

```bash
# Install SSH client if not present
which ssh || apt-get update && apt-get install -y openssh-client

# Copy persistent keys into place
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cp /app/.borg/persistent/ssh/* ~/.ssh/
chmod 600 ~/.ssh/id_*
chmod 644 ~/.ssh/*.pub ~/.ssh/config ~/.ssh/known_hosts 2>/dev/null
```

## Guidelines

- This is for lightweight infrastructure state (keys, configs), not large data
- Each repo decides what it needs to persist via its own CLAUDE.md
- Borg does not auto-restore anything — agents are responsible for copying files into place when needed
- The `.borg/` directory is gitignored, so nothing in persistent/ is committed
