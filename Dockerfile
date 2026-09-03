# syntax=docker/dockerfile:1

# ---------- build stage ----------
# Node 22 (the spec's target). better-sqlite3 is a native module, so the build
# happens inside the image on musl — a node_modules built on the host will not
# load here. .dockerignore keeps host node_modules/dist out.
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
# sink is a dev-only tool (not built or shipped) but npm ci needs its manifest.
COPY packages/sink/package.json packages/sink/
RUN npm ci

COPY packages/core ./packages/core
COPY packages/server ./packages/server
COPY packages/web ./packages/web
RUN npm run build

# Prune dev dependencies for the runtime copy.
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV EWC_DATA_DIR=/data
ENV EWC_WEB_DIR=/app/packages/web/dist
ENV EWC_PORT=8080
WORKDIR /app

# ffmpeg + ffprobe: transcode uploaded Studio video media layers to a small
# no-audio mp4 and decode its frames for the DDP wire (milestone 8b).
RUN apk add --no-cache ffmpeg

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/web/dist ./packages/web/dist

VOLUME /data
EXPOSE 8080/tcp
# DDP realtime egress is UDP/4048 outbound to devices — no inbound port needed.

# 127.0.0.1, not localhost — Alpine resolves localhost to ::1 first and the
# server binds IPv4 only, which fails the check even when the app is healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
