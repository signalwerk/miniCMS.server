import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { parseYaml } from "@signalwerk/minicms/core/content";
import { buildPlan, executePlan } from "../bin/migrate-image-assets.mjs";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createApiProject(prefix = "minicms-migrate-") {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(rootDir, "content"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "cms.config.yml"),
    `connectors:
  default: { name: api, api_url: https://api.example.com, auth_url: https://auth.example.com }
site: { media_folder: content/media }
node_types:
  page:
    kind: document
    fields: { title: { widget: string } }
collections:
  pages:
    folder: content/pages
    node_type: page
`
  );
  return rootDir;
}

async function createImageMigrationProject(imageValue) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-migrate-image-value-"));
  const bytes = Buffer.from("image bytes");
  const imageHash = hash(bytes);
  await fs.mkdir(path.join(rootDir, "content", "images"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "content", "media", "images", imageHash), {
    recursive: true
  });
  await fs.writeFile(
    path.join(rootDir, "cms.config.yml"),
    `connectors:
  default: { name: api, api_url: https://api.example.com, auth_url: https://auth.example.com }
site:
  media_folder: content/media
  public_folder: /media
node_types:
  image:
    kind: document
    fields:
      image: { widget: image }
collections:
  images:
    folder: content/images
    node_type: image
`
  );
  await fs.writeFile(
    path.join(rootDir, "content", "images", "image.yml"),
    `id: image
type: image
properties:
  image:
${imageValue.replaceAll("HASH", imageHash).split("\n").map((line) => `    ${line}`).join("\n")}
slots: {}
`
  );
  await fs.writeFile(
    path.join(rootDir, "content", "media", "images", imageHash, "original.png"),
    bytes
  );
  return { rootDir, imageHash };
}

test("migration rejects a cache root that contains the project", async () => {
  for (const getCacheDir of [
    (rootDir) => path.parse(rootDir).root,
    (rootDir) => path.dirname(rootDir),
    (rootDir) => rootDir
  ]) {
    const rootDir = await createApiProject("minicms-migrate-cache-safety-");
    await assert.rejects(
      buildPlan(rootDir, { cacheDir: getCacheDir(rootDir) }),
      /may not contain the project root/
    );
  }
});

test("migration rejects a cache reached through a symlink ancestor into content", async () => {
  const rootDir = await createApiProject("minicms-migrate-cache-link-");
  const aliasRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-migrate-cache-alias-"));
  await fs.mkdir(path.join(rootDir, "content", "cache"));
  await fs.symlink(path.join(rootDir, "content"), path.join(aliasRoot, "linked-content"));
  await assert.rejects(
    buildPlan(rootDir, { cacheDir: path.join(aliasRoot, "linked-content", "cache") }),
    /outside content/
  );
});

test("migration rejects a backup reached through a symlink parent into the project", async () => {
  const rootDir = await createApiProject("minicms-migrate-backup-link-");
  const cacheDir = `${rootDir}-cache`;
  const aliasRoot = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-migrate-backup-alias-"));
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, "old.webp"), "cache");
  await fs.symlink(rootDir, path.join(aliasRoot, "linked-project"));
  const plan = await buildPlan(rootDir, { cacheDir });
  await assert.rejects(
    executePlan(plan, path.join(aliasRoot, "linked-project", "backup")),
    /outside the project root/
  );
});

test("migration aborts without deleting cache files added after preflight", async () => {
  const rootDir = await createApiProject("minicms-migrate-cache-drift-");
  const cacheDir = `${rootDir}-cache`;
  const backupDir = `${rootDir}-backup`;
  await fs.mkdir(cacheDir);
  await fs.writeFile(path.join(cacheDir, "old.webp"), "old cache");
  const plan = await buildPlan(rootDir, { cacheDir });
  await fs.writeFile(path.join(cacheDir, "late.webp"), "late cache");
  await assert.rejects(
    executePlan(plan, backupDir),
    /cache changed after preflight/
  );
  assert.equal(await fs.readFile(path.join(cacheDir, "old.webp"), "utf8"), "old cache");
  assert.equal(await fs.readFile(path.join(cacheDir, "late.webp"), "utf8"), "late cache");
  assert.equal(
    await fs.readFile(path.join(backupDir, "cache", "old.webp"), "utf8"),
    "old cache"
  );
});

test("migration derives identity only from a string src", async () => {
  const { rootDir, imageHash } = await createImageMigrationProject(
    `src: /media/images/HASH/original.png
hash: ${"b".repeat(64)}
filename: wrong.png
path: /media/images/${"c".repeat(64)}/wrong.png
sha: ${"d".repeat(64)}
width: 10
future_metadata: { color: blue }`
  );
  const plan = await buildPlan(rootDir);
  assert.deepEqual(plan.records[0].next.properties.image, {
    hash: imageHash,
    filename: "original.png",
    width: 10,
    future_metadata: { color: "blue" }
  });

  const invalid = await createImageMigrationProject(
    `src: null
hash: HASH
filename: original.png`
  );
  await assert.rejects(buildPlan(invalid.rootDir), /\.src must be a string/);

  const legacyIdentity = await createImageMigrationProject(
    `hash: HASH
filename: original.png
path: /media/images/HASH/original.png`
  );
  await assert.rejects(
    buildPlan(legacyIdentity.rootDir),
    /must be empty or contain a hash and original filename/
  );
});

