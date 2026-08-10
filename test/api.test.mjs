import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import sharp from "sharp";
import { imageServicePath } from "@signalwerk/minicms/core/image-service";
import { parseYaml } from "@signalwerk/minicms/core/content";
import { createApp } from "../src/app.mjs";
import {
  createConfigTransaction,
  TRANSACTION_ROOT_NAME
} from "../src/config-transaction.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readYaml(filePath) {
  return parseYaml(await fs.readFile(filePath, "utf8"));
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
    api_url: https://api.example.com
    auth_url: https://auth.example.com
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

async function useGithubStorage(rootDir) {
  const configPath = path.join(rootDir, "cms.config.yml");
  const source = await fs.readFile(configPath, "utf8");
  await fs.writeFile(
    configPath,
    source.replace(
      `  default:
    name: api
    api_url: https://api.example.com
    auth_url: https://auth.example.com`,
      `  default:
    name: github
    repo: signalwerk/example
    base_url: https://auth.example.com
    branch: main`
    ),
    "utf8"
  );
}

async function withServer(run, options = {}) {
  const rootDir = await makeFixture();
  await options.prepareRoot?.(rootDir);
  const environment = typeof options.environment === "function"
    ? options.environment(rootDir)
    : options.environment;
  const server = createApp({
    rootDir,
    ...(environment ? { environment } : {}),
    ...(options.imageLogger ? { imageLogger: options.imageLogger } : {})
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, rootDir);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function putConfig(
  baseUrl,
  config,
  etag,
  schemaRenames = { node_types: {}, collections: {} }
) {
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
    body: JSON.stringify({ config, schema_renames: schemaRenames })
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
      body: JSON.stringify({
        config,
        schema_renames: { node_types: {}, collections: {} }
      })
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

test("requires the explicit configuration-save envelope", async () => {
  await withServer(async (baseUrl) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    const headers = {
      "content-type": "application/json",
      "if-match": loaded.headers.get("etag")
    };
    for (const body of [
      config,
      { config },
      { config, schema_renames: {} },
      {
        config,
        schema_renames: { node_types: {}, collections: {}, extra: {} }
      },
      {
        config,
        schema_renames: { node_types: [], collections: {} }
      },
      {
        config,
        schema_renames: { node_types: {}, collections: {} },
        extra: true
      }
    ]) {
      const response = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
      });
      assert.equal(response.status, 400);
    }

    const accepted = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        config,
        schema_renames: { node_types: {}, collections: {} }
      })
    });
    assert.equal(accepted.status, 200);
  });
});

test("validates schema rename plans before inspecting or writing collection storage", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const current = await loaded.json();
    const etag = loaded.headers.get("etag");
    const originalConfig = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    const next = structuredClone(current);
    next.collections.documents = next.collections.pages;
    delete next.collections.pages;
    delete next.collections.files;
    next.collections.documents.folder = "content/documents";
    const rejected = await putConfig(baseUrl, next, etag, {
      node_types: {},
      collections: {
        pages: "documents",
        files: "documents"
      }
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /one-to-one/);
    assert.equal(
      await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
      originalConfig
    );
    await fs.access(path.join(rootDir, "content", "pages", "home.yml"));
    await fs.access(path.join(rootDir, "content", "files"));
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "documents")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
      (error) => error.code === "ENOENT"
    );
  });
});

test("rejects media storage-mode changes without an explicit offline migration", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const next = await loaded.json();
    const originalConfig = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    const originalRecord = await fs.readFile(
      path.join(rootDir, "content", "pages", "home.yml"),
      "utf8"
    );
    next.connectors.default = {
      name: "github",
      repo: "signalwerk/example",
      base_url: "https://auth.example.com",
      branch: "main"
    };
    const rejected = await putConfig(
      baseUrl,
      next,
      loaded.headers.get("etag")
    );
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /cannot change media storage mode/);
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
    await assert.rejects(
      fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
      (error) => error.code === "ENOENT"
    );
  });
});

test("rejects media-folder changes without an explicit offline migration", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const next = await loaded.json();
    const configPath = path.join(rootDir, "cms.config.yml");
    const originalConfig = await fs.readFile(configPath, "utf8");
    const mediaSentinel = path.join(
      rootDir,
      "content",
      "media",
      "pages",
      "sentinel.txt"
    );
    await fs.mkdir(path.dirname(mediaSentinel), { recursive: true });
    await fs.writeFile(mediaSentinel, "keep");
    next.site.media_folder = "content/assets";

    const rejected = await putConfig(
      baseUrl,
      next,
      loaded.headers.get("etag")
    );
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /cannot change site\.media_folder/);
    assert.equal(await fs.readFile(configPath, "utf8"), originalConfig);
    assert.equal(await fs.readFile(mediaSentinel, "utf8"), "keep");
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "assets")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
      (error) => error.code === "ENOENT"
    );
  });
});

