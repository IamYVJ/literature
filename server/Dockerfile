# syntax=docker/dockerfile:1
# ============================================================================
# Literature server image.
#
# BUILD FROM THE REPO ROOT, NOT FROM server/:
#     docker build -f server/Dockerfile -t literature-server .
#
# The reason is the whole point of the design — the server imports the SAME game
# engine the browser runs (../js/state.js, rules.js, cards.js, intents.js), the
# same guards (../js/guards.js) and the same bots (../js/bots.js,
# ../js/botdriver.js), so the build context has to contain both directories. A
# Dockerfile that could only see server/ would force a copy of the engine, and a
# second copy of the rules is the one thing this project is organised to avoid.
#
# Target is linux/arm64 (Raspberry Pi 4B, 64-bit Pi OS). See
# .github/workflows/server.yml — the CI builds that platform explicitly, because a
# default build on an x86 runner produces an image the Pi cannot run.
# ============================================================================

# --- dependencies ----------------------------------------------------------
# Node 22 is the LTS line. The tag floats within the major version, which is the
# right trade for a hobby deployment: patch-level security fixes arrive on a
# rebuild instead of needing a commit. To pin harder, copy the digest out of a
# successful build log and append it as node:22-alpine@sha256:<digest> — don't
# invent one, an incorrect digest fails the build with a confusing error.
FROM node:22-alpine AS deps
WORKDIR /app

# Only the manifest, so this layer is cached until a dependency actually changes.
COPY server/package.json ./package.json

# --omit=dev because the server has no dev dependencies and should never grow one
# in the image. There is no lockfile on purpose: `ws` is pinned to an exact version
# and has zero runtime dependencies of its own, so the tree is fully determined by
# the manifest and a lockfile would only be a second thing to keep in step.
RUN npm install --omit=dev --no-audit --no-fund

# --- runtime ---------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app

# NODE_ENV=production is not a performance hint here, it is a SAFETY setting:
# guards.js refuses a missing Origin header and refuses localhost origins when it
# is set, and honours a wildcard in ALLOWED_ORIGINS only when it is not. A
# container that lost this variable would quietly accept connections from
# anywhere, so it lives in the image rather than in the deployment.
ENV NODE_ENV=production
ENV PORT=9000

# Stamped by CI with the commit sha and reported by /health. It is the only way to
# tell, from a browser, whether the container the Pi is running is the one you
# pushed — which is the first question to ask when a deploy looks like it did
# nothing.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION

COPY --from=deps /app/node_modules ./node_modules
COPY server/package.json ./package.json
COPY server/ ./server/
COPY js/ ./js/

# The node image already ships an unprivileged `node` user. Nothing here writes to
# disk — rooms live in memory and die with the process — so the whole tree can stay
# read-only to the process that serves it.
USER node

EXPOSE 9000

# No curl in the image and no reason to add one: Node 22 has global fetch. Asking
# the app over the loopback interface tests the thing that actually matters, which
# is that the HTTP server is answering, not merely that PID 1 exists.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form, so the process is PID 1 and receives SIGTERM directly — index.js
# handles it and closes sockets cleanly, which is what makes a redeploy look like a
# reconnect to every client instead of a hang.
CMD ["node", "server/index.js"]
