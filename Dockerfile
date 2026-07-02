# d2-web-editor production image. Single Fastify process serves the built Vue SPA + REST API
# + atlases + socket.io. Behind the existing Cloudflare Tunnel it is reached at
# d2mapeditor.online/map (dashboard path-ingress -> http://d2editor:3000); the app strips the
# /map base itself (BASE_PATH). The 253 MB atlas set is NOT baked — it is mounted from a
# volume at /app/public/assets (see docker-compose.yml). Scenarios are baked (deploy/scenarios).
#
# Single stage (build + run in one image) for reliability — a beta-acceptable size trade for not
# depending on a multi-stage COPY of the pnpm-symlinked workspace. Optimize to multi-stage later.
FROM node:22-alpine
WORKDIR /app
RUN corepack enable

# the web bundle is built for the /map base + with the LLM Copilot disabled
ARG VITE_BASE=/map/
ARG VITE_COPILOT_LLM=off

# NOTE: do NOT set NODE_ENV=production before `pnpm install` — pnpm then SKIPS devDependencies
# (typescript, vite, vue-tsc), so the build can't run (`tsc: not found`). It is set after the
# build (and also via compose) for the runtime.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    BASE_PATH=/map \
    COPILOT_LLM=off \
    WEB_DIST=/app/apps/web/dist \
    ASSETS_DIR=/app/public/assets \
    SCENARIO_ROOTS=/app/deploy/scenarios \
    UPLOAD_DIR=/app/var/uploads \
    PROJECTS_DIR=/app/var/projects \
    LLM_DIR=/app/var/llm

# whole workspace (the .dockerignore keeps node_modules / dist / public/assets / var out)
COPY . .
# Build packages (tsc -b), then the server (tsc -p -> apps/server/dist), then the web (vite ->
# apps/web/dist). No `pnpm -r run gen` (JSON schemas for the Python pipeline; not needed at
# runtime, and it must run after build:tsc). The `test -f` lines fail the image LOUDLY if either
# build artifact is missing, instead of shipping a container that crash-loops on a missing dist.
RUN pnpm install --frozen-lockfile \
 && pnpm run build:tsc \
 && pnpm --filter @d2/mapgen run build \
 && pnpm --filter @d2/server run build \
 && VITE_BASE="$VITE_BASE" VITE_COPILOT_LLM="$VITE_COPILOT_LLM" pnpm --filter @d2/web run build \
 && test -f packages/mapgen/dist/index.js \
 && test -f apps/server/dist/index.js \
 && test -f apps/web/dist/index.html

ENV NODE_ENV=production
EXPOSE 3000
# run node directly; node resolves @d2/* via the workspace node_modules symlinks. WORKDIR /app
# so config.REPO_ROOT (resolve(__dirname,'..','..','..')) is /app.
CMD ["node", "apps/server/dist/index.js"]