test("transactionally renames concrete schema keys, records, media, and cache namespaces", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const current = await loaded.json();
    const etag = loaded.headers.get("etag");
    const imageBytes = Buffer.from("schema-rename-image");
    const imageHash = sha256(imageBytes);
    const fileHash = sha256("schema-rename-file");
    const structuredImage = {
      hash: imageHash,
      filename: "Original image.png"
    };
    await fs.writeFile(
      path.join(rootDir, "content", "pages", "home.yml"),
      `id: home
type: page
order: 0
properties:
  uuid: 84a3ef27-cdce-477b-863f-c1f418037685
  parent_uuid: null
  title: Home
  image:
    hash: ${imageHash}
    filename: Original image.png
slots:
  content:
    - id: abcdefghijklmno
      type: text
      order: 0
      properties:
        text: '[Page](minicms://reference/pages/home)'
      slots: {}
`,
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "content", "files", "manual.yml"),
      `id: manual
type: download
order: 0
properties:
  file: /media/pages/${fileHash}/Manual.pdf
slots: {}
`,
      "utf8"
    );
    const mediaSource = path.join(
      rootDir,
      "content",
      "media",
      "pages",
      imageHash
    );
    await fs.mkdir(mediaSource, { recursive: true });
    await fs.writeFile(path.join(mediaSource, "asset.dat"), imageBytes);
    const cacheRoot = path.join(rootDir, "image-cache");
    const oldCache = path.join(
      cacheRoot,
      "images_v1",
      "media",
      "pages",
      imageHash,
      "noop"
    );
    const unrelatedCache = path.join(
      cacheRoot,
      "images_v1",
      "media",
      "files",
      fileHash,
      "noop"
    );
    await fs.mkdir(oldCache, { recursive: true });
    await fs.mkdir(unrelatedCache, { recursive: true });
    await fs.writeFile(path.join(oldCache, "asset.png"), "old cache");
    await fs.writeFile(path.join(unrelatedCache, "asset.png"), "keep cache");

    const next = structuredClone(current);
    next.node_types.article = next.node_types.page;
    delete next.node_types.page;
    next.node_types.rich_text = next.node_types.text;
    delete next.node_types.text;
    next.node_types.article.slots.content.allowed_types = ["rich_text"];
    next.collections.documents = next.collections.pages;
    delete next.collections.pages;
    next.collections.documents.folder = "content/documents";
    next.collections.documents.node_type = "article";
    next.collections.documents.allowed_types = ["article"];
    next.collections.documents.hierarchy.allowed_child_types = ["article"];

    const saved = await putConfig(baseUrl, next, etag, {
      node_types: { page: "article", text: "rich_text" },
      collections: { pages: "documents" }
    });
    const savedBody = await saved.text();
    assert.equal(saved.status, 200, savedBody);
    const result = JSON.parse(savedBody);
    assert.deepEqual(result.schema_renames, {
      node_types: { page: "article", text: "rich_text" },
      collections: { pages: "documents" }
    });

    await assert.rejects(
      fs.access(path.join(rootDir, "content", "pages")),
      (error) => error.code === "ENOENT"
    );
    const migratedPage = await readYaml(
      path.join(rootDir, "content", "documents", "home.yml")
    );
    assert.equal(migratedPage.type, "article");
    assert.equal(migratedPage.slots.content[0].type, "rich_text");
    assert.equal(
      migratedPage.slots.content[0].properties.text,
      "[Page](minicms://reference/documents/home)"
    );
    assert.deepEqual(migratedPage.properties.image, structuredImage);
    assert.equal(
      (
        await readYaml(path.join(rootDir, "content", "files", "manual.yml"))
      ).properties.file,
      `/media/documents/${fileHash}/Manual.pdf`
    );
    assert.deepEqual(
      await fs.readFile(
        path.join(
          rootDir,
          "content",
          "media",
          "documents",
          imageHash,
          "asset.dat"
        )
      ),
      imageBytes
    );
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "media", "pages")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(fs.access(oldCache), (error) => error.code === "ENOENT");
    assert.equal(
      await fs.readFile(path.join(unrelatedCache, "asset.png"), "utf8"),
      "keep cache"
    );

    const raw = await fetch(
      `${baseUrl}/media/documents/${imageHash}/A-different-name.png`
    );
    assert.equal(raw.status, 200);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), imageBytes);
    assert.equal(
      (
        await fetch(`${baseUrl}/media/pages/${imageHash}/Original.png`)
      ).status,
      404
    );
  }, {
    environment: (rootDir) => ({
      MINICMS_IMAGE_CACHE_DIR: path.join(rootDir, "image-cache")
    })
  });
});

test("keeps GitHub media global while renaming collection records and cache keys", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const initial = await fetch(`${baseUrl}/api/config`);
    const current = await initial.json();

    const incidentalHash = "a".repeat(64);
    const filePath = path.join(rootDir, "content", "files", "manual.yml");
    await fs.writeFile(
      filePath,
      `id: manual
type: download
order: 0
properties:
  file: /media/pages/${incidentalHash}/Manual.pdf
slots: {}
`,
      "utf8"
    );
    const globalSentinel = path.join(
      rootDir,
      "content",
      "media",
      "pages",
      "unrelated",
      "sentinel.txt"
    );
    await fs.mkdir(path.dirname(globalSentinel), { recursive: true });
    await fs.writeFile(globalSentinel, "keep global media");
    const oldCache = path.join(
      rootDir,
      "image-cache",
      "images_v1",
      "media",
      "pages",
      incidentalHash,
      "noop"
    );
    await fs.mkdir(oldCache, { recursive: true });
    await fs.writeFile(path.join(oldCache, "asset.png"), "stale cache");

    const next = structuredClone(current);
    next.collections.documents = next.collections.pages;
    delete next.collections.pages;
    next.collections.documents.folder = "content/documents";
    const renamed = await putConfig(
      baseUrl,
      next,
      initial.headers.get("etag"),
      {
        node_types: {},
        collections: { pages: "documents" }
      }
    );
    assert.equal(renamed.status, 200, await renamed.text());
    await fs.access(path.join(rootDir, "content", "documents", "home.yml"));
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "pages")),
      (error) => error.code === "ENOENT"
    );
    assert.equal(await fs.readFile(globalSentinel, "utf8"), "keep global media");
    assert.equal(
      (await readYaml(filePath)).properties.file,
      `/media/pages/${incidentalHash}/Manual.pdf`
    );
    await assert.rejects(fs.access(oldCache), (error) => error.code === "ENOENT");
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "media", "documents")),
      (error) => error.code === "ENOENT"
    );
  }, {
    prepareRoot: useGithubStorage,
    environment: (rootDir) => ({
      MINICMS_IMAGE_CACHE_DIR: path.join(rootDir, "image-cache")
    })
  });
});

