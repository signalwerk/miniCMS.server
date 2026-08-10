import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { constants as fsConstants, promises as fs } from "node:fs";
import {
  dumpYaml,
  normalizeRepositoryPath,
  parseYaml,
  validateRecord
} from "@signalwerk/minicms/core/content";
import {
  isRemoteCollection,
  migrateRecordSchemaKeys,
  normalizeSchemaRenames,
  validateSourceConfig
} from "@signalwerk/minicms/core/connectors";
import { mediaStorageMode } from "./media-contract.mjs";

const TRANSACTION_ROOT_NAME = ".minicms-config-transactions";
const MANIFEST_NAME = "manifest.json";
const CONFIG_NAME = "next-config.yml";
const TRANSACTION_VERSION = 2;
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);

function transactionError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function digest(source) {
  return createHash("sha256").update(source).digest("hex");
}

function etagFor(source) {
  return `"${digest(source)}"`;
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function overlaps(left, right) {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function localCollectionFolders(config, status = 400) {
  const entries = [];
  for (const [name, collection] of Object.entries(config.collections ?? {})) {
    if (isRemoteCollection(collection)) continue;
    const folder = normalizeRepositoryPath(
      collection.folder,
      `Collection "${name}" folder`,
      status
    );
    if (folder === "content" || !folder.startsWith("content/")) {
      throw transactionError(
        status,
        `Collection "${name}" must use a folder strictly inside content/.`
      );
    }
    entries.push({ name, folder });
  }
  const mediaFolder = normalizeRepositoryPath(
    config.site?.media_folder || "content/media",
    "site.media_folder",
    status
  );
  if (mediaFolder === "content" || !mediaFolder.startsWith("content/")) {
    throw transactionError(
      status,
      "site.media_folder must be strictly inside content/."
    );
  }
  for (const entry of entries) {
    if (overlaps(entry.folder, mediaFolder)) {
      throw transactionError(
        status,
        `Collection "${entry.name}" folder must not overlap site.media_folder.`
      );
    }
  }
  for (let index = 0; index < entries.length; index += 1) {
    for (let candidate = index + 1; candidate < entries.length; candidate += 1) {
      if (!overlaps(entries[index].folder, entries[candidate].folder)) continue;
      throw transactionError(
        status,
        `Collection folders for "${entries[index].name}" and "${entries[candidate].name}" must be distinct and must not be nested.`
      );
    }
  }
  return new Map(entries.map(({ name, folder }) => [name, folder]));
}

function mediaFolder(config, status = 400) {
  const folder = normalizeRepositoryPath(
    config.site?.media_folder || "content/media",
    "site.media_folder",
    status
  );
  if (folder === "content" || !folder.startsWith("content/")) {
    throw transactionError(
      status,
      "site.media_folder must be strictly inside content/."
    );
  }
  return folder;
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function assertDirectoryComponents(
  rootDir,
  relativePath,
  { finalMayBeMissing = true, status = 400 } = {}
) {
  const segments = relativePath.split("/");
  let current = rootDir;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const stat = await lstatOrNull(current);
    if (!stat) {
      if (finalMayBeMissing || index < segments.length - 1) return;
      throw transactionError(
        status,
        `Required directory "${relativePath}" does not exist.`
      );
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw transactionError(
        status,
        `Content path "${relativePath}" contains a symlink or non-directory component.`
      );
    }
  }
}

async function ensureTrustedRoot(rootDir) {
  const stat = await fs.lstat(rootDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw transactionError(500, "The project root must be a regular directory.");
  }
}

function statIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function sameStatIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function inventoryDirectory(source, label) {
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw transactionError(400, `${label} must be a regular directory.`);
  }
  const directories = [{ relativePath: "", stat: statIdentity(sourceStat) }];
  const files = [];

  async function walk(directory, relativeDirectory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw transactionError(
          400,
          `${label} contains a symbolic link at "${relativePath}".`
        );
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        directories.push({ relativePath, stat: statIdentity(stat) });
        await walk(entryPath, relativePath);
        continue;
      }
      if (entry.isFile() && stat.isFile()) {
        files.push({ relativePath, stat: statIdentity(stat) });
        continue;
      }
      throw transactionError(
        400,
        `${label} contains unsupported linked or special entry "${relativePath}".`
      );
    }
  }

  await walk(source, "");
  return { directories, files };
}

