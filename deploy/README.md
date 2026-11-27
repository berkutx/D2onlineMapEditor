# Deploying the editor to 151.115.56.12/map

The editor publishes as its **own** isolated Docker stack on the existing server and is
temporarily reached through the shared nginx at `http://151.115.56.12/map/`. It does not
publish a host port and does not modify the voicer container.

## Architecture
- One container `d2editor` (Fastify) serves the built SPA + `/api` + atlases + socket.io.
- It joins the existing external Docker network **`d2map_net`** so `lastwar_nginx`
  can reach it as `http://d2editor:3000`.
- The app runs under base path **`/map`** (`BASE_PATH=/map`): nginx forwards `/map/*`
  unchanged, and the app strips the prefix itself (Fastify
  `rewriteUrl`); socket.io is pinned to `/map/socket.io`; the web build uses Vite `base=/map/`.
- Deploy: push to `main` → GitHub Actions tars the code over SSH to `~/d2editor` →
  `docker compose up -d --build` (separate compose project, isolated).

## One-time setup

### 0. Voice integration secret and staged flag

Create one 32-byte random secret and add it as the GitHub Actions secret
`D2_INTEGRATION_SECRET` in **both** repositories. It is rendered into the two server-side
`.env` files and never sent to the browser. The stacks communicate as
`d2editor -> http://d2map_app:3456` over `d2map_net`.

Keep the Actions variable `VOICE_INTEGRATION_ENABLED=off` while deploying/migrating the
private voicer. For a pilot, set it to `on` and put the permitted browser `x-client-id` values
in `VOICE_INTEGRATION_CLIENTS` (comma-separated); set the matching voicer usernames in that
repository's `D2_INTEGRATION_USERS`. Empty allowlists enable every user. When the flag is off,
the new button is hidden and the existing `.sg` export remains the default.

### 0.5 Temporary map preview

The editor also accepts a played `.sg` from an external web service without creating an editable
user project. Authentication is deliberately disabled for the initial integration:

```http
POST /map/api/maps/preview
Content-Type: multipart/form-data
X-Preview-Client-IP: <optional original visitor IP>

file=<one .sg, up to 32 MiB>
```

Without `X-Preview-Client-IP`, the editor uses the request's network address. Until service
authentication is added, a caller can spoof the optional header, so its per-IP limit is
best-effort; never expose `D2_INTEGRATION_SECRET` to make up for that.

Success is `201` with `{ id, path, expiresAt, sha256, cacheHit: false }`; `expiresAt` is a Unix
timestamp in milliseconds and `path` is relative to the editor origin. The external service
should cache `path` and send every spectator to that existing capability URL. A repeated POST of
the same bytes during the active lifetime is a `200` cache hit with the same id/deadline and no
second file. GET views are unlimited; only creation of a new unique snapshot consumes the limit
of 5 per originating IP per hour (`429` carries `Retry-After`).

Storage and registry writes use temporary files plus atomic renames. If the volume is full the
request returns `507 preview_storage_full`, removes the incomplete snapshot, and refunds the IP
quota entry.

The deadline is fixed at creation (default one hour): views and cache hits never extend it. The
server removes the `.sg` and registry entry, and the returned capability link then shows an
expiry error instead of opening an editable default map. There is no client-side `preview` URL
flag: server metadata is authoritative and cannot be disabled by editing the URL. Project save,
raw download, clone, generation, voice handoff, `.sg`/ZIP export, and socket edits all return
`403`; the SPA hides the corresponding editor controls and displays the countdown. Viewers of
the same capability automatically share a presence-only room, so they can see each other's
cursors and selections without receiving edit permissions.

### 1. GitHub secrets (already added)
`SERVER_HOST`, `SERVER_SSH_KEY`, `SERVER_USERNAME` — same as the existing repo.

### 2. Shared nginx IP route (active)

`lastwar_nginx` publishes host ports 80/443 and is attached to both its own network and
`d2map_net`. Its server block routes `/map/` to `http://d2editor:3000`; `/map` redirects to
`/map/`. The deploy workflow verifies the network attachment, reloads nginx, and checks
`http://127.0.0.1/map/api/health` through that route after every restart.

The former Cloudflare hostname/tunnel is not part of this deployment while the domain is
unavailable. The browser entry point is currently `http://151.115.56.12/map/`.

