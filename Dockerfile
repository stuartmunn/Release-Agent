# --- build stage: compile TS, build native modules ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 builds a native addon; provide the toolchain in case no prebuild matches.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Releasebot CLI (used by the daily fetch) and MCP server (used for follow-ups) installed
# globally so nothing is downloaded at runtime.
RUN npm install -g @releasebot-io/cli @releasebot-io/mcp \
    && npm cache clean --force

# Bring the already-built node_modules over, then drop devDependencies (no native rebuild).
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev

COPY --from=build /app/dist ./dist
COPY .claude ./.claude

# SQLite cache + last_run + credit log live here; mount a volume to persist them.
RUN mkdir -p /data
VOLUME ["/data"]
ENV DATA_DIR=/data

CMD ["node", "dist/index.js"]