function sameInventory(left, right) {
  if (
    left.directories.length !== right.directories.length ||
    left.files.length !== right.files.length
  ) {
    return false;
  }
  return ["directories", "files"].every((kind) =>
    left[kind].every(
      (entry, index) =>
        entry.relativePath === right[kind][index].relativePath &&
        sameStatIdentity(entry.stat, right[kind][index].stat)
    )
  );
}

async function copyInventory(source, destination, inventory, rewrites) {
  await fs.mkdir(destination, { recursive: false });
  for (const entry of inventory.directories.slice(1)) {
    await fs.mkdir(path.join(destination, entry.relativePath));
  }
  for (const entry of inventory.files) {
    const destinationPath = path.join(destination, entry.relativePath);
    if (rewrites.has(entry.relativePath)) {
      const rewrite = rewrites.get(entry.relativePath);
      await fs.writeFile(path.join(destination, rewrite.relativePath), rewrite.source, {
        encoding: "utf8",
        flag: "wx"
      });
      continue;
    }
    await fs.copyFile(
      path.join(source, entry.relativePath),
      destinationPath,
      fsConstants.COPYFILE_EXCL
    );
  }
}

async function writeExclusive(filePath, source) {
  await fs.writeFile(filePath, source, { encoding: "utf8", flag: "wx" });
}

