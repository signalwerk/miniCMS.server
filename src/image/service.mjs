import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { isRemoteCollection } from "@signalwerk/minicms/core/connectors";
import { parseContentAddressedMediaPath } from "@signalwerk/minicms/core/image-service";
import { ASSET_FILENAME, mediaStorageMode } from "../media-contract.mjs";
import {
  imageProjectConfiguration,
  operationalImageConfiguration
} from "./config.mjs";
import { normalizeMediaReference, requestError } from "./url.mjs";

const INPUT_FORMATS = new Set([
  "avif",
  "gif",
  "heif",
  "jpeg",
  "png",
  "tiff",
  "webp"
]);
const SVG_PREFIX_BYTES = 128 * 1024;
const CROP_GEOMETRY_EPSILON = 1e-7;
const VERIFIED_SOURCE_LIMIT = 1024;
const AVIF_BRANDS = new Set(["avif", "avis"]);
const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "mif1",
  "msf1"
]);

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function sourceError(status, message) {
  return requestError(status, message);
}

function statSignature(stat) {
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs
  ].join(":");
}

async function regularFileStat(filePath) {
  let stat;
  try {
    stat = await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw sourceError(404, "The requested media file does not exist.");
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  return stat;
}

async function openUnchangedFile(source, signature) {
  let handle = null;
  try {
    handle = await fs.open(source.path, "r");
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || statSignature(stat) !== signature) {
      throw sourceError(409, "The media file changed while it was processed.");
    }
    return { fileHandle: handle, length: Number(stat.size) };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw sourceError(409, "The media file changed while it was processed.");
    }
    throw error;
  }
}

async function hashUnchangedFile(source) {
  let handle = null;
  try {
    handle = await fs.open(source.path, "r");
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile() ||
      statSignature(openedStat) !== source.signature
    ) {
      throw sourceError(409, "The media file changed while it was verified.");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
    }
    const finishedStat = await handle.stat({ bigint: true });
    if (statSignature(finishedStat) !== source.signature) {
      throw sourceError(409, "The media file changed while it was verified.");
    }
    return hash.digest("hex");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw sourceError(409, "The media file changed while it was verified.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function createSourceHashResolver({
  hashSource = hashUnchangedFile,
  maxEntries = VERIFIED_SOURCE_LIMIT
} = {}) {
  const entries = new Map();
  return async (source) => {
    const cached = entries.get(source.path);
    if (cached?.signature === source.signature) {
      entries.delete(source.path);
      entries.set(source.path, cached);
      return cached.pending;
    }

    const entry = {
      signature: source.signature,
      pending: hashSource(source)
    };
    entries.delete(source.path);
    entries.set(source.path, entry);
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
    try {
      return await entry.pending;
    } catch (error) {
      if (entries.get(source.path) === entry) entries.delete(source.path);
      throw error;
    }
  };
}

async function safeDirectory(rootDir, configuredMediaFolder, { create = false } = {}) {
  const contentRoot = path.resolve(rootDir, "content");
  const declaredMediaRoot = path.resolve(rootDir, configuredMediaFolder);
  if (
    declaredMediaRoot === contentRoot ||
    !isInside(contentRoot, declaredMediaRoot)
  ) {
    throw sourceError(500, "The configured media folder must be inside content/.");
  }

  let contentStat;
  try {
    contentStat = await fs.lstat(contentRoot);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!create) {
      throw sourceError(404, "The configured media folder does not exist.");
    }
    await fs.mkdir(contentRoot).catch((mkdirError) => {
      if (mkdirError.code !== "EEXIST") throw mkdirError;
    });
    contentStat = await fs.lstat(contentRoot);
  }
  if (contentStat.isSymbolicLink() || !contentStat.isDirectory()) {
    throw sourceError(500, "content/ must be a regular directory.");
  }
  const trustedContentRoot = await fs.realpath(contentRoot);

  const relative = path.relative(contentRoot, declaredMediaRoot);
  let current = contentRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT" || !create) {
        if (error.code === "ENOENT") {
          throw sourceError(404, "The configured media folder does not exist.");
        }
        throw error;
      }
      await fs.mkdir(current).catch((mkdirError) => {
        if (mkdirError.code !== "EEXIST") throw mkdirError;
      });
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw sourceError(500, "The configured media folder must not contain symbolic links.");
    }
  }

  const trustedMediaRoot = await fs.realpath(declaredMediaRoot);
  if (!isInside(trustedContentRoot, trustedMediaRoot)) {
    throw sourceError(500, "The configured media folder resolves outside content/.");
  }
  return { declaredMediaRoot, trustedMediaRoot };
}

