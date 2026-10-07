# AGENTS.md

This package is the independent miniCMS filesystem API. It never builds,
serves, or imports the React editor.

This service and its current consumers are under coordinated pre-release
development. Prefer one clean breaking contract across miniCMS, this service,
and consumer repositories over compatibility routes, redirects, parsers, or
other shims. Remove the superseded behavior, tests, and documentation in the
same change unless backward compatibility is explicitly requested.

## Architecture

- `src/app.mjs` owns the existing config, complete-record YAML, collection,
  upload, rename, delete, and public-media HTTP behavior.
- `src/auth.mjs` owns wildcard production CORS, the one-request GitHub-token
  identity exchange, in-memory opaque bearer sessions, the optional fixed
  machine-read bearer, and authorization middleware. The central auth worker,
  not this service, owns GitHub OAuth.
- `src/config.mjs` is the fail-closed environment and command configuration
  boundary.
- `src/config-transaction.mjs` owns strong config revisions and copy-first,
  journaled local schema-key migrations, collection-folder moves, API media
  namespace moves, and complete-record rewrites. `src/project-gate.mjs` prevents
  config transactions from interleaving with authenticated collection reads,
  CRUD, and uploads. Gate ownership follows the async route operation, not the
  response socket lifetime; a disconnected request must retain its lock until
  its filesystem work ends.
- `src/image/` owns the public Sharp derivative service: `config.mjs` reads
  bounded operational settings, `url.mjs` adapts the shared canonical
  contract, `service.mjs` owns safe source resolution/processing/cache, and
  `routes.mjs` owns HTTP semantics. Never hand-build or reparse image URLs;
  import `@signalwerk/minicms/core/image-service`.
- `src/admin.mjs` hosts the service's own editor at `/admin/`: a static page
  that loads the published miniCMS bundle (`MINICMS_ADMIN_SCRIPT_URL`,
  default pinned to an immutable rawcdn.githack.com bundle) and bootstraps from
  `/admin/cms.config.yml`, the project's raw config. That bootstrap file is
  deliberately public, like every static consumer's `admin/cms.config.yml`, so
  the config must never contain secrets; sign-in uses the config's API
  connector and every content read or write stays behind `/api`.
- `src/upload.mjs` streams authenticated uploads to an exclusive temporary
  file and atomically publishes them without buffering originals in memory.
- `bin/minicms-api.mjs` starts either the loopback-only unauthenticated `dev`
  service or the always-authenticated production `start` service.
- `bin/migrate-record-identity.mjs` is the explicit offline, preflight-first
  one-time migration from readable record ids, `content_id`-style identity
  fields, stored `filename` keys, and site-level media folders to opaque record
  ids in `<slug>-<id>.yml` / `<id>.yml` files and per-field `media_folder`. Run it only while the service is stopped;
  `--write` requires a new backup directory outside the project. It validates
  every rewritten record against the next schema before writing and records
  the readable-id map in the backup. The superseded image-asset migration was
  removed after every volume adopted `{hash, filename}`.
- Record files are named `<slug>-<id>.yml` from the collection slug template,
  or `<id>.yml` without one (shared `recordFileStem`/`recordIdFromFileStem`).
  Records are located by listing file names and matching the trailing id; only
  the matching file is read. Files without a trailing id, files whose content
  id differs, and duplicate ids are rejected. Create derives the name itself;
  rename takes no body and re-renders only the slug part. Record mutations (create/save/rename/delete) take the exclusive
  project gate so a scan cannot race a concurrent move; uploads and reads stay
  shared. Uploads must name the field's `media_folder`; acceptance comes from
  the shared `uploadFieldAccept` helper.
- Content-model behavior must remain DRY. Import it only through
  `@signalwerk/minicms/core/content`, `/core/connectors`, `/core/media`,
  `/core/slug`, and `/core/image-service`. Service configuration is a source
  manifest and must use `validateSourceConfig`; it never materializes or
  proxies remote aliases. The shared validator owns ordered slot-default
  templates and slot minimum/maximum record invariants; keep the immutable core
  pin current so API config and record writes enforce the same schema as the
  browser editor.
