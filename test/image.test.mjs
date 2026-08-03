import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { imageServicePath } from "@signalwerk/minicms/core/image-service";
import { createApp } from "../src/app.mjs";

const SVG_SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><script>alert(1)</script><rect width="120" height="80" fill="red"/></svg>`;
const PADDED_SVG_SOURCE = `<!--${" ".repeat(70 * 1024)}-->${SVG_SOURCE}`;

function configSource({
  strategy = "revalidate",
  maxAge = 0,
  publicFolder = "/media"
} = {}) {
  return `site:
  media_folder: content/uploads
  public_folder: ${publicFolder}
  image_processing:
    width: 64
    height: 64
    fit: inside
    format: webp
    quality: 82
    cache:
      schema: images_v1
      strategy: ${strategy}
      max_age: ${maxAge}
node_types:
  page:
    kind: document
    fields:
      title: { widget: string }
      image: { widget: image, accept: [image/jpeg, image/png, image/tiff, .tif, .tiff, image/svg+xml] }
      file: { widget: file, accept: ["*/*"] }
collections:
  pages:
    folder: content/pages
    extension: yml
    node_type: page
`;
}

async function makeFixture(options = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-images-"));
  const mediaDir = path.join(rootDir, "content", "uploads");
  const cacheDir = path.join(rootDir, "image-cache");
  await fs.mkdir(mediaDir, { recursive: true });
  await fs.mkdir(path.join(rootDir, "content", "pages"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "cms.config.yml"),
    configSource(options),
    "utf8"
  );
  await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 4,
      background: { r: 220, g: 30, b: 40, alpha: 1 }
    }
  })
    .jpeg({ quality: 90 })
    .toFile(path.join(mediaDir, "photo.jpg"));
  const patternWidth = 120;
  const patternHeight = 80;
  const patternPixels = Buffer.alloc(patternWidth * patternHeight * 3);
  for (let y = 0; y < patternHeight; y += 1) {
    for (let x = 0; x < patternWidth; x += 1) {
      const offset = (y * patternWidth + x) * 3;
      patternPixels[offset] = x * 2;
      patternPixels[offset + 1] = y * 3;
      patternPixels[offset + 2] = 40;
    }
  }
  await sharp(patternPixels, {
    raw: { width: patternWidth, height: patternHeight, channels: 3 }
  })
    .png()
    .toFile(path.join(mediaDir, "pattern.png"));
  const jpeg = await fs.readFile(path.join(mediaDir, "photo.jpg"));
  const jpegComment = Buffer.from("<svg data-test>", "ascii");
  const jpegCommentLength = jpegComment.length + 2;
  await fs.writeFile(
    path.join(mediaDir, "tagged.jpg"),
    Buffer.concat([
      jpeg.subarray(0, 2),
      Buffer.from([
        0xff,
        0xfe,
        jpegCommentLength >> 8,
        jpegCommentLength & 0xff
      ]),
      jpegComment,
      jpeg.subarray(2)
    ])
  );
  await sharp({
    create: {
      width: 90,
      height: 60,
      channels: 3,
      background: { r: 30, g: 90, b: 180 }
    }
  })
    .tiff({ compression: "lzw" })
    .toFile(path.join(mediaDir, "scan.tif"));
  await fs.copyFile(
    path.join(mediaDir, "scan.tif"),
    path.join(mediaDir, "scan.tiff")
  );
  await sharp({
    create: {
      width: 2,
      height: 1,
      channels: 4,
      background: { r: 220, g: 30, b: 40, alpha: 0.25 }
    }
  })
    .png()
    .toFile(path.join(mediaDir, "alpha.png"));
  await sharp({
    create: {
      width: 120,
      height: 80,
      channels: 3,
      background: { r: 20, g: 180, b: 90 }
    }
  })
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .toFile(path.join(mediaDir, "oriented.jpg"));
  await fs.writeFile(path.join(mediaDir, "vector.svg"), SVG_SOURCE, "utf8");
  await fs.writeFile(
    path.join(mediaDir, "padded.svg"),
    PADDED_SVG_SOURCE,
    "utf8"
  );
  await fs.writeFile(
    path.join(mediaDir, "disguised.jpg"),
    SVG_SOURCE,
    "utf8"
  );
  await fs.writeFile(
    path.join(mediaDir, "padded-disguised.jpg"),
    PADDED_SVG_SOURCE,
    "utf8"
  );
  await fs.writeFile(path.join(mediaDir, "unknown.jpg"), "not an image", "utf8");
  await fs.writeFile(path.join(mediaDir, "invalid.svg"), "not an svg", "utf8");
  await fs.writeFile(path.join(mediaDir, "Research ü draft.txt"), "notes", "utf8");
  await fs.mkdir(path.join(mediaDir, "nested", "archive"), { recursive: true });
  await fs.writeFile(
    path.join(mediaDir, "nested", "archive", "report.txt"),
    "nested notes",
    "utf8"
  );
  const media = {};
  for (const [key, sourcePath, filename, collection = "images"] of [
    ["photo", path.join(mediaDir, "photo.jpg"), "photo.jpg"],
    ["pattern", path.join(mediaDir, "pattern.png"), "pattern.png"],
    ["tagged", path.join(mediaDir, "tagged.jpg"), "tagged.jpg"],
    ["scanTif", path.join(mediaDir, "scan.tif"), "scan.tif"],
    ["scanTiff", path.join(mediaDir, "scan.tiff"), "scan.tiff"],
    ["alpha", path.join(mediaDir, "alpha.png"), "alpha.png"],
    ["oriented", path.join(mediaDir, "oriented.jpg"), "oriented.jpg"],
    ["vector", path.join(mediaDir, "vector.svg"), "vector.svg"],
    ["padded", path.join(mediaDir, "padded.svg"), "padded.svg"],
    ["disguised", path.join(mediaDir, "disguised.jpg"), "disguised.jpg"],
    [
      "paddedDisguised",
      path.join(mediaDir, "padded-disguised.jpg"),
      "padded-disguised.jpg"
    ],
    ["unknown", path.join(mediaDir, "unknown.jpg"), "unknown.jpg"],
    ["invalidSvg", path.join(mediaDir, "invalid.svg"), "invalid.svg"],
    [
      "notes",
      path.join(mediaDir, "Research ü draft.txt"),
      "research-draft.txt",
      "files"
    ],
    [
      "report",
      path.join(mediaDir, "nested", "archive", "report.txt"),
      "report.txt",
      "files"
    ]
  ]) {
    const contents = await fs.readFile(sourcePath);
    const sha = createHash("sha256").update(contents).digest("hex");
    const directory = path.join(mediaDir, collection, sha);
    const filePath = path.join(directory, filename);
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(sourcePath, filePath);
    media[key] = Object.freeze({
      filePath,
      filename,
      sha,
      source: `/media/${collection}/${sha}/${filename}`
    });
  }
  return {
    rootDir,
    mediaDir,
    cacheDir,
    media: Object.freeze(media),
    addressedSha: media.photo.sha,
    addressedSource: media.photo.source,
    addressedSvgSource: media.vector.source
  };
}

async function withServer(run, options = {}) {
  const {
    beforeStart,
    cacheUnavailable = false,
    environment = {},
    quietImageWarnings = false,
    ...fixtureOptions
  } = options;
  const fixture = await makeFixture(fixtureOptions);
  const cacheParent = cacheUnavailable
    ? path.join(fixture.rootDir, "cache-is-a-file")
    : fixture.cacheDir;
  if (cacheUnavailable) await fs.writeFile(cacheParent, "not a directory", "utf8");
  await beforeStart?.({ ...fixture, cacheParent });
  const app = createApp({
    rootDir: fixture.rootDir,
    imageLogger:
      cacheUnavailable || quietImageWarnings ? { warn() {} } : console,
    environment: {
      MINICMS_IMAGE_CACHE_DIR: cacheParent,
      MINICMS_IMAGE_MAX_EDGE: "512",
      MINICMS_IMAGE_MAX_OUTPUT_PIXELS: "65536",
      MINICMS_MEDIA_MAX_UPLOAD_BYTES: "1024",
      MINICMS_IMAGE_CONCURRENCY: "1",
      MINICMS_IMAGE_QUEUE_LIMIT: "4",
      MINICMS_IMAGE_TIMEOUT_SECONDS: "5",
      ...environment
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  try {
    const config = await fetch(
      `http://127.0.0.1:${address.port}/api/config`
    ).then((response) => response.json());
    await run({
      ...fixture,
      config,
      baseUrl: `http://127.0.0.1:${address.port}`
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  }
}