async function resolveStoredAsset({ rootDir, config, segments, filename }) {
  const configuredMediaFolder = config.site?.media_folder || "content/media";
  const { declaredMediaRoot, trustedMediaRoot } = await safeDirectory(
    rootDir,
    configuredMediaFolder
  );

  let current = declaredMediaRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        throw sourceError(404, "The requested media file does not exist.");
      }
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw sourceError(404, "The requested media file does not exist.");
    }
    current = await fs.realpath(current);
    if (!isInside(trustedMediaRoot, current)) {
      throw sourceError(404, "The requested media file does not exist.");
    }
  }

  current = path.join(current, filename);
  const stat = await regularFileStat(current);
  const realPath = await fs.realpath(current);
  if (!isInside(trustedMediaRoot, realPath)) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  return Object.freeze({
    path: realPath,
    relativePath: [...segments, filename].join("/"),
    stat,
    signature: statSignature(stat),
    size: Number(stat.size),
    mtime: new Date(Number(stat.mtimeMs))
  });
}

async function resolveMediaSource({ rootDir, config, reference }) {
  const mediaFolder = String(
    config.site?.media_folder || "content/media"
  ).replace(/^\/+|\/+$/g, "");
  const normalizedReference = String(reference || "").replace(/^\/+/, "");
  const storageReference = normalizedReference.startsWith(`${mediaFolder}/`);
  const relative = storageReference
    ? normalizedReference.slice(mediaFolder.length + 1)
    : normalizeMediaReference(reference, {
        mediaFolder,
        publicFolder: config.site?.public_folder || "/media"
      });
  const segments = relative.split("/");
  const storage = mediaStorageMode(config);
  const expectedLength = storage === "api" ? 3 : 2;
  if (segments.length !== expectedLength) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  const [collection, sha, encodedFilename] = storage === "api"
    ? segments
    : [null, ...segments];
  if (
    (collection !== null && !/^[a-z0-9][a-z0-9._-]*$/i.test(collection)) ||
    !/^[a-f0-9]{64}$/.test(sha)
  ) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  let filename;
  try {
    filename = (
      storageReference ? encodedFilename : decodeURIComponent(encodedFilename)
    ).normalize("NFC");
  } catch {
    throw sourceError(404, "The requested media file does not exist.");
  }
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  const source = await resolveStoredAsset({
    rootDir,
    config,
    segments: storage === "api"
      ? [collection, sha]
      : [sha],
    filename: storage === "api" ? ASSET_FILENAME : filename
  });
  return Object.freeze({
    ...source,
    addressed: { collection, sha, filename }
  });
}

async function resolveGithubHashSource({
  rootDir,
  config,
  sha,
  sourceHash = hashUnchangedFile
}) {
  const configuredMediaFolder = config.site?.media_folder || "content/media";
  const { declaredMediaRoot, trustedMediaRoot } = await safeDirectory(
    rootDir,
    configuredMediaFolder
  );
  const directory = path.join(declaredMediaRoot, sha);
  const directoryStat = await fs.lstat(directory).catch((error) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw sourceError(404, "The requested media file does not exist.");
    }
    throw error;
  });
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  const realDirectory = await fs.realpath(directory);
  if (!isInside(trustedMediaRoot, realDirectory)) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  const entries = await fs.readdir(realDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) continue;
    try {
      const source = await resolveStoredAsset({
        rootDir,
        config,
        segments: [sha],
        filename: entry.name
      });
      if (await sourceHash(source) === sha) return source;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  throw sourceError(404, "The requested media file does not exist.");
}

async function resolveImageSource({
  rootDir,
  config,
  route,
  sourceHash = hashUnchangedFile
}) {
  const collection = config.collections?.[route.collection];
  if (!collection || isRemoteCollection(collection)) {
    throw sourceError(404, "The requested media file does not exist.");
  }
  if (mediaStorageMode(config) === "github") {
    return resolveGithubHashSource({
      rootDir,
      config,
      sha: route.sha,
      sourceHash
    });
  }
  const source = await resolveStoredAsset({
    rootDir,
    config,
    segments: [route.collection, route.sha],
    filename: ASSET_FILENAME
  });
  if (await sourceHash(source) === route.sha) return source;
  throw sourceError(404, "The requested media file does not exist.");
}

