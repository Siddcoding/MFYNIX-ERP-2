# MFinTech Smart ERP — container image.
#
# This is the portable route: the same image runs on Railway, Fly.io, Koyeb,
# Google Cloud Run, AWS App Runner, Azure Container Apps, a DigitalOcean
# droplet, or a server in the client's own office. Nothing in it is specific to
# any one host.
#
# Build from the PROJECT ROOT (the folder holding backend/ and frontend/),
# because the server serves the frontend from a sibling directory:
#     docker build -t mfintech-erp .
#     docker run -p 3000:3000 -v mfintech-data:/data \
#       -e NODE_ENV=production -e JWT_SECRET="$(openssl rand -hex 32)" \
#       -e DB_PATH=/data/mfintech.db mfintech-erp

# Two stages: the first compiles better-sqlite3 (a native module needing python
# and a C++ toolchain), the second ships only the compiled result. It keeps the
# final image around a quarter of the size and, more usefully, keeps a compiler
# out of the running container.
FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/backend
COPY backend/package*.json ./
# npm ci when a lockfile is present (reproducible), npm install when it is not.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

# ---------------------------------------------------------------------------

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/mfintech.db

# dumb-init reaps zombies and passes signals through, so `docker stop` and a
# platform's rolling deploy actually shut the server down cleanly instead of
# killing it mid-write to the database.
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/backend/node_modules ./backend/node_modules
COPY backend ./backend
COPY frontend ./frontend

# The database lives on a volume, never inside the image layer - an image layer
# is replaced on every deploy, which would silently discard the company's data.
RUN mkdir -p /data && chown -R node:node /data /app

USER node
EXPOSE 3000

# Reports unhealthy if the process is up but cannot read its own database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "backend/server.js"]
