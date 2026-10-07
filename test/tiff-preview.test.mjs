import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withTiffPreviewSource } from "../src/image/tiff-preview.mjs";

function fixture({ big, little, layers = true }) {
  const offset = big ? 16 : 8;
  const countBytes = big ? 8 : 2;
  const entryBytes = big ? 20 : 12;
  const pointerBytes = big ? 8 : 4;
  const tags = layers ? [256, 34675, 37724] : [256, 34675];
  const payload = offset + countBytes + tags.length * entryBytes + pointerBytes;
  const data = Buffer.alloc(payload + 16);
  const set16 = (value, position) => little ? data.writeUInt16LE(value, position) : data.writeUInt16BE(value, position);
  const set32 = (value, position) => little ? data.writeUInt32LE(value, position) : data.writeUInt32BE(value, position);
  const set64 = (value, position) => little ? data.writeBigUInt64LE(BigInt(value), position) : data.writeBigUInt64BE(BigInt(value), position);
  data.write(little ? "II" : "MM");
  set16(big ? 43 : 42, 2);
  if (big) { set16(8, 4); set64(offset, 8); set64(tags.length, offset); }
  else { set32(offset, 4); set16(tags.length, offset); }
  for (let index = 0; index < tags.length; index += 1) {
    const entry = offset + countBytes + index * entryBytes;
    set16(tags[index], entry);
    set16(tags[index] === 256 ? 4 : 7, entry + 2);
    const count = tags[index] === 256 ? 1 : 8;
    const value = tags[index] === 256 ? 1782 : payload + (tags[index] === 37724 ? 8 : 0);
    if (big) { set64(count, entry + 4); set64(value, entry + 12); }
    else { set32(count, entry + 4); set32(value, entry + 8); }
  }
  data.write("ICC dataLAYERS!!", payload);
  return { data, offset, countBytes, entryBytes, pointerBytes };
}

for (const big of [false, true]) {
  for (const little of [false, true]) {
    test(`TIFF preview preserves ICC/payload and removes layer tag (${big ? "BigTIFF" : "classic"}, ${little ? "LE" : "BE"})`, async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tiff-preview-test-"));
      const file = path.join(directory, "source.tif");
      const f = fixture({ big, little });
      let temporary;
      try {
        await fs.writeFile(file, f.data);
        await withTiffPreviewSource({ path: file }, { maxInputPixels: 1_000_000 }, async source => {
          temporary = source.path;
          assert.notEqual(temporary, file);
          const actual = await fs.readFile(temporary);
          const readCount = big
            ? Number(little ? actual.readBigUInt64LE(f.offset) : actual.readBigUInt64BE(f.offset))
            : little ? actual.readUInt16LE(f.offset) : actual.readUInt16BE(f.offset);
          assert.equal(readCount, 2);
          const start = f.offset + f.countBytes;
          assert.deepEqual(actual.subarray(start, start + 2 * f.entryBytes), f.data.subarray(start, start + 2 * f.entryBytes));
          assert.equal(actual.length, f.data.length);
          assert.deepEqual(actual.subarray(-16), f.data.subarray(-16));
        });
        await assert.rejects(fs.access(temporary), { code: "ENOENT" });
        assert.deepEqual(await fs.readFile(file), f.data);
        await assert.rejects(withTiffPreviewSource({ path: file }, { maxInputPixels: 1_000_000 }, async source => {
          temporary = source.path;
          throw new Error("decode failed");
        }), /decode failed/);
        await assert.rejects(fs.access(temporary), { code: "ENOENT" });
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  }
}

test("TIFF preview leaves ordinary TIFFs alone and bounds malformed directory reads", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tiff-preview-test-"));
  const file = path.join(directory, "source.tif");
  try {
    const f = fixture({ big: false, little: true, layers: false });
    await fs.writeFile(file, f.data);
    await withTiffPreviewSource({ path: file }, { maxInputPixels: 1_000_000 }, source => assert.equal(source.path, file));
    f.data.writeUInt16LE(65535, f.offset);
    await fs.writeFile(file, f.data);
    await assert.rejects(withTiffPreviewSource({ path: file }, { maxInputPixels: 1_000_000 }, () => assert.fail()), { status: 415 });
    f.data.writeUInt16LE(2, f.offset);
    f.data.writeUInt32LE(0xfffffff0, 4);
    await fs.writeFile(file, f.data);
    await assert.rejects(withTiffPreviewSource({ path: file }, { maxInputPixels: 1_000_000 }, () => assert.fail()), { status: 415 });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