async function prefixOf(filePath, size = SVG_PREFIX_BYTES) {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function prefixLooksLikeSvg(prefix) {
  let source = prefix.toString("utf8").replace(/^\uFEFF/, "");
  const prolog = /^\s*(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)/i;
  while (prolog.test(source)) source = source.replace(prolog, "");
  return /^\s*<svg(?:\s|>)/i.test(source);
}

function hasBytes(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function isoBmffBrands(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 4, 8) !== "ftyp") {
    return [];
  }
  let boxSize = buffer.readUInt32BE(0);
  let brandOffset = 8;
  if (boxSize === 1) {
    if (buffer.length < 24) return [];
    const extendedSize = buffer.readBigUInt64BE(8);
    if (extendedSize < 24n) return [];
    boxSize = extendedSize > BigInt(buffer.length)
      ? buffer.length
      : Number(extendedSize);
    brandOffset = 16;
  } else if (boxSize === 0) {
    boxSize = buffer.length;
  } else if (boxSize < 16) {
    return [];
  }
  const end = Math.min(buffer.length, boxSize);
  if (brandOffset + 8 > end) return [];
  const brands = [buffer.toString("ascii", brandOffset, brandOffset + 4)];
  for (let offset = brandOffset + 8; offset + 4 <= end; offset += 4) {
    brands.push(buffer.toString("ascii", offset, offset + 4));
  }
  return brands;
}

function rasterFormatFromMagic(prefix) {
  if (hasBytes(prefix, 0, [0xff, 0xd8, 0xff])) return "jpeg";
  if (hasBytes(prefix, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  const header = prefix.toString("ascii", 0, 12);
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a")) return "gif";
  if (
    hasBytes(prefix, 0, [0x49, 0x49, 0x2a, 0x00]) ||
    hasBytes(prefix, 0, [0x4d, 0x4d, 0x00, 0x2a]) ||
    hasBytes(prefix, 0, [0x49, 0x49, 0x2b, 0x00]) ||
    hasBytes(prefix, 0, [0x4d, 0x4d, 0x00, 0x2b])
  ) {
    return "tiff";
  }
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WEBP") {
    return "webp";
  }
  const brands = isoBmffBrands(prefix);
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "avif";
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) return "heif";
  return null;
}

async function detectImageFileType(filePath) {
  const prefix = await prefixOf(filePath);
  const format = rasterFormatFromMagic(prefix);
  if (format) return { kind: "raster", format };
  if (prefixLooksLikeSvg(prefix)) return { kind: "svg", format: "svg" };
  return { kind: "unsupported", format: null };
}

async function sourceMediaType(source) {
  return detectImageFileType(source.path);
}

function createLimiter({ concurrency, queueLimit }) {
  let active = 0;
  const queue = [];

  function advance() {
    while (active < concurrency && queue.length) {
      const queued = queue.shift();
      active += 1;
      Promise.resolve()
        .then(queued.operation)
        .then(queued.resolve, queued.reject)
        .finally(() => {
          active -= 1;
          advance();
        });
    }
  }

  return function limited(operation) {
    if (active >= concurrency && queue.length >= queueLimit) {
      const error = sourceError(503, "The image processor is busy. Try again shortly.");
      error.retryAfter = 1;
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      queue.push({ operation, resolve, reject });
      advance();
    });
  };
}

function quotedEtag(hash) {
  return `"sha256-${hash}"`;
}

function signatureEtag(signature) {
  return quotedEtag(createHash("sha256").update(signature).digest("hex"));
}

function orientedDimensions(metadata) {
  const width = Number(metadata.width);
  const pageHeight = Number(metadata.pageHeight);
  const rawHeight = Number(metadata.height);
  const height = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : rawHeight;
  if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
    throw sourceError(415, "The image has no usable dimensions.");
  }
  if ([5, 6, 7, 8].includes(metadata.orientation)) {
    return { width: height, height: width };
  }
  return { width, height };
}

function rotatedDimensions(width, height, angle) {
  const normalized = Math.abs(angle % 180);
  if (normalized === 0) return { width, height };
  if (normalized === 90) return { width: height, height: width };
  const radians = (normalized * Math.PI) / 180;
  return {
    width: Math.round(
      Math.abs(width * Math.cos(radians)) +
        Math.abs(height * Math.sin(radians))
    ),
    height: Math.round(
      Math.abs(width * Math.sin(radians)) +
        Math.abs(height * Math.cos(radians))
    )
  };
}