function servicePath(source, config, options = {}) {
  return imageServicePath(source, { config, ...options });
}

async function cacheFiles(cacheDir) {
  const files = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files.push(file);
    }
  }
  await walk(cacheDir);
  return files;
}

async function waitFor(check, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test("transforms content-addressed raster images, publishes safe info, and reuses the atomic disk cache", async () => {
  await withServer(async ({
    baseUrl,
    config,
    cacheDir,
    media,
    addressedSha,
    addressedSource
  }) => {
    const route = servicePath(addressedSource, config, {
      width: 60,
      height: 40,
      format: "webp",
      quality: 70
    });
    assert.equal(
      route,
      `/media/_image/images_v1/images/${addressedSha}/photo.jpg/resize@width:60,height:40,fit:inside;quality@70/photo.webp`
    );
    const first = await fetch(`${baseUrl}${route}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/webp");
    assert.equal(first.headers.get("cache-control"), "public, max-age=0, must-revalidate");
    assert.equal(first.headers.get("x-minicms-image-cache"), "miss");
    assert.match(first.headers.get("etag"), /^"sha256-[a-f0-9]{64}"$/);
    const firstBytes = Buffer.from(await first.arrayBuffer());
    const output = await sharp(firstBytes).metadata();
    assert.equal(output.width, 60);
    assert.equal(output.height, 40);

    const second = await fetch(`${baseUrl}${route}`);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-minicms-image-cache"), "hit");
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), firstBytes);
    assert.equal(second.headers.get("etag"), first.headers.get("etag"));

    const conditional = await fetch(`${baseUrl}${route}`, {
      headers: { "if-none-match": first.headers.get("etag") }
    });
    assert.equal(conditional.status, 304);
    assert.equal((await conditional.arrayBuffer()).byteLength, 0);

    const head = await fetch(`${baseUrl}${route}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(firstBytes.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const files = await cacheFiles(cacheDir);
    assert.equal(files.length, 1);
    assert.match(path.basename(files[0]), /^[a-f0-9]{64}\.webp$/);
    assert.match(
      path.relative(cacheDir, files[0]),
      /^minicms-image-cache\/[a-f0-9]{16}\/images_v1\/[a-f0-9]{2}\/[a-f0-9]{64}\.webp$/
    );
    assert.equal(files.some((file) => file.endsWith(".tmp")), false);

    const ownedCacheRoot = path.dirname(path.dirname(path.dirname(files[0])));
    await fs.rm(ownedCacheRoot, { recursive: true });
    const rebuilt = await fetch(`${baseUrl}${route}`);
    assert.equal(rebuilt.status, 200);
    assert.equal(rebuilt.headers.get("x-minicms-image-cache"), "miss");
    await rebuilt.arrayBuffer();
    await fs.access(ownedCacheRoot);

    const infoRoute = servicePath(addressedSource, config, { info: true });
    const infoResponse = await fetch(`${baseUrl}${infoRoute}`);
    assert.equal(infoResponse.status, 200);
    assert.equal(infoResponse.headers.get("access-control-allow-origin"), "*");
    const info = await infoResponse.json();
    assert.equal(info.width, 120);
    assert.equal(info.height, 80);
    assert.equal(info.sourceWidth, 120);
    assert.equal(info.sourceHeight, 80);
    assert.equal(info.format, "jpeg");
    assert.equal(Object.hasOwn(info, "meta"), false);
    assert.equal(Object.hasOwn(info, "path"), false);
    assert.equal(Object.hasOwn(info, "exif"), false);
    assert.equal(Object.hasOwn(info, "icc"), false);

    const orientedInfoRoute = servicePath(
      media.oriented.source,
      config,
      { info: true }
    );
    const orientedInfo = await fetch(`${baseUrl}${orientedInfoRoute}`).then(
      (result) => result.json()
    );
    assert.equal(orientedInfo.width, 80);
    assert.equal(orientedInfo.height, 120);
  });
});

test("uploads directly into the readable content-addressed image route", async () => {
  await withServer(async ({ baseUrl, config, mediaDir }) => {
    const original = await sharp({
      create: {
        width: 16,
        height: 8,
        channels: 3,
        background: { r: 10, g: 120, b: 220 }
      }
    }).png().toBuffer();
    const sha = createHash("sha256").update(original).digest("hex");
    const upload = await fetch(
      `${baseUrl}/api/media/pages?filename=Fresh%20Image.png`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: original
      }
    );
    assert.equal(upload.status, 201);
    const result = await upload.json();
    assert.deepEqual(result, {
      filename: "fresh-image.png",
      sha,
      path: `/media/pages/${sha}/fresh-image.png`,
      storage_path: `content/uploads/pages/${sha}/fresh-image.png`
    });
    assert.deepEqual(
      await fs.readFile(path.join(mediaDir, "pages", sha, "fresh-image.png")),
      original
    );

    const route = servicePath(result.path, config, {
      width: 8,
      height: 8,
      format: "webp"
    });
    assert.match(
      route,
      new RegExp(`/pages/${sha}/fresh-image\\.png/resize@`)
    );
    const transformed = await fetch(`${baseUrl}${route}`);
    assert.equal(transformed.status, 200);
    const metadata = await sharp(
      Buffer.from(await transformed.arrayBuffer())
    ).metadata();
    assert.equal(metadata.width, 8);
    assert.equal(metadata.height, 4);
  });
});

test("applies ordered rotate, resize, flatten, and quality operations", async () => {
  await withServer(async ({ baseUrl, config, media }) => {
    const route = servicePath(media.photo.source, config, {
      format: "png",
      operations: [
        { type: "rotate", options: { angle: 90 } },
        {
          type: "resize",
          options: { width: 30, height: 40, fit: "inside" }
        },
        { type: "flatten", options: { background: "ffffff" } },
        { type: "quality", options: { value: 90 } }
      ]
    });
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200);
    const metadata = await sharp(
      Buffer.from(await response.arrayBuffer())
    ).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width, 27);
    assert.equal(metadata.height, 40);
    assert.equal(metadata.hasAlpha, false);

    const withoutEnlargement = servicePath(media.photo.source, config, {
      format: "png",
      operations: [
        {
          type: "crop",
          options: { left: 0, top: 0, width: 30, height: 20 }
        },
        {
          type: "resize",
          options: { width: 64, height: 64, fit: "inside" }
        },
        { type: "quality", options: { value: 90 } }
      ]
    });
    const originalSize = await fetch(`${baseUrl}${withoutEnlargement}`);
    assert.equal(originalSize.status, 200);
    const originalMetadata = await sharp(
      Buffer.from(await originalSize.arrayBuffer())
    ).metadata();
    assert.equal(originalMetadata.width, 30);
    assert.equal(originalMetadata.height, 20);

    const removeAlpha = servicePath(media.alpha.source, config, {
      format: "png",
      operations: [
        { type: "flatten", options: { alpha: "remove" } },
        { type: "quality", options: { value: 90 } }
      ]
    });
    const alphaBytes = Buffer.from(
      await (await fetch(`${baseUrl}${removeAlpha}`)).arrayBuffer()
    );
    const alphaMetadata = await sharp(alphaBytes).metadata();
    const alphaPixel = await sharp(alphaBytes).raw().toBuffer();
    assert.equal(alphaMetadata.hasAlpha, false);
    assert.equal(alphaPixel[0] > 150, true);

    const impossibleCrop = servicePath(media.alpha.source, config, {
      format: "png",
      operations: [
        {
          type: "crop",
          options: { left: 2, top: 0, width: 1, height: 1 }
        },
        { type: "quality", options: { value: 90 } }
      ]
    });
    assert.equal((await fetch(`${baseUrl}${impossibleCrop}`)).status, 400);

    const roundedRotation = servicePath(media.photo.source, config, {
      format: "png",
      operations: [
        {
          type: "crop",
          options: {
            left: 95,
            top: 20,
            width: 40,
            height: 20,
            rotation: 45
          }
        },
        { type: "quality", options: { value: 90 } }
      ]
    });
    assert.equal((await fetch(`${baseUrl}${roundedRotation}`)).status, 400);
  });
});

