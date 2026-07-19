# --- Build stage: whisper.cpp for local voice-note transcription (no API, fully offline) ---
FROM debian:bookworm-slim AS whisper-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
# Static build so the single whisper-cli binary can be copied into the runtime image.
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp /whisper \
  && cmake -S /whisper -B /whisper/build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  && cmake --build /whisper/build --config Release -j"$(nproc)" --target whisper-cli
# Quantized multilingual "small" model (~190MB): good Hindi/English accuracy at CPU-friendly speed.
RUN curl -fSL -o /whisper/ggml-small-q5_1.bin \
      https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin

FROM node:20-slim

# Runtime tools the agent needs: git + gh (for PRs), ffmpeg (voice-note conversion),
# plus ca-certs/curl/jq for setup.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl gnupg jq ffmpeg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# whisper.cpp binary + model from the build stage; picked up via WHISPER_BIN/WHISPER_MODEL.
COPY --from=whisper-build /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper-build /whisper/ggml-small-q5_1.bin /opt/whisper/ggml-small-q5_1.bin

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
# Enable local voice-note transcription (unset these to disable it).
ENV WHISPER_BIN=/usr/local/bin/whisper-cli
ENV WHISPER_MODEL=/opt/whisper/ggml-small-q5_1.bin

ENTRYPOINT ["sh", "./deploy/docker-entrypoint.sh"]
