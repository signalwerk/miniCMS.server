# AGENTS.md

This package is the independent miniCMS filesystem API. It never builds,
serves, or imports the React editor.

## Architecture

- `src/app.mjs` owns the existing config, complete-record YAML, collection,
  upload, rename, delete, and public-media HTTP behavior.
- `src/auth.mjs` owns wildcard production CORS, GitHub OAuth with PKCE,
  one-time origin-bound code exchange, in-memory bearer sessions, and
  authorization middleware.
- `src/config.mjs` is the fail-closed environment and command configuration
  boundary.
- `src/image/` owns the public Sharp derivative service: `config.mjs` reads
  bounded operational settings, `url.mjs` adapts the shared canonical
  contract, `service.mjs` owns safe source resolution/processing/cache, and
  `routes.mjs` owns HTTP semantics. Never hand-build or reparse image URLs;
  import `@signalwerk/minicms/core/image-service`.
- `src/upload.mjs` streams authenticated uploads to an exclusive temporary
  file and atomically publishes them without buffering originals in memory.
- `bin/minicms-api.mjs` starts either the loopback-only unauthenticated `dev`
  service or the always-authenticated production `start` service.
- Content-model behavior must remain DRY. Import it only through
  `@signalwerk/minicms/core/content`, `/core/media`, `/core/slug`, and
  `/core/image-service`.
- This standalone repository pins `@signalwerk/minicms` to an immutable public
  GitHub archive. Publish the required miniCMS commit before updating that pin,
  and regenerate `package-lock.json`; do not restore a sibling `file:`
  dependency that breaks independent builds.
- `Dockerfile` is the production image boundary. `docker-compose.yml` is
  Coolify-ready, exposes only container port 8787, and mounts the single
  durable project root from `/DATA/miniCMS/backend/data` to `/data`. The
  runtime is non-root with a read-only container filesystem; only `/data` and
  the bounded `/tmp` tmpfs are writable.

## Security invariants

- `dev` must refuse non-loopback hosts. `start` must never provide an
  unauthenticated fallback and must validate every required setting before
  listening.
- Only the hard-coded GitHub login `signalwerk` may authenticate. Never trust
  an allowed login, provider, or OAuth endpoint from environment variables or
  consumer YAML.
- GitHub tokens and the GitHub client secret never cross to the browser, logs,
  callback HTML, exchange responses, or persisted files.
- OAuth state is unpredictable and single-use. Exchange codes are bound to the
  validated admin origin and client nonce, expire after 60 seconds, and are
  single-use. Bearers expire after eight hours and logout revokes them.
- Store only keyed hashes of state, exchange codes, and bearer tokens.
- All non-auth `/api/*` routes authenticate before large parsers. Keep
  the exact content-addressed raw and derivative `/media` routes explicitly
  public because they contain public website assets and `<img>` requests cannot
  attach bearer headers.
- Public content-addressed media paths use exactly
  `<collection>/<lowercase-sha256>/<filename>` below the configured media
  folder. Resolve real paths, reject every symlink/non-regular file, and never
  use request values in cache paths. Encoded identifiers and flat raw paths are
  rejected. SVG is exact passthrough and must never reach Sharp.
- Sharp always uses finite input/output/channel/timeout bounds and a bounded
  service queue. Project dimensions are URL-builder defaults; only deployment
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
- The disk cache uses SHA-256 keys, in-process miss deduplication, atomic
  publication, streamed hits, best-effort I/O, and finite byte/entry eviction
  limits. `MINICMS_IMAGE_CACHE_DIR` is a parent; only the fixed project-keyed
  child is service-owned and eligible for cleanup. Revalidate that ownership
  on every cache access. Cache schema and shard directories must also be
  regular, contained directories before use, and one non-creating maintenance
  pass must be scheduled when the process starts.
- Raw reusable `/media/:collection/:sha256/:filename` files always revalidate
  and support byte ranges;
  non-image files are attachments on the API/auth origin. Only schema-based
  derivatives below `/media/_image/*` may use the project's immutable
  strategy. New URLs use the configured schema; older valid schemas redirect
  to it during independent rollouts. Curated `.json` metadata uses
  only `noop`, is intentionally public
  with `Access-Control-Allow-Origin: *`, and must never include paths, EXIF/GPS,
  ICC buffers, or internal errors.
- Production project roots must use durable writable storage. The service does
  not synchronize filesystem edits back to GitHub.
- The service is single-replica per writable project root: OAuth state,
  sessions, write coordination, and image work are process-local. A CDN or
  reverse proxy owns public-route request rate limiting.
- `MINICMS_MEDIA_MAX_UPLOAD_BYTES` bounds all authenticated media uploads;
  image-specific environment settings bound only Sharp and derivative-cache
  work.
- Upload routes validate a configured collection before reading the body and
  use only upload fields reachable from that collection and its nested slot
  types; image bytes must match the filename format before publication. Compute
  SHA-256 while streaming and publish below
  `<collection>/<sha256>/<collision-safe-filename>`; never accept a client hash
  or overwrite a concurrent upload. Collision suffixes remain inside the
  255-byte component limit and preserve per-record file ownership for
  `delete_files_with_record`. On first upload, remove only strictly named stale
  upload temporaries left by an interrupted prior single-replica process.
- Production API CORS deliberately uses `Access-Control-Allow-Origin: *` and
  never credential cookies; every content operation still requires an opaque
  bearer issued only after `signalwerk` authenticates. OAuth start accepts any
  canonical HTTP(S) browser origin, while callback delivery and one-time code
  exchange remain bound to that exact origin and client nonce. Authentication
  responses retain no-store, nosniff, CSP, and no-referrer protections.
- Unauthenticated development accepts browser API requests only from loopback
  origins; origin-less CLI requests remain valid.

## Commands

Requires Node.js 24 or newer.

```sh
npm install
npm run dev -- --project-root /path/to/project
npm start -- --project-root /path/to/project
npm test
docker compose config
docker compose build
```

Add filesystem behavior coverage to `test/api.test.mjs`, image security/cache
coverage to `test/image.test.mjs`, and authentication or deployment-boundary
coverage to `test/auth.test.mjs`. Preserve complete-record atomic persistence
and rollback-safe file deletion.