test("crops axis-aligned, right-angle, and fractional source regions", async () => {
  await withServer(async ({ baseUrl, config, media }) => {
    async function transformed(crop) {
      const route = servicePath(media.pattern.source, config, {
        format: "png",
        operations: [
          { type: "crop", options: crop },
          { type: "quality", options: { value: 90 } }
        ]
      });
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200);
      const result = await sharp(
        Buffer.from(await response.arrayBuffer())
      ).raw().toBuffer({ resolveWithObject: true });
      return { route, ...result };
    }

    function pixel(result, x, y) {
      const offset = (y * result.info.width + x) * result.info.channels;
      return [...result.data.subarray(offset, offset + 3)];
    }

    const axis = await transformed({
      left: 20,
      top: 10,
      width: 31,
      height: 21
    });
    assert.equal(axis.info.width, 31);
    assert.equal(axis.info.height, 21);
    const axisStart = pixel(axis, 5, 5);
    const axisEnd = pixel(axis, 25, 15);
    assert.equal(axisEnd[0] > axisStart[0], true);
    assert.equal(axisEnd[1] > axisStart[1], true);

    const rightAngle = await transformed({
      left: 30,
      top: 20,
      width: 40,
      height: 20,
      rotation: 90
    });
    assert.equal(rightAngle.info.width, 40);
    assert.equal(rightAngle.info.height, 20);
    const rightTopLeft = pixel(rightAngle, 5, 5);
    const rightTopRight = pixel(rightAngle, 34, 5);
    const rightBottomLeft = pixel(rightAngle, 5, 14);
    assert.equal(rightTopRight[1] > rightTopLeft[1] + 50, true);
    assert.equal(rightBottomLeft[0] < rightTopLeft[0] - 10, true);

    const fractional = await transformed({
      left: 34.75,
      top: 24.75,
      width: 50.5,
      height: 30.5,
      rotation: 12.25
    });
    assert.match(fractional.route, /rotation:12\.25/);
    assert.equal(fractional.info.width, 51);
    assert.equal(fractional.info.height, 31);
    const center = pixel(fractional, 25, 15);
    assert.equal(Math.abs(center[0] - 120) < 8, true);
    assert.equal(Math.abs(center[1] - 120) < 8, true);

    const downsampledRoute = servicePath(media.pattern.source, config, {
      format: "png",
      operations: [
        {
          type: "crop",
          options: {
            left: 34.75,
            top: 24.75,
            width: 50.5,
            height: 30.5,
            rotation: 12.25
          }
        },
        {
          type: "resize",
          options: { width: 25, height: 25, fit: "inside" }
        },
        { type: "quality", options: { value: 90 } }
      ]
    });
    const downsampled = await fetch(`${baseUrl}${downsampledRoute}`);
    assert.equal(downsampled.status, 200);
    const downsampledInfo = await sharp(
      Buffer.from(await downsampled.arrayBuffer())
    ).metadata();
    assert.equal(downsampledInfo.width, 25);
    assert.equal(downsampledInfo.height, 15);

    const crossingLocalBox = await transformed({
      left: -10,
      top: 30,
      width: 40,
      height: 20,
      rotation: 90
    });
    assert.equal(crossingLocalBox.info.width, 40);
    assert.equal(crossingLocalBox.info.height, 20);
  });
});

