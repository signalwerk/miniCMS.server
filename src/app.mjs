import express from "express";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  configuredCollectionMediaAccept,
  mediaAcceptErrorMessage,
  mediaFileMatchesAccept,
  recordMediaStoragePaths
} from "@signalwerk/minicms/core/media";
import {
  assertSafeName as assertSharedSafeName,
  dumpYaml,
  hierarchyValue,
  parseYaml,
  summarizeRecord,
  validateRecord as validateSharedRecord
} from "@signalwerk/minicms/core/content";
import {
  isRemoteCollection,
  validateSourceConfig as validateSharedConfig
} from "@signalwerk/minicms/core/connectors";
import { createDevelopmentAuthentication } from "./auth.mjs";
import {
  createImageService,
  detectImageFileType,
  resolveMediaSource
} from "./image/service.mjs";
import { createMediaRouter } from "./image/routes.mjs";
import {
  cleanUploadTemporaries,
  mediaUploadLimit,
  normalizeUploadFilename,
  streamMediaUpload
} from "./upload.mjs";
import { createConfigTransaction } from "./config-transaction.mjs";
import { createProjectGate, withProjectGate } from "./project-gate.mjs";

const IMAGE_EXTENSION_FORMATS = new Map([
  [".avif", "avif"],
  [".gif", "gif"],
  [".heic", "heif"],
  [".heif", "heif"],
  [".jpeg", "jpeg"],
  [".jpg", "jpeg"],
  [".png", "png"],
  [".svg", "svg"],
  [".tif", "tiff"],
  [".tiff", "tiff"],
  [".webp", "webp"]
]);
const IMAGE_FORMAT_MIME_TYPES = Object.freeze({
  avif: "image/avif",
  gif: "image/gif",
  heif: "image/heif",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  tiff: "image/tiff",
  webp: "image/webp"
});

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function validateUploadedImage(filePath, filename, acceptedTypes) {
  const detected = await detectImageFileType(filePath);
  if (detected.kind === "unsupported") {
    throw httpError(400, "The uploaded file is not a supported image.");
  }
  const extension = path.extname(filename).toLowerCase();
  const expectedFormat = IMAGE_EXTENSION_FORMATS.get(extension);
  if (!expectedFormat || detected.format !== expectedFormat) {
    throw httpError(
      400,
      "The uploaded image contents do not match its filename extension."
    );
  }
  const detectedFile = {
    filename,
    mimeType: IMAGE_FORMAT_MIME_TYPES[detected.format]
  };
  if (!mediaFileMatchesAccept(detectedFile, acceptedTypes)) {
    throw httpError(
      400,
      mediaAcceptErrorMessage(detectedFile, acceptedTypes)
    );
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readYaml(filePath) {
  const source = await fs.readFile(filePath, "utf8");
  return parseYaml(source);
}

async function writeYamlAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryFile = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const output = dumpYaml(value);
  await fs.writeFile(temporaryFile, output, "utf8");
  await fs.rename(temporaryFile, filePath);
}

async function removeFilesAtomically(filePaths) {
  const moved = [];
  try {
    for (const [index, filePath] of filePaths.entries()) {
      const temporaryPath = path.join(
        path.dirname(filePath),
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${index}.delete`
      );
      await fs.rename(filePath, temporaryPath);
      moved.push({ filePath, temporaryPath });
    }
  } catch (error) {
    for (const { filePath, temporaryPath } of moved.reverse()) {
      await fs.rename(temporaryPath, filePath).catch(() => {});
    }
    throw error;
  }
  await Promise.all(
    moved.map(({ temporaryPath }) => fs.unlink(temporaryPath).catch(() => {}))
  );
}

async function pruneEmptyContentAddressedDirectories(sources) {
  for (const source of sources) {
    const segments = String(source.relativePath || "").split("/");
    if (
      segments.length !== 3 ||
      !/^[a-f0-9]{64}$/.test(segments[1])
    ) {
      continue;
    }
    const hashDirectory = path.dirname(source.path);
    try {
      await fs.rmdir(hashDirectory);
    } catch {
      continue;
    }
    await fs.rmdir(path.dirname(hashDirectory)).catch(() => {});
  }
}

function summarize(record, stat, collection) {
  return summarizeRecord(
    record,
    { birthtime: stat.birthtime, mtime: stat.mtime },
    collection
  );
}

export function createApp({
  rootDir,
  configFile = path.join(rootDir, "cms.config.yml"),
  authentication = createDevelopmentAuthentication(),
  environment = process.env,
  imageLogger = console
}) {
  const app = express();
  const contentRoot = path.resolve(rootDir, "content");

  app.disable("x-powered-by");

  let cachedConfig = null;
  let cachedConfigMtime = 0;
  const projectGate = createProjectGate();
  const projectRead = (handler) =>
    withProjectGate(projectGate, "read", handler);
  const projectWrite = (handler) =>
    withProjectGate(projectGate, "write", handler);
  const configTransaction = createConfigTransaction({ rootDir, configFile });
  let transactionRecovery = null;

  function ensureTransactionRecovery() {
    transactionRecovery ??= configTransaction.recover();
    return transactionRecovery;
  }

  async function getConfig() {
    await ensureTransactionRecovery();
    configTransaction.check();
    let stat;
    try {
      stat = await fs.stat(configFile);
    } catch (error) {
      if (error.code === "ENOENT") throw httpError(500, "cms.config.yml was not found.");
      throw error;
    }
    if (!cachedConfig || cachedConfigMtime !== stat.mtimeMs) {
      const config = await readYaml(configFile);
      validateSharedConfig(config);
      cachedConfig = config;
      cachedConfigMtime = stat.mtimeMs;
    }
    return cachedConfig;
  }

  const imageService = createImageService({
    rootDir,
    getConfig,
    environment,
    logger: imageLogger
  });
  const maxUploadBytes = mediaUploadLimit(environment);
  const uploadCleanupPromises = new Map();

  function cleanUploadDirectoryOnce(directory) {
    if (!uploadCleanupPromises.has(directory)) {
      const cleanup = cleanUploadTemporaries(directory).catch((error) => {
        uploadCleanupPromises.delete(directory);
        throw error;
      });
      uploadCleanupPromises.set(directory, cleanup);
    }
    return uploadCleanupPromises.get(directory);
  }

  async function getCollection(name) {
    assertSharedSafeName(name, "collection name");
    const config = await getConfig();
    const configuredCollection = config.collections[name];
    if (!configuredCollection) {
      throw httpError(404, `Collection "${name}" does not exist.`);
    }
    if (isRemoteCollection(configuredCollection)) {
      throw httpError(
        404,
        `Collection "${name}" is provided by connector "${configuredCollection.connector}" and is not stored by this service.`
      );
    }
    const collection = { name, ...configuredCollection };

    const folder = await configTransaction.resolveCollectionDirectory(
      collection.folder
    );
    return { config, collection, folder };
  }

  function recordPath(folder, collection, id) {
    assertSharedSafeName(id, "record id");
    const extension = String(collection.extension || "yml").replace(/^\./, "");
    if (!["yml", "yaml"].includes(extension)) {
      throw httpError(500, `Unsupported extension "${extension}".`);
    }
    return path.join(folder, `${id}.${extension}`);
  }

  app.use("/api", authentication.cors);

  app.get("/api/health", (_request, response) => {
    response.set("cache-control", "no-store");
    response.json({ ok: true });
  });

  app.get("/api/ready", async (_request, response) => {
    response.set({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    try {
      const config = await getConfig();
      imageService.validateProjectConfiguration(config);
      response.json({ ok: true });
    } catch {
      response.status(503).json({ ok: false });
    }
  });

  // Media stays public even when a configured image schema is "api". Mount
  // its exact GET/HEAD routes before the broader authenticated API namespace.
  app.use(createMediaRouter({ imageService, getConfig }));

  app.use("/api/auth", authentication.router);
  app.use("/api", authentication.requireSession);

  // Authentication is deliberately resolved before potentially large request
  // bodies are parsed. The public GitHub-token bootstrap owns its small parser.
  app.post(
    "/api/media/:collectionName",
    projectRead(
    async (request, response, next) => {
      try {
        const { config, collection } = await getCollection(
          request.params.collectionName
        );
        const {
          filename: originalName,
          base,
          extension
        } = normalizeUploadFilename(request.query.filename);
        const acceptedTypes = configuredCollectionMediaAccept(
          config,
          collection
        );
        const uploadedFile = {
          filename: originalName,
          mimeType: request.headers["content-type"]
        };
        if (
          !acceptedTypes.length ||
          !mediaFileMatchesAccept(uploadedFile, acceptedTypes)
        ) {
          throw httpError(
            400,
            mediaAcceptErrorMessage(uploadedFile, acceptedTypes)
          );
        }
        const { trustedMediaRoot } = await imageService.uploadDirectory(config);
        await cleanUploadDirectoryOnce(trustedMediaRoot);
        const acceptedImageTypes = configuredCollectionMediaAccept(
          config,
          collection,
          "image"
        );
        const validateTemporary = mediaFileMatchesAccept(
          uploadedFile,
          acceptedImageTypes
        )
          ? ({ temporaryPath }) =>
              validateUploadedImage(
                temporaryPath,
                originalName,
                acceptedImageTypes
              )
          : undefined;
        const { filename, sha } = await streamMediaUpload({
          request,
          directory: trustedMediaRoot,
          collection: collection.name,
          base,
          extension,
          maxBytes: maxUploadBytes,
          validateTemporary
        });

        const publicFolder = String(
          config.site?.public_folder || "/media"
        ).replace(/\/$/, "");
        response.status(201).json({
          filename,
          sha,
          path: `${publicFolder}/${collection.name}/${sha}/${filename}`,
          storage_path: `${String(
            config.site?.media_folder || "content/media"
          ).replace(/\/$/, "")}/${collection.name}/${sha}/${filename}`
        });
      } catch (error) {
        next(error);
      }
    })
  );

  app.use("/api", express.json({ limit: "10mb" }));

  app.get("/api/config", projectRead(async (_request, response, next) => {
    try {
      await ensureTransactionRecovery();
      const { config, etag } = await configTransaction.snapshot();
      response.set("etag", etag);
      response.json(config);
    } catch (error) {
      next(error);
    }
  }));

  app.put("/api/config", projectWrite(async (request, response, next) => {
    try {
      const config = validateSharedConfig(request.body, 400);
      await ensureTransactionRecovery();
      imageService.validateProjectConfiguration(config, 400);
      const mediaFolder = path.resolve(
        rootDir,
        config.site?.media_folder || "content/media"
      );
      if (!isInside(contentRoot, mediaFolder)) {
        throw httpError(400, "site.media_folder must be inside content/.");
      }
      for (const [name, collection] of Object.entries(config.collections)) {
        if (isRemoteCollection(collection)) continue;
        if (typeof collection.folder !== "string" || !collection.folder) {
          throw httpError(400, `Collection "${name}" must define a folder.`);
        }
        const folder = path.resolve(rootDir, collection.folder);
        if (!isInside(contentRoot, folder)) {
          throw httpError(
            400,
            `Collection "${name}" must use a folder inside content/.`
          );
        }
        const extension = String(collection.extension || "yml").replace(
          /^\./,
          ""
        );
        if (!["yml", "yaml"].includes(extension)) {
          throw httpError(
            400,
            `Collection "${name}" uses unsupported extension "${extension}".`
          );
        }
      }
      const etag = await configTransaction.save(
        config,
        request.headers["if-match"]
      );
      const stat = await fs.stat(configFile);
      cachedConfig = config;
      cachedConfigMtime = stat.mtimeMs;
      response.set("etag", etag);
      response.json({ saved: true, config });
    } catch (error) {
      next(error);
    }
  }));

  app.get("/api/collections", projectRead(async (_request, response, next) => {
    try {
      const config = await getConfig();
      response.json({
        collections: Object.fromEntries(
          Object.entries(config.collections)
            .filter(([, collection]) => !isRemoteCollection(collection))
            .map(
              ([
                name,
                {
                  label,
                  label_singular,
                  icon,
                  node_type,
                  hierarchy,
                  views,
                  slug,
                  identifier_field,
                  delete_files_with_record
                }
              ]) => [
                name,
                {
                  label,
                  label_singular,
                  icon,
                  node_type,
                  hierarchy,
                  views,
                  slug,
                  identifier_field,
                  delete_files_with_record
                }
              ]
            )
        )
      });
    } catch (error) {
      next(error);
    }
  }));

  app.get("/api/collections/:collectionName", projectRead(async (request, response, next) => {
    try {
      const { collection, folder } = await getCollection(request.params.collectionName);
      let entries;
      try {
        entries = await fs.readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        entries = [];
      }
      const extensions = new Set([".yml", ".yaml"]);
      const files = entries.filter(
        (entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())
      );

      const items = await Promise.all(
        files.map(async (entry) => {
          const filePath = path.join(folder, entry.name);
          const [record, stat] = await Promise.all([readYaml(filePath), fs.stat(filePath)]);
          return summarize(record, stat, collection);
        })
      );
      items.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
      response.json({ collection: collection.name, items });
    } catch (error) {
      next(error);
    }
  }));

  app.get(
    "/api/collections/:collectionName/:recordId",
    projectRead(async (request, response, next) => {
      try {
        const { collection, folder } = await getCollection(
          request.params.collectionName
        );
        const filePath = recordPath(folder, collection, request.params.recordId);
        response.json(await readYaml(filePath));
      } catch (error) {
        if (error.code === "ENOENT") {
          next(httpError(404, `Record "${request.params.recordId}" does not exist.`));
        } else {
          next(error);
        }
      }
    })
  );

  app.put(
    "/api/collections/:collectionName/:recordId",
    projectRead(async (request, response, next) => {
      try {
        const { config, collection, folder } = await getCollection(
          request.params.collectionName
        );
        if (request.body?.id !== request.params.recordId) {
          throw httpError(400, "The record id must match the URL.");
        }
        validateSharedRecord(request.body, collection, config);
        const filePath = recordPath(folder, collection, request.params.recordId);
        await writeYamlAtomic(filePath, request.body);
        const stat = await fs.stat(filePath);
        response.json({ saved: true, item: summarize(request.body, stat, collection) });
      } catch (error) {
        next(error);
      }
    })
  );

  app.post(
    "/api/collections/:collectionName/:recordId/rename",
    projectRead(async (request, response, next) => {
      try {
        const { config, collection, folder } = await getCollection(
          request.params.collectionName
        );
        const oldId = request.params.recordId;
        const newId = request.body?.id;
        assertSharedSafeName(newId, "record id");
        if (newId === oldId) {
          throw httpError(400, "The new record id must be different.");
        }

        const oldPath = recordPath(folder, collection, oldId);
        const newPath = recordPath(folder, collection, newId);
        let record;
        try {
          record = await readYaml(oldPath);
        } catch (error) {
          if (error.code === "ENOENT") {
            throw httpError(404, `Record "${oldId}" does not exist.`);
          }
          throw error;
        }
        try {
          await fs.access(newPath);
          throw httpError(409, `Record "${newId}" already exists.`);
        } catch (error) {
          if (error.status === 409) throw error;
          if (error.code !== "ENOENT") throw error;
        }

        if (collection.hierarchy?.enabled && !collection.hierarchy?.id_field) {
          const entries = await fs.readdir(folder, { withFileTypes: true });
          const yamlFiles = entries.filter(
            (entry) =>
              entry.isFile() &&
              [".yml", ".yaml"].includes(path.extname(entry.name).toLowerCase())
          );
          for (const entry of yamlFiles) {
            if (path.join(folder, entry.name) === oldPath) continue;
            const candidate = await readYaml(path.join(folder, entry.name));
            const candidateParent = hierarchyValue(
              candidate,
              collection,
              "parent_field",
              candidate?.parent ?? null
            );
            if (candidateParent === oldId) {
              throw httpError(
                409,
                `Record "${oldId}" has child records and its hierarchy uses the filename as its id.`
              );
            }
          }
        }

        const renamedRecord = { ...record, id: newId };
        validateSharedRecord(renamedRecord, collection, config);
        await writeYamlAtomic(newPath, renamedRecord);
        try {
          await fs.unlink(oldPath);
        } catch (error) {
          await fs.unlink(newPath).catch(() => {});
          throw error;
        }
        const stat = await fs.stat(newPath);
        response.json({
          saved: true,
          record: renamedRecord,
          item: summarize(renamedRecord, stat, collection)
        });
      } catch (error) {
        next(error);
      }
    })
  );

  app.delete(
    "/api/collections/:collectionName/:recordId",
    projectRead(async (request, response, next) => {
      try {
        const { config, collection, folder } = await getCollection(
          request.params.collectionName
        );
        const filePath = recordPath(folder, collection, request.params.recordId);
        try {
          await fs.access(filePath);
        } catch (error) {
          if (error.code === "ENOENT") {
            throw httpError(404, `Record "${request.params.recordId}" does not exist.`);
          }
          throw error;
        }

        const entries = await fs.readdir(folder, { withFileTypes: true });
        const yamlFiles = entries.filter(
          (entry) =>
            entry.isFile() && [".yml", ".yaml"].includes(path.extname(entry.name).toLowerCase())
        );
        const deletingRecord = await readYaml(filePath);
        const deletingHierarchyId = hierarchyValue(
          deletingRecord,
          collection,
          "id_field",
          deletingRecord.id
        );
        for (const entry of yamlFiles) {
          if (path.join(folder, entry.name) === filePath) continue;
          const candidate = await readYaml(path.join(folder, entry.name));
          const candidateParent = hierarchyValue(
            candidate,
            collection,
            "parent_field",
            candidate?.parent ?? null
          );
          if (candidateParent === deletingHierarchyId) {
            throw httpError(
              409,
              `Record "${request.params.recordId}" still has child records. Move or delete them first.`
            );
          }
        }

        const mediaPaths = collection.delete_files_with_record
          ? recordMediaStoragePaths(deletingRecord, config)
          : [];
        const existingMediaSources = [];
        for (const mediaPath of mediaPaths) {
          try {
            const source = await resolveMediaSource({
              rootDir,
              config,
              reference: mediaPath
            });
            existingMediaSources.push(source);
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }

        await removeFilesAtomically([
          filePath,
          ...existingMediaSources.map((source) => source.path)
        ]);
        await pruneEmptyContentAddressedDirectories(existingMediaSources);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    })
  );

  app.post("/api/collections/:collectionName", projectRead(async (request, response, next) => {
    try {
      const { config, collection, folder } = await getCollection(request.params.collectionName);
      validateSharedRecord(request.body, collection, config);
      const filePath = recordPath(folder, collection, request.body.id);
      try {
        await fs.access(filePath);
        throw httpError(409, `Record "${request.body.id}" already exists.`);
      } catch (error) {
        if (error.status === 409) throw error;
        if (error.code !== "ENOENT") throw error;
      }
      await writeYamlAtomic(filePath, request.body);
      const stat = await fs.stat(filePath);
      response
        .status(201)
        .json({ saved: true, item: summarize(request.body, stat, collection) });
    } catch (error) {
      next(error);
    }
  }));

  app.use((error, _request, response, _next) => {
    const status = error.status || (error instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(error);
    response.set({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });
    if (error.retryAfter) response.set("retry-after", String(error.retryAfter));
    response.status(status).json({
      error: status >= 500 ? "Server error" : "Request error",
      message:
        status >= 500
          ? "An unexpected server error occurred."
          : error.message || "An unexpected error occurred."
    });
  });

  return app;
}
