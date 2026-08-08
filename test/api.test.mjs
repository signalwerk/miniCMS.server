import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { createApp } from "../src/app.mjs";
import {
  createConfigTransaction,
  TRANSACTION_ROOT_NAME
} from "../src/config-transaction.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function makeFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-"));
  await fs.mkdir(path.join(rootDir, "content", "pages"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "content", "files"), { recursive: true });
  await fs.writeFile(
    path.join(rootDir, "cms.config.yml"),
    `connectors:
  default:
    name: api
site:
  media_folder: content/media
  public_folder: /media
node_types:
  page:
    kind: document
    fields:
      uuid: { widget: uuid }
      title: { widget: string }
      image: { widget: image, accept: [image/png, image/svg+xml, image/tiff, .tif, .tiff] }
    views:
      detail:
        panels:
          inspector:
            groups:
              content:
                fields: [title]
    slots:
      content:
        allowed_types: [text]
  text:
    kind: content
    fields:
      text: { widget: text }
  download:
    kind: document
    fields:
      file: { widget: file, accept: ["*/*"] }
collections:
  pages:
    folder: content/pages
    extension: yml
    slug: "{{title}}"
    node_type: page
    allowed_types: [page]
    hierarchy:
      enabled: true
      id_field: uuid
      parent_field: parent_uuid
      allowed_child_types: [page]
    views:
      list:
        type: tree
  files:
    folder: content/files
    extension: yml
    node_type: download
    allowed_types: [download]
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(rootDir, "content", "pages", "home.yml"),
    `id: home
type: page
order: 0
properties:
  uuid: 84a3ef27-cdce-477b-863f-c1f418037685
  parent_uuid: null
  title: Home
slots:
  content: []
`,
    "utf8"
  );
  return rootDir;
}

async function withServer(run) {
  const rootDir = await makeFixture();
  const server = createApp({ rootDir }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, rootDir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function putConfig(baseUrl, config, etag) {
  let revision = etag;
  if (!revision) {
    const current = await fetch(`${baseUrl}/api/config`);
    revision = current.headers.get("etag");
  }
  return fetch(`${baseUrl}/api/config`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "if-match": revision
    },
    body: JSON.stringify(config)
  });
}

test("serves configuration and collection summaries", async () => {
  await withServer(async (baseUrl) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) => response.json());
    assert.equal(config.collections.pages.slug, "{{title}}");
    assert.deepEqual(
      config.node_types.page.views.detail.panels.inspector.groups.content.fields,
      ["title"]
    );

    const collections = await fetch(`${baseUrl}/api/collections`).then((response) =>
      response.json()
    );
    assert.equal(collections.collections.pages.slug, "{{title}}");
    assert.equal(collections.collections.pages.views.list.type, "tree");

    const list = await fetch(`${baseUrl}/api/collections/pages`).then((response) =>
      response.json()
    );
    assert.deepEqual(list.items.map((item) => item.id), ["home"]);
    assert.equal(list.items[0].hierarchy_id, "84a3ef27-cdce-477b-863f-c1f418037685");
    assert.equal(list.items[0].hidden, false);
    assert.equal(list.items[0].properties.title, "Home");
    assert.match(list.items[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(list.items[0].updated_at, /^\d{4}-\d{2}-\d{2}T/);

    const record = await fetch(`${baseUrl}/api/collections/pages/home`).then((response) =>
      response.json()
    );
    assert.equal(record.properties.title, "Home");
  });
});

test("validates and atomically saves the guided configuration", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) =>
      response.json()
    );
    config.site.name = "Edited project";
    config.node_types.page.fields.layout = {
      label: "Page layout",
      widget: "select",
      required: false,
      options: [
        { label: "Default", value: "default" },
        { label: "Wide", value: "wide" }
      ]
    };

    const saved = await putConfig(baseUrl, config);
    assert.equal(saved.status, 200);
    const savedConfig = (await saved.json()).config;
    assert.equal(savedConfig.site.name, "Edited project");
    assert.equal(
      Object.hasOwn(savedConfig.node_types.page.fields.layout, "required"),
      false
    );

    const source = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    assert.match(source, /name: Edited project/);
    assert.match(source, /label: Page layout/);
    assert.match(source, /value: wide/);
    assert.doesNotMatch(source, /required: false/);

    const invalid = structuredClone(config);
    invalid.node_types.page.fields.layout.widget = "object";
    const rejected = await putConfig(baseUrl, invalid);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /unsupported widget "object"/);

    const structuredSearch = structuredClone(config);
    structuredSearch.collections.pages.views.list.search = {
      fields: [{ field: "title", appearance: "title" }]
    };
    const rejectedSearch = await putConfig(baseUrl, structuredSearch);
    assert.equal(rejectedSearch.status, 400);
    assert.match(
      (await rejectedSearch.json()).message,
      /search fields must use a field name/
    );

    const current = await fetch(`${baseUrl}/api/config`).then((response) =>
      response.json()
    );
    assert.equal(current.site.name, "Edited project");
    assert.equal(current.node_types.page.fields.layout.widget, "select");
  });
});

test("requires the current config ETag before saving", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    const etag = loaded.headers.get("etag");
    assert.match(etag, /^"[a-f0-9]{64}"$/);
    config.site.name = "Revision protected";

    const missing = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config)
    });
    assert.equal(missing.status, 428);

    const stale = await putConfig(baseUrl, config, `"${"0".repeat(64)}"`);
    assert.equal(stale.status, 412);

    const saved = await putConfig(baseUrl, config, etag);
    assert.equal(saved.status, 200);
    const nextEtag = saved.headers.get("etag");
    assert.match(nextEtag, /^"[a-f0-9]{64}"$/);
    assert.notEqual(nextEtag, etag);

    const repeatedStale = await putConfig(baseUrl, config, etag);
    assert.equal(repeatedStale.status, 412);
    assert.match(
      await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
      /name: Revision protected/
    );
  });
});

test("moves a populated collection folder in the config transaction", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    const etag = loaded.headers.get("etag");
    const oldPath = path.join(rootDir, "content", "pages", "home.yml");
    const oldBytes = await fs.readFile(oldPath);
    config.collections.pages.folder = "content/documents";

    const saved = await putConfig(baseUrl, config, etag);
    assert.equal(saved.status, 200);
    await assert.rejects(fs.access(oldPath), (error) => error.code === "ENOENT");
    assert.deepEqual(
      await fs.readFile(
        path.join(rootDir, "content", "documents", "home.yml")
      ),
      oldBytes
    );

    const listed = await fetch(`${baseUrl}/api/collections/pages`).then(
      (response) => response.json()
    );
    assert.deepEqual(listed.items.map((item) => item.id), ["home"]);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/collections/pages/home`).then((response) =>
          response.json()
        )
      ).properties.title,
      "Home"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
      (error) => error.code === "ENOENT"
    );
  });
});

