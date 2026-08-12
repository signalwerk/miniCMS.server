import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import express from "express";
import mime from "mime-types";
import { parseContentAddressedMediaPath } from "@signalwerk/minicms/core/image-service";
import { mediaStorageMode } from "../media-contract.mjs";
import { parseImageRoute, requestError } from "./url.mjs";

const DERIVATIVE_CACHE_CONTROL = "public, max-age=31536000, immutable";

const CONTENT_TYPES = Object.freeze({
  avif: "image/avif",
  gif: "image/gif",
  heif: "image/heif",
  jpg: "image/jpeg",
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

function publicHeaders(response, { etag, length, mtime, svg = false }) {
  response.set({
    "accept-ranges": "none",
    "cache-control": DERIVATIVE_CACHE_CONTROL,
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
  } finally {
    await closeResultFile(result);
  }
}

function rawSecurityHeaders(response, result, contentType, filename) {
  response.type(contentType);
  response.set({
    "access-control-allow-origin": "*",
    "access-control-expose-headers":
      "Accept-Ranges, Content-Length, Content-Range, ETag",
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
    response.attachment(filename);
    response.type(contentType);
    response.set("content-security-policy", "sandbox; default-src 'none'");
  }
}

function requestedByteRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size < 1) return false;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && (!Number.isSafeInteger(last) || last < 0))
  ) {
    return false;
  }
  if (first === null) {
    if (last === 0) return false;
    return {
      start: Math.max(0, size - last),
      end: size - 1
    };
  }
  if (first >= size) return false;
  const end = last === null ? size - 1 : Math.min(last, size - 1);
  if (end < first) return false;
  return { start: first, end };
}

function ifRangeMatches(request, result) {
  const supplied = request.get("if-range");
  if (!supplied) return true;
  if (supplied.startsWith("W/")) return false;
  if (supplied.startsWith('"')) return supplied === result.etag;
  const date = new Date(supplied);
  return (
    !Number.isNaN(date.getTime()) &&
    Math.floor(result.source.mtime.getTime() / 1000) <=
      Math.floor(date.getTime() / 1000)
  );
}

function rawModifiedSince(request, mtime) {
  if (request.get("if-none-match")) return false;
  const supplied = request.get("if-modified-since");
  if (!supplied) return false;
  const date = new Date(supplied);
  return (
    !Number.isNaN(date.getTime()) &&
    Math.floor(mtime.getTime() / 1000) <= Math.floor(date.getTime() / 1000)
  );
}

async function sendRawResult(
  request,
  response,
  next,
  result,
  contentType,
  filename
) {
  rawSecurityHeaders(response, result, contentType, filename);
  response.set({
    "accept-ranges": "bytes",
    etag: result.etag,
    "last-modified": result.source.mtime.toUTCString()
  });
  if (
    finishNotModified(request, response, result.etag) ||
    rawModifiedSince(request, result.source.mtime)
  ) {
    if (!response.headersSent) {
      response.removeHeader("content-length");
      response.status(304).end();
    }
    await closeResultFile(result);
    return;
  }
  const range = request.method === "GET" && ifRangeMatches(request, result)
    ? requestedByteRange(request.get("range"), result.length)
    : null;
  if (range === false) {
    await closeResultFile(result);
    response
      .status(416)
      .set("content-range", `bytes */${result.length}`)
      .set("content-length", "0")
      .end();
    return;
  }
  const length = range
    ? range.end - range.start + 1
    : result.length;
  response.set("content-length", String(length));
  if (range) {
    response
      .status(206)
      .set("content-range", `bytes ${range.start}-${range.end}/${result.length}`);
  } else {
    response.status(200);
  }
  if (request.method === "HEAD") {
    await closeResultFile(result);
    response.end();
    return;
  }
  const stream = result.fileHandle.createReadStream({
    autoClose: true,
    ...(range ? { start: range.start, end: range.end } : {})
  });
  try {
    await pipeline(stream, response);
  } catch (error) {
    if (response.headersSent) response.destroy(error);
    else next(error);
  } finally {
    await closeResultFile(result);
  }
}

function createMediaRouter({ imageService, getConfig }) {
  const router = express.Router();

  async function serveImage(request, response, next) {
    const infoRequest =
      String(request.params.format || "").toLowerCase() === "json";
    if (infoRequest) response.set("access-control-allow-origin", "*");
    try {
      const route = parseImageRoute(request.originalUrl);
      const config = await getConfig();
      const project = imageService.validateProjectConfiguration(config);
      if (route.schema !== project.cache.schema) {
        throw requestError(404, "The image route is not canonical.");
      }
      if (route.format === "json") {
        const result = await imageService.info(route, { config, project });
        const body = Buffer.from(JSON.stringify(result.meta));
        const etag = bodyEtag(body);
        response.type("application/json");
        publicHeaders(response, {
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
    "/:schema/media/:collection/:sha/:operations/:filename.:format",
    serveImage
  );

  async function serveRaw(request, response, next) {
    try {
      const config = await getConfig();
      const storage = mediaStorageMode(config);
      const requestedForm = request.params.collection === undefined
        ? "github"
        : "api";
      if (storage !== requestedForm) {
        throw requestError(404, "The requested media file does not exist.");
      }
      const addressed = parseContentAddressedMediaPath(
        request.originalUrl.split("?", 1)[0],
        config
      );
      if (
        !addressed ||
        request.originalUrl.split("?", 1)[0] !== addressed.path
      ) {
        throw requestError(404, "The requested media file does not exist.");
      }
      const result = await imageService.raw(addressed.path, { config });
      const inferredContentType =
        mime.lookup(addressed.filename) || "application/octet-stream";
      const contentType = result.svg
        ? CONTENT_TYPES.svg
        : result.mediaType.kind === "raster"
          ? CONTENT_TYPES[result.mediaType.format]
          : inferredContentType === "image/svg+xml"
            ? "application/octet-stream"
            : inferredContentType;
      await sendRawResult(
        request,
        response,
        next,
        result,
        contentType,
        addressed.filename
      );
    } catch (error) {
      next(
        error.status === 400
          ? requestError(404, "The requested media file does not exist.")
          : error
      );
    }
  }

  router.get("/media/:collection/:sha/:filename", serveRaw);
  router.get("/media/:sha/:filename", serveRaw);

  return router;
}

export { createMediaRouter };
