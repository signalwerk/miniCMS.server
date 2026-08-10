import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ASSET_FILENAME } from "./media-contract.mjs";

const MAX_FILENAME_BYTES = 255;
const UPLOAD_TEMP_PATTERN = /^\.minicms-upload-\d+-[a-f0-9]{20}\.tmp$/;
const githubPublicationLocks = new Map();

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
  const filename = String(value ?? "").normalize("NFC");
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
    extension
  };
}

function normalizeUploadCollection(value) {
  const collection = String(value ?? "");
  if (
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

async function ensureUploadDirectory(mediaRoot, segments) {
  const trustedRoot = await fs.realpath(mediaRoot);
  let current = trustedRoot;
  for (const segment of segments) {
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

async function hashRegularFile(filePath) {
  const before = await fs.lstat(filePath, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw uploadError(409, "The stored media asset is invalid.");
  }
  const handle = await fs.open(filePath, "r");
  try {
    const opened = await handle.stat({ bigint: true });
    // Dropping the publisher's temporary hard link legitimately changes ctime
    // after asset.dat is visible. The verified digest below remains the source
    // of truth; inode, size, and mtime still guard replacement/content races.
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    ) {
      throw uploadError(409, "The stored media asset changed while it was verified.");
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
    }
    const finished = await handle.stat({ bigint: true });
    if (
      finished.dev !== opened.dev ||
      finished.ino !== opened.ino ||
      finished.size !== opened.size ||
      finished.mtimeNs !== opened.mtimeNs
    ) {
      throw uploadError(409, "The stored media asset changed while it was verified.");
    }
    return digest.digest("hex");
  } finally {
    await handle.close().catch(() => {});
  }
}

async function publishUpload(temporaryPath, directory, expectedHash) {
  await fs.chmod(temporaryPath, 0o644);
  const destination = path.join(directory, ASSET_FILENAME);
  try {
    // Linking publishes a complete file without replacing a concurrent upload.
    await fs.link(temporaryPath, destination);
    await fs.unlink(temporaryPath).catch(() => {});
    return { reused: false };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await hashRegularFile(destination) !== expectedHash) {
      throw uploadError(
        409,
        "The stored media asset does not match its content-addressed directory."
      );
    }
    return { reused: true };
  }
}

function truncateUtf8(value, maximumBytes) {
  let output = "";
  for (const character of value) {
    if (Buffer.byteLength(output + character, "utf8") > maximumBytes) break;
    output += character;
  }
  return output;
}

async function githubAssets(directory, expectedHash) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const filenames = [];
  const canonicalNames = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw uploadError(409, "The GitHub media directory is invalid.");
    }
    const filePath = path.join(directory, entry.name);
    if (await hashRegularFile(filePath) !== expectedHash) {
      throw uploadError(
        409,
        "A GitHub media file does not match its content-addressed directory."
      );
    }
    const { filename } = normalizeUploadFilename(entry.name);
    if (filename !== entry.name) {
      throw uploadError(
        409,
        "The GitHub media directory contains a filename that is not NFC-normalized."
      );
    }
    const canonicalKey = filename.toLowerCase();
    if (canonicalNames.has(canonicalKey)) {
      throw uploadError(
        409,
        "The GitHub media directory contains ambiguous normalized filenames."
      );
    }
    canonicalNames.add(canonicalKey);
    filenames.push(filename);
  }
  return filenames;
}

function availableGithubFilename(requested, existing) {
  const names = new Set(existing.map((name) => name.toLowerCase()));
  if (!names.has(requested.toLowerCase())) return requested;
  const extension = path.extname(requested);
  const stem = path.basename(requested, extension);
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const marker = `-${suffix}`;
    const maximumStemBytes = MAX_FILENAME_BYTES - Buffer.byteLength(marker + extension);
    const candidateStem = truncateUtf8(stem, maximumStemBytes).replace(/[._-]+$/u, "") || "file";
    const candidate = `${candidateStem}${marker}${extension}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  throw uploadError(409, "A unique GitHub media filename could not be allocated.");
}

async function publishGithubUpload(temporaryPath, directory, filename) {
  await fs.chmod(temporaryPath, 0o644);
  const destination = path.join(directory, filename);
  try {
    await fs.link(temporaryPath, destination);
    await fs.unlink(temporaryPath).catch(() => {});
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

async function withGithubPublicationLock(key, operation) {
  const previous = githubPublicationLocks.get(key) || Promise.resolve();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => pending);
  githubPublicationLocks.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (githubPublicationLocks.get(key) === tail) {
      githubPublicationLocks.delete(key);
    }
  }
}

async function streamMediaUpload({
  request,
  directory,
  collection,
  filename,
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
    const uploadDirectory = await ensureUploadDirectory(directory, [
      normalizedCollection,
      sha
    ]);
    const { reused } = await publishUpload(temporaryPath, uploadDirectory, sha);
    return {
      collection: normalizedCollection,
      filename,
      hash: sha,
      reused,
      size
    };
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

async function streamGithubMediaUpload({
  request,
  directory,
  filename,
  duplicate,
  maxBytes,
  validateTemporary
}) {
  if (![undefined, "reuse", "copy"].includes(duplicate)) {
    throw uploadError(400, "The duplicate upload choice is invalid.");
  }
  const { temporaryPath, size, sha } = await writeUploadTemporary(
    request,
    directory,
    maxBytes
  );
  try {
    await validateTemporary?.({ temporaryPath, sha, size });
    const uploadDirectory = await ensureUploadDirectory(directory, [sha]);
    return await withGithubPublicationLock(uploadDirectory, async () => {
      let existing = await githubAssets(uploadDirectory, sha);
      if (!existing.length) {
        if (await publishGithubUpload(temporaryPath, uploadDirectory, filename)) {
          return { filename, hash: sha, reused: false, size };
        }
        existing = await githubAssets(uploadDirectory, sha);
      }

      const existingFilename = existing[0];
      if (duplicate === "reuse") {
        return {
          filename: existingFilename,
          hash: sha,
          reused: true,
          size
        };
      }

      const copyFilename = availableGithubFilename(filename, existing);
      if (duplicate !== "copy") {
        return {
          duplicate: true,
          existingFilename,
          copyFilename,
          hash: sha,
          size
        };
      }

      let candidate = copyFilename;
      const attempted = [];
      while (!(await publishGithubUpload(
        temporaryPath,
        uploadDirectory,
        candidate
      ))) {
        attempted.push(candidate);
        existing = await githubAssets(uploadDirectory, sha);
        candidate = availableGithubFilename(filename, [...existing, ...attempted]);
      }
      return { filename: candidate, hash: sha, reused: false, size };
    });
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}

export {
  cleanUploadTemporaries,
  mediaUploadLimit,
  normalizeUploadFilename,
  streamGithubMediaUpload,
  streamMediaUpload
};
