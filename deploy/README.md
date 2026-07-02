# Deploying the editor to d2mapeditor.online/map

The editor publishes as its **own** isolated Docker stack on the existing server, reached
through the **existing Cloudflare Tunnel** at `https://d2mapeditor.online/map`. It does not
touch the live `d2mapeditor` site.

## Architecture
- One container `d2editor` (Fastify) serves the built SPA + `/api` + atlases + socket.io.
- It joins the existing external Docker network **`d2map_net`** so the running `cloudflared`
  can reach it as `http://d2editor:3000`.
- The app runs under base path **`/map`** (`BASE_PATH=/map`): the tunnel forwards
  `d2mapeditor.online/map/*` unchanged, and the app strips the prefix itself (Fastify
  `rewriteUrl`); socket.io is pinned to `/map/socket.io`; the web build uses Vite `base=/map/`.
- Deploy: push to `main` → GitHub Actions tars the code over SSH to `~/d2editor` →
  `docker compose up -d --build` (separate compose project, isolated).

## One-time setup

### 1. GitHub secrets (already added)
`SERVER_HOST`, `SERVER_SSH_KEY`, `SERVER_USERNAME` — same as the existing repo.

### 2. Cloudflare Zero-Trust: route /map to our container
Networks → Tunnels → (your tunnel) → **Public Hostname** → add a rule **ABOVE** the catch-all:
- **Hostname:** `d2mapeditor.online`
- **Path:** `map` (i.e. matches `/map` and everything under it — try `map` first; if the
  dashboard requires a regex, use `^/map(/.*)?$`)
- **Service:** `http://d2editor:3000`

Rule **order matters**: this `/map` rule must come before the existing `/` → `d2map_app:3456`
rule, else `/` swallows it. Changes take effect in seconds and are trivially reversible.

### 2.5 Data disk (done 2026-07-02)
Volumes are bind-backed onto a dedicated disk: `/dev/sda` (ext4, label `d2data`, in fstab
with `nofail`) mounted at **`/mnt/data`**; our data lives in `/mnt/data/d2editor/{assets,uploads}`
(the voicer's in `/mnt/data/d2mapeditor/*`). The compose volume NAMES are unchanged, so the
asset-upload command and CI work as before. If the server is ever rebuilt: create + mount the
disk and `mkdir -p` those dirs BEFORE `docker compose up` (bind volumes fail on missing dirs).

### 3. Populate the atlas volume (253 MB, not in git)
The atlases are built offline from the GOG install and are gitignored, so they ship out of
band — **once** — from a machine that has `public/assets/` (the dev box). From the repo root:

```sh
# creates/fills the named volume the container mounts read-only at /app/public/assets
tar czf - -C public/assets . | ssh <USER>@<HOST> \
  'docker volume create d2editor_assets >/dev/null; \
   docker run --rm -i -v d2editor_assets:/dst alpine sh -c "cd /dst && tar xzf -"'
```

Re-run this whenever the asset pipeline regenerates the atlases. (The container reads them
read-only; a deploy never touches the volume.)

## Deploy
`git push origin main` → the **Deploy** workflow builds + restarts `d2editor`. First deploy:
push, wait for the build, confirm the Cloudflare rule, then open `https://d2mapeditor.online/map`.

## Prod toggles (baked via compose / Docker args)
- `BASE_PATH=/map`, `VITE_BASE=/map/` — the base path.
- `COPILOT_LLM=off`, `VITE_COPILOT_LLM=off` — LLM Copilot disabled (the offline MarkovJunior
  recipes/keywords still work).
- `SCENARIO_ROOTS=/app/deploy/scenarios` — the single bundled map (`История демона.sg`).
- Atlases via the `d2editor_assets` volume; uploads via `d2editor_uploads`.

## Local sanity check (no Docker)
```sh
pnpm run build:tsc
VITE_BASE=/map/ VITE_COPILOT_LLM=off pnpm --filter @d2/web run build
BASE_PATH=/map PORT=3010 WEB_DIST="$PWD/apps/web/dist" \
  SCENARIO_ROOTS="$PWD/deploy/scenarios" node apps/server/dist/index.js
# then: curl localhost:3010/map , /map/api/scenarios , /map/api/health
```
