# syntax=docker/dockerfile:1
# Multi-stage — builder compiles native addons, runtime is slim bookworm without build tools
FROM node:20-bookworm-slim AS builder

WORKDIR /usr/src/node-app

# Build deps for better-sqlite3 (needs python + build-essential)
RUN apt-get update && \
    apt-get install -y --no-install-recommends build-essential python3 libsqlite3-dev && \
    rm -rf /var/lib/apt/lists/*

# Accept build arguments
ARG BUILD_NUMBER=unknown
ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_DATE=unknown
ENV BUILD_NUMBER=$BUILD_NUMBER
ENV GIT_COMMIT=$GIT_COMMIT
ENV GIT_BRANCH=$GIT_BRANCH
ENV BUILD_DATE=$BUILD_DATE

COPY package*.json ./
# Force native build against bookworm glibc
ENV npm_config_build_from_source=true
RUN npm ci --build-from-source --unsafe-perm

COPY . .
RUN node scripts/generateBuildInfo.js && ls -la build-info.* 2>/dev/null || ls -la src/build-info.* 2>/dev/null || echo "no build-info"

# Runtime — no build tools, non-root
FROM node:20-bookworm-slim

RUN mkdir -p /usr/src/node-app && chown -R node:node /usr/src/node-app
RUN mkdir -p /app/data && chown -R node:node /app/data

WORKDIR /usr/src/node-app

ARG BUILD_NUMBER=unknown
ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_DATE=unknown
ENV BUILD_NUMBER=$BUILD_NUMBER
ENV GIT_COMMIT=$GIT_COMMIT
ENV GIT_BRANCH=$GIT_BRANCH
ENV BUILD_DATE=$BUILD_DATE
ENV NODE_ENV=production

COPY --from=builder /usr/src/node-app/node_modules ./node_modules
COPY --from=builder /usr/src/node-app/package*.json ./
COPY --chown=node:node . .
# Overwrite with builder's fresh build-info (with build args)
COPY --from=builder /usr/src/node-app/build-info.json ./build-info.json
COPY --from=builder /usr/src/node-app/build-info.js ./build-info.js

# Ensure entrypoint and ownership
RUN chown -R node:node /usr/src/node-app && chmod +x /usr/src/node-app/docker-entrypoint.sh || true

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/v1/build-info/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/src/node-app/docker-entrypoint.sh"]
CMD ["npm", "start"]