test("renames remote aliases in local records without moving connector-owned storage", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const initial = await fetch(`${baseUrl}/api/config`);
    const current = await initial.json();
    current.connectors.central = {
      name: "api",
      api_url: "https://media.example.com",
      auth_url: "https://auth.example.com"
    };
    current.collections.central_sources = {
      connector: "central",
      remote_collection: "sources"
    };
    const prepared = await putConfig(
      baseUrl,
      current,
      initial.headers.get("etag")
    );
    assert.equal(prepared.status, 200);

    const pagePath = path.join(rootDir, "content", "pages", "home.yml");
    await fs.writeFile(
      pagePath,
      `id: home
type: page
order: 0
properties:
  uuid: 84a3ef27-cdce-477b-863f-c1f418037685
  parent_uuid: null
  title: Home
slots:
  content:
    - id: abcdefghijklmno
      type: text
      order: 0
      properties:
        text: '[Source](minicms://reference/central_sources/item-1)'
      slots: {}
`,
      "utf8"
    );
    const cacheSentinel = path.join(
      rootDir,
      "image-cache",
      "images_v1",
      "media",
      "central_sources",
      "hash",
      "noop",
      "asset.png"
    );
    await fs.mkdir(path.dirname(cacheSentinel), { recursive: true });
    await fs.writeFile(cacheSentinel, "remote cache namespace");

    const next = structuredClone(current);
    next.collections.library_sources = next.collections.central_sources;
    delete next.collections.central_sources;
    const renamed = await putConfig(
      baseUrl,
      next,
      prepared.headers.get("etag"),
      {
        node_types: {},
        collections: { central_sources: "library_sources" }
      }
    );
    assert.equal(renamed.status, 200, await renamed.text());
    assert.equal(
      (await readYaml(pagePath)).slots.content[0].properties.text,
      "[Source](minicms://reference/library_sources/item-1)"
    );
    assert.equal(await fs.readFile(cacheSentinel, "utf8"), "remote cache namespace");
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "central_sources")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "library_sources")),
      (error) => error.code === "ENOENT"
    );
  }, {
    environment: (rootDir) => ({
      MINICMS_IMAGE_CACHE_DIR: path.join(rootDir, "image-cache")
    })
  });
});

test("commits schema renames before best-effort cache cleanup and never follows cache links", async (t) => {
  const warnings = [];
  await withServer(async (baseUrl, rootDir) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-cache-link-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    const sentinel = path.join(outside, "sentinel.txt");
    await fs.writeFile(sentinel, "keep");
    const linkedCollection = path.join(
      rootDir,
      "image-cache",
      "images_v1",
      "media",
      "pages"
    );
    await fs.mkdir(path.dirname(linkedCollection), { recursive: true });
    try {
      await fs.symlink(outside, linkedCollection);
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
        return;
      }
      throw error;
    }

    const loaded = await fetch(`${baseUrl}/api/config`);
    const next = await loaded.json();
    next.collections.documents = next.collections.pages;
    delete next.collections.pages;
    next.collections.documents.folder = "content/documents";
    const saved = await putConfig(
      baseUrl,
      next,
      loaded.headers.get("etag"),
      {
        node_types: {},
        collections: { pages: "documents" }
      }
    );
    assert.equal(saved.status, 200);
    await fs.access(path.join(rootDir, "content", "documents", "home.yml"));
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "pages")),
      (error) => error.code === "ENOENT"
    );
    assert.equal(await fs.readFile(sentinel, "utf8"), "keep");
    assert.ok(warnings.some((message) => /cache cleanup/.test(message)));
  }, {
    environment: (rootDir) => ({
      MINICMS_IMAGE_CACHE_DIR: path.join(rootDir, "image-cache")
    }),
    imageLogger: {
      warn(message) {
        warnings.push(message);
      }
    }
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

test("renames empty and virtual collection storage without inventing missing folders", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const current = await loaded.json();
    current.collections.virtual = {
      folder: "content/virtual",
      extension: "yml",
      node_type: "download",
      allowed_types: ["download"]
    };
    const prepared = await putConfig(
      baseUrl,
      current,
      loaded.headers.get("etag")
    );
    assert.equal(prepared.status, 200);

    const next = structuredClone(current);
    next.collections.downloads = next.collections.files;
    delete next.collections.files;
    next.collections.downloads.folder = "content/downloads";
    next.collections.virtual_copy = next.collections.virtual;
    delete next.collections.virtual;
    next.collections.virtual_copy.folder = "content/virtual-copy";
    const saved = await putConfig(
      baseUrl,
      next,
      prepared.headers.get("etag"),
      {
        node_types: {},
        collections: {
          files: "downloads",
          virtual: "virtual_copy"
        }
      }
    );
    assert.equal(saved.status, 200);
    assert.deepEqual(await fs.readdir(path.join(rootDir, "content", "downloads")), []);
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "files")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "virtual")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "virtual-copy")),
      (error) => error.code === "ENOENT"
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

test("rejects a collection move into its own source tree", async () => {
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
    config.collections.pages.folder = "content/pages/archive";

    const rejected = await putConfig(
      baseUrl,
      config,
      loaded.headers.get("etag")
    );
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).message, /cannot contain or be contained/);
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
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "pages", "archive")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
      (error) => error.code === "ENOENT"
    );
  });
});