function orientedCropGeometry(dimensions, options, resizeOptions) {
  const { left, top, width, height } = options;
  const rotation = Number(options.rotation || 0) % 360;
  const centerX = left + width / 2;
  const centerY = top + height / 2;
  const radians = (rotation * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2]
  ].map(([x, y]) => ({
    x: centerX + cosine * x - sine * y,
    y: centerY + sine * x + cosine * y
  }));
  if (
    corners.some(
      (corner) =>
        corner.x < -CROP_GEOMETRY_EPSILON ||
        corner.y < -CROP_GEOMETRY_EPSILON ||
        corner.x > dimensions.width + CROP_GEOMETRY_EPSILON ||
        corner.y > dimensions.height + CROP_GEOMETRY_EPSILON
    )
  ) {
    throw sourceError(400, "The crop rectangle is outside the image.");
  }

  const minimumX = Math.min(...corners.map((corner) => corner.x));
  const minimumY = Math.min(...corners.map((corner) => corner.y));
  const maximumX = Math.max(...corners.map((corner) => corner.x));
  const maximumY = Math.max(...corners.map((corner) => corner.y));
  const patchLeft = Math.max(
    0,
    Math.floor(minimumX + CROP_GEOMETRY_EPSILON) - 1
  );
  const patchTop = Math.max(
    0,
    Math.floor(minimumY + CROP_GEOMETRY_EPSILON) - 1
  );
  const patchRight = Math.min(
    dimensions.width,
    Math.ceil(maximumX - CROP_GEOMETRY_EPSILON) + 1
  );
  const patchBottom = Math.min(
    dimensions.height,
    Math.ceil(maximumY - CROP_GEOMETRY_EPSILON) + 1
  );
  const patch = {
    left: patchLeft,
    top: patchTop,
    width: patchRight - patchLeft,
    height: patchBottom - patchTop
  };
  const sourceOutput = {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height))
  };
  const output = resizeOptions
    ? resizedDimensions(
        sourceOutput.width,
        sourceOutput.height,
        resizeOptions
      )
    : sourceOutput;
  const scale = Math.min(
    1,
    Math.max(
      output.width / sourceOutput.width,
      output.height / sourceOutput.height
    )
  );
  const resizedPatch = {
    width: Math.min(
      patch.width,
      Math.max(1, Math.round(patch.width * scale))
    ),
    height: Math.min(
      patch.height,
      Math.max(1, Math.round(patch.height * scale))
    )
  };
  const scaleX = resizedPatch.width / patch.width;
  const scaleY = resizedPatch.height / patch.height;
  const appliedRotation = rotation ? -rotation : 0;
  const rotated = rotatedDimensions(
    resizedPatch.width,
    resizedPatch.height,
    appliedRotation
  );
  const patchCenterX = patch.left + patch.width / 2;
  const patchCenterY = patch.top + patch.height / 2;
  const deltaX = (centerX - patchCenterX) * scaleX;
  const deltaY = (centerY - patchCenterY) * scaleY;
  const appliedRadians = (appliedRotation * Math.PI) / 180;
  const appliedCosine = Math.cos(appliedRadians);
  const appliedSine = Math.sin(appliedRadians);
  const rotatedCenterX =
    rotated.width / 2 +
    appliedCosine * deltaX -
    appliedSine * deltaY;
  const rotatedCenterY =
    rotated.height / 2 +
    appliedSine * deltaX +
    appliedCosine * deltaY;
  const maximumLeft = rotated.width - output.width;
  const maximumTop = rotated.height - output.height;
  if (maximumLeft < 0 || maximumTop < 0) {
    throw sourceError(400, "The crop rectangle is outside the image.");
  }
  const extract = {
    left: Math.min(
      maximumLeft,
      Math.max(0, Math.round(rotatedCenterX - output.width / 2))
    ),
    top: Math.min(
      maximumTop,
      Math.max(0, Math.round(rotatedCenterY - output.height / 2))
    ),
    width: output.width,
    height: output.height
  };
  const sourceMaximumLeft = dimensions.width - sourceOutput.width;
  const sourceMaximumTop = dimensions.height - sourceOutput.height;
  const sourceExtract = {
    left: Math.min(
      sourceMaximumLeft,
      Math.max(0, Math.round(centerX - sourceOutput.width / 2))
    ),
    top: Math.min(
      sourceMaximumTop,
      Math.max(0, Math.round(centerY - sourceOutput.height / 2))
    ),
    width: sourceOutput.width,
    height: sourceOutput.height
  };
  return {
    patch,
    resizedPatch,
    rotatedPatch: rotated,
    rotation: appliedRotation,
    extract,
    sourceExtract,
    sourceOutput,
    output
  };
}

