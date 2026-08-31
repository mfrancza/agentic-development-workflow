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
# release. Kept in sync with docker/Dockerfile so the reviewer and developer
# images run against the same CLI.
ARG CLAUDE_CODE_VERSION=2.1.150
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Install OpenAI Codex CLI. Pin to a specific version so workflow runs are
# reproducible; override at build time with --build-arg if you want a different
# release. Kept in sync with docker/Dockerfile so the reviewer and developer
# images ship the same Codex release.
ARG CODEX_CLI_VERSION=0.146.0
RUN npm install -g "@openai/codex@${CODEX_CLI_VERSION}"

# Install Grok Build CLI. Pin to a specific version so workflow runs are
# reproducible; override at build time with --build-arg if you want a different
# release. Kept in sync with docker/Dockerfile so the reviewer and developer
# images ship the same Grok Build CLI release. The vendor install script supports
# version pinning via a positional argument; GROK_BIN_DIR writes the binary to
# /usr/local/bin so it is on the system PATH before the USER agent directive
# (matching how gh, claude, and codex are installed). See
# docs/design/grok-build-cli.md Decision 2.
ARG GROK_BUILD_CLI_VERSION=1.0.13
RUN curl -fsSL https://x.ai/cli/install.sh | \
    GROK_BIN_DIR=/usr/local/bin bash -s -- "${GROK_BUILD_CLI_VERSION}" && \
    cp -f "$(readlink -f /usr/local/bin/grok)" /usr/local/bin/grok.real && \
    mv -f /usr/local/bin/grok.real /usr/local/bin/grok && \
    rm -f /usr/local/bin/agent && \
    chmod 0755 /usr/local/bin/grok

# Create non-root agent user
RUN useradd -m -s /bin/bash agent

# Verify the grok binary is a regular world-executable file reachable by the
# agent user — fail the build rather than the first runtime use.
RUN test -f /usr/local/bin/grok && runuser -u agent -- /usr/local/bin/grok --version

# Copy the reviewer entrypoint and prompts. The reviewer image deliberately
# ships no git-askpass.sh and no commit/push code paths — see
# docs/design/reviewer-container.md decision 3 (structural no-write guarantee).
COPY entrypoint.sh /opt/agent/entrypoint.sh
COPY prompts/ /opt/agent/prompts/
RUN chmod +x /opt/agent/entrypoint.sh

# Run as agent user
USER agent
WORKDIR /home/agent

ENTRYPOINT ["/opt/agent/entrypoint.sh"]
