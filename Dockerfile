# syntax=docker/dockerfile:1.6

# --- stage 1: build the Node wrapper ---
FROM node:20-alpine AS build
WORKDIR /wrapper
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build && pnpm prune --prod

# --- stage 2: final image layered on the upstream nextcloud-mcp-server ---
FROM ghcr.io/cbcoutinho/nextcloud-mcp-server:latest

USER root

# Upstream is Debian trixie — install Node 20 + supervisor + curl via apt.
# nodejs in trixie is v20.x, new enough for built-in fetch (Node >=18).
RUN apt-get update \
 && apt-get install -y --no-install-recommends nodejs supervisor ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Wrapper lives at /wrapper so /app stays owned by the upstream as-shipped.
WORKDIR /wrapper
COPY --from=build /wrapper/dist ./dist
COPY --from=build /wrapper/node_modules ./node_modules
COPY --from=build /wrapper/package.json ./package.json
COPY web/ ./web/

# Wrapper state lives under /app/wrapper-data (persisted via volume).
# Do NOT use /app/data in case the upstream ever ships something there.
RUN mkdir -p /app/wrapper-data /var/log /var/run \
 && touch /app/upstream.env \
 && chmod 600 /app/upstream.env

COPY supervisord.conf /etc/supervisord.conf

ENV PORT=9650 \
    UPSTREAM_PORT=8000 \
    DISCOVERY_PORT=9099 \
    CONFIG_PATH=/app/wrapper-data/config.json \
    UPSTREAM_ENV_PATH=/app/upstream.env

EXPOSE 9650 9099/udp

# Override the upstream image's entrypoint — supervisord is now PID 1.
ENTRYPOINT []
CMD ["supervisord", "-c", "/etc/supervisord.conf"]