test("bounds oriented crop work while allowing a large source and small crop", async () => {
  await withServer(async ({ baseUrl, config, media }) => {
    const smallCrop = servicePath(media.pattern.source, config, {
      format: "png",
      operations: [
        {
          type: "crop",
          options: { left: 45, top: 30, width: 20, height: 20 }
        },
        { type: "quality", options: { value: 90 } }
      ]
    });
    const smallResponse = await fetch(`${baseUrl}${smallCrop}`);
    assert.equal(smallResponse.status, 200);
    const smallMetadata = await sharp(
      Buffer.from(await smallResponse.arrayBuffer())
    ).metadata();
    assert.equal(smallMetadata.width, 20);
    assert.equal(smallMetadata.height, 20);

    const downsampledCrop = servicePath(media.pattern.source, config, {
      format: "png",
      operations: [
        {
          type: "crop",
          options: { left: 0, top: 0, width: 120, height: 80 }
        },
        {
          type: "resize",
          options: { width: 32, height: 32, fit: "inside" }
        },
        { type: "quality", options: { value: 90 } }
      ]
    });
    const downsampledResponse = await fetch(`${baseUrl}${downsampledCrop}`);
    assert.equal(downsampledResponse.status, 200);
    const downsampledMetadata = await sharp(
      Buffer.from(await downsampledResponse.arrayBuffer())
    ).metadata();
    assert.equal(downsampledMetadata.width, 32);
    assert.equal(downsampledMetadata.height, 21);

    const expensivePatch = servicePath(media.pattern.source, config, {
      format: "png",
      operations: [
        {
          type: "crop",
          options: { left: 28, top: 39, width: 64, height: 2, rotation: 45 }
        },
        { type: "quality", options: { value: 90 } }
      ]
    });
    assert.equal((await fetch(`${baseUrl}${expensivePatch}`)).status, 413);
  }, {
    environment: {
      MINICMS_IMAGE_MAX_EDGE: "64",
      MINICMS_IMAGE_MAX_OUTPUT_PIXELS: "65536"
    }
  });
});