test("preflights and performs the offline strict image/asset migration once", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-migrate-"));
  const backupDir = `${rootDir}-backup`;
  const cacheDir = `${rootDir}-cache`;
  const imageBytes = Buffer.from("png bytes");
  const svgBytes = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>");
  const imageHash = hash(imageBytes);
  const svgHash = hash(svgBytes);
  await fs.mkdir(path.join(rootDir, "content", "images"), { recursive: true });
  await fs.mkdir(path.join(cacheDir, "v1", "media"), { recursive: true });
  await fs.writeFile(path.join(cacheDir, "v1", "media", "old.webp"), "cache");
  await fs.mkdir(path.join(rootDir, "content", "media", "images", imageHash), {
    recursive: true
  });
  await fs.mkdir(path.join(rootDir, "content", "media", "images", svgHash), {
    recursive: true
  });
  await fs.writeFile(
    path.join(rootDir, "cms.config.yml"),
    `connectors:
  default: { name: api, api_url: https://api.example.com, auth_url: https://auth.example.com }
site:
  media_folder: content/media
  public_folder: /media
node_types:
  image:
    kind: document
    fields:
      image: { widget: image }
collections:
  images:
    folder: content/images
    node_type: image
`
  );
  await fs.writeFile(
    path.join(rootDir, "content", "images", "annotated.yml"),
    `id: annotated
type: image
properties:
  image:
    src: /media/images/${imageHash}/Screenshot 2026.png
    width: 100
    height: 80
    regions:
      - { id: abcdefghijklmno, x: 1, y: 2, width: 3, height: 4 }
    points: []
slots: {}
`
  );
  await fs.writeFile(
    path.join(rootDir, "content", "images", "scalar.yml"),
    `id: scalar
type: image
properties:
  image: /media/images/${svgHash}/ghostscript_tiger-2.svg
slots: {}
`
  );
  await fs.writeFile(
    path.join(rootDir, "content", "media", "images", imageHash, "Screenshot 2026.png"),
    imageBytes
  );
  await fs.writeFile(
    path.join(rootDir, "content", "media", "images", svgHash, "ghostscript_tiger-2.svg"),
    svgBytes
  );
  await fs.writeFile(
    path.join(rootDir, "content", "media", "images", svgHash, "ghostscript_tiger.svg"),
    svgBytes
  );

  const plan = await buildPlan(rootDir, { cacheDir });
  assert.equal(plan.records.length, 2);
  assert.equal(plan.assets.length, 2);
  assert.equal(plan.assets.reduce((count, asset) => count + asset.remove.length, 0), 3);
  assert.equal(plan.cacheFiles.length, 1);
  await executePlan(plan, backupDir);

  const annotated = parseYaml(
    await fs.readFile(path.join(rootDir, "content", "images", "annotated.yml"), "utf8")
  );
  assert.deepEqual(annotated.properties.image, {
    hash: imageHash,
    filename: "Screenshot 2026.png",
    width: 100,
    height: 80,
    regions: [{ id: "abcdefghijklmno", x: 1, y: 2, width: 3, height: 4 }],
    points: []
  });
  const scalar = parseYaml(
    await fs.readFile(path.join(rootDir, "content", "images", "scalar.yml"), "utf8")
  );
  assert.deepEqual(scalar.properties.image, {
    hash: svgHash,
    filename: "ghostscript_tiger-2.svg"
  });
  assert.deepEqual(
    await fs.readdir(path.join(rootDir, "content", "media", "images", svgHash)),
    ["asset.dat"]
  );
  assert.deepEqual(
    await fs.readFile(path.join(rootDir, "content", "media", "images", imageHash, "asset.dat")),
    imageBytes
  );
  await fs.access(path.join(backupDir, "manifest.json"));
  assert.equal((await fs.readdir(cacheDir)).length, 0);
  assert.equal(
    await fs.readFile(path.join(backupDir, "cache", "v1", "media", "old.webp"), "utf8"),
    "cache"
  );

  const current = await buildPlan(rootDir, { cacheDir });
  assert.equal(current.records.length, 0);
  assert.equal(current.assets.some((asset) => asset.create || asset.remove.length), false);
});

test("migration rejects a hash directory whose bytes do not match its name", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-migrate-bad-"));
  const wrongHash = "a".repeat(64);
  await fs.mkdir(path.join(rootDir, "content", "media", "images", wrongHash), {
    recursive: true
  });
  await fs.writeFile(path.join(rootDir, "content", "images.yml"), "unused");
  await fs.writeFile(
    path.join(rootDir, "cms.config.yml"),
    `connectors:
  default: { name: api, api_url: https://api.example.com, auth_url: https://auth.example.com }
site: { media_folder: content/media }
node_types:
  page:
    kind: document
    fields: { title: { widget: string } }
collections:
  pages:
    folder: content/pages
    node_type: page
`
  );
  await fs.writeFile(
    path.join(rootDir, "content", "media", "images", wrongHash, "wrong.png"),
    "different"
  );
  await assert.rejects(buildPlan(rootDir), /has SHA-256/);
});
