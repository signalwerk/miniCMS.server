# miniCMS API

The independent filesystem microservice for
[`miniCMS`](https://github.com/signalwerk/miniCMS). It exposes the same content operations used
by the browser's miniCMS API adapter without serving or building the editor.
The editor remains a static JavaScript application and may use miniCMS API and
GitHub connectors side by side.

The service reads a consumer project's `cms.config.yml`, complete YAML records
below `content/`, and uploaded files below the configured media folder. Shared
configuration, record, media, and filename behavior comes from the public
`@signalwerk/minicms/core/*` entries; this package does not duplicate it. Image
service configuration, content-addressed source parsing, operation parsing,
and URL generation use
`@signalwerk/minicms/core/image-service`, so the static editor, website builds,
and this service share one contract.

The miniCMS ecosystem is currently developed as one controlled pre-release
contract. Coordinated breaking changes across miniCMS, this service, and its
consumer repositories are preferred over compatibility routes or redirects;
backward compatibility is added only when explicitly required.

## Development

Node.js 24 or newer is required.

```sh
npm install
npm run dev -- --project-root /path/to/content-project
```

Development is deliberately unauthenticated and defaults to
`http://127.0.0.1:8787`. The `dev` command refuses any `HOST` other than
`127.0.0.1`, `::1`, or `localhost`. `PORT`, `HOST`,
`MINICMS_PROJECT_ROOT`, and `--project-root` are supported. Browser requests
with an `Origin` are accepted only from loopback origins; origin-less CLI
requests remain available.

The API image adapter uses a public Sharp-backed derivative route instead of
loading full raster originals into the editor. Direct GitHub-backed projects
continue to use GitHub media URLs and do not depend on this service.

## Image processing

Configure the project-owned defaults in `cms.config.yml`:

```yaml
site:
  media_folder: content/media
  public_folder: /media
  image_processing:
    width: 2400
    height: 2400
    fit: inside
    format: webp
    quality: 82
    cache:
      schema: v1
```

`fit` supports `cover`, `contain`, `fill`, and `inside`; raster output supports
AVIF, GIF, JPEG, PNG, TIFF, and WebP. JPEG accepts both `format: jpg` and
`format: jpeg`, preserving `.jpg` or `.jpeg` respectively in the URL. The
cache schema is a short URL/cache namespace. Bump it when
changing rendering semantics or when an immutable source URL is replaced. It
is the only cache setting.

The shared helper builds the canonical readable route:

```text
/<schema>/media/<collection>/<sha256>/<canonical-operations>/<output-name>.<format>
```

For example:

```text
/v1/media/images/c5a4c3f1bb4b1ba46407335be8e668361cf6c0383fc266a3657c268bf31ed2cc/resize@width:1600,height:900,fit:inside;quality@82/photo.webp
```

The final basename is cosmetic. Any canonical safe basename selects the same
content hash and operation stack; it never participates in source lookup,
cache identity, in-process deduplication, or ETags. In GitHub development mode,
the derivative collection segment must still identify a configured concrete
local collection before the global hash source can be used.

For example, an operation stack can be
`resize@width:1600,height:900,fit:inside;quality@82`. Supported operations are
`resize`, `rotate`, `flatten`, `crop`, `quality`, and `noop`; they execute from
left to right, `quality` is final, and `noop` is used alone. Every crop
describes a source-space selection, must be the first operation, and cannot be
combined with the separate whole-image `rotate` operation. A crop may carry its
own annotation `rotation`. For example:

```text
crop@left:144,top:171,width:701,height:411,rotation:-26;resize@width:2400,height:2400,fit:inside;quality@82
```

`left` and `top` may be negative when a rotated rectangle still lies inside the
source; `width` and `height` may be decimal but must each cover at least one
source pixel. Rotation is clockwise, matching the stored annotation. The
service validates all four rotated corners, rounds the upright result to the
nearest integer pixel size, extracts only the bounding source patch, and
counter-rotates it. A following `fit:inside` resize is fused before rotation,
so a huge source crop can produce a small bounded derivative without rotating
the whole original. The service accepts only the shared helper's canonical
serialization, validates
every option, refuses path traversal/symlinks, bounds input and output pixels,
requires a supported raster file signature before invoking Sharp, and
processes only the first page/frame. Project `width` and `height` are
URL-builder defaults, so a later config change does not invalidate URLs from an
older site build. The deployment-owned `MINICMS_IMAGE_MAX_*` settings are the
server's hard limits. A `.json` suffix returns curated
source metadata with orientation-aware top-level `width` and `height`. It is
public and sends `Access-Control-Allow-Origin: *`; it never exposes filesystem
paths, raw EXIF/GPS, or ICC data. Metadata URLs always use the canonical
`noop` operation. The requested schema must match the configured schema;
mismatches return 404. The removed `/media/_image/*` form and schema redirects
are deliberately unsupported. Encoded identifiers and flat service sources
are not supported.

SVG uses the same schema route with `noop` and `.svg`, but is never passed to
Sharp. The original bytes are streamed unchanged with their SVG content type,
`nosniff`, and a sandboxing CSP. Requests to rasterize SVG return 415. For an
API-owned project, `/media/<collection>/<sha256>/<filename>` resolves the fixed
`<media-folder>/<collection>/<sha256>/asset.dat`; its final filename is
cosmetic. A GitHub-owned checkout served by the development API instead uses
`/media/<sha256>/<filename>` and the GitHub-compatible physical
`<media-folder>/<sha256>/<original-filename>`; its requested basename is also
cosmetic and selects a verified regular file by hash. Both modes reject
symlinks and always revalidate. Raw delivery stays pinned to the already-open
verified file descriptor even if its path is replaced, while retaining HEAD
and byte-range behavior. Non-image files are served as attachments with a
restrictive CSP so uploaded documents cannot become active content on the API
origin.

Before any raw, metadata, SVG, cached, or generated response is returned, the
service hashes the selected source and requires it to match the SHA-256 route
segment. Successful checks are memoized in a bounded cache keyed by the source
file's stat identity, so unchanged large originals are not reread on every hit.

Raster caching is deliberately just a derivative directory. Each generated
file uses a basename-independent path below the cache root:

```text
<cache-dir>/<schema>/media/<collection>/<sha256>/<canonical-operations>/asset.<format>
```

If that regular file exists, the service streams it. Otherwise Sharp produces
the derivative once, atomically stores it, and returns the generated bytes. A
SHA-256 digest of schema, collection, source hash, operations, and format is
used for the ETag and in-process miss deduplication; the vanity basename is
excluded. Cache I/O failures degrade to an
uncached response instead of taking the image service down. Metadata JSON and
byte-preserving SVG responses are served directly and are not duplicated in
the raster cache.

There is no entry limit, byte limit, expiry, background scan, or eviction.
Derivative files remain until an operator removes them. Bumping the schema
starts a new namespace and requires updating every consumer in the same
coordinated release; the old schema stops resolving immediately and its cache
directory can be deleted. `MINICMS_IMAGE_CACHE_DIR` is the exact cache
directory. It defaults to an OS temporary directory, so production should
configure it on durable storage. Derivative, SVG, and info responses use one
fixed `public, max-age=31536000, immutable` browser/CDN policy; original media
continues to revalidate.

Operational limits are deployment settings rather than editable project
content:

- `MINICMS_IMAGE_CACHE_DIR` (absolute derivative directory)
- `MINICMS_IMAGE_CONCURRENCY` (default 2 transformations)
- `MINICMS_IMAGE_QUEUE_LIMIT` (default 1024 waiting transformations)
- `MINICMS_IMAGE_MAX_INPUT_PIXELS` (default Sharp's 268,402,689)
- `MINICMS_IMAGE_MAX_OUTPUT_PIXELS` (default 32,000,000)
- `MINICMS_IMAGE_MAX_OUTPUT_BYTES` (default 64 MiB)
- `MINICMS_IMAGE_MAX_EDGE` (default 8192px)
- `MINICMS_IMAGE_TIMEOUT_SECONDS` (default 40)
- `MINICMS_MEDIA_MAX_UPLOAD_BYTES` (default 512 MiB)

Uploads remain authenticated. They are streamed into an exclusive temporary
file with the configured byte bound while the service computes SHA-256. The
browser's NFC-normalized original basename is returned unchanged together with
the computed `hash`. An API-owned project atomically publishes the bytes once
as `<media-folder>/<collection>/<sha256>/asset.dat`; another upload with the
same hash silently reuses that verified file while retaining the new record's
filename. A GitHub-owned development checkout instead publishes
`<media-folder>/<sha256>/<original-filename>`. A duplicate hash returns a choice
between the existing file and a collision-safe suffixed copy so local data
remains directly committable to GitHub. Before the first upload, the service
replica removes only its strictly named temporary files left by an interrupted
prior process.

Every upload declares `widget=image|file`; missing or unknown values are
rejected. Accepted types come only from matching upload fields reachable from
the named collection, including nested slot types. Image uploads are checked from their
bytes before publication and must match their filename extension; generic file
rules in another collection cannot authorize them. The browser never supplies
the hash, and huge originals are never buffered into the Node.js heap.

### One-time image migration

The strict image value is `{hash, filename}` plus optional annotation fields;
runtime code does not parse the superseded scalar or `{src, ...}` forms. Before
deploying this contract to an existing API-owned volume, stop the service and
run a complete dry preflight, then the write with an absent backup directory
outside the project root (its parent directory must already exist):

```sh
node bin/migrate-image-assets.mjs --project-root /data \
  --cache-dir /data/.cache --check
node bin/migrate-image-assets.mjs --project-root /data --write \
  --cache-dir /data/.cache \
  --backup-dir /data-backups/minicms-images-before-asset-dat
node bin/migrate-image-assets.mjs --project-root /data \
  --cache-dir /data/.cache --check
```

The command verifies every regular source against its hash before writing,
backs up every changed YAML and removed old source, links one `asset.dat` per
hash atomically, rewrites records, verifies the strict result, removes old
filenames, and clears only the preflighted derivative-cache contents. It is
idempotent. Cache and backup containment checks use resolved physical paths,
so symlinked parents cannot redirect cleanup into `content/`, make the cache
contain the project, or place the backup inside either protected tree. A
project-local cache such as `/data/.cache` remains valid because it is outside
`content/`; a backup must be outside the complete project. A failure must keep
the service stopped; restore the paths listed in the backup manifest before
retrying. The
derivative cache is disposable and should be cleared once because old
basename-specific entries are no longer used.

## Production

`npm start` always enables authentication and fails before listening unless
the session secret and runtime settings are valid:

```sh
MINICMS_SESSION_SECRET=replace-with-at-least-32-random-characters \
HOST=0.0.0.0 \
npm start -- --project-root /srv/content-project
```

The project root must live on durable writable storage. This service edits the
mounted YAML/media files directly; it does not commit those changes to GitHub,
and an ephemeral deployment filesystem will lose them.

### Docker Compose and Coolify

The repository includes a production image and a Coolify-compatible
`docker-compose.yml`. Configure these secrets in Coolify:

```text
MINICMS_SESSION_SECRET=replace-with-at-least-32-random-characters
MINICMS_READ_TOKEN=optional-read-only-deployment-token
```

Then deploy the Compose service and assign its domain to container port `8787`.
The service is exposed only to Coolify's proxy; Compose deliberately does not
publish a host port. It runs as UID/GID `1000:1000`, so prepare the durable host
directory with matching write access. The mounted directory must directly
contain `cms.config.yml` and `content/`:

```text
/DATA/miniCMS/backend/data/
├── .cache/
├── cms.config.yml
└── content/
```

Compose mounts that directory at `/data` and keeps the image cache below
`/data/.cache`. The readiness healthcheck validates both the project and image
configuration. Use exactly one running replica for this writable volume;
overlapping rolling replacements are not safe.

Run one service replica per writable project root. Bearer sessions, write
coordination, and in-flight image work are process-local. Put a CDN or reverse
proxy with request rate limits in front of the intentionally public raw
`/media/*` and derivative `/:schema/media/*` routes; per-instance Sharp
concurrency and queue limits remain the final resource boundary. Rate-limit
`POST /api/auth/github` as well so it cannot be used as an unbounded GitHub
`/user` proxy.

- The only accepted GitHub identity is hard-coded as numeric user ID `992878`
  with the case-insensitive login `signalwerk`; neither value can be widened
  through an environment variable or project configuration.
- `MINICMS_SESSION_SECRET` must contain at least 32 characters and should be a
  high-entropy deployment secret.
- `MINICMS_READ_TOKEN` is optional. When configured, it must contain at least
  32 non-whitespace characters and should be an independent high-entropy
  deployment secret. Send it as an `Authorization: Bearer` value only from a
  trusted static-build environment; never store it in `cms.config.yml` or
  browser code.

Authentication needs no other service environment variables. `HOST`, `PORT`,
`MINICMS_PROJECT_ROOT`, and the image/upload limits remain ordinary runtime
settings.

This service does not own or require a GitHub OAuth app, public callback URL,
client ID, or client secret. The browser authenticates with the shared central
GitHub auth worker and sends the resulting token exactly once to:

```http
POST /api/auth/github
Content-Type: application/json

{"token":"<github-token>"}
```

The service immediately calls GitHub `/user` with that token and requires both
user ID `992878` and login `signalwerk`. It never logs, persists, caches,
returns, or reuses the GitHub token. A successful response contains a new
opaque miniCMS bearer and its session metadata. That bearer lasts eight hours,
is stored only as a keyed hash in process memory, and is revoked by logout.
Restarting the service logs out existing sessions.

Production CORS allows every origin with `Access-Control-Allow-Origin: *`,
permits the `Authorization`, `Content-Type`, and `If-Match` headers, exposes
`ETag`, and never enables credential cookies. The central worker, not this API,
restricts which browser
origins can receive the GitHub token. `POST /api/auth/github` is public so the
browser can exchange that token, but it succeeds only after the service's own
GitHub identity check. Browser content reads and every mutation require the
resulting opaque bearer before large body parsers run. An optional machine read
token can access only `GET`/`HEAD` config, collection-list, and record routes;
the same token receives `403` for configuration writes, record mutations,
renames, and uploads. `/api/health`, `/api/ready`, `/api/auth/session`, and
`POST /api/auth/github` are public. Health reports that the process is alive;
readiness also validates the project and image configuration.
The raw `/media/*` and derivative `/<schema>/media/*` routes are intentionally
public: these assets are website-public content, and ordinary image elements
cannot attach the opaque service bearer.

## API

Public routes:

- `GET /api/health`
- `GET /api/ready`
- `GET /api/auth/session`
- `POST /api/auth/github`
- `GET` and `HEAD`
  `/<schema>/media/<collection>/<sha256>/<canonical-operations>/<output-name>.<format>`
- `GET` and `HEAD /media/<collection>/<sha256>/<filename>` for originals/downloads
- `GET` and `HEAD /media/<sha256>/<filename>` only for a GitHub-owned
  development checkout

Authenticated production routes:

- `POST /api/auth/logout`
- `GET` and `PUT /api/config`
- `GET /api/collections`
- `GET` and `POST /api/collections/:collection`
- `GET`, `PUT`, and `DELETE /api/collections/:collection/:record`
- `POST /api/collections/:collection/:record/rename`
- `POST /api/media/:collection?filename=<name>&widget=<image|file>[&duplicate=reuse|copy]`

Configuration writes use optimistic concurrency and an explicit schema-migration
envelope:

```http
GET /api/config
ETag: "<sha256-of-exact-config-bytes>"

PUT /api/config
Content-Type: application/json
If-Match: "<etag-from-get>"

{
  "config": {
    "connectors": {},
    "site": {},
    "node_types": {},
    "collections": {}
  },
  "schema_renames": {
    "node_types": { "old_type": "new_type" },
    "collections": { "old_collection": "new_collection" }
  }
}
```

Missing and stale preconditions return `428` and `412`. When the folder of a
same-key local collection changes, that PUT copies its existing folder to the
absent destination. Explicit one-to-one key renames additionally rewrite root
and nested record types, canonical inline references, and canonical API file
URLs. Concrete collection renames move the target-configured content folder and
`content/media/<collection>` namespace; structured image values stay unchanged.
Changing a continuing collection between `yml` and `yaml` migrates every record
filename and rejects occupied destination paths.
GitHub-development media keeps its global hash namespace during collection
renames. Configuration saves cannot change between API and GitHub media storage
layouts or change `site.media_folder`; either requires a separate offline
migration.
Remote-alias renames preserve their connector identity and never move remote
storage. Every affected source record, filename, destination, and resulting
record is preflighted before the first write. The transaction then atomically
commits `cms.config.yml` and removes only the old folders or journal backups.
An interrupted transaction is recovered from the service-owned
`.minicms-config-transactions` journal before content is served. A newly
configured local collection must have an absent physical content folder and
media namespace; with those paths absent, it lists as empty until the first
record write.
Derived cache namespaces for renamed concrete collections are removed safely
and best-effort only after the config transaction commits.
The journal recovers interrupted service processes; it does not claim
fsync-backed durability across a host or storage power failure.
The service must be the only runtime writer of the mounted configuration and
collection folders. Stop it before synchronizing or editing that durable root
from the host; external concurrent writes cannot participate in its
process-local transaction gate.

When `MINICMS_READ_TOKEN` is configured, that bearer additionally permits only:

- `GET` and `HEAD /api/config`
- `GET` and `HEAD /api/collections`
- `GET` and `HEAD /api/collections/:collection`
- `GET` and `HEAD /api/collections/:collection/:record`

The service still owns exactly one project root. Imported collection aliases
declared with `connector` and `remote_collection` are config metadata for
clients: this service neither proxies them nor maps them into its filesystem.
Their collection CRUD and upload routes return `404`; clients must call the
named connector directly.

Run all filesystem and authentication integration tests with:

```sh
npm test
```