test("transactionally migrates record filenames when the YAML extension changes", async () => {
  for (const renameCollection of [false, true]) {
    await withServer(async (baseUrl, rootDir) => {
      const loaded = await fetch(`${baseUrl}/api/config`);
      const next = await loaded.json();
      const collectionName = renameCollection ? "documents" : "pages";
      if (renameCollection) {
        next.collections.documents = next.collections.pages;
        delete next.collections.pages;
        next.collections.documents.folder = "content/documents";
      }
      next.collections[collectionName].extension = "yaml";
      const saved = await putConfig(
        baseUrl,
        next,
        loaded.headers.get("etag"),
        renameCollection
          ? {
              node_types: {},
              collections: { pages: "documents" }
            }
          : undefined
      );
      assert.equal(saved.status, 200, await saved.text());
      const folder = path.join(rootDir, "content", collectionName);
      await assert.rejects(
        fs.access(path.join(folder, "home.yml")),
        (error) => error.code === "ENOENT"
      );
      assert.equal((await readYaml(path.join(folder, "home.yaml"))).id, "home");
      assert.equal(
        (
          await fetch(`${baseUrl}/api/collections/${collectionName}/home`).then(
            (response) => response.json()
          )
        ).properties.title,
        "Home"
      );
      if (renameCollection) {
        await assert.rejects(
          fs.access(path.join(rootDir, "content", "pages")),
          (error) => error.code === "ENOENT"
        );
      }
      await assert.rejects(
        fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
        (error) => error.code === "ENOENT"
      );
    });
  }
});

test("rejects hidden file and tree collisions at migrated extension paths", async () => {
  for (const collisionKind of ["file", "directory"]) {
    await withServer(async (baseUrl, rootDir) => {
      const loaded = await fetch(`${baseUrl}/api/config`);
      const next = await loaded.json();
      const configPath = path.join(rootDir, "cms.config.yml");
      const originalConfig = await fs.readFile(configPath, "utf8");
      const oldRecordPath = path.join(rootDir, "content", "pages", "home.yml");
      const originalRecord = await fs.readFile(oldRecordPath, "utf8");
      const collisionName = collisionKind === "file"
        ? "home.yaml"
        : "rogue.YAML";
      const collisionPath = path.join(
        rootDir,
        "content",
        "pages",
        collisionName
      );
      if (collisionKind === "file") {
        await fs.writeFile(collisionPath, "hidden collision");
      } else {
        await fs.mkdir(collisionPath);
        await fs.writeFile(path.join(collisionPath, "sentinel.txt"), "keep");
      }
      next.collections.pages.extension = "yaml";

      const rejected = await putConfig(
        baseUrl,
        next,
        loaded.headers.get("etag")
      );
      assert.ok([400, 409].includes(rejected.status));
      assert.equal(await fs.readFile(configPath, "utf8"), originalConfig);
      assert.equal(await fs.readFile(oldRecordPath, "utf8"), originalRecord);
      if (collisionKind === "file") {
        assert.equal(await fs.readFile(collisionPath, "utf8"), "hidden collision");
      } else {
        assert.equal(
          await fs.readFile(path.join(collisionPath, "sentinel.txt"), "utf8"),
          "keep"
        );
      }
      await assert.rejects(
        fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
        (error) => error.code === "ENOENT"
      );
    });
  }
});

test("rejects physical folders, files, and links for newly added collections", async (t) => {
  await withServer(async (baseUrl, rootDir) => {
    const loaded = await fetch(`${baseUrl}/api/config`);
    const config = await loaded.json();
    const etag = loaded.headers.get("etag");
    const originalConfig = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    await fs.mkdir(path.join(rootDir, "content", "occupied-directory"));
    await fs.writeFile(
      path.join(rootDir, "content", "occupied-file"),
      "not a collection"
    );
    const candidates = [
      ["duplicate_directory", "content/occupied-directory"],
      ["duplicate_file", "content/occupied-file"]
    ];
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-linked-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    try {
      await fs.symlink(outside, path.join(rootDir, "content", "occupied-link"));
      candidates.push(["duplicate_link", "content/occupied-link"]);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      t.diagnostic(`symlink assertion skipped: ${error.code}`);
    }

    for (const [name, folder] of candidates) {
      const next = structuredClone(config);
      next.collections[name] = {
        ...next.collections.pages,
        folder
      };
      const rejected = await putConfig(baseUrl, next, etag);
      assert.ok([400, 409].includes(rejected.status), `${name}: ${rejected.status}`);
      assert.equal(
        await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
        originalConfig
      );
    }

    await fs.mkdir(
      path.join(rootDir, "content", "media", "duplicate_media"),
      { recursive: true }
    );
    const mediaConflict = structuredClone(config);
    mediaConflict.collections.duplicate_media = {
      ...mediaConflict.collections.pages,
      folder: "content/clean-duplicate"
    };
    const rejectedMedia = await putConfig(baseUrl, mediaConflict, etag);
    assert.equal(rejectedMedia.status, 409);
    assert.equal(
      await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
      originalConfig
    );
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "clean-duplicate")),
      (error) => error.code === "ENOENT"
    );
  });
});