test("keeps new and moved empty API collections virtual until first write", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    config.collections.empty = {
      folder: "content/empty",
      extension: "yml",
      node_type: "page",
      allowed_types: ["page"]
    };

    const added = await putConfig(baseUrl, config, loaded.headers.get("etag"));
    assert.equal(added.status, 200);
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "empty")),
      (error) => error.code === "ENOENT"
    );
    assert.deepEqual(
      await fetch(`${baseUrl}/api/collections/empty`).then((response) =>
        response.json()
      ),
      { collection: "empty", items: [] }
    );

    config.collections.empty.folder = "content/empty-renamed";
    const moved = await putConfig(
      baseUrl,
      config,
      added.headers.get("etag")
    );
    assert.equal(moved.status, 200);
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "empty-renamed")),
      (error) => error.code === "ENOENT"
    );

    const created = await fetch(`${baseUrl}/api/collections/empty`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "first",
        type: "page",
        order: 0,
        properties: {
          uuid: "5c675e48-8ca3-4f92-b31f-9f03aa8bcf3f",
          parent_uuid: null,
          title: "First"
        },
        slots: { content: [] }
      })
    });
    assert.equal(created.status, 201);
    await fs.access(
      path.join(rootDir, "content", "empty-renamed", "first.yml")
    );
  });
});

