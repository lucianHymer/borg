# Borg Setup

Interactive setup wizard for Borg initialization. Validates configuration, guides users through missing steps, and auto-generates values where possible.

## When to Use

- First-time Borg setup
- Configuration validation
- Troubleshooting setup issues
- User explicitly requests setup help

## What This Skill Does

1. **Detection** - Check what's already configured
2. **Interactive Setup** - Guide through missing configuration
3. **Validation** - Test the setup
4. **Documentation** - Link to relevant guides

## Setup Steps

### Phase 1: Environment Variables (.env)

Check for `.env` file. If missing, create from template:

1. **GITHUB_APP_ID** - Prompt user for GitHub App ID
   - Guide: "Create a GitHub App at https://github.com/settings/apps"
   - Required permissions: Contents (read), Metadata (read)
   - Validate: must be numeric

2. **BROKER_SECRET** - Auto-generate or validate existing
   - Generate: `openssl rand -hex 32`
   - **CRITICAL WARNING**: "This value is immutable once dev containers are created. Changing it requires regenerating ALL dev container credentials."
   - Validate: must be 64 hex characters

3. **WORKSPACE_ROOT** - Detect or prompt
   - Auto-detect: current working directory
   - Validate: path exists and is a directory
   - Warn if doesn't match detected workspace

4. **DOCKER_GID** - Auto-detect
   - Command: `getent group docker | cut -d: -f3`
   - Validate: must be numeric
   - If detection fails, prompt user

5. **PUBLIC_HOST** - Prompt user
   - Guide: "Enter the public hostname or IP of this server (used for SSH config snippets)"
   - Example: "borg.example.com" or "192.168.1.100"
   - This is NOT the Cloudflare tunnel URL

6. **CLAUDE_CREDENTIALS** (Optional) - Use default or custom
   - Default: `~/.claude/.credentials.json`
   - Validate if provided: file exists

7. **TUNNEL_TOKEN** (Optional) - Prompt if user wants HTTPS dashboard
   - Guide: "Get token from Cloudflare Tunnel: https://one.dash.cloudflare.com/"
   - Skip if user doesn't need public HTTPS access

Write `.env` file with generated/collected values.

### Phase 2: GitHub App Credentials

1. **secrets/github-app.pem** - GitHub App private key
   - Prompt: "Download private key from your GitHub App settings"
   - Guide: "Settings → GitHub Apps → Your App → Generate a private key"
   - Validate:
     - File exists
     - Valid PEM format (regex: `^-----BEGIN [A-Z ]+-----`, `-----END [A-Z ]+-----$`)
     - File permissions are 600 or stricter
   - If validation fails, explain the issue and ask user to fix it

2. **secrets/github-installations.json** - Org to installation ID mapping
   - Check if `secrets/github-installations.json.example` exists (copy template)
   - Guide: "Find installation ID: GitHub → Settings → Installations → Your App → Installation ID (in URL)"
   - Example format:
     ```json
     {
       "your-org": "12345678"
     }
     ```
   - Validate: valid JSON, at least one org entry

### Phase 3: Broker Environment (Dev Containers)

1. **secrets/broker-env.sh** - Auto-generate from BROKER_SECRET
   - Read BROKER_SECRET from `.env`
   - Write file:
     ```bash
     export CREDENTIAL_BROKER_URL=http://broker:3000
     export BROKER_SECRET=<value-from-env>
     ```
   - **Warn again**: "Remember: BROKER_SECRET is immutable once dev containers use it"

### Phase 4: Docker Validation

1. **Docker daemon health**
   - Run: `docker info`
   - If fails, guide: "Start Docker daemon: sudo systemctl start docker"

2. **Docker socket permissions**
   - Check: `/var/run/docker.sock` accessible
   - If fails, guide: "Add your user to docker group: sudo usermod -aG docker $USER && newgrp docker"

### Phase 5: Telegram Bot Setup

1. **Telegram bot token**
   - Guide: "Create bot with @BotFather on Telegram"
   - Steps:
     1. Message @BotFather: `/newbot`
     2. Follow prompts (name, username)
     3. Save the token
   - Validate format: starts with digits, contains `:`

