import {
  IMAGE_FORMATS,
  imageServiceSlug,
  parseContentAddressedMediaPath,
  parseImageOperations,
  serializeImageOperations
} from "@signalwerk/minicms/core/image-service";

const ROUTE_FORMATS = new Set([...IMAGE_FORMATS, "json", "svg"]);
const CACHE_SCHEMA_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeMediaReference(value, { mediaFolder, publicFolder }) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > 2048 ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)
  ) {
    throw requestError(400, "The media identifier does not contain a local media path.");
  }

  const pathname = value.split(/[?#]/, 1)[0];
  const normalized = pathname.replace(/^\/+|\/+$/g, "");
  const normalizedMediaFolder = String(mediaFolder)
    .replace(/^\/+|\/+$/g, "");
  const normalizedPublicFolder = String(publicFolder || "/media")
    .replace(/^\/+|\/+$/g, "");
  let relative = normalized;
  for (const prefix of new Set([
    normalizedMediaFolder,
    normalizedPublicFolder,
    "media"
  ])) {
    if (!prefix) continue;
    if (relative === prefix) {
      relative = "";
      break;
    }
    if (relative.startsWith(`${prefix}/`)) {
      relative = relative.slice(prefix.length + 1);
      break;
    }
  }
  if (relative === "content" || relative.startsWith("content/")) {
    throw requestError(400, "The media path is outside the configured media folder.");
  }

  const segments = relative.split("/");
  if (
    !relative ||
    segments.length > 32 ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 255 ||
        /[\\/\u0000-\u001f\u007f]/.test(segment)
    )
  ) {
    throw requestError(400, "The media identifier contains an invalid path.");
  }
  return segments.join("/");
}

function parseImageRoute(params) {
  const schema = String(params.schema || "");
  if (!CACHE_SCHEMA_PATTERN.test(schema)) {
    throw requestError(400, "The image cache schema is invalid.");
  }
  const suppliedFormat = String(params.format || "");
  const format = suppliedFormat.toLowerCase();
  if (!ROUTE_FORMATS.has(format)) {
    throw requestError(400, "The requested image format is not supported.");
  }
  if (suppliedFormat !== format) {
    throw requestError(404, "The image output format is not canonical.");
  }

  let addressed;
  let parsedOperations;
  try {
    addressed = parseContentAddressedMediaPath(
      `/media/${String(params.collection || "")}/${String(params.sha || "")}/${String(params.filename || "")}`
    );
    if (!addressed) {
      throw new TypeError("Invalid content-addressed media path.");
    }
    parsedOperations = parseImageOperations(String(params.operations || ""));
  } catch (error) {
    throw requestError(400, error.message);
  }
  const expectedSlug = imageServiceSlug(addressed.path);
  if (params.slug !== expectedSlug) {
    throw requestError(404, "The image slug is not canonical.");
  }
  const canonical = serializeImageOperations(parsedOperations);
  if (params.operations !== canonical) {
    throw requestError(404, "The image operation stack is not canonical.");
  }

  const operations = numericOperations(parsedOperations);
  return Object.freeze({
    schema,
    slug: expectedSlug,
    format,
    sourceSegments: Object.freeze([
      addressed.collection,
      addressed.sha,
      addressed.filename
    ]),
    reference: addressed.path,
    operations,
    canonical
  });
}

function numericOperations(operations) {
  return operations.map(({ type, options = {} }) => ({
    type,
    options: Object.fromEntries(
      Object.entries(options).map(([name, value]) => [
        name,
        [
          "width",
          "height",
          "left",
          "top",
          "rotation",
          "angle",
          "value"
        ].includes(name)
          ? Number(value)
          : value
      ])
    )
  }));
}

export {
  normalizeMediaReference,
  parseImageRoute,
  requestError
};