test("rejects collection folder collisions without changing config or content", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    const originalConfig = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    const originalRecord = await fs.readFile(
      path.join(rootDir, "content", "pages", "home.yml"),
      "utf8"
    );
    await fs.mkdir(path.join(rootDir, "content", "occupied"));
    await fs.writeFile(
      path.join(rootDir, "content", "occupied", "keep.txt"),
      "keep",
      "utf8"
    );
    config.collections.pages.folder = "content/occupied";

    const rejected = await putConfig(
      baseUrl,
      config,
      loaded.headers.get("etag")
    );
    assert.equal(rejected.status, 409);
    assert.equal(
      await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
      originalConfig
    );
    assert.equal(
      await fs.readFile(
        path.join(rootDir, "content", "pages", "home.yml"),
        "utf8"
      ),
      originalRecord
    );
    assert.equal(
      await fs.readFile(
        path.join(rootDir, "content", "occupied", "keep.txt"),
        "utf8"
      ),
      "keep"
    );
  });
});

test("rejects unsafe collection folder topology and linked components", async (t) => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    const etag = loaded.headers.get("etag");

    const contentRoot = structuredClone(config);
    contentRoot.collections.pages.folder = "content";
    assert.equal((await putConfig(baseUrl, contentRoot, etag)).status, 400);

    const duplicate = structuredClone(config);
    duplicate.collections.pages.folder = duplicate.collections.files.folder;
    assert.equal((await putConfig(baseUrl, duplicate, etag)).status, 400);

    const mediaOverlap = structuredClone(config);
    mediaOverlap.collections.pages.folder = "content/media/pages";
    assert.equal((await putConfig(baseUrl, mediaOverlap, etag)).status, 400);

    const outside = path.join(rootDir, "outside");
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(rootDir, "content", "linked"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
        return;
      }
      throw error;
    }
    const linked = structuredClone(config);
    linked.collections.pages.folder = "content/linked/pages";
    assert.equal((await putConfig(baseUrl, linked, etag)).status, 400);
    await fs.access(path.join(rootDir, "content", "pages", "home.yml"));
  });
});

test("rejects a new collection below a linked folder", async (t) => {
  await withServer(async (baseUrl, rootDir) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-linked-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    try {
      await fs.symlink(outside, path.join(rootDir, "content", "linked"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
        return;
      }
      throw error;
    }

    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    config.collections.linked = {
      folder: "content/linked/pages",
      extension: "yml",
      node_type: "page",
      allowed_types: ["page"]
    };
    const saved = await putConfig(baseUrl, config, loaded.headers.get("etag"));
    assert.equal(saved.status, 400);
    await assert.rejects(fs.access(path.join(outside, "pages")));
  });
});

