import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requestError } from "./url.mjs";

const PHOTOSHOP_LAYER_DATA = 37724;
const MAX_DIRECTORY_ENTRIES = 4096;

// Remove only Photoshop's non-rendering layer blob from a private copy. TIFF
// pixel offsets, alpha, ICC, orientation and all other tags remain untouched.
// Large blobs can exhaust libtiff's cumulative 50 MB allocation budget even
// when the flattened image itself is small. Never disable decoder limits.
async function directoryWithoutLayers(handle) {
  const stat = await handle.stat();
  const read = async (offset, length) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > stat.size) {
      throw requestError(415, "The TIFF directory is invalid.");
    }
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, offset);
    if (result.bytesRead !== length) throw requestError(415, "The TIFF directory is truncated.");
    return buffer;
  };
  const header = await read(0, Math.min(16, stat.size));
  const order = header.toString("ascii", 0, 2);
  if (header.length < 8 || !["II", "MM"].includes(order)) {
    throw requestError(415, "The TIFF header is invalid.");
  }
  const little = order === "II";
  const uint16 = (buffer, offset) => little ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const uint32 = (buffer, offset) => little ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const uint64 = (buffer, offset) => Number(little ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset));
  const version = uint16(header, 2);
  const big = version === 43;
  if (version !== 42 && !big) throw requestError(415, "The TIFF version is unsupported.");
  if (big && (header.length < 16 || uint16(header, 4) !== 8 || uint16(header, 6) !== 0)) {
    throw requestError(415, "The BigTIFF header is invalid.");
  }
  const offset = big ? uint64(header, 8) : uint32(header, 4);
  const countBytes = big ? 8 : 2;
  const entryBytes = big ? 20 : 12;
  const pointerBytes = big ? 8 : 4;
  const countBuffer = await read(offset, countBytes);
  const count = big ? uint64(countBuffer, 0) : uint16(countBuffer, 0);
  if (!Number.isSafeInteger(count) || count > MAX_DIRECTORY_ENTRIES) {
    throw requestError(415, "The TIFF directory is too large.");
  }
  const directory = await read(offset + countBytes, count * entryBytes + pointerBytes);
  const retained = [];
  for (let index = 0; index < count; index += 1) {
    const entry = directory.subarray(index * entryBytes, (index + 1) * entryBytes);
    if (uint16(entry, 0) !== PHOTOSHOP_LAYER_DATA) retained.push(entry);
  }
  if (retained.length === count) return null;
  const replacement = Buffer.alloc(countBytes + directory.length);
  if (big) {
    if (little) replacement.writeBigUInt64LE(BigInt(retained.length));
    else replacement.writeBigUInt64BE(BigInt(retained.length));
  } else if (little) replacement.writeUInt16LE(retained.length);
  else replacement.writeUInt16BE(retained.length);
  for (let index = 0; index < retained.length; index += 1) {
    retained[index].copy(replacement, countBytes + index * entryBytes);
  }
  directory.subarray(count * entryBytes).copy(replacement, countBytes + retained.length * entryBytes);
  return { offset, replacement, size: stat.size };
}

async function withTiffPreviewSource(source, operational, consume) {
  const handle = await fs.open(source.path, "r");
  let patch;
  try {
    patch = await directoryWithoutLayers(handle);
  } finally {
    await handle.close();
  }
  if (!patch) return consume(source);
  if (patch.size > operational.maxInputPixels * 8 + 65536) {
    throw requestError(413, "The TIFF preview source is too large.");
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-tiff-"));
  try {
    const file = path.join(directory, "preview.tif");
    await fs.copyFile(source.path, file);
    const output = await fs.open(file, "r+");
    try {
      await output.write(patch.replacement, 0, patch.replacement.length, patch.offset);
    } finally {
      await output.close();
    }
    return await consume({ ...source, path: file });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export { withTiffPreviewSource };