test("processes both TIF and TIFF source filenames", async () => {
  await withServer(async ({ baseUrl, config, media }) => {
    for (const source of [media.scanTif.source, media.scanTiff.source]) {
      const route = servicePath(source, config, {
        width: 45,
        height: 45,
        format: "webp"
      });
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "image/webp");
      const metadata = await sharp(
        Buffer.from(await response.arrayBuffer())
      ).metadata();
      assert.equal(metadata.width, 45);
      assert.equal(metadata.height, 30);
    }

    const info = await fetch(
      `${baseUrl}${servicePath(media.scanTiff.source, config, { info: true })}`
    ).then((response) => response.json());
    assert.equal(info.format, "tiff");
    assert.equal(info.width, 90);
    assert.equal(info.height, 60);
  });
});

test("source changes invalidate the server cache without serving deleted media", async () => {
  await withServer(async ({ baseUrl, config, mediaDir, media }) => {
    const route = servicePath(media.photo.source, config, {
      width: 40,
      height: 40,
      format: "png"
    });
    const first = await fetch(`${baseUrl}${route}`);
    const firstEtag = first.headers.get("etag");
    await first.arrayBuffer();

    await sharp({
      create: {
        width: 80,
        height: 120,
        channels: 3,
        background: { r: 10, g: 20, b: 220 }
      }
    })
      .jpeg()
      .toFile(path.join(mediaDir, ".replacement.jpg"));
    await fs.rename(
      path.join(mediaDir, ".replacement.jpg"),
      media.photo.filePath
    );

    const replaced = await fetch(`${baseUrl}${route}`);
    assert.equal(replaced.status, 200);
    assert.equal(replaced.headers.get("x-minicms-image-cache"), "miss");
    assert.notEqual(replaced.headers.get("etag"), firstEtag);
    await replaced.arrayBuffer();

    await fs.unlink(media.photo.filePath);
    const deleted = await fetch(`${baseUrl}${route}`);
    assert.equal(deleted.status, 404);
  });
});

test("existing URLs survive image defaults and cache schema changes", async () => {
  await withServer(async ({ baseUrl, config, media }) => {
    const oldRoute = servicePath(media.photo.source, config, {
      width: 60,
      height: 40
    });
    const nextConfig = structuredClone(config);
    nextConfig.site.image_processing.width = 32;
    nextConfig.site.image_processing.height = 32;
    nextConfig.site.image_processing.cache.schema = "images_v2";
    const saved = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(nextConfig)
    });
    assert.equal(saved.status, 200);
    const savedConfig = (await saved.json()).config;

    const oldResponse = await fetch(`${baseUrl}${oldRoute}`);
    assert.equal(oldResponse.status, 200);
    assert.match(oldResponse.url, /\/_image\/images_v2\//);
    const oldOutput = await sharp(
      Buffer.from(await oldResponse.arrayBuffer())
    ).metadata();
    assert.equal(oldOutput.width, 60);
    assert.equal(oldOutput.height, 40);

    assert.match(
      servicePath(media.photo.source, savedConfig),
      /\/_image\/images_v2\/.*resize@width:32,height:32/
    );
  });
});

test("canonical transformed URLs survive a custom public media folder", async () => {
  await withServer(async ({ baseUrl, config, media }) => {
    const customSource = media.photo.source.replace(
      "/media/",
      "/assets/library/"
    );
    const route = servicePath(customSource, config, {
      width: 40,
      height: 30
    });
    assert.match(
      route,
      new RegExp(`/images/${media.photo.sha}/photo\\.jpg/`)
    );
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 200);
    const output = await sharp(
      Buffer.from(await response.arrayBuffer())
    ).metadata();
    assert.equal(output.width, 40);
    assert.equal(output.height, 27);
  }, { publicFolder: "/assets/library" });
});

