import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import express from "express";
import mime from "mime-types";
import { parseContentAddressedMediaPath } from "@signalwerk/minicms/core/image-service";
import { imageCacheControl } from "./config.mjs";
import { parseImageRoute, requestError } from "./url.mjs";

const CONTENT_TYPES = Object.freeze({
  avif: "image/avif",
  gif: "image/gif",
  heif: "image/heif",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml; charset=utf-8",
  tiff: "image/tiff",
  webp: "image/webp"
});
const INLINE_RAW_IMAGE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp"
]);

function bodyEtag(body) {
  const hash = createHash("sha256").update(body).digest("hex");
  return `"sha256-${hash}"`;
}

function etagMatches(request, etag) {
  const supplied = request.get("if-none-match");
  if (!supplied) return false;
  const normalized = (value) => value.trim().replace(/^W\//, "");
  return supplied
    .split(",")
    .some((candidate) => candidate.trim() === "*" || normalized(candidate) === normalized(etag));
}

function publicHeaders(response, { project, etag, length, mtime, svg = false }) {
  response.set({
    "accept-ranges": "none",
    "cache-control": imageCacheControl(project.cache),
    "content-length": String(length),
    "cross-origin-resource-policy": "cross-origin",
    etag,
    "last-modified": mtime.toUTCString(),
    "x-content-type-options": "nosniff"
  });
  if (svg) {
    response.set(
      "content-security-policy",
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    );
  }
}

function finishNotModified(request, response, etag) {
  if (!etagMatches(request, etag)) return false;
  response.removeHeader("content-length");
  response.status(304).end();
  return true;
}

async function closeResultFile(result) {
  await result.fileHandle?.close().catch(() => {});
}

async function sendFileResult(request, response, next, result, contentType) {
  response.type(contentType);
  publicHeaders(response, {
    project: result.project,
    etag: result.etag,
    length: result.length,
    mtime: result.source.mtime,
    svg: result.svg
  });
  if (result.cacheStatus) {
    response.set("x-minicms-image-cache", result.cacheStatus);
  }
  if (finishNotModified(request, response, result.etag)) {
    await closeResultFile(result);
    return;
  }
  if (request.method === "HEAD") {
    await closeResultFile(result);
    response.status(200).end();
    return;
  }
  if (result.buffer) {
    response.status(200).send(result.buffer);
    return;
  }
  const stream = result.fileHandle
    ? result.fileHandle.createReadStream({ autoClose: true })
    : createReadStream(result.filePath || result.source.path);
  response.status(200);
  try {
    await pipeline(stream, response);
  } catch (error) {
    if (response.headersSent) response.destroy(error);
    else next(error);
  }
}

function rawSecurityHeaders(response, result, contentType) {
  response.type(contentType);
  response.set({
    "cache-control": "public, max-age=0, must-revalidate",
    "cross-origin-resource-policy": "cross-origin",
    "x-content-type-options": "nosniff",
    "x-minicms-image-cache": "raw"
  });
  if (result.svg) {
    response.set(
      "content-security-policy",
      "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
    );
  } else if (!INLINE_RAW_IMAGE_TYPES.has(String(contentType).split(";", 1)[0])) {
    response.attachment(path.basename(result.source.relativePath));
    response.type(contentType);
    response.set("content-security-policy", "sandbox; default-src 'none'");
  }
}

function imageLocation(route, schema = route.schema) {
  return [
    "",
    "media",
    "_image",
    schema,
    ...route.sourceSegments,
    route.canonical,
    `${route.slug}.${route.format}`
  ].join("/");
}

function createMediaRouter({ imageService, getConfig }) {
  const router = express.Router();

  async function serveImage(request, response, next) {
    const infoRequest =
      String(request.params.format || "").toLowerCase() === "json";
    if (infoRequest) response.set("access-control-allow-origin", "*");
    try {
      const route = parseImageRoute(request.params);
      const config = await getConfig();
      const project = imageService.validateProjectConfiguration(config);
      if (route.schema !== project.cache.schema) {
        response.set({
          "cache-control": "no-store",
          location: imageLocation(route, project.cache.schema)
        });
        response.status(307).end();
        return;
      }
      if (request.originalUrl.split("?", 1)[0] !== imageLocation(route)) {
        throw requestError(404, "The image route is not canonical.");
      }
      if (route.format === "json") {
        const result = await imageService.info(route, { config, project });
        const body = Buffer.from(JSON.stringify(result.meta));
        const etag = bodyEtag(body);
        response.type("application/json");
        publicHeaders(response, {
          project: result.project,
          etag,
          length: body.length,
          mtime: result.source.mtime
        });
        if (finishNotModified(request, response, etag)) return;
        if (request.method === "HEAD") response.status(200).end();
        else response.status(200).send(body);
        return;
      }

      const result = await imageService.transformed(route, {
        config,
        project
      });
      await sendFileResult(
        request,
        response,
        next,
        result,
        CONTENT_TYPES[route.format]
      );
    } catch (error) {
      next(error);
    }
  }

  router.get(
    "/_image/:schema/:collection/:sha/:filename/:operations/:slug.:format",
    serveImage
  );

  router.get("/:collection/:sha/:filename", async (request, response, next) => {
    try {
      const addressed = parseContentAddressedMediaPath(
        `/media/${String(request.params.collection || "")}/${String(request.params.sha || "")}/${String(request.params.filename || "")}`
      );
      if (
        !addressed ||
        request.originalUrl.split("?", 1)[0] !== addressed.path
      ) {
        throw requestError(404, "The requested media file does not exist.");
      }
      const result = await imageService.raw(addressed.path);
      const inferredContentType =
        mime.lookup(result.source.relativePath) || "application/octet-stream";
      const contentType = result.svg
        ? CONTENT_TYPES.svg
        : result.mediaType.kind === "raster"
          ? CONTENT_TYPES[result.mediaType.format]
          : inferredContentType === "image/svg+xml"
            ? "application/octet-stream"
            : inferredContentType;
      rawSecurityHeaders(response, result, contentType);
      response.sendFile(result.source.path, {
        acceptRanges: true,
        cacheControl: false,
        dotfiles: "deny",
        lastModified: true
      });
    } catch (error) {
      next(
        error.status === 400
          ? requestError(404, "The requested media file does not exist.")
          : error
      );
    }
  });

  return router;
}

export { createMediaRouter };