test("refuses a configured collection folder replaced by a symlink", async (t) => {
  await withServer(async (baseUrl, rootDir) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-linked-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const pages = path.join(rootDir, "content", "pages");
    await fs.rename(pages, path.join(rootDir, "content", "pages-original"));
    try {
      await fs.symlink(outside, pages);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
        return;
      }
      throw error;
    }

    const listed = await fetch(`${baseUrl}/api/collections/pages`);
    assert.equal(listed.status, 500);
    const created = await fetch(`${baseUrl}/api/collections/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "outside",
        type: "page",
        order: 0,
        properties: {
          uuid: "abcdefghijklmno",
          title: "Outside"
        },
        slots: { content: [] }
      })
    });
    assert.equal(created.status, 500);
    await assert.rejects(fs.access(path.join(outside, "outside.yml")));
  });
});

test("recovers copy-first folder transactions from either config side", async () => {
  for (const committed of [false, true]) {
    const rootDir = await makeFixture();
    try {
      const configFile = path.join(rootDir, "cms.config.yml");
      const oldSource = await fs.readFile(configFile, "utf8");
      const newSource = oldSource.replace(
        "folder: content/pages",
        "folder: content/recovered"
      );
      const transactionDir = path.join(
        rootDir,
        TRANSACTION_ROOT_NAME,
        "a".repeat(24)
      );
      await fs.mkdir(path.join(transactionDir, "stage"), { recursive: true });
      await fs.cp(
        path.join(rootDir, "content", "pages"),
        path.join(rootDir, "content", "recovered"),
        { recursive: true }
      );
      await fs.writeFile(
        path.join(transactionDir, "manifest.json"),
        `${JSON.stringify({
          version: 1,
          oldConfigHash: sha256(oldSource),
          newConfigHash: sha256(newSource),
          moves: [
            {
              collection: "pages",
              source: "content/pages",
              destination: "content/recovered",
              stage: "stage/0",
              sourceExists: true
            }
          ]
        })}\n`,
        "utf8"
      );
      if (committed) await fs.writeFile(configFile, newSource, "utf8");

      await createConfigTransaction({ rootDir, configFile }).recover();
      if (committed) {
        await assert.rejects(
          fs.access(path.join(rootDir, "content", "pages")),
          (error) => error.code === "ENOENT"
        );
        await fs.access(
          path.join(rootDir, "content", "recovered", "home.yml")
        );
      } else {
        await fs.access(path.join(rootDir, "content", "pages", "home.yml"));
        await assert.rejects(
          fs.access(path.join(rootDir, "content", "recovered")),
          (error) => error.code === "ENOENT"
        );
      }
      await assert.rejects(
        fs.access(transactionDir),
        (error) => error.code === "ENOENT"
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  }
});

test("stores remote aliases without treating them as local collections", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) =>
      response.json()
    );
    config.connectors.central_media = {
      name: "api",
      api_url: "https://media.example"
    };
    config.node_types.central_image = {
      connector: "central_media",
      remote_type: "media_image"
    };
    config.collections.central_images = {
      connector: "central_media",
      remote_collection: "images"
    };

    const saved = await putConfig(baseUrl, config);
    assert.equal(saved.status, 200);
    const savedConfig = (await saved.json()).config;
    assert.deepEqual(savedConfig.collections.central_images, {
      connector: "central_media",
      remote_collection: "images"
    });
    assert.deepEqual(savedConfig.node_types.central_image, {
      connector: "central_media",
      remote_type: "media_image"
    });

    const source = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    assert.match(source, /central_images:/);
    assert.match(source, /remote_collection: images/);

    const collectionIndex = await fetch(`${baseUrl}/api/collections`).then(
      (response) => response.json()
    );
    assert.equal(collectionIndex.collections.central_images, undefined);

    const requests = [
      ["GET", "/api/collections/central_images"],
      ["GET", "/api/collections/central_images/example"],
      ["POST", "/api/collections/central_images"],
      ["PUT", "/api/collections/central_images/example"],
      ["DELETE", "/api/collections/central_images/example"],
      ["POST", "/api/collections/central_images/example/rename"],
      ["POST", "/api/media/central_images?filename=example.png"]
    ];
    for (const [method, pathname] of requests) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        method,
        headers: {
          "content-type":
            pathname.startsWith("/api/media/")
              ? "image/png"
              : "application/json"
        },
        body: ["GET", "DELETE"].includes(method) ? undefined : "{}"
      });
      assert.equal(response.status, 404, `${method} ${pathname}`);
      assert.match(
        (await response.json()).message,
        /provided by connector "central_media".*not stored by this service/
      );
    }

    await assert.rejects(
      fs.access(path.join(rootDir, "content", "central_images")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(
        path.join(rootDir, "content", "media", "central_images")
      ),
      (error) => error.code === "ENOENT"
    );
  });
});

test("rejects unknown detail field references in configuration", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const configPath = path.join(rootDir, "cms.config.yml");
    const source = await fs.readFile(configPath, "utf8");
    await fs.writeFile(
      configPath,
      source.replace("fields: [title]", "fields: [missing_field]"),
      "utf8"
    );

    const response = await fetch(`${baseUrl}/api/config`);
    assert.equal(response.status, 500);
    assert.equal(
      (await response.json()).message,
      "An unexpected server error occurred."
    );
    const readiness = await fetch(`${baseUrl}/api/ready`);
    assert.equal(readiness.status, 503);
    assert.deepEqual(await readiness.json(), { ok: false });
  });
});

test("uploads media with safe collision-resistant filenames", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const contents = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 10, g: 20, b: 30 }
      }
    }).png().toBuffer();
    const upload = () =>
      fetch(`${baseUrl}/api/media/pages?filename=${encodeURIComponent("Hero Image.png")}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: contents
      });

    const first = await upload();
    assert.equal(first.status, 201);
    const firstResult = await first.json();
    const hash = sha256(contents);
    assert.equal(firstResult.filename, "hero-image.png");
    assert.equal(firstResult.sha, hash);
    assert.equal(firstResult.path, `/media/pages/${hash}/hero-image.png`);

    const second = await upload();
    assert.equal(second.status, 201);
    const secondResult = await second.json();
    assert.equal(secondResult.filename, "hero-image-2.png");
    assert.equal(secondResult.path, `/media/pages/${hash}/hero-image-2.png`);

    const concurrent = await Promise.all([upload(), upload(), upload()]);
    assert.deepEqual(
      concurrent.map((response) => response.status),
      [201, 201, 201]
    );
    const concurrentNames = await Promise.all(
      concurrent.map(async (response) => (await response.json()).filename)
    );
    assert.equal(
      new Set([
        firstResult.filename,
        secondResult.filename,
        ...concurrentNames
      ]).size,
      5
    );

    const stored = await fs.readFile(
      path.join(rootDir, "content", "media", "pages", hash, "hero-image.png"),
      null
    );
    assert.deepEqual(stored, contents);

    const maximumName = `${"a".repeat(251)}.png`;
    const uploadMaximumName = () =>
      fetch(
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(maximumName)}`,
        {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: contents
        }
      );
    const maximumFirst = await uploadMaximumName();
    const maximumSecond = await uploadMaximumName();
    assert.equal(maximumFirst.status, 201);
    assert.equal(maximumSecond.status, 201);
    const maximumFirstName = (await maximumFirst.json()).filename;
    const maximumSecondName = (await maximumSecond.json()).filename;
    assert.equal(Buffer.byteLength(maximumFirstName), 255);
    assert.equal(Buffer.byteLength(maximumSecondName), 255);
    assert.match(maximumSecondName, /-2\.png$/);
  });
});

test("cleans only service-owned upload temporaries before the first upload", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const mediaDirectory = path.join(rootDir, "content", "media");
    await fs.mkdir(mediaDirectory, { recursive: true });
    const stale = path.join(
      mediaDirectory,
      ".minicms-upload-123-0123456789abcdefabcd.tmp"
    );
    const unrelated = path.join(mediaDirectory, ".keep.tmp");
    await fs.writeFile(stale, "stale", "utf8");
    await fs.writeFile(unrelated, "keep", "utf8");
    const contents = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 1, g: 2, b: 3 }
      }
    }).png().toBuffer();

    const response = await fetch(
      `${baseUrl}/api/media/pages?filename=clean.png`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: contents
      }
    );
    assert.equal(response.status, 201);
    await assert.rejects(fs.access(stale), { code: "ENOENT" });
    assert.equal(await fs.readFile(unrelated, "utf8"), "keep");
  });
});

test("rejects unsafe upload filenames before writing a temporary file", async () => {
  await withServer(async (baseUrl, rootDir) => {
    for (const filename of [
      "image.bad#extension",
      "folder\\image.png",
      `${"a".repeat(256)}.png`
    ]) {
      const response = await fetch(
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(filename)}`,
        {
          method: "POST",
          headers: { "content-type": "image/png" },
          body: "not-written"
        }
      );
      assert.equal(response.status, 400);
    }
    const mediaDirectory = path.join(rootDir, "content", "media");
    const mediaEntries = await fs.readdir(mediaDirectory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    assert.equal(
      mediaEntries.some((name) =>
        name.startsWith(".minicms-upload-")
      ),
      false
    );
  });
});

