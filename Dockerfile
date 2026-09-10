# syntax=docker/dockerfile:1

##
## Base: Node + a real Google Chrome install (Puppeteer needs the OS libs
## that ship with the .deb package; the slim Node image doesn't have them,
## and letting Puppeteer download its own Chromium into this image is both
## slower and less reliable).
##
FROM node:20-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
      wget gnupg ca-certificates fonts-liberation \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the Chrome installed above instead of downloading one.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

##
## deps: full dependency install (needed to run tsup/tsc for the build stage)
##
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

##
## build: compile TypeScript -> dist/ with tsup
##
FROM deps AS build
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

##
## prod-deps: production-only node_modules for the runtime image
##
FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

##
## runtime: minimal final image
##
FROM base AS runtime

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY bin ./bin
COPY package.json ./

# Run as a non-root user, and give it a writable directory that exports
# land in by default (mount a volume here to get the exported site out
# of the container).
RUN groupadd --system framer \
    && useradd --system --create-home --gid framer framer \
    && mkdir -p /app/output && chown -R framer:framer /app
USER framer
WORKDIR /app/output

ENV NODE_ENV=production

# Only meaningful for `framer-export ui`, which binds to 127.0.0.1 by
# default (safe for native/non-Docker use). Pass --host 0.0.0.0 so it
# binds on all interfaces inside the container and is reachable through
# a published port, e.g.:
#   docker run --rm -p 4400:4400 -v "$PWD/output:/app/output" \
#     framer-export ui --host 0.0.0.0 --no-open
EXPOSE 4400

ENTRYPOINT ["node", "/app/bin/framer-export.js"]
CMD ["--help"]