function resizedDimensions(width, height, options) {
  const requestedWidth = options.width;
  const requestedHeight = options.height;
  if (requestedWidth && requestedHeight) {
    if (options.fit === "contain") {
      return { width: requestedWidth, height: requestedHeight };
    }
    if (["cover", "fill"].includes(options.fit)) {
      return {
        width: Math.min(width, requestedWidth),
        height: Math.min(height, requestedHeight)
      };
    }
    const scale = Math.min(requestedWidth / width, requestedHeight / height, 1);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  if (requestedWidth) {
    const scale = Math.min(requestedWidth / width, 1);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale))
    };
  }
  const scale = Math.min(requestedHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function dimensionsExceedOperationalLimits(dimensions, operational) {
  return (
    dimensions.width > operational.maxEdge ||
    dimensions.height > operational.maxEdge ||
    dimensions.width * dimensions.height > operational.maxOutputPixels
  );
}

function validateRequestedDimensions(operations, operational) {
  for (const operation of operations) {
    if (operation.type !== "resize") continue;
    if (
      (operation.options.width && operation.options.width > operational.maxEdge) ||
      (operation.options.height && operation.options.height > operational.maxEdge)
    ) {
      throw sourceError(413, "The requested output dimensions are too large.");
    }
  }
}

function validateOutputDimensions(metadata, operations, operational) {
  let dimensions = orientedDimensions(metadata);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    if (operation.type === "crop") {
      const resize =
        operations[index + 1]?.type === "resize" &&
        operations[index + 1].options.fit === "inside"
          ? operations[index + 1].options
          : null;
      const geometry = orientedCropGeometry(
        dimensions,
        operation.options,
        resize
      );
      if (geometry.rotation) {
        if (
          dimensionsExceedOperationalLimits(geometry.resizedPatch, operational) ||
          dimensionsExceedOperationalLimits(geometry.rotatedPatch, operational)
        ) {
          throw sourceError(413, "The requested image operation is too large.");
        }
      }
      dimensions = geometry.output;
      if (resize) index += 1;
    } else if (operation.type === "resize") {
      dimensions = resizedDimensions(
        dimensions.width,
        dimensions.height,
        operation.options
      );
    } else if (operation.type === "rotate") {
      dimensions = rotatedDimensions(
        dimensions.width,
        dimensions.height,
        operation.options.angle
      );
    }
    if (dimensionsExceedOperationalLimits(dimensions, operational)) {
      throw sourceError(413, "The requested image operation is too large.");
    }
  }
  return dimensions;
}

function sharpInput(source, operational) {
  return sharp(source.path, {
    autoOrient: true,
    failOn: "warning",
    limitInputChannels: 5,
    limitInputPixels: operational.maxInputPixels,
    pages: 1,
    sequentialRead: true,
    unlimited: false
  }).timeout({ seconds: operational.timeoutSeconds });
}

async function rasterMetadata(source, operational, detectedFormat) {
  if (!detectedFormat || !INPUT_FORMATS.has(detectedFormat)) {
    throw sourceError(415, "The media file is not a supported raster image.");
  }
  let metadata;
  try {
    metadata = await sharpInput(source, operational).metadata();
  } catch {
    throw sourceError(415, "The media file is not a supported raster image.");
  }
  if (!INPUT_FORMATS.has(metadata.format)) {
    throw sourceError(415, "The media file is not a supported raster image.");
  }
  orientedDimensions(metadata);
  return metadata;
}

function safeRasterMetadata(metadata, source) {
  const normalized = orientedDimensions(metadata);
  return {
    format: metadata.format,
    size: source.size,
    width: normalized.width,
    height: normalized.height,
    sourceWidth: metadata.width ?? null,
    sourceHeight: metadata.height ?? null,
    orientation: metadata.orientation ?? null,
    space: metadata.space ?? null,
    channels: metadata.channels ?? null,
    depth: metadata.depth ?? null,
    density: metadata.density ?? null,
    chromaSubsampling: metadata.chromaSubsampling ?? null,
    isProgressive: Boolean(metadata.isProgressive),
    isPalette: Boolean(metadata.isPalette),
    pages: metadata.pages ?? 1,
    pageHeight: metadata.pageHeight ?? null,
    hasProfile: Boolean(metadata.hasProfile),
    hasAlpha: Boolean(metadata.hasAlpha)
  };
}

function parseSvgNumber(value) {
  if (typeof value !== "string") return null;
  const match = /^\s*(\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) && number > 0 && number <= 1_000_000
    ? number
    : null;
}

