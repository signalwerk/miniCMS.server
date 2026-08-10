#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dumpYaml,
  parseYaml,
  validateRecord
} from "@signalwerk/minicms/core/content";
import {
  isRemoteCollection,
  validateSourceConfig
} from "@signalwerk/minicms/core/connectors";
import { ASSET_FILENAME, mediaStorageMode } from "../src/media-contract.mjs";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IMAGE_IDENTITY_KEYS = new Set(["src", "hash", "filename", "path", "sha"]);

function migrationError(message) {
  const error = new Error(message);
  error.name = "MediaMigrationError";
  return error;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function resolvePhysicalPath(value) {
  let current = path.resolve(value);
  const missingSegments = [];
  while (true) {
    try {
      const resolved = await fs.realpath(current);
      return path.join(resolved, ...missingSegments);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

function normalizedFilename(value, label) {
  const filename = String(value ?? "").normalize("NFC");
  if (
    !filename ||
    filename === "." ||
    filename === ".." ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    /[\\/\u0000-\u001f\u007f]/.test(filename)
  ) {
    throw migrationError(`${label} has an invalid original filename.`);
  }
  return filename;
}

function decodeFilename(value, label) {
  try {
    return normalizedFilename(decodeURIComponent(value), label);
  } catch (error) {
    if (error.name === "MediaMigrationError") throw error;
    throw migrationError(`${label} has invalid URL encoding.`);
  }
}

function referenceSegments(value, config, label) {
  const mediaFolder = String(
    config.site?.media_folder || "content/media"
  ).replace(/^\/+|\/+$/g, "");
  const normalizedValue = typeof value === "string"
    ? value.replace(/^\/+/, "")
    : "";
  const isStorageValue = normalizedValue.startsWith(`${mediaFolder}/`);
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) ||
    (!isStorageValue && (value.includes("?") || value.includes("#"))) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw migrationError(`${label} is not an unambiguous local media path.`);
  }
  let relative = value.replace(/^\/+|\/+$/g, "");
  let storageReference = false;
  const prefixes = new Set([
    mediaFolder,
    String(config.site?.public_folder || "/media").replace(/^\/+|\/+$/g, ""),
    "media"
  ]);
  for (const prefix of prefixes) {
    if (relative.startsWith(`${prefix}/`)) {
      relative = relative.slice(prefix.length + 1);
      storageReference = prefix === mediaFolder;
      break;
    }
  }
  const segments = relative.split("/");
  if (
    segments.length !== 3 ||
    !/^[a-z0-9][a-z0-9._-]*$/i.test(segments[0]) ||
    !HASH_PATTERN.test(segments[1])
  ) {
    throw migrationError(
      `${label} must use <public-folder>/<collection>/<sha256>/<filename>.`
    );
  }
  return {
    collection: segments[0],
    hash: segments[1],
    filename: storageReference
      ? normalizedFilename(segments[2], label)
      : decodeFilename(segments[2], label)
  };
}

function encodePathFilename(filename) {
  return encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function migrateImageValue(value, config, collectionName, label) {
  if (value === undefined || value === null || value === "") {
    return { value, reference: null, changed: false };
  }
  if (typeof value === "string") {
    const reference = referenceSegments(value, config, label);
    if (reference.collection !== collectionName) {
      throw migrationError(
        `${label} points to collection "${reference.collection}" instead of its owning collection "${collectionName}".`
      );
    }
    return {
      value: { hash: reference.hash, filename: reference.filename },
      reference,
      changed: true
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError(`${label} has an invalid image value.`);
  }
  if (Object.hasOwn(value, "src")) {
    if (typeof value.src !== "string") {
      throw migrationError(`${label}.src must be a string.`);
    }
    const reference = referenceSegments(value.src, config, label);
    if (reference.collection !== collectionName) {
      throw migrationError(
        `${label} points to collection "${reference.collection}" instead of its owning collection "${collectionName}".`
      );
    }
    const annotations = Object.fromEntries(
      Object.entries(value).filter(([key]) => !IMAGE_IDENTITY_KEYS.has(key))
    );
    return {
      value: {
        hash: reference.hash,
        filename: reference.filename,
        ...annotations
      },
      reference,
      changed: true
    };
  }
  if (!HASH_PATTERN.test(value.hash) || typeof value.filename !== "string") {
    throw migrationError(`${label} is neither an old image path nor a strict image asset.`);
  }
  const filename = normalizedFilename(value.filename, label);
  const normalized = { ...value, filename };
  return {
    value: normalized,
    reference: { collection: collectionName, hash: value.hash, filename },
    changed: filename !== value.filename
  };
}

function migrateNode(node, config, collectionName, label, references) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    throw migrationError(`${label} is not a valid record node.`);
  }
  const type = config.node_types?.[node.type];
  if (!type) throw migrationError(`${label} uses unknown type "${node.type}".`);
  let changed = false;
  for (const [fieldName, field] of Object.entries(type.fields || {})) {
    const value = node.properties?.[fieldName];
    const fieldLabel = `${label}.properties.${fieldName}`;
    if (field.widget === "image") {
      const migrated = migrateImageValue(
        value,
        config,
        collectionName,
        fieldLabel
      );
      if (migrated.reference) references.push(migrated.reference);
      if (migrated.changed) {
        node.properties ??= {};
        node.properties[fieldName] = migrated.value;
        changed = true;
      }
    } else if (field.widget === "file" && value) {
      const reference = referenceSegments(value, config, fieldLabel);
      references.push(reference);
      const publicFolder = String(config.site?.public_folder || "/media").replace(/\/$/, "");
      const canonical = `${publicFolder}/${reference.collection}/${reference.hash}/${encodePathFilename(reference.filename)}`;
      if (canonical !== value) {
        node.properties[fieldName] = canonical;
        changed = true;
      }
    }
  }
  for (const [slotName, children] of Object.entries(node.slots || {})) {
    if (!Array.isArray(children)) {
      throw migrationError(`${label}.slots.${slotName} is not an array.`);
    }
    children.forEach((child, index) => {
      if (migrateNode(
        child,
        config,
        collectionName,
        `${label}.slots.${slotName}[${index}]`,
        references
      )) changed = true;
    });
  }
  return changed;
}

async function hashFile(filePath) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw migrationError(`${filePath} is not a regular non-symlink file.`);
  }
  const handle = await fs.open(filePath, "r");
  try {
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      digest.update(chunk);
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

async function existingDirectory(directory, label, { optional = false } = {}) {
  const stat = await fs.lstat(directory).catch((error) => {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  });
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw migrationError(`${label} is not a regular non-symlink directory.`);
  }
  return true;
}

async function cacheInventory(cacheRoot) {
  if (!cacheRoot) return [];
  if (!(await existingDirectory(cacheRoot, "Image cache", { optional: true }))) {
    return [];
  }
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw migrationError(`${entryPath} is a symbolic link inside the image cache.`);
      }
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push(entryPath);
      else throw migrationError(`${entryPath} is not a regular cache entry.`);
    }
  }
  await visit(cacheRoot);
  return files;
}

