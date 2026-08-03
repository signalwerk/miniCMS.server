import os from "node:os";
import path from "node:path";
import { normalizeImageProcessingConfig } from "@signalwerk/minicms/core/image-service";

function imageConfigurationError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function integer(value, fallback, { name, minimum, maximum }) {
  const candidate = value === undefined || value === "" ? fallback : Number(value);
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw imageConfigurationError(
      `${name} must be an integer from ${minimum} through ${maximum}.`
    );
  }
  return candidate;
}

function imageCacheRoot(rootDir, configuredPath) {
  const configuredRoot = configuredPath?.trim();
  if (configuredRoot && !path.isAbsolute(configuredRoot)) {
    throw imageConfigurationError(
      "MINICMS_IMAGE_CACHE_DIR must be an absolute directory."
    );
  }
  const cacheRoot = path.resolve(
    configuredRoot || path.join(os.tmpdir(), "minicms-image-cache")
  );
  if (
    configuredRoot &&
    (cacheRoot === path.parse(cacheRoot).root ||
      cacheRoot === path.resolve(os.homedir()))
  ) {
    throw imageConfigurationError(
      "MINICMS_IMAGE_CACHE_DIR must not target a filesystem root or home directory."
    );
  }
  const contentRoot = path.resolve(rootDir, "content");
  const relativeToContent = path.relative(contentRoot, cacheRoot);
  if (
    relativeToContent === "" ||
    (relativeToContent !== ".." &&
      !relativeToContent.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeToContent))
  ) {
    throw imageConfigurationError(
      "MINICMS_IMAGE_CACHE_DIR must not be inside the project content directory."
    );
  }
  return cacheRoot;
}

function operationalImageConfiguration({
  rootDir,
  environment = process.env
} = {}) {
  return Object.freeze({
    cacheRoot: imageCacheRoot(
      rootDir,
      environment.MINICMS_IMAGE_CACHE_DIR?.trim()
    ),
    concurrency: integer(environment.MINICMS_IMAGE_CONCURRENCY, 2, {
      name: "MINICMS_IMAGE_CONCURRENCY",
      minimum: 1,
      maximum: 32
    }),
    queueLimit: integer(environment.MINICMS_IMAGE_QUEUE_LIMIT, 1024, {
      name: "MINICMS_IMAGE_QUEUE_LIMIT",
      minimum: 0,
      maximum: 4096
    }),
    maxInputPixels: integer(
      environment.MINICMS_IMAGE_MAX_INPUT_PIXELS,
      268402689,
      {
        name: "MINICMS_IMAGE_MAX_INPUT_PIXELS",
        minimum: 1_000_000,
        maximum: 1_000_000_000
      }
    ),
    maxOutputPixels: integer(
      environment.MINICMS_IMAGE_MAX_OUTPUT_PIXELS,
      32_000_000,
      {
        name: "MINICMS_IMAGE_MAX_OUTPUT_PIXELS",
        minimum: 65_536,
        maximum: 268_402_689
      }
    ),
    maxOutputBytes: integer(
      environment.MINICMS_IMAGE_MAX_OUTPUT_BYTES,
      64 * 1024 * 1024,
      {
        name: "MINICMS_IMAGE_MAX_OUTPUT_BYTES",
        minimum: 1024,
        maximum: 512 * 1024 * 1024
      }
    ),
    maxEdge: integer(environment.MINICMS_IMAGE_MAX_EDGE, 8192, {
      name: "MINICMS_IMAGE_MAX_EDGE",
      minimum: 64,
      maximum: 8192
    }),
    timeoutSeconds: integer(
      environment.MINICMS_IMAGE_TIMEOUT_SECONDS,
      20,
      {
        name: "MINICMS_IMAGE_TIMEOUT_SECONDS",
        minimum: 1,
        maximum: 300
      }
    )
  });
}

function imageProjectConfiguration(config, operational, status = 500) {
  let normalized;
  try {
    normalized = normalizeImageProcessingConfig(config);
  } catch (error) {
    throw imageConfigurationError(error.message, status);
  }
  if (
    normalized.width > operational.maxEdge ||
    normalized.height > operational.maxEdge ||
    normalized.width * normalized.height > operational.maxOutputPixels
  ) {
    throw imageConfigurationError(
      "site.image_processing dimensions exceed the operational image limits.",
      status
    );
  }
  return normalized;
}

export {
  imageProjectConfiguration,
  operationalImageConfiguration
};