async function safeSvgMetadata(source) {
  const prefix = (await prefixOf(source.path)).toString("utf8");
  const root = /<svg\b([^>]*)>/i.exec(prefix)?.[1] || "";
  const attribute = (name) =>
    new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i").exec(root)?.[1] ?? null;
  const viewBox = String(attribute("viewBox") || "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const viewBoxWidth =
    viewBox.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0
      ? viewBox[2]
      : null;
  const viewBoxHeight =
    viewBox.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0
      ? viewBox[3]
      : null;
  const width = parseSvgNumber(attribute("width")) ?? viewBoxWidth;
  const height = parseSvgNumber(attribute("height")) ?? viewBoxHeight;
  return {
    format: "svg",
    size: source.size,
    width,
    height,
    sourceWidth: width,
    sourceHeight: height,
    orientation: null,
    space: null,
    channels: null,
    depth: null,
    density: null,
    chromaSubsampling: null,
    isProgressive: false,
    isPalette: false,
    pages: 1,
    pageHeight: null,
    hasProfile: false,
    hasAlpha: true
  };
}

function applyOperations(image, operations, metadata) {
  let transformed = image;
  let dimensions = orientedDimensions(metadata);
  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];
    const options = operation.options;
    if (operation.type === "resize") {
      transformed = transformed.resize(options.width, options.height, {
        fit: options.fit,
        withoutEnlargement: true
      });
      dimensions = resizedDimensions(
        dimensions.width,
        dimensions.height,
        options
      );
    } else if (operation.type === "rotate") {
      transformed = transformed.rotate(options.angle);
      dimensions = rotatedDimensions(
        dimensions.width,
        dimensions.height,
        options.angle
      );
    } else if (operation.type === "crop") {
      const resize =
        operations[index + 1]?.type === "resize" &&
        operations[index + 1].options.fit === "inside"
          ? operations[index + 1].options
          : null;
      const geometry = orientedCropGeometry(dimensions, options, resize);
      if (geometry.rotation) {
        transformed = transformed
          .extract(geometry.patch)
          .resize(geometry.resizedPatch.width, geometry.resizedPatch.height, {
            fit: "fill",
            withoutEnlargement: true
          })
          .rotate(geometry.rotation)
          .extract(geometry.extract);
      } else {
        transformed = transformed.extract(geometry.sourceExtract);
        if (resize) {
          transformed = transformed.resize(resize.width, resize.height, {
            fit: "inside",
            withoutEnlargement: true
          });
        }
      }
      dimensions = geometry.output;
      if (resize) index += 1;
    } else if (operation.type === "flatten") {
      if (options.background) {
        transformed = transformed.flatten({
          background: `#${options.background}`
        });
      } else if (options.alpha === "remove") {
        transformed = transformed.removeAlpha();
      }
    }
  }
  return transformed;
}

function formatOutput(image, format, quality) {
  if (format === "jpg" || format === "jpeg") {
    return image.jpeg({ quality });
  }
  if (format === "png") return image.png({ quality });
  if (format === "webp") return image.webp({ quality });
  if (format === "avif") return image.avif({ quality });
  if (format === "tiff") return image.tiff({ quality });
  if (format === "gif") return image.gif({ quality });
  throw sourceError(400, "The requested raster output format is unsupported.");
}

async function computeRaster(source, route, operational, detectedFormat) {
  const metadata = await rasterMetadata(source, operational, detectedFormat);
  validateOutputDimensions(metadata, route.operations, operational);
  const quality = route.operations.find((operation) => operation.type === "quality")
    ?.options.value;
  let image = applyOperations(
    sharpInput(source, operational),
    route.operations,
    metadata
  );
  image = formatOutput(image, route.format, quality);
  let result;
  try {
    result = await image.toBuffer({ resolveWithObject: true });
  } catch {
    throw sourceError(422, "The image transformation could not be completed.");
  }
  if (
    !result.data.length ||
    result.data.length > operational.maxOutputBytes ||
    dimensionsExceedOperationalLimits(result.info, operational)
  ) {
    throw sourceError(413, "The generated image is too large.");
  }
  return result.data;
}

function cacheKey(route) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: route.schema,
        collection: route.collection,
        sha: route.sha,
        operations: route.canonical,
        format: route.format
      })
    )
    .digest("hex");
}

async function ensureCacheRoot(cacheRoot, rootDir) {
  await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const rootStat = await fs.lstat(cacheRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("The image cache root is not a regular directory.");
  }
  const trustedRoot = await fs.realpath(cacheRoot);
  const contentRoot = await fs.realpath(path.resolve(rootDir, "content")).catch(
    (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  );
  if (contentRoot && isInside(contentRoot, trustedRoot)) {
    throw new Error("The image cache root must stay outside project content.");
  }
  return trustedRoot;
}

async function removeCollectionCacheDirectories(cacheRoot, rootDir, collection) {
  if (
    typeof collection !== "string" ||
    !collection ||
    collection === "." ||
    collection === ".." ||
    Buffer.byteLength(collection, "utf8") > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(collection)
  ) {
    throw new Error("The image cache collection name is invalid.");
  }
  const rootStat = await fs.lstat(cacheRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootStat) return;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("The image cache root is not a regular directory.");
  }
  const trustedRoot = await fs.realpath(cacheRoot);
  const contentRoot = await fs.realpath(path.resolve(rootDir, "content")).catch(
    (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  );
  if (contentRoot && isInside(contentRoot, trustedRoot)) {
    throw new Error("The image cache root must stay outside project content.");
  }

  const schemas = await fs.readdir(trustedRoot, { withFileTypes: true });
  for (const schema of schemas) {
    if (!schema.isDirectory() || schema.isSymbolicLink()) continue;
    const schemaPath = path.join(trustedRoot, schema.name);
    const mediaPath = path.join(schemaPath, "media");
    const mediaStat = await fs.lstat(mediaPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!mediaStat) continue;
    if (mediaStat.isSymbolicLink() || !mediaStat.isDirectory()) {
      throw new Error("The image cache media namespace is not a regular directory.");
    }
    const destination = path.join(mediaPath, collection);
    const destinationStat = await fs.lstat(destination).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!destinationStat) continue;
    if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory()) {
      throw new Error("The image cache collection namespace is not a regular directory.");
    }
    const resolvedDestination = await fs.realpath(destination);
    if (!isInside(trustedRoot, resolvedDestination)) {
      throw new Error("The image cache collection resolves outside its owned root.");
    }
    await fs.rm(resolvedDestination, { recursive: true, force: false });
  }
}