async function assertCacheInventoryUnchanged(plan) {
  if (!plan.cacheRoot) return;
  const planned = [...plan.cacheFiles].sort();
  const current = (await cacheInventory(plan.cacheRoot)).sort();
  if (
    planned.length !== current.length ||
    planned.some((filePath, index) => filePath !== current[index])
  ) {
    throw migrationError(
      "The image cache changed after preflight; refusing unbacked cleanup."
    );
  }
}

async function removePreflightedCacheFiles(plan) {
  const directories = new Set();
  for (const filePath of plan.cacheFiles) {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw migrationError(`${filePath} changed before cache cleanup.`);
    }
    await fs.unlink(filePath);
    let directory = path.dirname(filePath);
    while (directory !== plan.cacheRoot && isInside(plan.cacheRoot, directory)) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...directories].sort(
    (left, right) => right.split(path.sep).length - left.split(path.sep).length
  )) {
    await fs.rmdir(directory).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    });
  }
}

async function buildPlan(rootDir, { cacheDir = "" } = {}) {
  const projectRoot = path.resolve(rootDir);
  await existingDirectory(projectRoot, "Project root");
  const trustedProjectRoot = await fs.realpath(projectRoot);
  const configPath = path.join(projectRoot, "cms.config.yml");
  const config = parseYaml(await fs.readFile(configPath, "utf8"));
  validateSourceConfig(config);
  if (mediaStorageMode(config) !== "api") {
    throw migrationError("This migration is only for projects owned by an API connector.");
  }
  const contentRoot = path.join(projectRoot, "content");
  const mediaRoot = path.resolve(
    projectRoot,
    config.site?.media_folder || "content/media"
  );
  if (mediaRoot === contentRoot || !isInside(contentRoot, mediaRoot)) {
    throw migrationError("site.media_folder must be strictly inside content/.");
  }
  const requestedCacheRoot = cacheDir ? path.resolve(cacheDir) : null;
  if (
    requestedCacheRoot &&
    (
      requestedCacheRoot === path.parse(requestedCacheRoot).root ||
      isInside(requestedCacheRoot, projectRoot) ||
      isInside(contentRoot, requestedCacheRoot)
    )
  ) {
    throw migrationError(
      "The image cache must be an exact directory outside content/ and may not contain the project root."
    );
  }
  await existingDirectory(contentRoot, "content/");
  const trustedContentRoot = await fs.realpath(contentRoot);
  let cacheRoot = null;
  if (requestedCacheRoot) {
    await existingDirectory(requestedCacheRoot, "Image cache", { optional: true });
    cacheRoot = await resolvePhysicalPath(requestedCacheRoot);
    if (
      cacheRoot === path.parse(cacheRoot).root ||
      isInside(cacheRoot, trustedProjectRoot) ||
      isInside(trustedContentRoot, cacheRoot)
    ) {
      throw migrationError(
        "The image cache must be an exact directory outside content/ and may not contain the project root."
      );
    }
  }
  const mediaExists = await existingDirectory(mediaRoot, "site.media_folder", {
    optional: true
  });
  if (
    mediaExists &&
    !isInside(trustedContentRoot, await fs.realpath(mediaRoot))
  ) {
    throw migrationError("site.media_folder resolves outside content/.");
  }

  const records = [];
  const references = [];
  for (const [collectionName, collection] of Object.entries(config.collections || {})) {
    if (isRemoteCollection(collection)) continue;
    const folder = path.resolve(projectRoot, collection.folder);
    if (!isInside(contentRoot, folder)) {
      throw migrationError(`Collection "${collectionName}" is outside content/.`);
    }
    if (!(await existingDirectory(folder, `Collection "${collectionName}"`, { optional: true }))) {
      continue;
    }
    if (!isInside(trustedContentRoot, await fs.realpath(folder))) {
      throw migrationError(`Collection "${collectionName}" resolves outside content/.`);
    }
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
      const filePath = path.join(folder, entry.name);
      const recordStat = await fs.lstat(filePath);
      if (recordStat.isSymbolicLink() || !recordStat.isFile()) {
        throw migrationError(`${filePath} is not a regular record file.`);
      }
      const source = await fs.readFile(filePath, "utf8");
      const record = parseYaml(source);
      const next = structuredClone(record);
      const recordReferences = [];
      const changed = migrateNode(
        next,
        config,
        collectionName,
        `${collectionName}/${entry.name}`,
        recordReferences
      );
      validateRecord(next, { ...collection, name: collectionName }, config);
      references.push(...recordReferences);
      if (changed) records.push({
        filePath,
        source,
        next,
        output: dumpYaml(next),
        mode: recordStat.mode & 0o777
      });
    }
  }

  const assets = [];
  if (mediaExists) {
    for (const collectionEntry of await fs.readdir(mediaRoot, { withFileTypes: true })) {
      if (!collectionEntry.isDirectory() || collectionEntry.isSymbolicLink()) {
        throw migrationError(`${collectionEntry.name} is invalid inside site.media_folder.`);
      }
      const collectionDirectory = path.join(mediaRoot, collectionEntry.name);
      for (const hashEntry of await fs.readdir(collectionDirectory, { withFileTypes: true })) {
        if (!hashEntry.isDirectory() || hashEntry.isSymbolicLink() || !HASH_PATTERN.test(hashEntry.name)) {
          throw migrationError(`${collectionEntry.name}/${hashEntry.name} is not a valid hash directory.`);
        }
        const directory = path.join(collectionDirectory, hashEntry.name);
        const filenames = (await fs.readdir(directory, { withFileTypes: true })).map((entry) => {
          if (!entry.isFile() || entry.isSymbolicLink()) {
            throw migrationError(`${collectionEntry.name}/${hashEntry.name}/${entry.name} is not a regular file.`);
          }
          return entry.name;
        });
        if (!filenames.length) throw migrationError(`${directory} is empty.`);
        for (const filename of filenames) {
          const actual = await hashFile(path.join(directory, filename));
          if (actual !== hashEntry.name) {
            throw migrationError(`${collectionEntry.name}/${hashEntry.name}/${filename} has SHA-256 ${actual}.`);
          }
        }
        const legacy = filenames.filter((filename) => filename !== ASSET_FILENAME);
        assets.push({
          collection: collectionEntry.name,
          hash: hashEntry.name,
          directory,
          source: path.join(directory, filenames.includes(ASSET_FILENAME) ? ASSET_FILENAME : legacy[0]),
          destination: path.join(directory, ASSET_FILENAME),
          create: !filenames.includes(ASSET_FILENAME),
          remove: legacy.map((filename) => path.join(directory, filename))
        });
      }
    }
  }

  const identities = new Set(assets.map(({ collection, hash }) => `${collection}/${hash}`));
  for (const reference of references) {
    if (!identities.has(`${reference.collection}/${reference.hash}`)) {
      throw migrationError(
        `Record media ${reference.collection}/${reference.hash}/${reference.filename} has no physical hash directory.`
      );
    }
  }
  const cacheFiles = await cacheInventory(cacheRoot);
  return {
    projectRoot,
    trustedProjectRoot,
    configPath,
    mediaRoot,
    cacheRoot,
    cacheFiles,
    records,
    references,
    assets
  };
}