test("validates upload collections before reading or publishing media", async (t) => {
  await withServer(async (baseUrl, rootDir) => {
    const contents = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 1, g: 2, b: 3 }
      }
    }).png().toBuffer();
    const unknown = await fetch(
      `${baseUrl}/api/media/missing?filename=hero.png`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: "not-written"
      }
    );
    assert.equal(unknown.status, 404);

    const mediaDirectory = path.join(rootDir, "content", "media");
    const outside = path.join(rootDir, "outside-media");
    await fs.mkdir(mediaDirectory, { recursive: true });
    await fs.mkdir(outside);
    try {
      await fs.symlink(outside, path.join(mediaDirectory, "pages"), "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("Symbolic links are unavailable on this platform.");
        return;
      }
      throw error;
    }

    const linked = await fetch(
      `${baseUrl}/api/media/pages?filename=hero.png`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: contents
      }
    );
    assert.equal(linked.status, 409);
    assert.deepEqual(await fs.readdir(outside), []);
    assert.equal(
      (await fs.readdir(mediaDirectory)).some((name) =>
        name.startsWith(".minicms-upload-")
      ),
      false
    );
  });
});

test("uploads only configured image formats, including TIF and TIFF", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" />';
    const accepted = await fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Diagram.svg")}`,
      {
        method: "POST",
        headers: { "content-type": "image/svg+xml" },
        body: svg
      }
    );
    assert.equal(accepted.status, 201);
    const svgHash = sha256(svg);
    assert.equal(
      (await accepted.json()).path,
      `/media/pages/${svgHash}/diagram.svg`
    );
    assert.equal(
      await fs.readFile(
        path.join(rootDir, "content", "media", "pages", svgHash, "diagram.svg"),
        "utf8"
      ),
      svg
    );

    const tiffContents = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 12, g: 34, b: 56 }
      }
    }).tiff().toBuffer();
    for (const [filename, contentType] of [
      ["Scan.tif", "image/tiff"],
      ["Archive.tiff", "application/octet-stream"]
    ]) {
      const tiff = await fetch(
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(filename)}`,
        {
          method: "POST",
          headers: { "content-type": contentType },
          body: tiffContents
        }
      );
      assert.equal(tiff.status, 201);
      const storedName = filename.toLowerCase();
      const tiffHash = sha256(tiffContents);
      assert.deepEqual(
        (await tiff.json()).path,
        `/media/pages/${tiffHash}/${storedName}`
      );
      assert.deepEqual(
        await fs.readFile(
          path.join(rootDir, "content", "media", "pages", tiffHash, storedName),
          null
        ),
        tiffContents
      );
    }

    const pngContents = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 1, g: 2, b: 3 }
      }
    }).png().toBuffer();
    for (const [filename, contentType, body] of [
      ["not-a-vector.svg", "image/svg+xml", pngContents],
      ["hidden-vector.png", "image/svg+xml", Buffer.from(svg)],
      ["mentioned-vector.svg", "image/svg+xml", Buffer.from("notes <svg />")]
    ]) {
      const mismatch = await fetch(
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(filename)}`,
        {
          method: "POST",
          headers: { "content-type": contentType },
          body
        }
      );
      assert.equal(mismatch.status, 400);
      assert.match(
        (await mismatch.json()).message,
        /do not match|not a supported image/
      );
    }

    const vectorOnlyConfig = await fetch(`${baseUrl}/api/config`).then(
      (response) => response.json()
    );
    vectorOnlyConfig.node_types.page.fields.image.accept = ["image/svg+xml"];
    const savedVectorOnlyConfig = await putConfig(baseUrl, vectorOnlyConfig);
    assert.equal(savedVectorOnlyConfig.status, 200);
    const spoofedMime = await fetch(
      `${baseUrl}/api/media/pages?filename=spoofed.png`,
      {
        method: "POST",
        headers: { "content-type": "image/svg+xml" },
        body: pngContents
      }
    );
    assert.equal(spoofedMime.status, 400);
    assert.match((await spoofedMime.json()).message, /image\/svg\+xml/);

    const rejected = await fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Photo.jpg")}`,
      {
        method: "POST",
        headers: { "content-type": "image/jpeg" },
        body: "fake-jpeg"
      }
    );
    assert.equal(rejected.status, 400);
    assert.match(
      (await rejected.json()).message,
      /configured accepted file type.*Received MIME type: image\/jpeg\./
    );
  });
});

