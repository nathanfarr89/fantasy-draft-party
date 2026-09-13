# syntax = docker/dockerfile:1

FROM node:20-slim

# @napi-rs/canvas needs these system libs on Linux
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      libfontconfig1 \
      libpixman-1-0 \
      libcairo2 \
      libpango-1.0-0 \
      libpangocairo-1.0-0 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV="production"

# Install production deps only — skips electron and electron-builder entirely
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild @napi-rs/canvas --ignore-scripts=false

# Copy only what the server needs
COPY server/ ./server/
COPY player/ ./player/

EXPOSE 3000
CMD ["node", "server/index.js"]