2. **Telegram chat ID**
   - Guide: "Create a forum group (Telegram → New Group → enable Topics)"
   - Get ID: "Forward a message from the group to @userinfobot, or use: https://api.telegram.org/bot<token>/getUpdates"
   - Validate: numeric (negative for groups)

3. **Configure bot**
   - Guide: "Add bot to group as admin with permissions: Delete messages, Post messages, Manage topics"

**Note**: `.borg/settings.json` is auto-created on first bot run. We don't need to create it during setup.

### Phase 6: Final Validation

1. **Test Docker Compose**
   - Dry run: `docker compose config` (validates compose file)

2. **Preflight summary**
   - Show checklist of what's configured
   - List any warnings or optional items skipped

3. **Next steps**
   - "Run: ./borg.sh start"
   - "Monitor logs: ./borg.sh logs"
   - "Optional: Setup master thread knowledge base with ./scripts/init-knowledge-base.sh"

## Validation Functions

### PEM File Validation
```bash
# Check PEM format
head -n1 secrets/github-app.pem | grep -q "^-----BEGIN"
tail -n1 secrets/github-app.pem | grep -q "-----END.*-----$"

# Check permissions
stat -c %a secrets/github-app.pem  # Should be 600 or stricter (600, 400)
```

### Settings.json Required Fields
After bot creates `.borg/settings.json`, validate:
- `telegram_bot_token` - exists, format: `^\d+:.+`
- `telegram_chat_id` - exists, numeric
- `timezone` - exists, non-empty
- `model` - exists, one of: haiku, sonnet, opus

### WORKSPACE_ROOT Check
```bash
# Verify path exists
test -d "$WORKSPACE_ROOT"

# Warn if doesn't match current repo
current=$(pwd)
if [ "$WORKSPACE_ROOT" != "$current" ]; then
    echo "WARNING: WORKSPACE_ROOT doesn't match current directory"
fi
```

## Idempotency

- Detect existing configuration and skip completed steps
- Allow re-running setup to validate or fix issues
- Never overwrite existing files without confirmation
- Safe to run multiple times

## User Experience

**Conversational flow:**
1. Greet user: "Let's set up Borg! I'll check what's already configured..."
2. Show detection results: "Found: .env ✓, Missing: secrets/github-app.pem ✗"
3. For each missing item: explain, guide, validate
4. Use clear section headers for each phase
5. Show progress: "Phase 1/6: Environment Variables"
6. Celebrate wins: "✓ Docker is running and accessible"
7. Warn about critical items: "⚠️  BROKER_SECRET is immutable"
8. End with clear next steps

**Error handling:**
- If validation fails, explain what's wrong and how to fix it
- Offer to retry after user fixes issues
- Link to documentation for complex steps

## Example Interaction

```
Let's set up Borg! I'll check what's already configured...

Checking existing configuration...
  ✓ .env file exists
  ✗ secrets/github-app.pem not found
  ✗ secrets/github-installations.json not found
  ✓ Docker daemon is running

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase 1/6: Environment Variables
Your .env looks good! All required fields are present.

⚠️  BROKER_SECRET detected: This value is IMMUTABLE once dev containers
    are created. Changing it requires regenerating ALL dev container
    credentials.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase 2/6: GitHub App Credentials

I need your GitHub App private key...
[continues with interactive setup]
```

## Files Created/Modified

- `.env` - Environment variables (if missing)
- `secrets/github-app.pem` - User provides this (we validate)
- `secrets/github-installations.json` - User provides JSON (we validate)
- `secrets/broker-env.sh` - Auto-generated from BROKER_SECRET

## Related Files

- `.env.example` - Template for environment variables
- `secrets/github-installations.json.example` - Template for installations
- `scripts/init-knowledge-base.sh` - Master thread knowledge base setup (optional, Phase 2)
- `borg.sh` - Main entry point (has preflight checks)

## Integration with borg.sh

The `borg.sh start` command has basic preflight checks. This skill provides:
- More comprehensive validation
- Interactive setup for missing items
- Auto-generation of values
- Better error messages and guidance

Eventually, `borg.sh start` could call this skill on first run, but for now it's manually invoked.
