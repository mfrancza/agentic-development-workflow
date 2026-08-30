FROM node:22-bookworm

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI. Pin to a specific version so workflow runs are
# reproducible; override at build time with --build-arg if you want a different
# release.
ARG CLAUDE_CODE_VERSION=2.1.150
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Install OpenAI Codex CLI. Pin to a specific version so workflow runs are
# reproducible; override at build time with --build-arg if you want a different
# release. Kept in sync with docker/reviewer/Dockerfile so both images ship
# the same Codex release.
ARG CODEX_CLI_VERSION=0.146.0
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}"

# Install Grok Build CLI. Pin to a specific version so workflow runs are
# reproducible; override at build time with --build-arg if you want a different
# release. Kept in sync with docker/reviewer/Dockerfile so both images ship the
# same Grok Build CLI release. The vendor install script supports version pinning
# via a positional argument; GROK_BIN_DIR writes the binary to /usr/local/bin so
# it is on the system PATH before the USER agent directive (matching how gh,
# claude, and codex are installed). See docs/design/grok-build-cli.md Decision 2.
ARG GROK_BUILD_CLI_VERSION=1.0.13
RUN curl -fsSL https://x.ai/cli/install.sh | \
    GROK_BIN_DIR=/usr/local/bin bash -s -- "${GROK_BUILD_CLI_VERSION}"

# Create non-root agent user
RUN useradd -m -s /bin/bash agent

# Copy scripts
COPY scripts/ /opt/agent/
RUN chmod +x /opt/agent/entrypoint.sh /opt/agent/git-askpass.sh

# Run as agent user
USER agent
WORKDIR /home/agent

# Configure Codex CLI to use xAI's OpenAI-compatible API endpoint for Grok models.
# Verification result (docs/design/grok-developer-image-entrypoint.md Decision 1):
# at the pinned Codex CLI release (v0.146.0) a built-in first-class "xai" provider
# was not confirmed via `codex --help`, so the explicit config block is required.
# If a future pinned release ships a built-in xai provider the block is additive
# (inert) rather than harmful — the custom entry is still read and remains correct.
# Custom model_providers read credentials from the env var named by env_key
# (XAI_API_KEY), not from ~/.codex/auth.json — so no codex login step is
# needed for the xai arm (see docs/design/grok-models.md decision 2).
RUN mkdir -p /home/agent/.codex && \
    printf '[model_providers.xai]\nname = "xAI"\nbase_url = "https://api.x.ai/v1"\nenv_key = "XAI_API_KEY"\n' \
    > /home/agent/.codex/config.toml

ENTRYPOINT ["/opt/agent/entrypoint.sh"]
