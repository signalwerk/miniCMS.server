# miniCMS API

The independent filesystem microservice for
[`miniCMS`](https://github.com/signalwerk/miniCMS). It exposes the same content operations used
by the browser's miniCMS API adapter without serving or building the editor.
The editor remains a static JavaScript application and may choose either the
miniCMS API or GitHub API backend.

The service reads a consumer project's `cms.config.yml`, complete YAML records
below `content/`, and uploaded files below the configured media folder. Shared
configuration, record, media, and filename behavior comes from the public
`@signalwerk/minicms/core/*` entries; this package does not duplicate it. Image
service configuration, content-addressed source parsing, operation parsing,
and URL generation use
`@signalwerk/minicms/core/image-service`, so the static editor, website builds,
and this service share one contract.

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
      strategy: revalidate
      max_age: 0
```

`fit` supports `cover`, `contain`, `fill`, and `inside`; raster output supports
AVIF, GIF, JPEG, PNG, TIFF, and WebP. The cache schema is a short URL/cache
namespace. Bump it when changing rendering semantics or when an immutable
source URL is replaced. Strategies are:

- `revalidate` (default): public responses use the configured `max_age` and
  must revalidate afterward.
- `immutable`: schema-based derivatives receive immutable cache headers. Use
  this for the service's content-addressed uploads.
- `disabled`: derivative disk and browser caching is disabled.

The shared helper builds the canonical readable route:

```text
/media/_image/:schema/:collection/:sha256/:source-filename/:operation-stack/:source-slug.:format
```

For example:

```text
/media/_image/v1/images/c5a4c3f1bb4b1ba46407335be8e668361cf6c0383fc266a3657c268bf31ed2cc/photo.png/resize@width:1600,height:900,fit:inside;quality@82/photo.webp
```

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
`noop` operation. New URLs use the configured schema; older valid schemas
redirect to it so a site and the service can be deployed independently.
Encoded identifiers and flat service sources are not supported.

SVG uses the same schema route with `noop` and `.svg`, but is never passed to
Sharp. The original bytes are streamed unchanged with their SVG content type,
`nosniff`, and a sandboxing CSP. Requests to rasterize SVG return 415. The
ordinary `/media/:collection/:sha256/:filename` route resolves only regular,
non-symlink files inside the configured media folder and always uses
revalidation rather than the derivative's immutable policy. It supports byte ranges; non-image files
are served as attachments with a restrictive CSP so uploaded documents cannot
become active content on the OAuth/API origin.

Raster cache entries are SHA-256 addressed by cache schema, pipeline/Sharp
versions, a filesystem source signature, canonical operations, format, and
active limits. Writes use a same-directory temporary file plus atomic rename;
identical misses are deduplicated in-process. Hits and successfully cached
misses stream from disk. Cache maintenance is coalesced in the background and
bounds both bytes and entry count. It runs once after process startup for an
existing cache and after writes; cache I/O failures degrade to an uncached
response instead of taking the image service down.

`MINICMS_IMAGE_CACHE_DIR` names a cache parent, never a directory whose whole
contents the service owns. The service appends its own fixed, project-keyed
directory below it and only maintains that subtree. The default parent is the
OS temporary directory; configure a durable local parent in production when
derivatives should survive restarts.

Operational limits are deployment settings rather than editable project
content:

- `MINICMS_IMAGE_CACHE_DIR` (absolute cache parent)
- `MINICMS_IMAGE_CACHE_MAX_BYTES` (default 2 GiB)
- `MINICMS_IMAGE_CACHE_MAX_ENTRIES` (default 10,000)
- `MINICMS_IMAGE_CONCURRENCY` (default 2 transformations)
- `MINICMS_IMAGE_QUEUE_LIMIT` (default 32 waiting transformations)
- `MINICMS_IMAGE_MAX_INPUT_PIXELS` (default Sharp's 268,402,689)
- `MINICMS_IMAGE_MAX_OUTPUT_PIXELS` (default 32,000,000)
- `MINICMS_IMAGE_MAX_OUTPUT_BYTES` (default 64 MiB)
- `MINICMS_IMAGE_MAX_EDGE` (default 8192px)
- `MINICMS_IMAGE_TIMEOUT_SECONDS` (default 20)
- `MINICMS_MEDIA_MAX_UPLOAD_BYTES` (default 512 MiB)

Uploads remain authenticated. They are streamed into an exclusive temporary
file with the configured byte bound while the service computes SHA-256. The
file is then atomically published below
`<media-folder>/<collection>/<sha256>/<sanitized-filename>` and returned as
`/media/<collection>/<sha256>/<sanitized-filename>`. Concurrent name collisions
inside one hash directory receive numeric suffixes, preserving per-record file
ownership for deletion. Suffixing always stays within the filesystem's
255-byte filename limit. Before the first upload, the single service replica
removes only its strictly named temporary files left by an interrupted prior
process.

Accepted types come only from upload fields reachable from the named
collection, including nested slot types. Image uploads are checked from their
bytes before publication and must match their filename extension; generic file
rules in another collection cannot authorize them. The browser never supplies
the hash, and huge originals are never buffered into the Node.js heap.

## Production

`npm start` always enables authentication and fails before listening unless
every security setting is valid:

```sh
MINICMS_PUBLIC_URL=https://cms-api.example.com \
MINICMS_GITHUB_CLIENT_ID=replace-me \
MINICMS_GITHUB_CLIENT_SECRET=replace-me \
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
MINICMS_PUBLIC_URL=https://cms-api.example.com
MINICMS_GITHUB_CLIENT_ID=replace-me
MINICMS_GITHUB_CLIENT_SECRET=replace-me
MINICMS_SESSION_SECRET=replace-with-at-least-32-random-characters
```

Then deploy the Compose service and assign its domain to container port `8787`.
The service is exposed only to Coolify's proxy; Compose deliberately does not
publish a host port. It runs as UID/GID `1000:1000`, so prepare the durable host
directory with matching write access. The mounted directory must directly
contain `cms.config.yml` and `content/`:

```text
/DATA/miniCMS/backend/data/
├── cms.config.yml
└── content/
```

Compose mounts that directory at `/data` and keeps the image cache below
`/data/.cache`. The readiness healthcheck validates both the project and image
configuration. Use exactly one running replica for this writable volume;
overlapping rolling replacements are not safe.

Run one service replica per writable project root. OAuth state, bearer
sessions, write coordination, and in-flight image work are process-local. Put
a CDN or reverse proxy with request rate limits in front of the intentionally
public `/media/` routes; per-instance Sharp concurrency and queue limits remain
the final resource boundary.

- `MINICMS_PUBLIC_URL` is the service's exact HTTPS origin, without a path or
  trailing slash.
- The only accepted GitHub login is hard-coded as `signalwerk`; it cannot be
  widened through an environment variable or project configuration.
- `MINICMS_SESSION_SECRET` must contain at least 32 characters and should be a
  high-entropy deployment secret.

Configure the GitHub OAuth application's callback URL as
`<MINICMS_PUBLIC_URL>/api/auth/github/callback`. The flow requests no optional
GitHub scopes; the authenticated `/user` identity is sufficient.

The service uses GitHub's authorization-code flow with server-held OAuth
state and PKCE S256. It exchanges the code and loads `/user` server-side, then
allows only `signalwerk`. A GitHub access token is never returned to
the browser. The callback sends an origin- and nonce-bound, one-time exchange
code to the opener. That code lasts 60 seconds and can be exchanged once for a
random opaque bearer session lasting eight hours. Only keyed hashes of OAuth
state, exchange codes, and bearer tokens are kept in memory. Restarting the
service logs out existing sessions.

Production CORS allows every origin with `Access-Control-Allow-Origin: *`,
permits the `Authorization` and `Content-Type` headers, and never enables
credential cookies. OAuth accepts any canonical HTTP(S) browser origin, but
the callback and one-time exchange remain bound to that exact requesting
origin and nonce. All content API reads and writes require a bearer before
large body parsers run. `/api/health`, `/api/ready`, and the authentication
bootstrap routes are public. Health reports that the process is alive;
readiness also validates the project and image configuration.
The `/media/*` routes are intentionally public: these assets are website-public content,
and ordinary image elements cannot attach an OAuth bearer header.

## API

Public routes:

- `GET /api/health`
- `GET /api/ready`
- `GET /api/auth/session`
- `GET /api/auth/github/start?origin=<origin>&nonce=<nonce>`
- `GET /api/auth/github/callback`
- `POST /api/auth/exchange`
- `GET` and `HEAD /media/_image/:schema/:collection/:sha256/:filename/:operations/:slug.:format`
- `GET` and `HEAD /media/:collection/:sha256/:filename` for originals/downloads

Authenticated production routes:

- `POST /api/auth/logout`
- `GET` and `PUT /api/config`
- `GET /api/collections`
- `GET` and `POST /api/collections/:collection`
- `GET`, `PUT`, and `DELETE /api/collections/:collection/:record`
- `POST /api/collections/:collection/:record/rename`
- `POST /api/media/:collection?filename=<name>`

Run all filesystem and authentication integration tests with:

```sh
npm test
```
