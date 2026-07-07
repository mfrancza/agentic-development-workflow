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

# Create non-root agent user
RUN useradd -m -s /bin/bash agent

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