function cacheRouteSegments(route) {
  const segments = [
    route.schema,
    "media",
    route.collection,
    route.sha,
    route.canonical
  ];
  const output = `asset.${route.format}`;
  if (
    [...segments, output].some(
      (segment) =>
        typeof segment !== "string" ||
        !segment ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(segment)
    )
  ) {
    throw new Error("The image cache path is invalid.");
  }
  return { directories: segments, output };
}

async function ensureCacheDirectoryOnDisk(cacheRoot, rootDir, segments) {
  const trustedRoot = await ensureCacheRoot(cacheRoot, rootDir);
  let directory = trustedRoot;
  for (const segment of segments) {
    directory = path.join(directory, segment);
    try {
      await fs.mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("The image cache directory is not a regular directory.");
    }
    directory = await fs.realpath(directory);
    if (!isInside(trustedRoot, directory)) {
      throw new Error("The image cache directory resolves outside its owned root.");
    }
  }
}

async function readCached(cachePath, operational) {
  let handle = null;
  try {
    const stat = await fs.lstat(cachePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (
      stat.size < 1 ||
      stat.size > operational.maxOutputBytes
    ) {
      throw new Error("The image cache contains an invalid entry.");
    }
    handle = await fs.open(cachePath, "r");
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.dev !== stat.dev ||
      openedStat.ino !== stat.ino ||
      openedStat.size !== stat.size
    ) {
      await handle.close();
      return null;
    }
    return { fileHandle: handle, length: openedStat.size };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

async function writeCacheAtomic(cachePath, buffer) {
  const directory = path.dirname(cachePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(cachePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: "wx", mode: 0o600 });
    const existing = await fs.lstat(cachePath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw sourceError(500, "The image cache contains an invalid entry.");
    }
    await fs.rename(temporaryPath, cachePath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

function createImageService({
  rootDir,
  getConfig,
  environment = process.env,
  logger = console
}) {
  const operational = operationalImageConfiguration({ rootDir, environment });
  const limited = createLimiter(operational);
  const inFlight = new Map();
  const sourceHash = createSourceHashResolver({
    hashSource: (source) => limited(() => hashUnchangedFile(source))
  });

  function warnCache(action, error) {
    if (typeof logger?.warn !== "function") return;
    logger.warn(
      `miniCMS image cache ${action} failed: ${error?.message || String(error)}`
    );
  }

  async function ensureCacheDirectory(route) {
    const cacheRoute = cacheRouteSegments(route);
    await ensureCacheDirectoryOnDisk(
      operational.cacheRoot,
      rootDir,
      cacheRoute.directories
    );
    return cacheRoute;
  }

  async function sourceContext(reference, snapshot) {
    const config = snapshot?.config ?? await getConfig();
    const source = await resolveMediaSource({ rootDir, config, reference });
    const addressed = parseContentAddressedMediaPath(reference, config);
    if (!addressed || await sourceHash(source) !== addressed.sha) {
      throw sourceError(404, "The requested media file does not exist.");
    }
    return { config, source, sourceSignature: source.signature };
  }

  async function context(route, snapshot) {
    const config = snapshot?.config ?? await getConfig();
    const source = await resolveImageSource({
      rootDir,
      config,
      route,
      sourceHash
    });
    const project = snapshot?.project ?? imageProjectConfiguration(
      config,
      operational
    );
    return { config, source, sourceSignature: source.signature, project };
  }

  async function assertSourceUnchanged(source, signature) {
    if (statSignature(await regularFileStat(source.path)) !== signature) {
      throw sourceError(409, "The media file changed while it was processed.");
    }
  }

  async function raw(reference, snapshot) {
    const config = snapshot?.config ?? await getConfig();
    const addressed = parseContentAddressedMediaPath(reference, config);
    if (!addressed) {
      throw sourceError(404, "The requested media file does not exist.");
    }
    const result = mediaStorageMode(config) === "github"
      ? {
          config,
          source: await resolveGithubHashSource({
            rootDir,
            config,
            sha: addressed.sha,
            sourceHash
          })
        }
      : await sourceContext(reference, { config });
    const mediaType = await sourceMediaType(result.source);
    const opened = await openUnchangedFile(
      result.source,
      result.source.signature
    );
    return {
      ...result,
      ...opened,
      etag: quotedEtag(addressed.sha),
      mediaType,
      svg: mediaType.kind === "svg"
    };
  }

  async function info(route, snapshot) {
    const result = await context(route, snapshot);
    if (route.canonical !== "noop") {
      throw sourceError(400, "Image metadata routes must use the noop operation.");
    }
    const mediaType = await sourceMediaType(result.source);
    if (mediaType.kind === "unsupported") {
      throw sourceError(415, "The media file is not a supported image.");
    }
    const svg = mediaType.kind === "svg";
    const meta = svg
      ? await safeSvgMetadata(result.source)
      : await limited(async () =>
          safeRasterMetadata(
            await rasterMetadata(
              result.source,
              operational,
              mediaType.format
            ),
            result.source
          )
        );
    await assertSourceUnchanged(result.source, result.sourceSignature);
    return { ...result, svg, meta };
  }

  async function transformed(route, snapshot) {
    const result = await context(route, snapshot);
    validateRequestedDimensions(route.operations, operational);
    const mediaType = await sourceMediaType(result.source);
    if (route.format === "svg") {
      if (mediaType.kind !== "svg") {
        throw sourceError(415, "Raster media cannot be delivered as SVG.");
      }
      if (route.canonical !== "noop") {
        throw sourceError(400, "SVG delivery routes must use the noop operation.");
      }
      const opened = await openUnchangedFile(
        result.source,
        result.sourceSignature
      );
      return {
        ...result,
        svg: true,
        ...opened,
        etag: signatureEtag(result.sourceSignature),
        cacheStatus: "passthrough"
      };
    }
    if (mediaType.kind === "svg") {
      throw sourceError(415, "SVG media can only be delivered as SVG.");
    }
    if (mediaType.kind === "unsupported") {
      throw sourceError(415, "The media file is not a supported raster image.");
    }

    const key = cacheKey(route);
    const cacheRoute = cacheRouteSegments(route);
    const cachePath = path.join(
      operational.cacheRoot,
      ...cacheRoute.directories,
      cacheRoute.output
    );
    let cached = null;
    try {
      await ensureCacheDirectory(route);
      cached = await readCached(cachePath, operational);
    } catch (error) {
      warnCache("read", error);
    }
    if (cached) {
      try {
        await assertSourceUnchanged(result.source, result.sourceSignature);
      } catch (error) {
        await cached.fileHandle.close().catch(() => {});
        throw error;
      }
      return {
        ...result,
        svg: false,
        ...cached,
        etag: quotedEtag(key),
        cacheStatus: "hit"
      };
    }

    if (!inFlight.has(key)) {
      const pending = limited(() =>
        computeRaster(
          result.source,
          route,
          operational,
          mediaType.format
        )
      ).then(async (buffer) => {
        await assertSourceUnchanged(result.source, result.sourceSignature);
        let stored = false;
        try {
          await ensureCacheDirectory(route);
          await writeCacheAtomic(cachePath, buffer);
          stored = true;
        } catch (error) {
          warnCache("write", error);
        }
        return { buffer, stored };
      }).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
    }
    const generated = await inFlight.get(key);
    const { buffer } = generated;
    return {
      ...result,
      svg: false,
      buffer,
      length: buffer.length,
      etag: quotedEtag(key),
      cacheStatus: generated.stored ? "miss" : "uncached"
    };
  }

  async function uploadDirectory(config) {
    const configuredMediaFolder = config.site?.media_folder || "content/media";
    return safeDirectory(rootDir, configuredMediaFolder, { create: true });
  }

  function validateProjectConfiguration(config, status = 500) {
    return imageProjectConfiguration(config, operational, status);
  }

  async function removeCollectionCaches(collectionNames) {
    for (const collection of new Set(collectionNames)) {
      try {
        await removeCollectionCacheDirectories(
          operational.cacheRoot,
          rootDir,
          collection
        );
      } catch (error) {
        warnCache(`cleanup for collection "${collection}"`, error);
      }
    }
  }

  return Object.freeze({
    info,
    raw,
    removeCollectionCaches,
    transformed,
    uploadDirectory,
    validateProjectConfiguration
  });
}

export {
  createImageService,
  detectImageFileType,
  resolveImageSource,
  resolveMediaSource
};
