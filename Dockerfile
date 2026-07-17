FROM node:20-slim

# Runtime tools the agent needs: git + gh (for PRs), plus ca-certs/curl/jq for setup.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg jq \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install deps first (better layer caching), then build the TypeScript.
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Persistent dirs: /data (repos + state + logs) and the Claude config/session dir.
# Owned by the `node` user because Claude Code refuses --dangerously-skip-permissions as root.
RUN mkdir -p /data /home/node/.claude \
  && chown -R node:node /data /home/node/.claude /app

USER node
ENV NODE_ENV=production
ENV CLAUDE_CONFIG_DIR=/home/node/.claude

ENTRYPOINT ["sh", "./deploy/docker-entrypoint.sh"]