async function copyBackup(plan, backupDir) {
  const backupRoot = path.resolve(backupDir);
  const trustedBackupRoot = await resolvePhysicalPath(backupRoot);
  if (isInside(plan.trustedProjectRoot, trustedBackupRoot)) {
    throw migrationError("The backup directory must be outside the project root.");
  }
  if (
    plan.cacheRoot &&
    (
      isInside(plan.cacheRoot, trustedBackupRoot) ||
      isInside(trustedBackupRoot, plan.cacheRoot)
    )
  ) {
    throw migrationError("The backup directory and image cache must not overlap.");
  }
  await fs.mkdir(backupRoot, { recursive: false });
  if (await fs.realpath(backupRoot) !== trustedBackupRoot) {
    throw migrationError("The backup directory changed while it was being created.");
  }
  const copied = new Set();
  for (const filePath of [
    ...plan.records.map(({ filePath: recordPath }) => recordPath),
    ...plan.assets.flatMap(({ remove }) => remove)
  ]) {
    if (copied.has(filePath)) continue;
    copied.add(filePath);
    const relative = path.relative(plan.projectRoot, filePath);
    const destination = path.join(trustedBackupRoot, "project", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(filePath, destination, fsConstants.COPYFILE_EXCL);
  }
  for (const filePath of plan.cacheFiles) {
    const relative = path.relative(plan.cacheRoot, filePath);
    const destination = path.join(trustedBackupRoot, "cache", relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(filePath, destination, fsConstants.COPYFILE_EXCL);
  }
  await fs.writeFile(
    path.join(trustedBackupRoot, "manifest.json"),
    `${JSON.stringify({
      created_at: new Date().toISOString(),
      project_root: plan.projectRoot,
      records: plan.records.map(({ filePath }) => path.relative(plan.projectRoot, filePath)),
      assets: plan.assets.map(({ collection, hash, remove }) => ({
        collection,
        hash,
        removed: remove.map((filePath) => path.basename(filePath))
      })),
      cache_root: plan.cacheRoot,
      cache_entries: plan.cacheFiles.map((filePath) =>
        path.relative(plan.cacheRoot, filePath)
      )
    }, null, 2)}\n`,
    { flag: "wx" }
  );
  return trustedBackupRoot;
}

async function writeYamlAtomic(filePath, output, mode) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.migration.tmp`
  );
  try {
    await fs.writeFile(temporary, output, { flag: "wx", mode });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

async function executePlan(plan, backupDir) {
  const changedAssets = plan.assets.filter(({ create, remove }) => create || remove.length);
  if (!plan.records.length && !changedAssets.length && !plan.cacheFiles.length) {
    return { backupRoot: null };
  }
  const backupRoot = await copyBackup(plan, backupDir);
  for (const asset of plan.assets) {
    if (!asset.create) continue;
    try {
      await fs.link(asset.source, asset.destination);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await hashFile(asset.destination) !== asset.hash) {
        throw migrationError(`${asset.destination} appeared with the wrong hash.`);
      }
    }
  }
  for (const record of plan.records) {
    await writeYamlAtomic(record.filePath, record.output, record.mode);
  }
  for (const asset of plan.assets) {
    if (await hashFile(asset.destination) !== asset.hash) {
      throw migrationError(`${asset.destination} failed post-write verification.`);
    }
  }
  const verified = await buildPlan(plan.projectRoot);
  if (verified.records.length) {
    throw migrationError("Record verification still found old image values.");
  }
  await assertCacheInventoryUnchanged(plan);
  for (const asset of plan.assets) {
    for (const legacyPath of asset.remove) await fs.unlink(legacyPath);
  }
  await removePreflightedCacheFiles(plan);
  const current = await buildPlan(plan.projectRoot, {
    cacheDir: plan.cacheRoot || ""
  });
  if (
    current.records.length ||
    current.assets.some(({ create, remove }) => create || remove.length) ||
    current.cacheFiles.length
  ) {
    throw migrationError("Post-migration verification did not reach the strict current state.");
  }
  return { backupRoot };
}

function parseArguments(argv) {
  let projectRoot = "";
  let backupDir = "";
  let cacheDir = process.env.MINICMS_IMAGE_CACHE_DIR || "";
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project-root") projectRoot = argv[++index] || "";
    else if (argument === "--backup-dir") backupDir = argv[++index] || "";
    else if (argument === "--cache-dir") cacheDir = argv[++index] || "";
    else if (argument === "--write") write = true;
    else if (argument === "--check") write = false;
    else throw migrationError(`Unknown argument: ${argument}`);
  }
  if (!projectRoot) throw migrationError("--project-root is required.");
  if (write && !backupDir) {
    throw migrationError("--write requires an absent --backup-dir outside the project root.");
  }
  return { projectRoot, backupDir, cacheDir, write };
}

async function main(argv) {
  const options = parseArguments(argv);
  const plan = await buildPlan(options.projectRoot, {
    cacheDir: options.cacheDir
  });
  const changedAssets = plan.assets.filter(({ create, remove }) => create || remove.length);
  const summary = {
    mode: options.write ? "write" : "check",
    records_to_rewrite: plan.records.length,
    hash_directories: plan.assets.length,
    assets_to_create: plan.assets.filter(({ create }) => create).length,
    old_files_to_remove: plan.assets.reduce(
      (total, { remove }) => total + remove.length,
      0
    ),
    cache_files_to_clear: plan.cacheFiles.length
  };
  if (options.write) {
    const result = await executePlan(plan, options.backupDir);
    summary.backup = result.backupRoot;
    summary.status = plan.records.length || changedAssets.length || plan.cacheFiles.length
      ? "migrated"
      : "already-current";
  } else {
    summary.status = plan.records.length || changedAssets.length || plan.cacheFiles.length
      ? "migration-required"
      : "current";
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { buildPlan, executePlan, main };
