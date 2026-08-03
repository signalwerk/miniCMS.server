import {
  parseImageServiceUrl,
  serializeImageOperations
} from "@signalwerk/minicms/core/image-service";

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

function parseImageRoute(value) {
  const parsed = parseImageServiceUrl(value);
  if (!parsed || parsed.baseUrl) {
    throw requestError(404, "The image route is not canonical.");
  }
  const canonical = serializeImageOperations(parsed.operations);
  const operations = numericOperations(parsed.operations);
  return Object.freeze({
    schema: parsed.schema,
    collection: parsed.collection,
    sha: parsed.sha,
    filename: parsed.filename,
    format: parsed.format,
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