test("uploads generic files when a file field accepts all MIME types", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const rejectedByPages = await fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Research notes.pdf")}`,
      {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "not-written"
      }
    );
    assert.equal(rejectedByPages.status, 400);

    const uploaded = await fetch(
      `${baseUrl}/api/media/files?filename=${encodeURIComponent("Research notes.pdf")}`,
      {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "fake-pdf"
      }
    );
    assert.equal(uploaded.status, 201);
    const pdfHash = sha256("fake-pdf");
    assert.equal(
      (await uploaded.json()).path,
      `/media/files/${pdfHash}/research-notes.pdf`
    );
    assert.equal(
      await fs.readFile(
        path.join(
          rootDir,
          "content",
          "media",
          "files",
          pdfHash,
          "research-notes.pdf"
        ),
        "utf8"
      ),
      "fake-pdf"
    );
  });
});

test("persists a complete record as YAML and reads it back", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const record = {
      id: "new-page",
      type: "page",
      order: 1,
      properties: {
        uuid: "d54b10eb-88ec-4ac8-937f-e1126f999a93",
        parent_uuid: "84a3ef27-cdce-477b-863f-c1f418037685",
        title: "New page",
        layout: "wide"
      },
      slots: {
        content: [
          { id: "intro", type: "text", properties: { text: "Hello" } }
        ]
      }
    };

    const created = await fetch(`${baseUrl}/api/collections/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record)
    });
    assert.equal(created.status, 201);

    record.properties.title = "Changed";
    const saved = await fetch(`${baseUrl}/api/collections/pages/new-page`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record)
    });
    assert.equal(saved.status, 200);

    const source = await fs.readFile(
      path.join(rootDir, "content", "pages", "new-page.yml"),
      "utf8"
    );
    assert.match(source, /title: Changed/);
    assert.match(source, /layout: wide/);
  });
});

test("renames a record file and updates its stored id", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const renamed = await fetch(`${baseUrl}/api/collections/pages/home/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "renamed-home" })
    });
    assert.equal(renamed.status, 200);
    const result = await renamed.json();
    assert.equal(result.record.id, "renamed-home");
    assert.equal(result.item.id, "renamed-home");

    const oldRecord = await fetch(`${baseUrl}/api/collections/pages/home`);
    assert.equal(oldRecord.status, 404);
    const newRecord = await fetch(
      `${baseUrl}/api/collections/pages/renamed-home`
    ).then((response) => response.json());
    assert.equal(newRecord.id, "renamed-home");

    const source = await fs.readFile(
      path.join(rootDir, "content", "pages", "renamed-home.yml"),
      "utf8"
    );
    assert.match(source, /^id: renamed-home$/m);

    await fs.writeFile(
      path.join(rootDir, "content", "pages", "taken.yml"),
      source.replace("id: renamed-home", "id: taken"),
      "utf8"
    );
    const collision = await fetch(
      `${baseUrl}/api/collections/pages/renamed-home/rename`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "taken" })
      }
    );
    assert.equal(collision.status, 409);
    assert.match((await collision.json()).message, /already exists/);
  });
});

