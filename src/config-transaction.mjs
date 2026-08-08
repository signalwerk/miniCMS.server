import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { constants as fsConstants, promises as fs } from "node:fs";
import {
  dumpYaml,
  normalizeRepositoryPath,
  parseYaml
} from "@signalwerk/minicms/core/content";
import {
  isRemoteCollection,
  validateSourceConfig
} from "@signalwerk/minicms/core/connectors";

const TRANSACTION_ROOT_NAME = ".minicms-config-transactions";
const MANIFEST_NAME = "manifest.json";
const CONFIG_NAME = "next-config.yml";
const TRANSACTION_VERSION = 1;

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
    throw transactionError(status, "site.media_folder must be strictly inside content/.");
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

function folderMoves(currentConfig, nextConfig) {
  const current = localCollectionFolders(currentConfig);
  const next = localCollectionFolders(nextConfig);
  const moves = [];
  for (const [name, source] of current) {
    const destination = next.get(name);
    if (!destination || destination === source) continue;
    moves.push({ collection: name, source, destination });
  }
  for (const move of moves) {
    for (const candidate of moves) {
      if (!overlaps(move.destination, candidate.source)) continue;
      throw transactionError(
        400,
        "Collection folder swaps, chains, and nested source/destination moves are not supported."
      );
    }
  }
  return moves;
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
      throw transactionError(status, `Required directory "${relativePath}" does not exist.`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw transactionError(
        status,
        `Collection path "${relativePath}" contains a symlink or non-directory component.`
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

async function copyDirectory(source, destination) {
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw transactionError(400, "A collection source must be a regular directory.");
  }
  await fs.mkdir(destination, { recursive: false });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourceEntry = path.join(source, entry.name);
    const destinationEntry = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, destinationEntry);
      continue;
    }
    if (!entry.isFile()) {
      throw transactionError(
        400,
        `Collection folder contains unsupported linked or special entry "${entry.name}".`
      );
    }
    await fs.copyFile(sourceEntry, destinationEntry, fsConstants.COPYFILE_EXCL);
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
    !Array.isArray(manifest.moves)
  ) {
    throw transactionError(500, "The miniCMS config transaction journal is invalid.");
  }
  return {
    ...manifest,
    moves: manifest.moves.map((move, index) => {
      if (
        typeof move?.collection !== "string" ||
        typeof move?.source !== "string" ||
        typeof move?.destination !== "string" ||
        move.stage !== `stage/${index}` ||
        typeof move.sourceExists !== "boolean"
      ) {
        throw transactionError(500, "The miniCMS config transaction journal is invalid.");
      }
      return {
        ...move,
        source: normalizeRepositoryPath(move.source, "transaction source", 500),
        destination: normalizeRepositoryPath(
          move.destination,
          "transaction destination",
          500
        )
      };
    })
  };
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
      throw transactionError(status, "Collection folders must be strictly inside content/.");
    }
    await ensureTrustedRoot(resolvedRoot);
    await assertDirectoryComponents(resolvedRoot, normalized, { status });
    return absolute(normalized);
  }

  async function transactionDirectories() {
    if (!(await assertTrustedTransactionRoot())) return [];
    let entries;
    entries = await fs.readdir(transactionRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    if (
      directories.length !== entries.length ||
      directories.some((entry) => !/^[a-f0-9]{24}$/.test(entry.name))
    ) {
      throw transactionError(500, "The miniCMS config transaction root is invalid.");
    }
    return directories.map((entry) => path.join(transactionRoot, entry.name));
  }

  async function removeTransactionDirectory(transactionDir) {
    await fs.rm(transactionDir, { recursive: true, force: true });
    await fs.rmdir(transactionRoot).catch(() => {});
  }

  async function rollback(transactionDir, manifest) {
    for (const move of [...manifest.moves].reverse()) {
      if (!move.sourceExists) continue;
      const destination = absolute(move.destination);
      await fs.rm(destination, { recursive: true, force: true });
    }
    await removeTransactionDirectory(transactionDir);
  }

  async function rollForward(transactionDir, manifest) {
    for (const move of manifest.moves) {
      if (!move.sourceExists) continue;
      const destination = absolute(move.destination);
      const destinationStat = await lstatOrNull(destination);
      if (!destinationStat?.isDirectory() || destinationStat.isSymbolicLink()) {
        throw transactionError(
          500,
          `Committed collection destination "${move.destination}" is missing or invalid.`
        );
      }
      await fs.rm(absolute(move.source), { recursive: true, force: true });
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
    let manifestSource;
    try {
      manifestSource = await fs.readFile(
        path.join(transactionDir, MANIFEST_NAME),
        "utf8"
      );
    } catch (error) {
      if (!isMissing(error)) throw error;
      await removeTransactionDirectory(transactionDir);
      return;
    }
    const manifest = validateManifest(JSON.parse(manifestSource));
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

  async function save(nextConfig, expectedEtag) {
    check();
    if (typeof expectedEtag !== "string" || !expectedEtag.trim()) {
      throw transactionError(428, "If-Match is required when saving configuration.");
    }
    await ensureTrustedRoot(resolvedRoot);
    await assertTrustedConfigFile();
    const oldSource = await currentSource();
    const currentEtag = etagFor(oldSource);
    if (expectedEtag.trim() !== currentEtag) {
      throw transactionError(412, "cms.config.yml changed while you were editing. Reload and try again.");
    }
    const currentConfig = validateSourceConfig(parseYaml(oldSource));
    const moves = folderMoves(currentConfig, nextConfig);
    for (const folder of localCollectionFolders(nextConfig).values()) {
      await resolveCollectionDirectory(folder, 400);
    }
    for (const move of moves) {
      await assertDirectoryComponents(resolvedRoot, move.source);
      await assertDirectoryComponents(resolvedRoot, move.destination);
      if (await lstatOrNull(absolute(move.destination))) {
        throw transactionError(
          409,
          `Collection "${move.collection}" destination folder "${move.destination}" already exists.`
        );
      }
    }

    const newSource = dumpYaml(nextConfig);
    if (!moves.length) {
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
      return etagFor(newSource);
    }

    const manifest = {
      version: TRANSACTION_VERSION,
      oldConfigHash: digest(oldSource),
      newConfigHash: digest(newSource),
      moves: await Promise.all(
        moves.map(async (move, index) => {
          const sourceStat = await lstatOrNull(absolute(move.source));
          if (
            sourceStat &&
            (sourceStat.isSymbolicLink() || !sourceStat.isDirectory())
          ) {
            throw transactionError(
              400,
              `Collection "${move.collection}" source folder is not a regular directory.`
            );
          }
          return {
            ...move,
            stage: `stage/${index}`,
            sourceExists: Boolean(sourceStat)
          };
        })
      )
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
      await fs.mkdir(stageRoot);
      await writeExclusive(path.join(transactionDir, CONFIG_NAME), newSource);
      await writeManifest(path.join(transactionDir, MANIFEST_NAME), manifest);
      for (const [index, move] of manifest.moves.entries()) {
        if (!move.sourceExists) continue;
        await copyDirectory(
          absolute(move.source),
          path.join(stageRoot, String(index))
        );
      }

      for (const [index, move] of manifest.moves.entries()) {
        if (!move.sourceExists) continue;
        const destination = absolute(move.destination);
        await fs.mkdir(path.dirname(destination), { recursive: true });
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
    return etagFor(newSource);
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
