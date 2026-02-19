FROM node:22-slim

WORKDIR /app

# ── System packages ──────────────────────────────────────────────────
# Install git, curl, jq, bash, and GitHub CLI (gh)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        git curl jq bash ca-certificates gnupg sudo && \
    # GitHub CLI: add the official apt repository
    mkdir -p -m 755 /etc/apt/keyrings && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    # Cleanup apt caches to keep the image small
    rm -rf /var/lib/apt/lists/*

# ── Dependency layer (cached unless package*.json changes) ───────────
COPY package.json package-lock.json tsconfig.json ./

# Install all deps (devDependencies needed for tsc build)
RUN npm ci

# ── Build layer ──────────────────────────────────────────────────────
COPY src/ ./src/
COPY .claude/ ./.claude/

RUN npm run build

# Remove devDependencies after compilation
RUN npm prune --production

# ── Runtime setup ────────────────────────────────────────────────────
COPY entrypoint.sh heartbeat-cron.sh ./
RUN chmod +x entrypoint.sh heartbeat-cron.sh

COPY docker/github-token-helper.sh /usr/local/bin/github-token-helper
RUN chmod +x /usr/local/bin/github-token-helper

# gh wrapper: mints a fresh token from the broker before each gh invocation
RUN mv /usr/bin/gh /usr/bin/gh-real
COPY docker/gh-wrapper.sh /usr/bin/gh
RUN chmod +x /usr/bin/gh

# ── Non-root user setup ─────────────────────────────────────────────
# node:22-slim provides a 'node' user (uid 1000). Set up its home dir.
RUN echo "node ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/node && \
    mkdir -p /home/node/.claude && \
    chown -R node:node /app /home/node

# Configure git for the node user
USER node
RUN git config --global credential.helper /usr/local/bin/github-token-helper && \
    git config --global credential.useHttpPath true

ENTRYPOINT ["./entrypoint.sh"]