async function writeManifest(filePath, manifest) {
  await writeExclusive(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function validateManifest(manifest) {
  if (
    !manifest ||
    manifest.version !== TRANSACTION_VERSION ||
    !/^[a-f0-9]{64}$/.test(manifest.oldConfigHash || "") ||
    !/^[a-f0-9]{64}$/.test(manifest.newConfigHash || "") ||
    !Array.isArray(manifest.directories)
  ) {
    throw transactionError(500, "The miniCMS config transaction journal is invalid.");
  }
  return {
    ...manifest,
    directories: manifest.directories.map((entry, index) => {
      if (
        !["collection", "media"].includes(entry?.kind) ||
        typeof entry?.label !== "string" ||
        !entry.label ||
        !["copy", "replace"].includes(entry.mode) ||
        typeof entry.source !== "string" ||
        typeof entry.destination !== "string" ||
        entry.stage !== `stage/${index}` ||
        entry.backup !== `backup/${index}`
      ) {
        throw transactionError(
          500,
          "The miniCMS config transaction journal is invalid."
        );
      }
      const source = normalizeRepositoryPath(
        entry.source,
        "transaction source",
        500
      );
      const destination = normalizeRepositoryPath(
        entry.destination,
        "transaction destination",
        500
      );
      if (
        (entry.mode === "replace" && source !== destination) ||
        (entry.mode === "copy" && source === destination)
      ) {
        throw transactionError(
          500,
          "The miniCMS config transaction journal is invalid."
        );
      }
      return { ...entry, source, destination };
    })
  };
}

function concreteCollectionRenamePairs(currentConfig, renames) {
  return Object.entries(renames.collections)
    .filter(([source]) => !isRemoteCollection(currentConfig.collections[source]))
    .map(([source, destination]) => ({ source, destination }));
}

export function createConfigTransaction({ rootDir, configFile }) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedConfig = path.resolve(configFile);
  const contentRoot = path.join(resolvedRoot, "content");
  const transactionRoot = path.join(resolvedRoot, TRANSACTION_ROOT_NAME);
  let fatalError = null;

  if (path.dirname(resolvedConfig) !== resolvedRoot) {
    throw transactionError(500, "cms.config.yml must be stored in the project root.");
  }

  function absolute(relativePath) {
    const resolved = path.resolve(resolvedRoot, relativePath);
    if (!resolved.startsWith(`${contentRoot}${path.sep}`)) {
      throw transactionError(500, "A transaction path escaped content/.");
    }
    return resolved;
  }

  async function currentSource() {
    return fs.readFile(resolvedConfig, "utf8");
  }

  async function assertTrustedConfigFile() {
    const stat = await fs.lstat(resolvedConfig);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw transactionError(500, "cms.config.yml must be a regular file.");
    }
  }

  async function assertTrustedTransactionRoot({ allowMissing = true } = {}) {
    const stat = await lstatOrNull(transactionRoot);
    if (!stat) {
      if (allowMissing) return false;
      throw transactionError(500, "The miniCMS config transaction root is missing.");
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw transactionError(
        500,
        "The miniCMS config transaction root must be a regular directory."
      );
    }
    return true;
  }

  function check() {
    if (fatalError) throw fatalError;
  }

  async function snapshot() {
    check();
    await ensureTrustedRoot(resolvedRoot);
    await assertTrustedConfigFile();
    const source = await currentSource();
    return {
      config: validateSourceConfig(parseYaml(source)),
      etag: etagFor(source)
    };
  }

  async function resolveCollectionDirectory(relativePath, status = 500) {
    check();
    const normalized = normalizeRepositoryPath(
      relativePath,
      "collection folder",
      status
    );
    if (normalized === "content" || !normalized.startsWith("content/")) {
      throw transactionError(
        status,
        "Collection folders must be strictly inside content/."
      );
    }
    await ensureTrustedRoot(resolvedRoot);
    await assertDirectoryComponents(resolvedRoot, normalized, { status });
    return absolute(normalized);
  }

  async function transactionDirectories() {
    if (!(await assertTrustedTransactionRoot())) return [];
    const entries = await fs.readdir(transactionRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    if (
      directories.length !== entries.length ||
      directories.some((entry) => !/^[a-f0-9]{24}$/.test(entry.name))
    ) {
      throw transactionError(500, "The miniCMS config transaction root is invalid.");
    }
    return directories.map((entry) => path.join(transactionRoot, entry.name));
  }

  async function assertTrustedTransactionDirectory(transactionDir) {
    if (
      path.dirname(transactionDir) !== transactionRoot ||
      !/^[a-f0-9]{24}$/.test(path.basename(transactionDir))
    ) {
      throw transactionError(500, "The miniCMS config transaction path is invalid.");
    }
    await assertTrustedTransactionRoot({ allowMissing: false });
    const stat = await fs.lstat(transactionDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw transactionError(
        500,
        "The miniCMS config transaction directory must be a regular directory."
      );
    }
  }

  async function transactionBackupOrNull(transactionDir, index, label) {
    await assertTrustedTransactionDirectory(transactionDir);
    const backupRoot = path.join(transactionDir, "backup");
    const rootStat = await lstatOrNull(backupRoot);
    if (!rootStat) return null;
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw transactionError(500, "The transaction backup root is not a regular directory.");
    }
    const backup = path.join(backupRoot, String(index));
    const stat = await lstatOrNull(backup);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw transactionError(500, `${label} is not a regular directory.`);
    }
    return { backup, stat };
  }

  async function removeTransactionDirectory(transactionDir) {
    await assertTrustedTransactionDirectory(transactionDir);
    await fs.rm(transactionDir, { recursive: true, force: true });
    await assertTrustedTransactionRoot({ allowMissing: false });
    await fs.rmdir(transactionRoot).catch(() => {});
  }

  async function regularDirectoryOrNull(directory, label) {
    const stat = await lstatOrNull(directory);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw transactionError(500, `${label} is not a regular directory.`);
    }
    return stat;
  }

  async function removeRegularDirectoryIfPresent(directory, label) {
    if (!(await regularDirectoryOrNull(directory, label))) return;
    await fs.rm(directory, { recursive: true, force: false });
  }

  async function rollback(transactionDir, manifest) {
    const indexedEntries = manifest.directories.map((entry, index) => [
      index,
      entry
    ]);
    for (const [index, entry] of indexedEntries.reverse()) {
      await assertDirectoryComponents(resolvedRoot, entry.source, {
        status: 500
      });
      await assertDirectoryComponents(resolvedRoot, entry.destination, {
        status: 500
      });
      const source = absolute(entry.source);
      const destination = absolute(entry.destination);
      if (entry.mode === "copy") {
        await removeRegularDirectoryIfPresent(
          destination,
          `Transaction destination "${entry.destination}"`
        );
        continue;
      }
      const backupEntry = await transactionBackupOrNull(
        transactionDir,
        index,
        `Transaction backup for "${entry.label}"`
      );
      if (!backupEntry) continue;
      await removeRegularDirectoryIfPresent(
        source,
        `Rewritten source "${entry.source}"`
      );
      await fs.rename(backupEntry.backup, source);
    }
    await removeTransactionDirectory(transactionDir);
  }

  async function rollForward(transactionDir, manifest) {
    for (const [index, entry] of manifest.directories.entries()) {
      await assertDirectoryComponents(resolvedRoot, entry.source, {
        status: 500
      });
      await assertDirectoryComponents(resolvedRoot, entry.destination, {
        status: 500
      });
      const source = absolute(entry.source);
      const destination = absolute(entry.destination);
      if (entry.mode === "copy") {
        if (
          !(await regularDirectoryOrNull(
            destination,
            `Committed destination "${entry.destination}"`
          ))
        ) {
          throw transactionError(
            500,
            `Committed destination "${entry.destination}" is missing.`
          );
        }
        await removeRegularDirectoryIfPresent(
          source,
          `Committed source "${entry.source}"`
        );
        continue;
      }
      if (
        !(await regularDirectoryOrNull(
          source,
          `Committed rewritten source "${entry.source}"`
        ))
      ) {
        throw transactionError(
          500,
          `Committed rewritten source "${entry.source}" is missing.`
        );
      }
      const backupEntry = await transactionBackupOrNull(
        transactionDir,
        index,
        `Committed backup for "${entry.label}"`
      );
      if (backupEntry) {
        await fs.rm(backupEntry.backup, { recursive: true, force: false });
      }
    }
    await removeTransactionDirectory(transactionDir);
  }

  async function recover() {
    await ensureTrustedRoot(resolvedRoot);
    await assertTrustedConfigFile();
    const directories = await transactionDirectories();
    if (directories.length > 1) {
      throw transactionError(500, "Multiple unfinished miniCMS config transactions exist.");
    }
    if (!directories.length) return;
    const transactionDir = directories[0];
    const manifestPath = path.join(transactionDir, MANIFEST_NAME);
    const manifestStat = await lstatOrNull(manifestPath);
    if (!manifestStat) {
      await removeTransactionDirectory(transactionDir);
      return;
    }
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
      throw transactionError(500, "The miniCMS config transaction journal is invalid.");
    }
    const manifest = validateManifest(
      JSON.parse(await fs.readFile(manifestPath, "utf8"))
    );
    const configHash = digest(await currentSource());
    if (configHash === manifest.oldConfigHash) {
      await rollback(transactionDir, manifest);
      return;
    }
    if (configHash === manifest.newConfigHash) {
      await rollForward(transactionDir, manifest);
      return;
    }
    throw transactionError(
      500,
      "cms.config.yml does not match either side of its unfinished transaction."
    );
  }

  async function recordRewrites({
    source,
    sourceName,
    destinationName,
    currentConfig,
    nextConfig,
    renames,
    inventory,
    migrateRecords,
    storage
  }) {
    const rewrites = new Map();
    const currentCollection = {
      name: sourceName,
      ...currentConfig.collections[sourceName]
    };
    const nextCollection = {
      name: destinationName,
      ...nextConfig.collections[destinationName]
    };
    const configuredExtension = String(
      currentCollection.extension || "yml"
    ).replace(/^\./, "").toLowerCase();
    const nextExtension = String(
      nextCollection.extension || "yml"
    ).replace(/^\./, "").toLowerCase();
    if (!migrateRecords && configuredExtension === nextExtension) {
      return rewrites;
    }
    if (configuredExtension !== nextExtension) {
      const occupiedNextExtension = [
        ...inventory.directories.slice(1),
        ...inventory.files
      ].find(
        (entry) =>
          !entry.relativePath.includes("/") &&
          path.extname(entry.relativePath).toLowerCase() === `.${nextExtension}`
      );
      if (occupiedNextExtension) {
        throw transactionError(
          409,
          `Collection "${sourceName}" contains an occupied next-extension path "${occupiedNextExtension.relativePath}".`
        );
      }
    }
    const occupiedPaths = new Set([
      ...inventory.directories.map((entry) => entry.relativePath),
      ...inventory.files.map((entry) => entry.relativePath)
    ]);
    for (const entry of inventory.files) {
      if (
        entry.relativePath.includes("/") ||
        !YAML_EXTENSIONS.has(path.extname(entry.relativePath).toLowerCase())
      ) {
        continue;
      }
      const filePath = path.join(source, entry.relativePath);
      let record;
      try {
        const extension = path.extname(entry.relativePath).slice(1);
        if (extension !== configuredExtension) {
          throw transactionError(
            400,
            `Record "${sourceName}/${entry.relativePath}" does not use the collection's configured .${configuredExtension} extension.`
          );
        }
        record = parseYaml(await fs.readFile(filePath, "utf8"));
        if (
          typeof record?.id !== "string" ||
          path.basename(entry.relativePath, path.extname(entry.relativePath)) !==
            record.id
        ) {
          throw transactionError(
            400,
            `Record "${sourceName}/${entry.relativePath}" id must match its filename stem.`
          );
        }
        validateRecord(record, currentCollection, currentConfig, 400);
        const migrated = migrateRecordSchemaKeys(
          record,
          currentConfig,
          nextConfig,
          renames,
          { storage }
        );
        validateRecord(migrated, nextCollection, nextConfig, 400);
        const nextRelativePath = `${record.id}.${nextExtension}`;
        if (
          nextRelativePath !== entry.relativePath &&
          occupiedPaths.has(nextRelativePath)
        ) {
          throw transactionError(
            409,
            `Record "${sourceName}/${entry.relativePath}" cannot migrate to occupied path "${nextRelativePath}".`
          );
        }
        if (
          nextRelativePath !== entry.relativePath ||
          JSON.stringify(migrated) !== JSON.stringify(record)
        ) {
          rewrites.set(entry.relativePath, {
            relativePath: nextRelativePath,
            source: dumpYaml(migrated)
          });
        }
      } catch (error) {
        if (error?.status) throw error;
        throw transactionError(
          400,
          `Record "${sourceName}/${entry.relativePath}" could not be migrated: ${error.message}`
        );
      }
    }
    return rewrites;
  }

  async function preflight(currentConfig, nextConfig, renames) {
    const currentFolders = localCollectionFolders(currentConfig);
    const nextFolders = localCollectionFolders(nextConfig);
    const inverseRenames = new Map(
      concreteCollectionRenamePairs(currentConfig, renames).map(
        ({ source, destination }) => [destination, source]
      )
    );
    const plans = [];
    const absentPaths = new Map();
    const continuedSources = new Set();
    const migrateRecords =
      Object.keys(renames.node_types).length > 0 ||
      Object.keys(renames.collections).length > 0;
    const currentStorage = mediaStorageMode(currentConfig);
    const nextStorage = mediaStorageMode(nextConfig);
    if (currentStorage !== nextStorage) {
      throw transactionError(
        400,
        "Configuration saves cannot change media storage mode. Migrate the project storage separately."
      );
    }
    const currentMediaFolder = mediaFolder(currentConfig);
    const nextMediaFolder = mediaFolder(nextConfig);
    if (currentMediaFolder !== nextMediaFolder) {
      throw transactionError(
        400,
        "Configuration saves cannot change site.media_folder. Migrate the project storage separately."
      );
    }

    for (const [destinationName, destinationFolder] of nextFolders) {
      const renamedSource = inverseRenames.get(destinationName);
      const sourceName = renamedSource ??
        (currentFolders.has(destinationName) ? destinationName : null);
      const destination = absolute(destinationFolder);
      await assertDirectoryComponents(resolvedRoot, destinationFolder);

      if (!sourceName) {
        if (await lstatOrNull(destination)) {
          throw transactionError(
            409,
            `New collection "${destinationName}" folder "${destinationFolder}" already exists.`
          );
        }
        absentPaths.set(destinationFolder, `new collection "${destinationName}"`);
        continue;
      }
      continuedSources.add(sourceName);
      const sourceFolder = currentFolders.get(sourceName);
      const source = absolute(sourceFolder);
      await assertDirectoryComponents(resolvedRoot, sourceFolder);
      if (source !== destination && (await lstatOrNull(destination))) {
        throw transactionError(
          409,
          `Collection "${destinationName}" destination folder "${destinationFolder}" already exists.`
        );
      }
      if (source !== destination) {
        absentPaths.set(
          destinationFolder,
          `collection "${destinationName}" destination`
        );
      }
      const sourceStat = await lstatOrNull(source);
      if (!sourceStat) continue;
      if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
        throw transactionError(
          400,
          `Collection "${sourceName}" source folder is not a regular directory.`
        );
      }
      const inventory = await inventoryDirectory(
        source,
        `Collection "${sourceName}" folder`
      );
      const rewrites = await recordRewrites({
        source,
        sourceName,
        destinationName,
        currentConfig,
        nextConfig,
        renames,
        inventory,
        migrateRecords,
        storage: currentStorage
      });
      if (source === destination && !rewrites.size) continue;
      plans.push({
        kind: "collection",
        label: `collection:${sourceName}->${destinationName}`,
        source: sourceFolder,
        destination: destinationFolder,
        mode: source === destination ? "replace" : "copy",
        inventory,
        rewrites
      });
    }

    for (const [sourceName, sourceFolder] of currentFolders) {
      if (continuedSources.has(sourceName)) continue;
      const renamed = renames.collections[sourceName];
      if (renamed) {
        throw transactionError(
          400,
          `Concrete collection rename "${sourceName}" to "${renamed}" has no local destination.`
        );
      }
      await assertDirectoryComponents(resolvedRoot, sourceFolder);
    }

    if (currentStorage === "api") {
      for (const [destinationName] of nextFolders) {
        const sourceName = inverseRenames.get(destinationName) ??
          (currentFolders.has(destinationName) ? destinationName : null);
        if (sourceName) continue;
        const destinationRelative = `${nextMediaFolder}/${destinationName}`;
        await assertDirectoryComponents(resolvedRoot, destinationRelative);
        if (await lstatOrNull(absolute(destinationRelative))) {
          throw transactionError(
            409,
            `New collection "${destinationName}" media namespace already exists.`
          );
        }
        absentPaths.set(
          destinationRelative,
          `new collection "${destinationName}" media namespace`
        );
      }
      for (const { source: sourceName, destination: destinationName } of
        concreteCollectionRenamePairs(currentConfig, renames)) {
        const sourceRelative = `${currentMediaFolder}/${sourceName}`;
        const destinationRelative = `${nextMediaFolder}/${destinationName}`;
        const source = absolute(sourceRelative);
        const destination = absolute(destinationRelative);
        await assertDirectoryComponents(resolvedRoot, sourceRelative);
        await assertDirectoryComponents(resolvedRoot, destinationRelative);
        if (source !== destination && (await lstatOrNull(destination))) {
          throw transactionError(
            409,
            `Media namespace for collection "${destinationName}" already exists.`
          );
        }
        if (source !== destination) {
          absentPaths.set(
            destinationRelative,
            `media namespace for collection "${destinationName}"`
          );
        }
        const sourceStat = await lstatOrNull(source);
        if (!sourceStat) continue;
        if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
          throw transactionError(
            400,
            `Media namespace for collection "${sourceName}" is not a regular directory.`
          );
        }
        if (source === destination) continue;
        plans.push({
          kind: "media",
          label: `media:${sourceName}->${destinationName}`,
          source: sourceRelative,
          destination: destinationRelative,
          mode: "copy",
          inventory: await inventoryDirectory(
            source,
            `Media namespace for collection "${sourceName}"`
          ),
          rewrites: new Map()
        });
      }
    }

    const sources = plans.map((plan) => plan.source);
    const destinations = plans.map((plan) => plan.destination);
    for (let index = 0; index < plans.length; index += 1) {
      if (
        plans[index].mode === "copy" &&
        overlaps(destinations[index], sources[index])
      ) {
        throw transactionError(
          400,
          "A transaction destination cannot contain or be contained by its source."
        );
      }
      for (let candidate = 0; candidate < plans.length; candidate += 1) {
        if (index === candidate) continue;
        if (
          overlaps(destinations[index], sources[candidate]) ||
          overlaps(destinations[index], destinations[candidate])
        ) {
          throw transactionError(
            400,
            "Collection and media folder swaps, chains, and nested transaction destinations are not supported."
          );
        }
      }
    }
    return { absentPaths, plans };
  }

  async function assertPreflightStillCurrent(
    plans,
    absentPaths,
    oldSource,
    expectedEtag
  ) {
    await assertTrustedConfigFile();
    const latestSource = await currentSource();
    if (latestSource !== oldSource || etagFor(latestSource) !== expectedEtag) {
      throw transactionError(
        412,
        "cms.config.yml changed while the configuration migration was being prepared. Reload and try again."
      );
    }
    for (const plan of plans) {
      const source = absolute(plan.source);
      const latestInventory = await inventoryDirectory(source, plan.label);
      if (!sameInventory(plan.inventory, latestInventory)) {
        throw transactionError(
          409,
          `The source for ${plan.label} changed while its migration was being prepared.`
        );
      }
      if (
        plan.mode === "copy" &&
        (await lstatOrNull(absolute(plan.destination)))
      ) {
        throw transactionError(
          409,
          `The destination for ${plan.label} appeared while its migration was being prepared.`
        );
      }
    }
    for (const [relativePath, label] of absentPaths) {
      if (!(await lstatOrNull(absolute(relativePath)))) continue;
      throw transactionError(
        409,
        `The destination for ${label} appeared while its migration was being prepared.`
      );
    }
  }

  async function save({ config: nextConfig, schemaRenames, expectedEtag }) {
    check();
    if (typeof expectedEtag !== "string" || !expectedEtag.trim()) {
      throw transactionError(428, "If-Match is required when saving configuration.");
    }
    await ensureTrustedRoot(resolvedRoot);
    await assertTrustedConfigFile();
    const oldSource = await currentSource();
    const currentEtag = etagFor(oldSource);
    if (expectedEtag.trim() !== currentEtag) {
      throw transactionError(
        412,
        "cms.config.yml changed while you were editing. Reload and try again."
      );
    }
    const currentConfig = validateSourceConfig(parseYaml(oldSource));
    const renames = normalizeSchemaRenames(
      schemaRenames,
      currentConfig,
      nextConfig,
      400
    );
    const renamedConcreteCollections = concreteCollectionRenamePairs(
      currentConfig,
      renames
    ).map(({ source }) => source);
    const { absentPaths, plans } = await preflight(
      currentConfig,
      nextConfig,
      renames
    );
    const newSource = dumpYaml(nextConfig);

    await assertPreflightStillCurrent(
      plans,
      absentPaths,
      oldSource,
      currentEtag
    );
    if (!plans.length) {
      const temporary = path.join(
        resolvedRoot,
        `.cms.config.yml.${process.pid}.${Date.now()}.tmp`
      );
      try {
        await writeExclusive(temporary, newSource);
        await fs.rename(temporary, resolvedConfig);
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
      return {
        etag: etagFor(newSource),
        renamedConcreteCollections,
        schemaRenames: renames
      };
    }

    const manifest = {
      version: TRANSACTION_VERSION,
      oldConfigHash: digest(oldSource),
      newConfigHash: digest(newSource),
      directories: plans.map((plan, index) => ({
        kind: plan.kind,
        label: plan.label,
        mode: plan.mode,
        source: plan.source,
        destination: plan.destination,
        stage: `stage/${index}`,
        backup: `backup/${index}`
      }))
    };
    let transactionDir = null;
    try {
      if (!(await assertTrustedTransactionRoot())) {
        await fs.mkdir(transactionRoot, { recursive: false });
      }
      await assertTrustedTransactionRoot({ allowMissing: false });
      const candidate = path.join(
        transactionRoot,
        randomBytes(12).toString("hex")
      );
      await fs.mkdir(candidate, { recursive: false });
      transactionDir = candidate;
      const stageRoot = path.join(transactionDir, "stage");
      const backupRoot = path.join(transactionDir, "backup");
      await fs.mkdir(stageRoot);
      await fs.mkdir(backupRoot);
      await writeExclusive(path.join(transactionDir, CONFIG_NAME), newSource);
      await writeManifest(path.join(transactionDir, MANIFEST_NAME), manifest);

      for (const [index, plan] of plans.entries()) {
        await copyInventory(
          absolute(plan.source),
          path.join(stageRoot, String(index)),
          plan.inventory,
          plan.rewrites
        );
      }

      for (const [index, plan] of plans.entries()) {
        const source = absolute(plan.source);
        const destination = absolute(plan.destination);
        if (plan.mode === "replace") {
          await fs.rename(source, path.join(backupRoot, String(index)));
        } else {
          await fs.mkdir(path.dirname(destination), { recursive: true });
        }
        await fs.rename(path.join(stageRoot, String(index)), destination);
      }

      await fs.rename(path.join(transactionDir, CONFIG_NAME), resolvedConfig);
    } catch (error) {
      try {
        if (transactionDir) {
          await rollback(transactionDir, manifest);
        } else {
          await fs.rmdir(transactionRoot).catch(() => {});
        }
      } catch (rollbackError) {
        fatalError = transactionError(
          500,
          "The miniCMS config transaction could not be rolled back. Restart the service to recover it."
        );
        fatalError.cause = rollbackError;
        throw fatalError;
      }
      throw error;
    }

    try {
      await rollForward(transactionDir, manifest);
    } catch (error) {
      fatalError = transactionError(
        500,
        "The committed miniCMS config transaction requires recovery. Restart the service."
      );
      fatalError.cause = error;
      throw fatalError;
    }
    return {
      etag: etagFor(newSource),
      renamedConcreteCollections,
      schemaRenames: renames
    };
  }

  return Object.freeze({
    check,
    recover,
    resolveCollectionDirectory,
    save,
    snapshot
  });
}

export { TRANSACTION_ROOT_NAME, etagFor };
