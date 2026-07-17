#!/usr/bin/env sh
# Container entrypoint: materialize config from env, wire up git auth, ensure the project repos
# are cloned, then hand off to the orchestrator. Everything identity-specific comes from env vars
# (Dokploy injects them), so nothing sensitive is baked into the image.
set -e

PROJECTS_FILE="${PROJECTS_FILE:-/app/config/projects.json}"

# 1. projects.json from the PROJECTS_JSON env var (paste it minified as a single line in Dokploy).
if [ -n "$PROJECTS_JSON" ]; then
  mkdir -p "$(dirname "$PROJECTS_FILE")"
  printf '%s' "$PROJECTS_JSON" > "$PROJECTS_FILE"
fi

# 2. Let git clone/push over HTTPS using the bot's GitHub token.
if [ -n "$GITHUB_TOKEN" ]; then
  export GH_TOKEN="$GITHUB_TOKEN"
  gh auth setup-git 2>/dev/null \
    || git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"
fi

# 3. Clone any project repo that isn't present yet (idempotent; fetches if it already exists).
node deploy/ensure-repos.js || echo "[entrypoint] repo ensure step failed; continuing"

# 4. Start the service.
exec node dist/index.js
