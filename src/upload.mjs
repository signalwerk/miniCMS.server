import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sanitizeFilenameStem } from "@signalwerk/minicms/core/slug";

const MAX_FILENAME_BYTES = 255;
const UPLOAD_TEMP_PATTERN = /^\.minicms-upload-\d+-[a-f0-9]{20}\.tmp$/;

function uploadError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function mediaUploadLimit(environment = process.env) {
  const source = environment.MINICMS_MEDIA_MAX_UPLOAD_BYTES;
  const value = source === undefined || source === ""
    ? 512 * 1024 * 1024
    : Number(source);
  if (
    !Number.isSafeInteger(value) ||
    value < 1024 ||
    value > 4 * 1024 * 1024 * 1024
  ) {
    throw new Error(
      "MINICMS_MEDIA_MAX_UPLOAD_BYTES must be an integer from 1024 through 4294967296."
    );
  }
  return value;
}

function normalizeUploadFilename(value) {
  const filename = String(value ?? "");
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    Buffer.byteLength(filename, "utf8") > MAX_FILENAME_BYTES ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw uploadError(400, "The upload filename is invalid.");
  }
  const extension = path.extname(filename).toLowerCase();
  if (extension && !/^\.[a-z0-9][a-z0-9_-]{0,31}$/.test(extension)) {
    throw uploadError(400, "The upload filename has an invalid extension.");
  }
  return {
    filename,
    extension,
    base: sanitizeFilenameStem(
      path.basename(filename, extension),
      "image"
    )
  };
}

function normalizeUploadCollection(value) {
  const collection = String(value ?? "");
  if (
    collection === "_image" ||
    Buffer.byteLength(collection, "utf8") > 255 ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(collection)
  ) {
    throw uploadError(400, "The upload collection is invalid.");
  }
  return collection;
}

function declaredLength(request) {
  const value = request.get("content-length");
  if (value === undefined) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw uploadError(400, "The upload Content-Length is invalid.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw uploadError(413, "The uploaded file is too large.");
  }
  return length;
}

async function writeChunk(handle, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(
      buffer,
      offset,
      buffer.length - offset,
      null
    );
    if (!bytesWritten) throw new Error("The upload could not be written.");
    offset += bytesWritten;
  }
  return buffer.length;
}

async function writeUploadTemporary(request, directory, maxBytes) {
  const length = declaredLength(request);
  if (length !== null && length > maxBytes) {
    throw uploadError(413, `Uploads must be no larger than ${maxBytes} bytes.`);
  }
  const temporaryPath = path.join(
    directory,
    `.minicms-upload-${process.pid}-${randomBytes(10).toString("hex")}.tmp`
  );
  const handle = await fs.open(temporaryPath, "wx", 0o600);
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) {
        throw uploadError(413, `Uploads must be no larger than ${maxBytes} bytes.`);
      }
      digest.update(buffer);
      await writeChunk(handle, buffer);
    }
    if (!size) throw uploadError(400, "The uploaded file is empty.");
    await handle.sync();
    return { temporaryPath, size, sha: digest.digest("hex") };
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function cleanUploadTemporaries(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && UPLOAD_TEMP_PATTERN.test(entry.name)
      )
      .map((entry) =>
        fs.unlink(path.join(directory, entry.name)).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        })
      )
  );
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function ensureUploadDirectory(mediaRoot, collection, sha) {
  const trustedRoot = await fs.realpath(mediaRoot);
  let current = trustedRoot;
  for (const segment of [collection, sha]) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current, { mode: 0o755 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw uploadError(409, "The media upload directory is invalid.");
    }
    const real = await fs.realpath(current);
    if (!isInside(trustedRoot, real)) {
      throw uploadError(409, "The media upload directory is invalid.");
    }
    current = real;
  }
  return current;
}

async function publishUpload(
  temporaryPath,
  directory,
  { base, extension }
) {
  const existingNames = new Set(
    (await fs.readdir(directory)).map((name) => name.toLowerCase())
  );
  await fs.chmod(temporaryPath, 0o644);
  let suffix = 1;
  while (true) {
    const numericSuffix = suffix === 1 ? "" : `-${suffix}`;
    const maximumBaseLength =
      MAX_FILENAME_BYTES - numericSuffix.length - extension.length;
    const candidateBase =
      base.slice(0, maximumBaseLength).replace(/[._-]+$/g, "") || "image";
    const filename = `${candidateBase}${numericSuffix}${extension}`;
    suffix += 1;
    if (existingNames.has(filename.toLowerCase())) continue;
    const destination = path.join(directory, filename);
    try {
      // Linking publishes without replacing a file created by a concurrent
      // upload. Both paths live in the same configured media filesystem.
      await fs.link(temporaryPath, destination);
      // The link is the commit point. A failed temporary-file cleanup must not
      // report a failed upload after the destination is already visible.
      await fs.unlink(temporaryPath).catch(() => {});
      return filename;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      existingNames.add(filename.toLowerCase());
    }
  }
}

async function streamMediaUpload({
  request,
  directory,
  collection,
  base,
  extension,
  maxBytes,
  validateTemporary
}) {
  const normalizedCollection = normalizeUploadCollection(collection);
  const { temporaryPath, size, sha } = await writeUploadTemporary(
    request,
    directory,
    maxBytes
  );
  try {
    await validateTemporary?.({ temporaryPath, sha, size });
    const uploadDirectory = await ensureUploadDirectory(
      directory,
      normalizedCollection,
      sha
    );
    const filename = await publishUpload(temporaryPath, uploadDirectory, {
      base,
      extension
    });
    return { collection: normalizedCollection, filename, sha, size };
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

export {
  cleanUploadTemporaries,
  mediaUploadLimit,
  normalizeUploadFilename,
  streamMediaUpload
};