- This standalone repository pins `@signalwerk/minicms` to an immutable public
  GitHub archive. Publish the required miniCMS commit before updating that pin,
  and regenerate `package-lock.json`; do not restore a sibling `file:`
  dependency that breaks independent builds.
- `Dockerfile` is the production image boundary. `docker-compose.yml` is
  Coolify-ready, exposes only container port 8787, and mounts the single
  durable project root from `/DATA/miniCMS/backend/data` to `/data`. The
  runtime is non-root (UID 1000) with a read-only container filesystem; only
  `/data` and the bounded `/tmp` tmpfs are writable. The project root and
  `content/` themselves must be writable by UID 1000 (config saves and folder
  moves create files there); `/api/ready` fails otherwise.
- Editor-only `image_rendering.flatten` on image fields and list/inspector
  field references is validated by the pinned shared core. The browser requests
  the existing flatten operation before its normal resize/quality operations;
  no new API route or server-side default is needed. Preserve other libraries'
  rendering settings when configuring OSPAAAL's white background.
- `src/admin.mjs` pins the default browser bundle to an immutable published
  URL. Bump this URL together with the immutable shared-core package dependency
  after the miniCMS publication workflow succeeds. Non-empty
  `MINICMS_ADMIN_SCRIPT_URL` overrides it; an empty Coolify setting uses the
  pinned fallback (Coolify may replace Compose's environment defaults).

## Security invariants

- `dev` must refuse non-loopback hosts. `start` must never provide an
  unauthenticated fallback and must validate every required setting before
  listening.
- Only GitHub user ID `992878` with the case-insensitive login `signalwerk` may
  authenticate. Pin both in code; never trust an allowed identity or provider
  from environment variables, browser input, or consumer YAML.
- This service has no GitHub OAuth app, client credentials, callback, PKCE,
  state, or browser-origin exchange. The trusted browser obtains a GitHub token
  from the central auth worker and submits it once as the sole JSON value to
  `POST /api/auth/github`.
- Use the submitted GitHub token only for the immediate server-side `/user`
  lookup. Never log, persist, return, cache, or reuse it. Verify both the pinned
  numeric ID and login before issuing an opaque service bearer.
- Bearers expire after eight hours and logout revokes them. Store only keyed
  hashes of session and machine-read bearers; never persist sessions.
- `MINICMS_READ_TOKEN` is an optional production-only machine credential with
  at least 32 non-whitespace characters. Compare only keyed fixed-length
  digests. It authorizes exactly GET/HEAD config, collection-list, and record
  routes; it never authorizes config writes, record mutations, renames, or
  uploads and never changes the GitHub identity gate for browser sessions.
- All non-auth `/api/*` routes authenticate before large parsers. Keep the
  API-owned raw `/media/<collection>/<sha256>/<filename>`, GitHub-development
  raw `/media/<sha256>/<filename>`, and canonical derivative
  `/<schema>/media/<collection>/<sha256>/<canonical-operations>/<output-name>.<format>`
  route explicitly public because they contain public website assets and
  `<img>` requests cannot attach bearer headers.
- API-owned public media uses exactly
  `<collection>/<lowercase-sha256>/asset.dat` below the configured media folder;
  the requested raw filename is cosmetic. GitHub-owned development uses
  `<lowercase-sha256>/<original-filename>` so the checkout stays committable.
  Its public raw/derivative basename is still cosmetic and resolves a regular
  file by verified hash; internal deletion resolves the exact stored filename.
  Resolve real paths and reject every symlink/non-regular file. Only
  canonical segments returned by the shared route parser may enter mirrored
  cache paths; never use an unparsed request value. Encoded identifiers and
  flat raw paths are rejected. Missing content/media roots are ordinary public
  404 responses rather than internal errors. Verify source bytes against the
  route SHA-256 before raw, metadata, SVG, cache-hit, or generated delivery;
  memoization must be bounded and invalidated by the file-stat signature. Raw
  responses stream the already-open verified file descriptor so a later path
  replacement cannot select unverified bytes, and every conditional, range,
  HEAD, success, and failure exit closes it. SVG is exact passthrough and must
  never reach Sharp. Tests that inspect that descriptor after consuming a tiny
  loopback response must first await its `close` event; client body completion
  can precede route-pipeline cleanup by one event-loop turn.
- Source hashing and Sharp processing share a bounded service queue. Sharp
  always uses finite input/output/channel/timeout bounds. Project dimensions
  are URL-builder defaults; only deployment
  `MINICMS_IMAGE_MAX_*` settings are server-enforced, so existing URLs survive
  later project-default changes. Raster input must match an allowlisted file
  signature before Sharp, which then confirms the detected format. SVG is
  identified separately and never enters Sharp.
- Crop URLs use original-image `{left, top, width, height, rotation}` geometry
  as the first operation and cannot also use whole-image `rotate`. Coordinates
  may be decimal or negative; dimensions are decimal values of at least one
  source pixel. The service validates all four source-space corners, rounds the
  result dimensions deterministically, pre-extracts the bounding patch, and
  counter-rotates only that patch. A following `inside` resize is fused before
  rotation so huge source crops still produce bounded derivatives.
- Generated raster cache paths exclude the cosmetic output basename below the
  exact service-owned `MINICMS_IMAGE_CACHE_DIR` root:
  `<schema>/media/<collection>/<sha256>/<canonical-operations>/asset.<format>`.
  Cache directories must remain regular contained directories. The service
  uses a SHA-256 digest of that route only for ETags and in-process miss
  deduplication; publication is atomic, hits are streamed, and cache I/O is
  best-effort. There is no maintenance, expiry, capacity accounting, or
  eviction. In GitHub storage mode the derivative collection segment must name
  a concrete local collection before the global hash source is considered, so
  arbitrary collection aliases cannot multiply identical caches. Metadata JSON
  and byte-preserving SVG responses are not copied to the raster cache.
- JPEG derivatives accept both `jpg` and `jpeg` as canonical output formats;
  both use `image/jpeg` bytes and MIME type while retaining their requested
  extension in the URL and fixed `asset.jpg` or `asset.jpeg` cache filename.
- Raw reusable media files always revalidate and support byte ranges;
  non-image files are attachments on the API origin. Only schema-based
  derivatives below
  `/<schema>/media/<collection>/<sha256>/<canonical-operations>/<output-name>.<format>`
  use the service's fixed one-year immutable policy. The requested schema must
  equal the configured schema; mismatches return 404. There is no legacy
  `/media/_image/*` route or schema redirect. Curated `.json` metadata uses
  only `noop`, is intentionally public
  with `Access-Control-Allow-Origin: *`, and must never include paths, EXIF/GPS,
  ICC buffers, or internal errors.
- Mount the exact public GET/HEAD media router before `/api` authentication so
  every valid configured schema remains usable, including `api`; mutation
  routes under `/api` remain authenticated by HTTP method and route shape.
- Production project roots must use durable writable storage. The service does
  not synchronize filesystem edits back to GitHub.
- `GET /api/config` exposes a strong ETag over the exact source bytes;
  `PUT /api/config` accepts exactly `{config, schema_renames}`, where
  `schema_renames` contains exact `node_types` and `collections` old-to-new
  mappings, and requires that ETag in `If-Match`. Missing and stale
  preconditions return 428 and 412. CORS must
  allow `If-Match` and expose `ETag`. The returned config and ETag must come
  from one exact source snapshot so an external replacement cannot pair a
  stale body with a newer revision.
- A same-key local collection `folder` change is one config transaction.
  Collection folders must be distinct, non-nested strict descendants of
  `content/`, must not overlap a local field's `media_folder`, and may not traverse
  symlink/non-directory components. Validate every next folder on config save
  and every configured folder again before runtime CRUD, including collections
  that did not move. The destination must be absent. Remote aliases never
  participate, swaps/chains are rejected, and a missing source represents an
  empty collection without creating a placeholder directory.
- Schema key renames are explicit, one-to-one, and cannot collide, chain, swap,
  or change ownership. Alias renames preserve connector/remote identity and
  rewrite local canonical references without moving connector-owned storage.
  Concrete collection renames migrate their configured content folder and API
  media namespace. GitHub-development media remains in its global hash layout.
  Configuration saves may not switch API/GitHub media storage mode; that needs
  a separate offline migration. They likewise cannot remove a media folder
  still used by a continuing collection. Every surviving local record is validated against its
  current schema and filename, recursively migrated through the shared core,
  and validated against the next schema before the first filesystem write.
  A continuing collection may change between `yml` and `yaml`; the transaction
  renames every top-level record to the next extension and rejects any existing
  file or directory at a planned destination instead of adopting hidden data.
  Structured image identities remain unchanged; exact canonical API file URLs
  receive the renamed collection segment. Configured URL widgets likewise
  rewrite an exact standalone `minicms://link/<collection>/<value>` when that
  collection is renamed, while ordinary string fields remain byte-for-byte
  unchanged; configured Markdown destinations continue to rewrite both
  `minicms://reference/` and `minicms://link/` collection names.
- Folder and schema moves copy regular directories and files into the exact
  service-owned `.minicms-config-transactions` namespace, publish complete
  copies or swap staged rewrites against journaled backups, atomically replace
  config as the commit point, and only then remove exact old sources. New
  concrete collections may not adopt any existing physical folder or media
  namespace. Never prune parent directories. The journal recovers old-config
  state by removing copies/restoring backups and new-config state by removing
  old sources/backups; an unknown config hash fails readiness closed. Derived
  cache cleanup for renamed concrete collections runs safely and best-effort
  only after commit. This is
  process-crash recovery; the service does not claim fsync-backed host
  power-loss durability.
- Each service owns exactly one project root and never proxies connector
  traffic. Collections containing both `connector` and `remote_collection`
  are imported client-side aliases: omit them from the local collection index,
  reject their CRUD/upload routes, and skip them during local folder checks.
- The service is single-replica per writable project root: bearer sessions,
  write coordination, and image work are process-local. A CDN or reverse proxy
  owns public-route request rate limiting, including `POST /api/auth/github`.
  The service is also the exclusive runtime writer of `cms.config.yml` and
  collection folders. Deployment may prepare or synchronize the durable root
  only while the service is stopped; concurrent host-side writes bypass its
  process-local gate and optimistic transaction boundary.
- `MINICMS_MEDIA_MAX_UPLOAD_BYTES` bounds all authenticated media uploads;
  image-specific environment settings bound only Sharp and derivative-cache
  work.
- Upload routes validate a configured collection before reading the body and
  use only upload fields reachable from that collection and its nested slot
  types for the required exact `widget=image|file` query. Image bytes must match
  the filename format before publication; a sibling `file: "*/*"` field must
  never widen image acceptance. Compute
  SHA-256 while streaming and never accept a client hash. API-owned storage
  publishes exactly one verified `<collection>/<sha256>/asset.dat` and silently
  reuses it for duplicate bytes. GitHub-owned development storage publishes
  `<sha256>/<original-filename>` and requires an explicit reuse/copy choice for
  a duplicate hash; non-NFC existing names fail closed instead of returning a
  storage identity that does not exist on GitHub, and copies suffix safely
  inside the 255-byte limit. First-upload directory creation must tolerate
  concurrent requests racing on the same absent path.
  `delete_files_with_record` scans every other local record and removes a
  physical asset only after its last reference. On first upload, remove only
  strictly named stale upload temporaries left by an interrupted prior process.
- Production API CORS deliberately uses `Access-Control-Allow-Origin: *` and
  never credential cookies. It permits `If-Match` and exposes `ETag`. Every
  mutation and ordinary browser content read requires an opaque bearer issued
  only after `signalwerk` authenticates; the separately configured machine
  token grants only the narrow read routes above.
  The public `POST /api/auth/github` route accepts a central-worker GitHub token
  only long enough to verify `/user`; the worker owns its client-origin
  allowlist. Authentication responses retain no-store, nosniff, CSP, and
  no-referrer protections.
- Unauthenticated development accepts browser API requests only from loopback
  origins; origin-less CLI requests remain valid.

## Commands

For this checkout, `docker-compose.dev.yml` overrides `/data` with ignored
`./DATA` and publishes `127.0.0.1:8787`. Use both Compose files and supply
`MINICMS_SESSION_SECRET` as for production. The ignored executable
`sync-data.sh` pulls `root@91.107.230.36:/DATA/miniCMS/backend/data/` into
`./DATA/` via SSH port 22 and `~/.ssh/id_ed25519`; `--dry-run` previews it.
It never writes remotely or deletes local-only files. Stop the local service
before pulling; rsync replaces matching local files and is not an atomic
snapshot of a production service that is actively receiving writes.

Requires Node.js 24 or newer.

```sh
npm install
npm run dev -- --project-root /path/to/project
npm start -- --project-root /path/to/project
npm run migrate:identity -- --project-root /path/to/project --check
npm test
docker compose config
docker compose build
```

Add filesystem behavior coverage to `test/api.test.mjs`, image security/cache
coverage to `test/image.test.mjs`, and authentication or deployment-boundary
coverage to `test/auth.test.mjs`. Preserve complete-record atomic persistence
and rollback-safe file deletion.

## Legacy alpha-mask rendering

- Explicit `flatten@alpha:remove` uses a separate, bounded lossless TIFF
  normalization before subsequent background compositing. Sharp runs flatten
  before alpha removal inside a single pipeline; chaining both does not discard
  the mask first. This reproduces `data.media`'s legacy TIFF roundtrip, including
  its default sRGB conversion. Background-only and unconfigured rendering retain
  their previous behavior. Input/channel/timeout limits remain enabled; the
  intermediate stream has a finite byte bound derived from the input pixel limit.
- Tony Evora Congo original `c8ada4c4698f60504c18b291e07034b2b18b3986391c0a5224626553a1be2c88`
  is a 1741 × 2724 single-page CMYK TIFF with a fifth alpha-mask channel.
  `test/image.test.mjs` uses a synthetic masked CMYK TIFF and RGB transparency
  fixture to verify hidden colors survive explicit alpha removal. Bump the
  project's `site.image_processing.cache.schema` when deploying this changed
  rendering, since old derivatives and browser responses are immutable.
- Local verification on 2026-10-07: all 91 server tests pass, including the
  actual 64-channel input ceiling and rejection at 65. The development Docker
  service was rebuilt and its config cache schema changed from `v1` to `v2`
  through the authenticated API. Fresh and cached Congo JPEG bytes exactly
  matched the reproduced legacy transform; 826 content file hashes/signatures
  were unchanged. Before-config backup:
  `/private/tmp/minicms-local-config-before-alpha-fix.json`. Deploy this
  correction with production cache schema `v2` to regenerate immutable images.

- TIFF previews now omit Adobe Photoshop layer-data tag 37724 from a private
  temporary copy before metadata/decode. Embedded layer blobs can exhaust
  libtiff's cumulative 50 MB allocation budget (Angola asset `24b4e4c04aecb2c920c162c37d5fc3128740c68621c6d55f13b83b2aceddf0e5`
  has a 30,712,644-byte blob). Preserve every pixel/ICC/orientation/alpha tag
  and source byte; retain `unlimited: false`. `src/image/tiff-preview.mjs`
  supports bounded classic TIFF/BigTIFF directories in both byte orders and
  cleans temporary copies on success/failure. Keep cache schema `v2`: previous
  failed renders never published a derivative, and successful pixels are unchanged.
