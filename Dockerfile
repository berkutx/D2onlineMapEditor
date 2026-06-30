# d2-web-editor production image. Single Fastify process serves the built Vue SPA + REST API
# + atlases + socket.io. Behind the existing Cloudflare Tunnel it is reached at
# d2mapeditor.online/map (dashboard path-ingress -> http://d2editor:3000); the app strips the
# /map base itself (BASE_PATH). The 253 MB atlas set is NOT baked — it is mounted from a
# volume at /app/public/assets (see docker-compose.yml). Scenarios are baked (deploy/scenarios).
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable

# the web bundle is built for the /map base + with the LLM Copilot disabled
ARG VITE_BASE=/map/
ARG VITE_COPILOT_LLM=off

# whole workspace (the .dockerignore keeps node_modules / dist / public/assets / var out)
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm -r run gen \
 && pnpm run build:tsc \
 && pnpm --filter @d2/server run build \
 && VITE_BASE="$VITE_BASE" VITE_COPILOT_LLM="$VITE_COPILOT_LLM" pnpm --filter @d2/web run build \
 && pnpm prune --prod \
 && pnpm store prune || true

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    BASE_PATH=/map \
    COPILOT_LLM=off \
    WEB_DIST=/app/apps/web/dist \
    ASSETS_DIR=/app/public/assets \
    SCENARIO_ROOTS=/app/deploy/scenarios \
    UPLOAD_DIR=/app/var/uploads \
    LLM_DIR=/app/var/llm

# bring over the built workspace (server+packages dist, web/dist, pruned node_modules, scenarios)
COPY --from=build /app /app

EXPOSE 3000
CMD ["pnpm", "--filter", "@d2/server", "run", "start"]
