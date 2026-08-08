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
  journaled local collection-folder moves. `src/project-gate.mjs` prevents
  config transactions from interleaving with authenticated collection reads,
  CRUD, and uploads. Gate ownership follows the async route operation, not the
  response socket lifetime; a disconnected request must retain its lock until
  its filesystem work ends.
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
  `@signalwerk/minicms/core/content`, `/core/connectors`, `/core/media`,
  `/core/slug`, and `/core/image-service`. Service configuration is a source
  manifest and must use `validateSourceConfig`; it never materializes or
  proxies remote aliases.
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
- All non-auth `/api/*` routes authenticate before large parsers. Keep the raw
  `/media/<collection>/<sha256>/<filename>` route and canonical derivative
  `/<schema>/media/<collection>/<sha256>/<canonical-operations>/<output-name>.<format>`
  route explicitly public because they contain public website assets and
  `<img>` requests cannot attach bearer headers.
- Public content-addressed media paths use exactly
  `<collection>/<lowercase-sha256>/<filename>` below the configured media
  folder. Resolve real paths and reject every symlink/non-regular file. Only
  canonical segments returned by the shared route parser may enter mirrored
  cache paths; never use an unparsed request value. Encoded identifiers and
  flat raw paths are rejected. Verify source bytes against the route SHA-256
  before raw, metadata, SVG, cache-hit, or generated delivery; memoization must
  be bounded and invalidated by the file-stat signature. SVG is exact
  passthrough and must never reach Sharp.
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
- Generated raster cache paths mirror their canonical public URL below the
  exact service-owned `MINICMS_IMAGE_CACHE_DIR` root:
  `<schema>/media/<collection>/<sha256>/<canonical-operations>/<output-name>.<format>`.
  Cache directories must remain regular contained directories. The service
  uses a SHA-256 digest of that route only for ETags and in-process miss
  deduplication; publication is atomic, hits are streamed, and cache I/O is
  best-effort. There is no maintenance, expiry, capacity accounting, or
  eviction. Metadata JSON and byte-preserving SVG responses are not copied to
  the raster cache.
- JPEG derivatives accept both `jpg` and `jpeg` as canonical output formats;
  both use `image/jpeg` bytes and MIME type while retaining their requested
  extension in the URL and mirrored cache filename.
- Raw reusable `/media/<collection>/<sha256>/<filename>` files always revalidate
  and support byte ranges;
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
  `PUT /api/config` keeps the raw complete-config body and requires that ETag
  in `If-Match`. Missing and stale preconditions return 428 and 412. CORS must
  allow `If-Match` and expose `ETag`. The returned config and ETag must come
  from one exact source snapshot so an external replacement cannot pair a
  stale body with a newer revision.
- A same-key local collection `folder` change is one config transaction.
  Collection folders must be distinct, non-nested strict descendants of
  `content/`, must not overlap `site.media_folder`, and may not traverse
  symlink/non-directory components. Validate every next folder on config save
  and every configured folder again before runtime CRUD, including collections
  that did not move. The destination must be absent. Remote aliases never
  participate, swaps/chains are rejected, and a missing source represents an
  empty collection without creating a placeholder directory.
- Folder moves copy regular directories and files into the exact service-owned
  `.minicms-config-transactions` namespace, publish complete copies to absent
  destinations, atomically replace config as the commit point, and only then
  remove exact old source directories. Never prune parent directories. The
  journal recovers old-config state by removing copies and new-config state by
  removing old sources; an unknown config hash fails readiness closed. This is
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
  types; image bytes must match the filename format before publication. Compute
  SHA-256 while streaming and publish below
  `<collection>/<sha256>/<collision-safe-filename>`; never accept a client hash
  or overwrite a concurrent upload. Collision suffixes remain inside the
  255-byte component limit and preserve per-record file ownership for
  `delete_files_with_record`. On first upload, remove only strictly named stale
  upload temporaries left by an interrupted prior single-replica process.
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