test("preflights record identity, extension, and current schema before any rename writes", async () => {
  const cases = [
    {
      name: "filename identity",
      prepare: async (rootDir) => {
        const recordPath = path.join(rootDir, "content", "pages", "home.yml");
        const source = await fs.readFile(recordPath, "utf8");
        await fs.writeFile(recordPath, source.replace("id: home", "id: mismatch"));
      },
      message: /id must match its filename stem/
    },
    {
      name: "configured extension",
      prepare: async (rootDir) => {
        const source = await fs.readFile(
          path.join(rootDir, "content", "pages", "home.yml"),
          "utf8"
        );
        await fs.writeFile(
          path.join(rootDir, "content", "pages", "rogue.yaml"),
          source.replace("id: home", "id: rogue")
        );
      },
      message: /configured \.yml extension/
    },
    {
      name: "current schema",
      prepare: async (rootDir) => {
        const recordPath = path.join(rootDir, "content", "pages", "home.yml");
        const source = await fs.readFile(recordPath, "utf8");
        await fs.writeFile(recordPath, source.replace("type: page", "type: missing"));
      },
      message: /Record type "missing" is not allowed/
    }
  ];

  for (const fixtureCase of cases) {
    await withServer(async (baseUrl, rootDir) => {
      const loaded = await fetch(`${baseUrl}/api/config`);
      const current = await loaded.json();
      const etag = loaded.headers.get("etag");
      await fixtureCase.prepare(rootDir);
      const sourceDirectory = path.join(rootDir, "content", "pages");
      const before = await fs.readdir(sourceDirectory);
      const originalConfig = await fs.readFile(
        path.join(rootDir, "cms.config.yml"),
        "utf8"
      );
      const mediaSource = path.join(
        rootDir,
        "content",
        "media",
        "pages",
        "a".repeat(64)
      );
      await fs.mkdir(mediaSource, { recursive: true });
      await fs.writeFile(path.join(mediaSource, "asset.dat"), "keep");

      const next = structuredClone(current);
      next.collections.documents = next.collections.pages;
      delete next.collections.pages;
      next.collections.documents.folder = "content/documents";
      const rejected = await putConfig(baseUrl, next, etag, {
        node_types: {},
        collections: { pages: "documents" }
      });
      assert.equal(rejected.status, 400, fixtureCase.name);
      assert.match((await rejected.json()).message, fixtureCase.message);
      assert.equal(
        await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
        originalConfig
      );
      assert.deepEqual(await fs.readdir(sourceDirectory), before);
      await fs.access(path.join(mediaSource, "asset.dat"));
      await assert.rejects(
        fs.access(path.join(rootDir, "content", "documents")),
        (error) => error.code === "ENOENT"
      );
      await assert.rejects(
        fs.access(path.join(rootDir, "content", "media", "documents")),
        (error) => error.code === "ENOENT"
      );
      await assert.rejects(
        fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
        (error) => error.code === "ENOENT"
      );
    });
  }
});