test("strictly rejects noncanonical routes, invalid operations, and oversized outputs", async () => {
  await withServer(async ({ baseUrl, config, addressedSha, addressedSource }) => {
    const valid = servicePath(addressedSource, config, {
      width: 40,
      height: 40
    });
    const oldSchema = valid.replace("/_image/images_v1/", "/_image/old/");
    const oldVersion = await fetch(`${baseUrl}${oldSchema}`, {
      redirect: "manual"
    });
    assert.equal(oldVersion.status, 307);
    assert.equal(oldVersion.headers.get("cache-control"), "no-store");
    assert.equal(oldVersion.headers.get("location"), valid);

    assert.equal(
      (
        await fetch(
          `${baseUrl}${valid.replace(addressedSha, addressedSha.toUpperCase())}`
        )
      ).status,
      400
    );
    assert.equal(
      (
        await fetch(
          `${baseUrl}${valid.replace("/images/", "/%69mages/")}`
        )
      ).status,
      404
    );

    const badSlug = valid.replace("/photo.webp", "/duplicate.webp");
    assert.equal((await fetch(`${baseUrl}${badSlug}`)).status, 404);

    const sourceRoute = valid.slice(0, valid.indexOf("/resize@"));
    const invalidOperations = `${sourceRoute}/quality@101/photo.webp`;
    assert.equal((await fetch(`${baseUrl}${invalidOperations}`)).status, 400);

    const noncanonicalOperations = `${sourceRoute}/resize@40/photo.webp`;
    assert.equal((await fetch(`${baseUrl}${noncanonicalOperations}`)).status, 404);

    const invalidFormat = `${sourceRoute}/noop/photo.bmp`;
    assert.equal((await fetch(`${baseUrl}${invalidFormat}`)).status, 400);

    const uppercaseFormat = valid.replace(/\.webp$/, ".WEBP");
    assert.equal((await fetch(`${baseUrl}${uppercaseFormat}`)).status, 404);

    const removedEncodedRoute =
      "/media/_image/images_v1/L21lZGlhL3Bob3RvLmpwZw/noop/photo.webp";
    assert.equal(
      (await fetch(`${baseUrl}${removedEncodedRoute}`)).status,
      404
    );

    const oversized = `${sourceRoute}/resize@width:513,height:513,fit:cover;quality@82/photo.webp`;
    assert.equal((await fetch(`${baseUrl}${oversized}`)).status, 413);

    const oversizedSegment = `${"ü".repeat(126)}.jpg`;
    assert.equal(
      (
        await fetch(
          `${baseUrl}/media/images/${addressedSha}/${encodeURIComponent(oversizedSegment)}`
        )
      ).status,
      404
    );

    const invalidProjectConfig = structuredClone(config);
    invalidProjectConfig.site.image_processing.width = 512;
    invalidProjectConfig.site.image_processing.height = 512;
    const invalidProject = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(invalidProjectConfig)
    });
    assert.equal(invalidProject.status, 400);

    const transformedInfo = valid.replace(/photo\.webp$/, "photo.json");
    const infoError = await fetch(`${baseUrl}${transformedInfo}`);
    assert.equal(infoError.status, 400);
    assert.equal(infoError.headers.get("access-control-allow-origin"), "*");
  }, {
    environment: {
      MINICMS_IMAGE_MAX_EDGE: "64"
    }
  });
});