### 2.5 Data disk (done 2026-07-02)
Volumes are bind-backed onto a dedicated disk: `/dev/sda` (ext4, label `d2data`, in fstab
with `nofail`) mounted at **`/mnt/data`**; our data lives in `/mnt/data/d2editor/{assets,uploads,projects,rooms}`
(the voicer's in `/mnt/data/d2mapeditor/*`). The compose volume NAMES are unchanged, so the
asset-upload command and CI work as before. `rooms` = the durable per-room collab op-log
(added 2026-07-10). Visitors' own campaigns (sagas made, copied or uploaded in the editor) are
small JSON files in `uploads/campaigns/`; their mission maps are ordinary uploads beside them. The deploy workflow now `mkdir -p`s these dirs before `up` (via a throwaway
alpine container, so it needs no host sudo). If the server is ever rebuilt: create + mount the
disk; the deploy step recreates the dirs (bind volumes fail on a missing dir → the container
won't start, so the dirs must exist before `docker compose up`).

### 3. Populate the asset volume — the MOD STORE (several mods, not in git)
The editor serves several mods (game data sets) side by side from one content-addressed store
inside the same `d2editor_assets` volume:

```
mods/index.json              the installed mods + the default one
mods/<mod-id>/mod.json       one mod: identity + logical file name -> blob
blobs/<xx>/<sha256>.<ext>    immutable files; a file two mods share is stored once
```

Build each mod on a machine that has its game install (see `tools/asset-pipeline/README.md`):

```sh
python tools/asset-pipeline/build_mod.py --game "<MOD>/Game" --mod-id semga --name "Сёмга" \
  --family semga --family-order 1 --store public/assets --graphics --default
```

then ship **only the store** into the volume — the mods and the blobs their manifests name,
packed by `store_upload.py` (from a POSIX shell; PowerShell cannot pipe binary data, so there
write `--tar store.tgz`, `scp` it and untar it from the copy):

```sh
py -3.7 tools/asset-pipeline/store_upload.py --store public/assets --tar - | ssh <USER>@<HOST> \
  'docker volume create d2editor_assets >/dev/null; \
   docker run --rm -i -v d2editor_assets:/dst alpine sh -c "cd /dst && tar xzf -"'
```

`store_upload.py` leaves out **derived mods** (`tools/asset-pipeline/derive_mod.py`, a parent
mod plus local edits) unless they are named (`--mods a,b --include-derived`), and the blobs no
uploaded mod names (old atlas pages, earlier builds); its `mods/index.json` lists exactly the
mods it packs. `--list` prints the member paths instead, e.g. to check the copy on the server
with `sha256sum`. Do not tar `public/assets/mods` whole: its `index.json` also lists the local
derived mods, and its `mod.json` files carry the closed mods' tables.

- **Closed mods' tables stay on this PC.** A mod's `mod.json` names its install's own tables
  (`tables/<Name>.dbf`) and `capital.dat`. For a mod listed in `closedMods` of
  `mods.local.json` (a closed beta, today `semga-2`), the archive carries a `mod.json` without
  those entries and none of the blobs only they name; stderr says how many were left out.
  `store_upload.py` reads the list from `mods.local.json` at the repo root (or
  `--local-config <file>`), so **`mods.local.json` on the uploading PC must list every closed
  mod**; without the file no mod is treated as closed (stderr says so). The server's
  `mod.json` of a closed mod therefore differs from the local one (fewer files, another `rev`).

- **Adding or rebuilding a mod is the same command again.** Blobs are immutable and named by
  their hash, so re-sending is idempotent and never disturbs files in use; `mod.json` and
  `index.json` are small and replaced last by tar. The server notices a changed
  `mods/index.json` / `mod.json` on the next request — no restart.
- **No `?v` bump, no cache purge.** A mod's files are requested as
  `/assets/mods/<id>/<rev>/<name>` (`rev` = hash of its `mod.json`) and sprite sheets as
  `/assets/blobs/<xx>/<sha>.png`; both are served `immutable`. A rebuilt mod has a new `rev`,
  so every client asks for new URLs by itself.
- **Which maps belong to which mod**: a map in a mod's own scenario folder is that mod's.
  Uploaded maps are matched to a mod by the ids they reference. Where the folders come from:
  - on the server, the `d2editor_scenarios` volume (`/mnt/data/d2editor/scenarios`, seen as
    `MOD_SCENARIO_DIR=/app/var/mod-scenarios`): one folder per mod id, laid out like the
    install — `semga-2/Campaign/<saga>/*.sg`, `nazar-legacy/Exports/*.sg`. Copy maps in from the
    dev box (section 3d); a folder for a mod that had none is seen after `docker restart d2editor`,
    new files in an existing folder on the next listing;
  - elsewhere, the `MOD_SCENARIO_ROOTS` env (`modId=path;modId=path;…`) or a `mods.local.json`
    at the repo root (`{ "scenarioRoots": { "<modId>": ["<dir>", …] } }`, see
    `mods.local.json.example`).
- **A volume without `mods/index.json` keeps working** exactly as before: its flat files are
  served as one implicit mod `default` (sections 3a–3c below describe that older layout).
  So the store can be uploaded before or after the code that reads it.
- Old blobs no mod refers to any more are never deleted by a build; clear them out by hand
  when space matters (a blob is in use iff some `mods/*/mod.json` lists it).

### 3a. The older flat layout (one mod, 253 MB of atlas pages)
Before the mod store, the volume held ONE mod's files flat. The atlases are built offline from
the GOG install and are gitignored, so they ship out of band from a machine that has
`public/assets/` (the dev box). From the repo root:

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

### 3d. The mods' own maps — `d2editor_scenarios`
The maps and sagas a mod ships with live on the host in `/mnt/data/d2editor/scenarios/<mod-id>/`,
laid out like the install; the container sees them read-only as `MOD_SCENARIO_DIR`. The deploy
workflow creates the folder. Copy files in from a machine that has the install — through the
host folder, not the named volume, so compose still creates the volume with its bind options:

```sh
# list.txt = the files to send, relative to the install root, one per line
tar cf - -C "<install root>" -T list.txt | gzip -1 | ssh <USER>@<HOST> \
  "docker run --rm -i -v /mnt/data/d2editor/scenarios:/dst alpine \
   sh -c 'mkdir -p /dst/<mod-id> && cd /dst/<mod-id> && gzip -d | tar xf -'"
```

What is there (2026-11-26):

| mod | files | taken from the install |
|---|---|---|
| `semga-2` | 52 maps, 19 sagas | `Campaign/<saga>/*.sg`, `Campaign/*.csg` — not the restart copies in `Campaign/На случай бага` and `Campaign/Восстание Эльфов (…)`, not `SaveGame` |
| `smns3` | none | — |
| `nazar-legacy` | 20 maps | `Exports/*.sg` |

- SMNS 3.0 is a PvP mod with no sagas of its own. The sagas in its install's `Campaign` folder
  are fan sagas made for the base game and other mods; they were put on the site by mistake and
  deleted the same day (2026-11-26). Its folder stays, empty, for the mod's own maps.
- The Сёмга family's maps are kept once, under its newest version `semga-2`.
- `semga-2` is a closed beta and hidden (`HIDDEN_MODS`, see the toggles below): its 52 maps and
  19 sagas stay in its folder but are not listed. «История демона» opens on `semga`.
- A listing groups a map by its folders below the mod folder, `Campaign` left out
  («Возвращение Галлеана / Империя»).
- New files in an existing mod folder show on the next listing; a new mod folder after
  `docker restart d2editor`.

## Deploy
`git push origin main` → the **Deploy** workflow builds + restarts `d2editor`. Then open
`http://151.115.56.12/map/` and verify `/map/api/health`.

## Prod toggles (baked via compose / Docker args)
- `BASE_PATH=/map`, `VITE_BASE=/map/` — the base path.
- `COPILOT_LLM=off`, `VITE_COPILOT_LLM=off` — LLM Copilot disabled (the offline MarkovJunior
  recipes/keywords still work).
- `SCENARIO_ROOTS=/app/deploy/scenarios` — the bundled map (`История демона.sg`); a first visit
  starts from a copy of it (`pickDefaultScenario` in `apps/web/src/stores/mapStore.ts`).
- `MOD_SCENARIO_DIR=/app/var/mod-scenarios` — the mods' own maps (`d2editor_scenarios` volume).
- `HIDDEN_MODS=semga-2` — mods visitors are not shown (a closed beta): left out of the mod list,
  the maps and sagas of their own folders not listed, no map opened on them (a map of theirs
  is matched among the other mods, the way a data-only mod is skipped). For the eye only:
  nothing is deleted, and a mod's files and a map's id still answer. To show the mod again,
  drop it from `docker-compose.yml` and deploy. One exception: a hidden mod's full tables
  (`tables/`, `capital.dat`) are not served at all without a share key (next toggle).
- `MOD_SHARE_KEYS` — share keys of the mod comparison's secret link,
  `http://151.115.56.12/map/?mods&a=<mod>&b=<hidden mod>#key=<key>`. A page opened with a key
  sends it with every request; the server then lists the hidden mods too and serves their full
  tables (privately cached); by logical name and by blob hash alike, nothing of them answers
  without a key. Each key at least 24 characters; several separated by `,`. The key lives
  in the server's `~/d2editor/.env` only, never in the repository: the Deploy workflow keeps
  the value it finds there (or takes the `MOD_SHARE_KEYS` GitHub secret when that is set).
  To add or change one: edit `MOD_SHARE_KEYS=` in `~/d2editor/.env`, then
  `cd ~/d2editor && docker compose up -d --no-build --force-recreate`. To revoke a link, drop
  its key the same way. A hidden mod's tables reach the volume only with
  `store_upload.py --with-closed-tables`; without that flag they stay on the dev box.
- Atlases via the `d2editor_assets` volume; uploads via `d2editor_uploads`.
- The shared `lastwar_nginx` must let uploads through: both `location /map/` blocks in
  `/opt/lastwar-deploy/nginx/nginx.conf` (the lastwar stack's file, not in this repo) carry
  `client_max_body_size 32m;` (the app's own cap, `UPLOAD_MAX_BYTES`). Without it nginx answers
  any body over 1 MB with its own 413 and «Загрузить .sg…» fails for most real maps.

## Local sanity check (no Docker)
```sh
pnpm run build:tsc
VITE_BASE=/map/ VITE_COPILOT_LLM=off pnpm --filter @d2/web run build
BASE_PATH=/map PORT=3010 WEB_DIST="$PWD/apps/web/dist" \
  SCENARIO_ROOTS="$PWD/deploy/scenarios" node apps/server/dist/index.js
# then: curl localhost:3010/map , /map/api/scenarios , /map/api/health
```