test("rejects linked media namespaces before moving records or configuration", async (t) => {
  await withServer(async (baseUrl, rootDir) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-media-link-"));
    t.after(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.writeFile(path.join(outside, "sentinel.txt"), "keep");
    await fs.mkdir(path.join(rootDir, "content", "media"), { recursive: true });
    try {
      await fs.symlink(outside, path.join(rootDir, "content", "media", "pages"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
        return;
      }
      throw error;
    }
    const loaded = await fetch(`${baseUrl}/api/config`);
    const next = await loaded.json();
    const originalConfig = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    next.collections.documents = next.collections.pages;
    delete next.collections.pages;
    next.collections.documents.folder = "content/documents";

    const rejected = await putConfig(
      baseUrl,
      next,
      loaded.headers.get("etag"),
      {
        node_types: {},
        collections: { pages: "documents" }
      }
    );
    assert.equal(rejected.status, 400);
    assert.equal(
      await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
      originalConfig
    );
    await fs.access(path.join(rootDir, "content", "pages", "home.yml"));
    assert.equal(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"), "keep");
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "documents")),
      (error) => error.code === "ENOENT"
    );
    await assert.rejects(
      fs.access(path.join(rootDir, TRANSACTION_ROOT_NAME)),
      (error) => error.code === "ENOENT"
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
          version: 2,
          oldConfigHash: sha256(oldSource),
          newConfigHash: sha256(newSource),
          directories: [
            {
              kind: "collection",
              label: "collection:pages->pages",
              mode: "copy",
              source: "content/pages",
              destination: "content/recovered",
              stage: "stage/0",
              backup: "backup/0"
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

test("recovers in-place record rewrites before, during, and after the config commit", async () => {
  const phases = [
    { name: "source evacuated", published: false, committed: false },
    { name: "rewrite published", published: true, committed: false },
    { name: "config committed", published: true, committed: true }
  ];
  for (const phase of phases) {
    const rootDir = await makeFixture();
    try {
      const configFile = path.join(rootDir, "cms.config.yml");
      const oldSource = await fs.readFile(configFile, "utf8");
      const newSource = oldSource.replace(
        "site:\n",
        "site:\n  name: Recovered schema\n"
      );
      const pages = path.join(rootDir, "content", "pages");
      const oldMedia = path.join(rootDir, "content", "media", "pages");
      const newMedia = path.join(rootDir, "content", "media", "documents");
      const transactionDir = path.join(
        rootDir,
        TRANSACTION_ROOT_NAME,
        "b".repeat(24)
      );
      await fs.mkdir(path.join(transactionDir, "backup"), { recursive: true });
      await fs.mkdir(path.join(transactionDir, "stage"));
      await fs.mkdir(path.join(oldMedia, "hash"), { recursive: true });
      await fs.writeFile(path.join(oldMedia, "hash", "asset.dat"), "media");
      await fs.rename(pages, path.join(transactionDir, "backup", "0"));
      if (phase.published) {
        await fs.cp(
          path.join(transactionDir, "backup", "0"),
          pages,
          { recursive: true }
        );
        const recordPath = path.join(pages, "home.yml");
        const source = await fs.readFile(recordPath, "utf8");
        await fs.writeFile(
          recordPath,
          source.replace("title: Home", "title: Migrated")
        );
        await fs.cp(oldMedia, newMedia, { recursive: true });
      }
      await fs.writeFile(
        path.join(transactionDir, "manifest.json"),
        `${JSON.stringify({
          version: 2,
          oldConfigHash: sha256(oldSource),
          newConfigHash: sha256(newSource),
          directories: [
            {
              kind: "collection",
              label: "collection:pages->pages",
              mode: "replace",
              source: "content/pages",
              destination: "content/pages",
              stage: "stage/0",
              backup: "backup/0"
            },
            {
              kind: "media",
              label: "media:pages->documents",
              mode: "copy",
              source: "content/media/pages",
              destination: "content/media/documents",
              stage: "stage/1",
              backup: "backup/1"
            }
          ]
        })}\n`,
        "utf8"
      );
      if (phase.committed) await fs.writeFile(configFile, newSource, "utf8");

      await createConfigTransaction({ rootDir, configFile }).recover();
      const recovered = await fs.readFile(
        path.join(rootDir, "content", "pages", "home.yml"),
        "utf8"
      );
      if (phase.committed) {
        assert.match(recovered, /title: Migrated/, phase.name);
        assert.equal(await fs.readFile(configFile, "utf8"), newSource);
        await assert.rejects(
          fs.access(oldMedia),
          (error) => error.code === "ENOENT"
        );
        assert.equal(
          await fs.readFile(path.join(newMedia, "hash", "asset.dat"), "utf8"),
          "media"
        );
      } else {
        assert.match(recovered, /title: Home/, phase.name);
        assert.equal(await fs.readFile(configFile, "utf8"), oldSource);
        assert.equal(
          await fs.readFile(path.join(oldMedia, "hash", "asset.dat"), "utf8"),
          "media"
        );
        await assert.rejects(
          fs.access(newMedia),
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

test("recovery fails closed when a content-path ancestor became a symlink", async (t) => {
  const rootDir = await makeFixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-recovery-link-"));
  try {
    const configFile = path.join(rootDir, "cms.config.yml");
    const source = await fs.readFile(configFile, "utf8");
    const transactionDir = path.join(
      rootDir,
      TRANSACTION_ROOT_NAME,
      "c".repeat(24)
    );
    await fs.mkdir(path.join(transactionDir, "stage"), { recursive: true });
    await fs.mkdir(path.join(transactionDir, "backup"));
    await fs.mkdir(path.join(outside, "documents"));
    await fs.writeFile(
      path.join(outside, "documents", "sentinel.txt"),
      "do not remove"
    );
    await fs.writeFile(
      path.join(transactionDir, "manifest.json"),
      `${JSON.stringify({
        version: 2,
        oldConfigHash: sha256(source),
        newConfigHash: sha256(`${source}\n# next\n`),
        directories: [
          {
            kind: "media",
            label: "media:pages->documents",
            mode: "copy",
            source: "content/media/pages",
            destination: "content/media/documents",
            stage: "stage/0",
            backup: "backup/0"
          }
        ]
      })}\n`,
      "utf8"
    );
    await fs.mkdir(path.join(rootDir, "content", "media"));
    await fs.rename(
      path.join(rootDir, "content", "media"),
      path.join(rootDir, "content", "media-original")
    );
    try {
      await fs.symlink(outside, path.join(rootDir, "content", "media"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
        return;
      }
      throw error;
    }

    await assert.rejects(
      createConfigTransaction({ rootDir, configFile }).recover(),
      /symlink or non-directory component/
    );
    assert.equal(
      await fs.readFile(
        path.join(outside, "documents", "sentinel.txt"),
        "utf8"
      ),
      "do not remove"
    );
    await fs.access(transactionDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("recovery fails closed when its backup root became a symlink", async (t) => {
  const rootDir = await makeFixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-backup-link-"));
  try {
    const configFile = path.join(rootDir, "cms.config.yml");
    const source = await fs.readFile(configFile, "utf8");
    const transactionDir = path.join(
      rootDir,
      TRANSACTION_ROOT_NAME,
      "d".repeat(24)
    );
    await fs.mkdir(path.join(transactionDir, "stage"), { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel.txt"), "do not remove");
    try {
      await fs.symlink(outside, path.join(transactionDir, "backup"));
    } catch (error) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) {
        t.diagnostic(`symlink assertion skipped: ${error.code}`);
        return;
      }
      throw error;
    }
    await fs.writeFile(
      path.join(transactionDir, "manifest.json"),
      `${JSON.stringify({
        version: 2,
        oldConfigHash: sha256(source),
        newConfigHash: sha256(`${source}\n# next\n`),
        directories: [
          {
            kind: "collection",
            label: "collection:pages->pages",
            mode: "replace",
            source: "content/pages",
            destination: "content/pages",
            stage: "stage/0",
            backup: "backup/0"
          }
        ]
      })}\n`,
      "utf8"
    );

    await assert.rejects(
      createConfigTransaction({ rootDir, configFile }).recover(),
      /backup root is not a regular directory/
    );
    assert.equal(
      await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"),
      "do not remove"
    );
    await fs.access(path.join(rootDir, "content", "pages", "home.yml"));
    await fs.access(transactionDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("stores remote aliases without treating them as local collections", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) =>
      response.json()
    );
    config.connectors.central_media = {
      name: "api",
      api_url: "https://media.example",
      auth_url: "https://auth.example.com"
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
      ["POST", "/api/media/central_images?filename=example.png&widget=image"]
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

test("deduplicates uploads by hash while preserving each cosmetic filename", async () => {
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
      fetch(`${baseUrl}/api/media/pages?filename=${encodeURIComponent("Hero Image.png")}&widget=image`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: contents
      });

    const first = await upload();
    assert.equal(first.status, 201);
    const firstResult = await first.json();
    const hash = sha256(contents);
    assert.equal(firstResult.filename, "Hero Image.png");
    assert.equal(firstResult.hash, hash);
    assert.equal(firstResult.path, `/media/pages/${hash}/Hero%20Image.png`);
    assert.equal(firstResult.reused, false);
    assert.equal(
      firstResult.storage_path,
      `content/media/pages/${hash}/asset.dat`
    );

    const second = await fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Another Name.png")}&widget=image`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: contents
      }
    );
    assert.equal(second.status, 201);
    const secondResult = await second.json();
    assert.equal(secondResult.filename, "Another Name.png");
    assert.equal(secondResult.path, `/media/pages/${hash}/Another%20Name.png`);
    assert.equal(secondResult.reused, true);

    const concurrent = await Promise.all([upload(), upload(), upload()]);
    assert.deepEqual(
      concurrent.map((response) => response.status),
      [201, 201, 201]
    );
    const concurrentResults = await Promise.all(
      concurrent.map((response) => response.json())
    );
    assert.deepEqual(
      concurrentResults.map((result) => result.reused),
      [true, true, true]
    );

    const stored = await fs.readFile(
      path.join(rootDir, "content", "media", "pages", hash, "asset.dat"),
      null
    );
    assert.deepEqual(stored, contents);

    const maximumName = `${"a".repeat(251)}.png`;
    const uploadMaximumName = () =>
      fetch(
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(maximumName)}&widget=image`,
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
    assert.equal(maximumSecondName, maximumFirstName);
  });
});

test("publishes concurrent first uploads after racing to create the media root", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const contents = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 40, g: 50, b: 60 }
      }
    }).png().toBuffer();
    await assert.rejects(
      fs.access(path.join(rootDir, "content", "media")),
      (error) => error.code === "ENOENT"
    );
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        fetch(
          `${baseUrl}/api/media/pages?filename=first-${index}.png&widget=image`,
          {
            method: "POST",
            headers: { "content-type": "image/png" },
            body: contents
          }
        )
      )
    );
    const results = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(
      responses.map(({ status }) => status),
      Array(8).fill(201),
      JSON.stringify(results)
    );
    assert.equal(results.filter(({ reused }) => reused === false).length, 1);
    assert.equal(results.filter(({ reused }) => reused === true).length, 7);
    const hash = sha256(contents);
    assert.deepEqual(
      await fs.readdir(path.join(rootDir, "content", "media", "pages", hash)),
      ["asset.dat"]
    );
  });
});

test("development mirrors GitHub media layout and requires a duplicate choice", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const config = await fetch(`${baseUrl}/api/config`).then((response) =>
      response.json()
    );
    const body = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 1, g: 2, b: 3 }
      }
    }).png().toBuffer();
    const hash = sha256(body);
    const upload = (duplicate) => fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Hero Image.png")}&widget=image${
        duplicate ? `&duplicate=${duplicate}` : ""
      }`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body
      }
    );

    const first = await upload();
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), {
      filename: "Hero Image.png",
      hash,
      path: `/media/${hash}/Hero%20Image.png`,
      storage_path: `content/media/${hash}/Hero Image.png`,
      reused: false
    });
    const raw = await fetch(`${baseUrl}/media/${hash}/Anything%20Readable.jpg`);
    assert.equal(raw.status, 200);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), body);
    const derivative = imageServicePath(
      { hash, filename: "Hero Image.png" },
      { config, collection: "pages", width: 2, height: 1 }
    );
    const derivativeAlias = derivative.replace(
      /\/[^/]+\.webp$/,
      "/anything-readable.webp"
    );
    const originalDerivative = await fetch(`${baseUrl}${derivative}`);
    const aliasedDerivative = await fetch(`${baseUrl}${derivativeAlias}`);
    assert.equal(originalDerivative.status, 200);
    assert.equal(aliasedDerivative.status, 200);
    assert.equal(
      originalDerivative.headers.get("etag"),
      aliasedDerivative.headers.get("etag")
    );
    assert.equal(
      (await fetch(`${baseUrl}${derivative.replace("/pages/", "/invented/")}`)).status,
      404
    );
    const dotBody = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 9, g: 8, b: 7 }
      }
    }).png().toBuffer();
    const dotUpload = await fetch(
      `${baseUrl}/api/media/pages?filename=.hero.png&widget=image`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: dotBody
      }
    );
    assert.equal(dotUpload.status, 201);
    const dotDescriptor = await dotUpload.json();
    assert.equal((await fetch(`${baseUrl}${dotDescriptor.path}`)).status, 200);
    const conflict = await upload();
    assert.equal(conflict.status, 409);
    const choices = await conflict.json();
    assert.equal(choices.duplicate, true);
    assert.equal(choices.existing.filename, "Hero Image.png");
    assert.equal(choices.copy.filename, "Hero Image-2.png");
    assert.equal(choices.copy.proposed, true);

    const reused = await upload("reuse");
    assert.equal(reused.status, 201);
    assert.equal((await reused.json()).reused, true);
    const copied = await upload("copy");
    assert.equal(copied.status, 201);
    assert.equal((await copied.json()).filename, "Hero Image-2.png");
    assert.deepEqual(
      (await fs.readdir(path.join(rootDir, "content", "media", hash))).sort(),
      ["Hero Image-2.png", "Hero Image.png"]
    );
  }, { prepareRoot: useGithubStorage });
});

