# The API of the library: the catalog, the scan and the streams.
#
# The image carries ffmpeg and ffprobe, because the scan asks ffprobe what
# a movie is and the HLS pipeline hands it to ffmpeg. The Node version is
# the one that runs the TypeScript of the server directly, without a build
# step: the sources are shipped as they are.
FROM node:24-bookworm-slim AS deps

WORKDIR /app

# better-sqlite3 falls back to a compiler when no prebuilt binary fits, so
# the toolchain is here for the install and nowhere else.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# The lockfile of the whole workspace, so the install is the same one every
# time.
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN npm ci --omit=dev


FROM node:24-bookworm-slim AS runtime

# ffmpeg and ffprobe: the scan and the transcode need them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3002 \
    MOVIE_ROOT=/movies \
    DB_PATH=/data/catalog.sqlite \
    CACHE_DIR=/data/cache \
    FFPROBE_PATH=/usr/bin/ffprobe \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    LOG_LEVEL=info

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY package.json ./
COPY tsconfig.base.json ./
COPY apps/server ./apps/server

# The catalog and the converted files live on a volume; the movies are
# mounted read only.
VOLUME ["/data"]
EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3002)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