test("passes SVG through byte-for-byte, exposes safe dimensions, and never rasterizes it", async () => {
  await withServer(async ({ baseUrl, config, media, addressedSvgSource }) => {
    const svgRoute = servicePath(addressedSvgSource, config);
    const response = await fetch(`${baseUrl}${svgRoute}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
    assert.equal(response.headers.get("x-minicms-image-cache"), "passthrough");
    assert.match(response.headers.get("content-security-policy"), /sandbox/);
    assert.equal(await response.text(), SVG_SOURCE);

    const infoRoute = servicePath(addressedSvgSource, config, { info: true });
    const info = await fetch(`${baseUrl}${infoRoute}`).then((result) => result.json());
    assert.equal(info.width, 120);
    assert.equal(info.height, 80);
    assert.equal(info.format, "svg");

    const rasterAttempt = svgRoute.replace(/\.svg$/, ".webp");
    assert.equal((await fetch(`${baseUrl}${rasterAttempt}`)).status, 415);

    const disguisedRoute = servicePath(media.disguised.source, config);
    assert.equal((await fetch(`${baseUrl}${disguisedRoute}`)).status, 415);
    const rawDisguised = await fetch(`${baseUrl}${media.disguised.source}`);
    assert.match(rawDisguised.headers.get("content-type"), /^image\/svg\+xml/);
    assert.equal(await rawDisguised.text(), SVG_SOURCE);

    const paddedRoute = servicePath(media.padded.source, config);
    const padded = await fetch(`${baseUrl}${paddedRoute}`);
    assert.equal(padded.status, 200);
    assert.equal(await padded.text(), PADDED_SVG_SOURCE);

    const paddedDisguisedRoute = servicePath(
      media.paddedDisguised.source,
      config
    );
    assert.equal((await fetch(`${baseUrl}${paddedDisguisedRoute}`)).status, 415);
    assert.equal(
      (await fetch(`${baseUrl}${servicePath(media.unknown.source, config)}`))
        .status,
      415
    );
    assert.equal(
      (await fetch(`${baseUrl}${servicePath(media.invalidSvg.source, config)}`))
        .status,
      415
    );
    const invalidRawSvg = await fetch(`${baseUrl}${media.invalidSvg.source}`);
    assert.equal(invalidRawSvg.headers.get("content-type"), "application/octet-stream");
    assert.match(invalidRawSvg.headers.get("content-disposition"), /attachment/);

    const taggedRoute = servicePath(media.tagged.source, config, {
      width: 30,
      height: 20
    });
    const tagged = await fetch(`${baseUrl}${taggedRoute}`);
    assert.equal(tagged.status, 200);
    assert.equal(
      (await sharp(Buffer.from(await tagged.arrayBuffer())).metadata()).format,
      "webp"
    );
  });
});

test("serves configured raw media safely and rejects symbolic links", async (t) => {
  await withServer(async ({ baseUrl, mediaDir, rootDir, config, media }) => {
    const raw = await fetch(`${baseUrl}${media.photo.source}`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("x-minicms-image-cache"), "raw");
    assert.equal(raw.headers.get("content-type"), "image/jpeg");

    const range = await fetch(`${baseUrl}${media.photo.source}`, {
      headers: { range: "bytes=0-9" }
    });
    assert.equal(range.status, 206);
    assert.match(range.headers.get("content-range"), /^bytes 0-9\//);
    assert.equal((await range.arrayBuffer()).byteLength, 10);

    const download = await fetch(`${baseUrl}${media.notes.source}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /^attachment;/);
    assert.match(download.headers.get("content-security-policy"), /sandbox/);
    assert.equal(await download.text(), "notes");

    const report = await fetch(`${baseUrl}${media.report.source}`);
    assert.equal(report.status, 200);
    assert.equal(await report.text(), "nested notes");
    assert.equal((await fetch(`${baseUrl}/media/photo.jpg`)).status, 404);

    const unicodeInfo = servicePath(
      media.notes.source,
      config,
      { info: true }
    );
    const unsupported = await fetch(`${baseUrl}${unicodeInfo}`);
    assert.equal(unsupported.status, 415);

    const outside = path.join(rootDir, "outside.jpg");
    await fs.writeFile(outside, "outside", "utf8");
    const linkedSha = "c".repeat(64);
    const linkedDirectory = path.join(mediaDir, "images", linkedSha);
    const link = path.join(linkedDirectory, "linked.jpg");
    const linkedSource = `/media/images/${linkedSha}/linked.jpg`;
    await fs.mkdir(linkedDirectory, { recursive: true });
    try {
      await fs.symlink(outside, link);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("Symbolic links are unavailable on this platform.");
        return;
      }
      throw error;
    }
    assert.equal((await fetch(`${baseUrl}${linkedSource}`)).status, 404);
    const linkedRoute = servicePath(linkedSource, config, { info: true });
    assert.equal((await fetch(`${baseUrl}${linkedRoute}`)).status, 404);
  });
});

test("disabled cache writes nothing and streamed uploads enforce their byte limit", async () => {
  await withServer(async ({ baseUrl, config, cacheDir, mediaDir, media }) => {
    const route = servicePath(media.photo.source, config, {
      width: 30,
      height: 20
    });
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-minicms-image-cache"), "disabled");
      await response.arrayBuffer();
    }
    assert.deepEqual(await cacheFiles(cacheDir), []);

    const jsonBody = JSON.stringify({ ok: true });
    const jsonUpload = await fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("data.json")}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: jsonBody
      }
    );
    assert.equal(jsonUpload.status, 201);
    const jsonHash = createHash("sha256").update(jsonBody).digest("hex");
    assert.equal(
      await fs.readFile(
        path.join(mediaDir, "pages", jsonHash, "data.json"),
        "utf8"
      ),
      jsonBody
    );

    const oversized = await fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("too-large.bin")}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: Buffer.alloc(1025)
      }
    );
    assert.equal(oversized.status, 413);
    assert.equal(
      (await fs.readdir(mediaDir)).some((name) => name.includes("too-large")),
      false
    );
    assert.equal(
      (await fs.readdir(mediaDir)).some((name) => name.startsWith(".minicms-upload-")),
      false
    );
  }, { strategy: "disabled", maxAge: 0 });
});

test("cache storage failures never prevent derivative delivery", async () => {
  await withServer(async ({ baseUrl, config, media }) => {
    const route = servicePath(media.photo.source, config, {
      width: 30,
      height: 20
    });
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${baseUrl}${route}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-minicms-image-cache"), "uncached");
      assert.equal((await response.arrayBuffer()).byteLength > 0, true);
    }
  }, { cacheUnavailable: true });
});

