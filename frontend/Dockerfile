FROM node:22-alpine AS build

WORKDIR /var/www

# Accept build arguments
ARG BUILD_NUMBER=unknown
ARG GIT_COMMIT=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_DATE=unknown

# Set environment variables from build args
ENV BUILD_NUMBER=$BUILD_NUMBER
ENV GIT_COMMIT=$GIT_COMMIT
ENV GIT_BRANCH=$GIT_BRANCH
ENV BUILD_DATE=$BUILD_DATE

# Copy package files first for better caching
COPY package*.json ./
RUN npm ci

# Copy source files
COPY . .

# Generate build info with passed environment variables
RUN node scripts/generateBuildInfo.js

# Build the application
RUN npm run build

FROM caddy:2.11-alpine

# Copy the generated files from build stage
COPY --from=build /var/www/dist /usr/share/caddy
COPY --from=build /var/www/Caddyfile /etc/caddy/Caddyfile

# Create a deterministic unprivileged account and writable Caddy state dirs.
# Grant only the capability required to bind the configured low port, then
# remove libcap so it is not part of the runtime package set.
RUN addgroup -S -g 10001 caddy && \
    adduser -S -D -H -u 10001 -G caddy caddy && \
    mkdir -p /data /config && \
    chown caddy:caddy /data /config && \
    apk upgrade --no-cache && \
    apk add --no-cache --virtual .bind-cap-deps libcap && \
    setcap cap_net_bind_service=+ep /usr/bin/caddy && \
    apk del .bind-cap-deps

RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
USER caddy

EXPOSE 80

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]