test("GitHub duplicate choices reject decomposed existing filenames", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const body = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 3, g: 2, b: 1 }
      }
    }).png().toBuffer();
    const hash = sha256(body);
    const directory = path.join(rootDir, "content", "media", hash);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "Cafe\u0301.png"), body);
    const upload = (duplicate) => fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Café.png")}&widget=image${
        duplicate ? `&duplicate=${duplicate}` : ""
      }`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body
      }
    );

    for (const duplicate of [undefined, "reuse", "copy"]) {
      const response = await upload(duplicate);
      assert.equal(response.status, 409);
      assert.match((await response.json()).message, /not NFC-normalized/);
    }
    assert.deepEqual(await fs.readdir(directory), ["Cafe\u0301.png"]);
  }, { prepareRoot: useGithubStorage });
});

test("refuses a pre-existing API asset whose bytes do not match its hash directory", async () => {
  await withServer(async (baseUrl, rootDir) => {
    const body = await sharp({
      create: {
        width: 2,
        height: 1,
        channels: 3,
        background: { r: 4, g: 5, b: 6 }
      }
    }).png().toBuffer();
    const hash = sha256(body);
    const directory = path.join(rootDir, "content", "media", "pages", hash);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "asset.dat"), "wrong bytes");
    const response = await fetch(
      `${baseUrl}/api/media/pages?filename=valid.png&widget=image`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body
      }
    );
    assert.equal(response.status, 409);
    assert.match((await response.json()).message, /does not match/);
    assert.equal(
      await fs.readFile(path.join(directory, "asset.dat"), "utf8"),
      "wrong bytes"
    );
  });
});

test("requires an upload widget and keeps mixed file acceptance out of image uploads", async () => {
  await withServer(async (baseUrl) => {
    const png = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 7, g: 8, b: 9 }
      }
    }).png().toBuffer();
    for (const query of [
      "filename=missing.png",
      "filename=invalid.png&widget=video"
    ]) {
      const response = await fetch(`${baseUrl}/api/media/pages?${query}`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: png
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).message, /upload widget/);
    }

    const configResponse = await fetch(`${baseUrl}/api/config`);
    const config = await configResponse.json();
    config.node_types.page.fields.attachment = {
      widget: "file",
      accept: ["*/*"]
    };
    assert.equal(
      (await putConfig(baseUrl, config, configResponse.headers.get("etag"))).status,
      200
    );
    const rejectedImage = await fetch(
      `${baseUrl}/api/media/pages?filename=notes.pdf&widget=image`,
      {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "pdf"
      }
    );
    assert.equal(rejectedImage.status, 400);
    assert.match((await rejectedImage.json()).message, /image\/png/);
    const acceptedFile = await fetch(
      `${baseUrl}/api/media/pages?filename=notes.pdf&widget=file`,
      {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "pdf"
      }
    );
    assert.equal(acceptedFile.status, 201);
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
      `${baseUrl}/api/media/pages?filename=clean.png&widget=image`,
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
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(filename)}&widget=image`,
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
      `${baseUrl}/api/media/missing?filename=hero.png&widget=image`,
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
      `${baseUrl}/api/media/pages?filename=hero.png&widget=image`,
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
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Diagram.svg")}&widget=image`,
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
      `/media/pages/${svgHash}/Diagram.svg`
    );
    assert.equal(
      await fs.readFile(
        path.join(rootDir, "content", "media", "pages", svgHash, "asset.dat"),
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
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(filename)}&widget=image`,
        {
          method: "POST",
          headers: { "content-type": contentType },
          body: tiffContents
        }
      );
      assert.equal(tiff.status, 201);
      const tiffHash = sha256(tiffContents);
      assert.deepEqual(
        (await tiff.json()).path,
        `/media/pages/${tiffHash}/${filename}`
      );
      assert.deepEqual(
        await fs.readFile(
          path.join(rootDir, "content", "media", "pages", tiffHash, "asset.dat"),
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
        `${baseUrl}/api/media/pages?filename=${encodeURIComponent(filename)}&widget=image`,
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
      `${baseUrl}/api/media/pages?filename=spoofed.png&widget=image`,
      {
        method: "POST",
        headers: { "content-type": "image/svg+xml" },
        body: pngContents
      }
    );
    assert.equal(spoofedMime.status, 400);
    assert.match((await spoofedMime.json()).message, /image\/svg\+xml/);

    const rejected = await fetch(
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Photo.jpg")}&widget=image`,
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
      `${baseUrl}/api/media/pages?filename=${encodeURIComponent("Research notes.pdf")}&widget=file`,
      {
        method: "POST",
        headers: { "content-type": "application/pdf" },
        body: "not-written"
      }
    );
    assert.equal(rejectedByPages.status, 400);

    const uploaded = await fetch(
      `${baseUrl}/api/media/files?filename=${encodeURIComponent("Research notes.pdf")}&widget=file`,
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
      `/media/files/${pdfHash}/Research%20notes.pdf`
    );
    assert.equal(
      await fs.readFile(
        path.join(
          rootDir,
          "content",
          "media",
          "files",
          pdfHash,
          "asset.dat"
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
      path.join(childDirectory, "asset.dat"),
      "child-image",
      "utf8"
    );
    const home = await fetch(`${baseUrl}/api/collections/pages/home`).then(
      (response) => response.json()
    );
    home.properties.image = { hash: childHash, filename: "child-2.png" };
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
        image: { hash: childHash, filename: "child.png" },
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
      await fs.readFile(path.join(childDirectory, "asset.dat"), "utf8"),
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
    const outside = path.join(rootDir, "outside.png");
    await fs.writeFile(outside, "outside", "utf8");
    const linkedHash = sha256("outside");
    const linkedDirectory = path.join(mediaDirectory, "pages", linkedHash);
    await fs.mkdir(linkedDirectory, { recursive: true });
    try {
      await fs.symlink(outside, path.join(linkedDirectory, "asset.dat"));
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
        image: { hash: linkedHash, filename: "linked.png" },
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
