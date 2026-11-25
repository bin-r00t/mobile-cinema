# The player: the built frontend, served by nginx.
#
# nginx serves the files of the app and hands the API over to the server,
# so the browser only ever talks to one address.
FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json

RUN npm ci

COPY apps/web ./apps/web
# The typescript of the web app extends the one of the workspace.
COPY tsconfig.base.json ./

RUN npm run build --workspace @mobile-cinema/web


FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1
