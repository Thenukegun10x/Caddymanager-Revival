# syntax=docker/dockerfile:1
# Multi-stage — builder compiles native addons; runtime includes only Node and
# the libraries required by the app. Node 22 matches the CI toolchain.
FROM node:22-trixie-slim AS builder

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
RUN npm ci --unsafe-perm

COPY . .
RUN node scripts/generateBuildInfo.js
# Fail the build if the native SQLite addon cannot load or execute a query.
RUN node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); if (db.prepare('select 1 as v').get().v !== 1) process.exit(1); db.close();"

# H3: production-only dependency tree. Native addons are already built above.
FROM builder AS runtime-deps
RUN npm prune --omit=dev && npm cache clean --force

# Keep a stage with dev dependencies for the isolated test runner.
# libcurl4 is required by the mongodb-memory-server binary (Mongo parity tests).
FROM builder AS test
RUN apt-get update && \
    apt-get install -y --no-install-recommends libcurl4 && \
    rm -rf /var/lib/apt/lists/*
CMD ["/usr/src/node-app/node_modules/.bin/jest", "--runInBand"]

# Runtime — no npm/Corepack or compiler toolchain, non-root. Copying the Node executable
# onto a clean Debian base avoids shipping npm/corepack in the production image.
FROM debian:trixie-slim AS runtime

# better-sqlite3 runtime needs libsqlite3 (bundled build still links glibc + libstdc++)
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 libstdc++6 && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /usr/src/node-app /app/data /home/node && \
    chown 10001:10001 /usr/src/node-app /app/data /home/node && \
    printf 'node:x:10001:10001:Node.js user:/home/node:/usr/sbin/nologin\n' >> /etc/passwd && \
    printf 'node:x:10001:\n' >> /etc/group

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
ENV HOME=/home/node

COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime-deps /usr/src/node-app/node_modules ./node_modules
COPY --chown=10001:10001 . .
# Overwrite with builder's fresh build-info (with build args)
COPY --from=builder --chown=10001:10001 /usr/src/node-app/build-info.json ./build-info.json
COPY --from=builder --chown=10001:10001 /usr/src/node-app/build-info.js ./build-info.js

USER 10001:10001

# Run the native-addon and entrypoint checks as the production user.
RUN node -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); if (db.prepare('select 1 as v').get().v !== 1) process.exit(1); db.close();" && \
    test -x /usr/src/node-app/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/src/node-app/docker-entrypoint.sh"]
CMD ["node", "app.js"]