test("cache storage never follows a linked schema directory", async (t) => {
  await withServer(async ({ baseUrl, config, cacheDir, rootDir, media }) => {
    const initial = await fetch(
      `${baseUrl}${servicePath(media.photo.source, config, {
        width: 30,
        height: 20
      })}`
    );
    assert.equal(initial.status, 200);
    await initial.arrayBuffer();

    const serviceRoot = path.join(cacheDir, "minicms-image-cache");
    const [projectKey] = await fs.readdir(serviceRoot);
    const schemaDirectory = path.join(serviceRoot, projectKey, "images_v1");
    const outsideDirectory = path.join(rootDir, "outside-cache");
    await fs.rm(schemaDirectory, { recursive: true });
    await fs.mkdir(outsideDirectory);
    try {
      await fs.symlink(outsideDirectory, schemaDirectory);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("Symbolic links are unavailable on this platform.");
        return;
      }
      throw error;
    }

    const response = await fetch(
      `${baseUrl}${servicePath(media.photo.source, config, {
        width: 31,
        height: 20
      })}`
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-minicms-image-cache"), "uncached");
    await response.arrayBuffer();
    assert.deepEqual(await fs.readdir(outsideDirectory), []);
  }, { quietImageWarnings: true });
});

test("startup maintenance bounds only the service-owned cache", async () => {
  let sentinel;
  await withServer(async ({ cacheDir }) => {
    const files = await waitFor(async () => {
      const entries = (await cacheFiles(cacheDir)).filter(
        (file) => file !== sentinel
      );
      return entries.length <= 2 ? entries : null;
    });
    assert.equal(files.length, 2);
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep");
  }, {
    beforeStart: async ({ rootDir, cacheParent }) => {
      sentinel = path.join(cacheParent, "unrelated.txt");
      const projectKey = createHash("sha256")
        .update(path.resolve(rootDir))
        .digest("hex")
        .slice(0, 16);
      const shard = path.join(
        cacheParent,
        "minicms-image-cache",
        projectKey,
        "images_v1",
        "00"
      );
      await fs.mkdir(shard, { recursive: true });
      await fs.writeFile(sentinel, "keep", "utf8");
      await Promise.all(
        [1, 2, 3, 4].map((index) =>
          fs.writeFile(
            path.join(shard, `${index.toString(16).padStart(64, "0")}.webp`),
            `cache-${index}`,
            "utf8"
          )
        )
      );
    },
    environment: {
      MINICMS_IMAGE_CACHE_MAX_ENTRIES: "2"
    }
  });
});

test("opportunistic cache eviction enforces the configured entry bound", async () => {
  await withServer(async ({ baseUrl, config, cacheDir, media }) => {
    const responses = await Promise.all(
      [20, 21, 22, 23].map((width) =>
        fetch(
          `${baseUrl}${servicePath(media.photo.source, config, {
            width,
            height: 20,
            format: "webp"
          })}`
        )
      )
    );
    await Promise.all(
      responses.map(async (response) => {
        assert.equal(response.status, 200);
        await response.arrayBuffer();
      })
    );
    const files = await waitFor(async () => {
      const entries = await cacheFiles(cacheDir);
      return entries.length <= 2 ? entries : null;
    });
    assert.equal(files.length, 2);
    assert.equal(files.every((file) => /^[a-f0-9]{64}\.webp$/.test(path.basename(file))), true);
  }, {
    environment: {
      MINICMS_IMAGE_CACHE_MAX_ENTRIES: "2",
      MINICMS_IMAGE_CONCURRENCY: "2"
    }
  });
});

test("production authentication still protects mutations while public images remain anonymous", async () => {
  const fixture = await makeFixture({ strategy: "immutable", maxAge: 123 });
  const authentication = {
    cors: (_request, _response, next) => next(),
    router: (_request, _response, next) => next(),
    requireSession: (_request, response) => {
      response.status(401).json({ message: "Authentication is required." });
    }
  };
  const app = createApp({
    rootDir: fixture.rootDir,
    authentication,
    environment: {
      MINICMS_IMAGE_CACHE_DIR: fixture.cacheDir,
      MINICMS_IMAGE_MAX_EDGE: "512"
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const config = {
    site: {
      image_processing: {
        width: 64,
        height: 64,
        fit: "inside",
        format: "webp",
        quality: 82,
        cache: {
          schema: "images_v1",
          strategy: "immutable",
          max_age: 123
        }
      }
    }
  };
  try {
    const publicImage = await fetch(
      `${baseUrl}${servicePath(fixture.media.photo.source, config)}`
    );
    assert.equal(publicImage.status, 200);
    assert.equal(
      publicImage.headers.get("cache-control"),
      "public, max-age=123, immutable"
    );
    await publicImage.arrayBuffer();

    const rawImage = await fetch(`${baseUrl}${fixture.media.photo.source}`);
    assert.equal(rawImage.status, 200);
    assert.equal(
      rawImage.headers.get("cache-control"),
      "public, max-age=0, must-revalidate"
    );
    await rawImage.arrayBuffer();

    const protectedUpload = await fetch(
      `${baseUrl}/api/media/pages?filename=blocked.jpg`,
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: "blocked"
      }
    );
    assert.equal(protectedUpload.status, 401);
    await assert.rejects(
      fs.access(
        path.join(
          fixture.mediaDir,
          "pages",
          createHash("sha256").update("blocked").digest("hex"),
          "blocked.jpg"
        )
      ),
      { code: "ENOENT" }
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(fixture.rootDir, { recursive: true, force: true });
  }
});
