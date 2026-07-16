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
with `nofail`) mounted at **`/mnt/data`**; our data lives in `/mnt/data/d2editor/{assets,uploads,projects,rooms}`
(the voicer's in `/mnt/data/d2mapeditor/*`). The compose volume NAMES are unchanged, so the
asset-upload command and CI work as before. `rooms` = the durable per-room collab op-log
(added 2026-07-10). The deploy workflow now `mkdir -p`s these dirs before `up` (via a throwaway
alpine container, so it needs no host sudo). If the server is ever rebuilt: create + mount the
disk; the deploy step recreates the dirs (bind volumes fail on a missing dir → the container
won't start, so the dirs must exist before `docker compose up`).

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

### 3b. Update a CATALOG (unit / item / spell / decor / lord / modifier)
The `*Catalog.json` files under `public/assets/` are **also gitignored + volume-only** — they're
built offline by `tools/asset-pipeline/build_*_catalog.py` from the **target mod's** game `.dbf`
tables, so they are NOT in the image and a code deploy never updates them. To update one:

```sh
# 1) rebuild locally from the target mod's Game dir (example: unit catalog)
python tools/asset-pipeline/build_unit_catalog.py --game "<TARGET_MOD>/Game" --out public/assets
# 2) push JUST that file into the volume (single-file tar → leaves atlases untouched)
scp public/assets/unitCatalog.json <USER>@<HOST>:/tmp/unitCatalog.json
ssh <USER>@<HOST> 'docker run --rm -v d2editor_assets:/dst -v /tmp:/src:ro alpine \
  cp /src/unitCatalog.json /dst/unitCatalog.json; rm -f /tmp/unitCatalog.json'
# 3) BUMP the ?v in that catalog's store fetch (e.g. unitStore.ts `?v=2`) and `git push origin main`
```

**Why the `?v` bump is mandatory:** Cloudflare caches these JSONs `max-age=86400` (24h) + 7-day SWR,
and `assetUrl()` requests them with no version — so after a volume update the edge keeps serving the
STALE copy for up to a day. Bumping `?v=N` in the store's fetch makes clients request a new URL (cache
MISS → origin) on the next code deploy. There is no Cloudflare API purge token wired up; the `?v` bump
is the cache-bust. (`modifierStore` and `unitStore` already carry a `?v`.)

**`unitCatalog.json` specifically** must carry the `large` flag (Gunits `SIZE_SMALL` false = a 2-cell
big unit) — it is a **HARD REQUIREMENT**. It drives the big-unit merged formation slot + placing a
fresh big unit across both cells. `unitStore.load()` **FAILS LOUD** (throws → sets the store `error`
+ `console.error`) if the fetched catalog carries **zero** `large` entries: a sized catalog missing
from the volume is not normal operation, so there is **no silent fallback**. Deploy the sized catalog
(steps above) before or with the code — never ship the code against a size-less catalog.

### 3c. Populate `modscripts/` — Lua modifier sources (NEW volume-only asset)
The modifier dialog's **📜 button** shows a scripted modifier's Lua source (Prism-highlighted, lazy-
fetched one file at a time). Those sources are the target mod's `Game/Scripts/modifiers` tree, copied
verbatim into `public/assets/modscripts/` (~1153 `.lua`, ~1.7 MB). Like the atlases/catalogs they are
**gitignored + volume-only** (not in the image); the catalog's `script` field is the path under this
dir (e.g. `spells/buff_initiative_+10.lua`). A code deploy never touches them. To (re)deploy:

```sh
# from the repo root — directory-tar so ONLY modscripts/ lands, atlases/catalogs untouched
tar czf - -C public/assets modscripts | ssh <USER>@<HOST> \
  'docker run --rm -i -v d2editor_assets:/dst alpine sh -c "cd /dst && tar xzf -"'
# (PowerShell can't binary-pipe: `tar czf %TEMP%\ms.tgz -C public/assets modscripts`,
#  `scp` it to /tmp, then `ssh ... docker run -v /tmp:/src:ro alpine ... tar xzf /src/ms.tgz`.)
```

**No `?v` bump needed** (unlike catalogs): these files are immutable once shipped — the fetch uses the
bare `assetUrl("modscripts/<script>")`, so Cloudflare caches each 200 for a day with nothing to stale.
The only edge caveat is a **404 negative-cache**: if you probe a URL *before* populating the volume, that
PoP holds the 404 until its TTL expires. Populate the volume **before** shipping the feature so the first
real request for any file is a 200 — real users never see the 404. Rebuild source of the dir: the target
mod's `Game/Scripts/modifiers` (see `build_modifier_catalog.py`, which stores the `.lua` *path*, not code).

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