test("rejects child types that are not allowed by a slot", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/collections/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "bad-page",
        type: "page",
        properties: { title: "Bad" },
        slots: {
          content: [{ id: "nested-page", type: "page", properties: {} }]
        }
      })
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.message, /not allowed/);
  });
});

test("deletes leaf records and their configured uploads but refuses to orphan children", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) =>
      response.json()
    );
    config.collections.pages.delete_files_with_record = true;
    const savedConfig = await putConfig(baseUrl, config);
    assert.equal(savedConfig.status, 200);
    const childHash = sha256("child-image");
    const childDirectory = path.join(
      rootDir,
      "content",
      "media",
      "pages",
      childHash
    );
    await fs.mkdir(childDirectory, { recursive: true });
    await fs.writeFile(
      path.join(childDirectory, "child.png"),
      "child-image",
      "utf8"
    );
    await fs.writeFile(
      path.join(childDirectory, "child-2.png"),
      "child-image",
      "utf8"
    );
    const home = await fetch(`${baseUrl}/api/collections/pages/home`).then(
      (response) => response.json()
    );
    home.properties.image = `/media/pages/${childHash}/child-2.png`;
    const savedHome = await fetch(`${baseUrl}/api/collections/pages/home`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(home)
    });
    assert.equal(savedHome.status, 200);
    const child = {
      id: "child-page",
      type: "page",
      order: 1,
      properties: {
        uuid: "49c0c569-a0e1-4c4c-85c6-14b659aebd2d",
        parent_uuid: "84a3ef27-cdce-477b-863f-c1f418037685",
        title: "Child page",
        image: `/media/pages/${childHash}/child.png`,
        hidden: true
      },
      slots: { content: [] }
    };
    const created = await fetch(`${baseUrl}/api/collections/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(child)
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json()).item.hidden, true);

    const parentDelete = await fetch(`${baseUrl}/api/collections/pages/home`, {
      method: "DELETE"
    });
    assert.equal(parentDelete.status, 409);
    assert.match((await parentDelete.json()).message, /child records/);

    const childDelete = await fetch(`${baseUrl}/api/collections/pages/child-page`, {
      method: "DELETE"
    });
    assert.equal(childDelete.status, 204);

    const missing = await fetch(`${baseUrl}/api/collections/pages/child-page`);
    assert.equal(missing.status, 404);
    assert.equal(
      await fs.readFile(path.join(childDirectory, "child-2.png"), "utf8"),
      "child-image"
    );
    const homeDelete = await fetch(`${baseUrl}/api/collections/pages/home`, {
      method: "DELETE"
    });
    assert.equal(homeDelete.status, 204);
    await assert.rejects(
      fs.access(childDirectory),
      { code: "ENOENT" }
    );
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "media", "pages")),
      { code: "ENOENT" }
    );
  });
});

test("record deletion never follows a linked media file", async (t) => {
  await withServer(async (baseUrl, rootDir) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) =>
      response.json()
    );
    config.collections.pages.delete_files_with_record = true;
    assert.equal(
      (
        await putConfig(baseUrl, config)
      ).status,
      200
    );

    const mediaDirectory = path.join(rootDir, "content", "media");
    await fs.mkdir(mediaDirectory, { recursive: true });
    const outside = path.join(rootDir, "outside.png");
    await fs.writeFile(outside, "outside", "utf8");
    try {
      await fs.symlink(outside, path.join(mediaDirectory, "linked.png"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        t.skip("Symbolic links are unavailable on this platform.");
        return;
      }
      throw error;
    }

    const record = {
      id: "linked-page",
      type: "page",
      order: 1,
      properties: {
        uuid: "c7eec0cc-b54a-4c22-a0bc-8b7eb9e5aab2",
        parent_uuid: "",
        title: "Linked page",
        image: "/media/linked.png",
        hidden: false
      },
      slots: { content: [] }
    };
    assert.equal(
      (
        await fetch(`${baseUrl}/api/collections/pages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(record)
        })
      ).status,
      201
    );
    assert.equal(
      (
        await fetch(`${baseUrl}/api/collections/pages/linked-page`, {
          method: "DELETE"
        })
      ).status,
      204
    );
    assert.equal(await fs.readFile(outside, "utf8"), "outside");
  });
});
