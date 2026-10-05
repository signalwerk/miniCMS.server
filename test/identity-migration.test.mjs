import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { parseYaml } from "@signalwerk/minicms/core/content";
import { ID_PATTERN } from "@signalwerk/minicms/core/id";
import {
  buildPlan,
  executePlan
} from "../bin/migrate-record-identity.mjs";

const HASH = "c".repeat(64);

const config = `connectors:
  default:
    name: github
    repo: signalwerk/example
    base_url: https://auth.example.com
    branch: main
site:
  media_folder: content/media
  public_folder: /media
node_types:
  page:
    fields:
      content_id: { label: ID, widget: id, readonly: true, required: true }
      title: { widget: string }
      author: { widget: reference, collection: authors }
      body:
        widget: markdown
        blocknote:
          internal_links:
            collections: [pages, authors]
    views:
      detail:
        panels:
          info:
            groups:
              identity:
                fields: [content_id]
  author:
    fields:
      name: { widget: string }
      download: { widget: file }
      portrait: { widget: image }
collections:
  pages:
    folder: content/pages
    extension: yml
    slug: "{{title}}"
    node_type: page
    hierarchy:
      enabled: true
      id_field: content_id
      parent_field: parent_id
    views:
      reference: { value: content_id, title: title }
  authors:
    folder: content/authors
    extension: yml
    slug: "{{name}}"
    node_type: author
    hierarchy:
      enabled: true
      parent_field: parent
`;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-identity-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "content", "pages"), { recursive: true });
  await fs.mkdir(path.join(root, "content", "authors"), { recursive: true });
  await fs.writeFile(path.join(root, "cms.config.yml"), config);
  await fs.writeFile(
    path.join(root, "content", "pages", "home.yml"),
    `id: home
type: page
order: 0
properties:
  content_id: homecontentid01
  parent_id: null
  title: Home
  author: ada
  body: "[Ada](minicms://link/authors/ada) [About](minicms://link/pages/aboutcontent01)"
slots: {}
`
  );
  await fs.writeFile(
    path.join(root, "content", "pages", "about.yml"),
    `id: about
type: page
order: 1
properties:
  content_id: aboutcontent01x
  parent_id: homecontentid01
  title: About
slots: {}
`
  );
  await fs.writeFile(
    path.join(root, "content", "authors", "ada.yml"),
    `id: ada
type: author
order: 0
properties:
  name: Ada
  parent: null
  download: /media/${HASH}/Notes%20A.pdf
  portrait:
    hash: ${HASH}
    filename: portrait.png
slots: {}
`
  );
  await fs.writeFile(
    path.join(root, "content", "authors", "grace.yml"),
    `id: grace
type: author
order: 1
properties:
  name: Grace
  parent: ada
slots: {}
`
  );
  return root;
}

async function readYaml(root, ...segments) {
  return parseYaml(await fs.readFile(path.join(root, ...segments), "utf8"));
}

test("promotes generated identity fields, remaps readable ids, and moves media folders onto fields", async (t) => {
  const root = await fixture(t);
  const backup = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-identity-backup-"));
  await fs.rmdir(backup);
  t.after(() => fs.rm(backup, { recursive: true, force: true }));

  const plan = await buildPlan(root);
  assert.ok(plan.configOutput);
  assert.equal(plan.rewrites.length, 4);
  assert.deepEqual(Object.keys(plan.remapped), ["authors"]);
  await executePlan(plan, backup);

  const migratedConfig = parseYaml(
    await fs.readFile(path.join(root, "cms.config.yml"), "utf8")
  );
  assert.equal(migratedConfig.site.media_folder, undefined);
  assert.equal(migratedConfig.site.public_folder, undefined);
  assert.equal(migratedConfig.node_types.page.fields.content_id, undefined);
  assert.deepEqual(
    migratedConfig.node_types.page.views.detail.panels.info.groups.identity.fields,
    ["$id"]
  );
  assert.equal(migratedConfig.collections.pages.hierarchy.id_field, undefined);
  assert.equal(migratedConfig.collections.pages.views.reference.value, undefined);
  assert.equal(
    migratedConfig.node_types.author.fields.download.media_folder,
    "content/media"
  );
  assert.equal(
    migratedConfig.node_types.author.fields.portrait.media_folder,
    "content/media"
  );

  const home = await readYaml(root, "content", "pages", "home.yml");
  const about = await readYaml(root, "content", "pages", "about.yml");
  const ada = await readYaml(root, "content", "authors", "ada.yml");
  const grace = await readYaml(root, "content", "authors", "grace.yml");
  assert.equal(home.id, "homecontentid01");
  assert.equal(home.filename, "home");
  assert.equal(home.properties.content_id, undefined);
  assert.equal(about.id, "aboutcontent01x");
  assert.equal(about.properties.parent_id, "homecontentid01");
  assert.match(ada.id, ID_PATTERN);
  assert.equal(ada.filename, "ada");
  assert.equal(home.properties.author, ada.id);
  assert.equal(
    home.properties.body,
    `[Ada](minicms://link/authors/${ada.id}) [About](minicms://link/pages/aboutcontent01)`
  );
  assert.equal(grace.properties.parent, ada.id);
  assert.equal(
    ada.properties.download,
    `content/media/${HASH}/Notes%20A.pdf`
  );
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(backup, "id-map.json"), "utf8")),
    { authors: { ada: ada.id, grace: grace.id } }
  );
  assert.match(
    await fs.readFile(path.join(backup, "content", "authors", "ada.yml"), "utf8"),
    /^id: ada$/m
  );

  const again = await buildPlan(root);
  assert.equal(again.configOutput, null);
  assert.equal(again.rewrites.length, 0);
});

test("refuses slug templates that depend on the promoted identity field", async (t) => {
  const root = await fixture(t);
  const configPath = path.join(root, "cms.config.yml");
  await fs.writeFile(
    configPath,
    (await fs.readFile(configPath, "utf8")).replace(
      'slug: "{{title}}"',
      'slug: "{{content_id}}"'
    )
  );
  await assert.rejects(buildPlan(root), /Change the slug template before migrating/);
});

test("refuses a backup directory inside the project", async (t) => {
  const root = await fixture(t);
  const plan = await buildPlan(root);
  await assert.rejects(
    executePlan(plan, path.join(root, "backup")),
    /outside the project root/
  );
  assert.match(
    await fs.readFile(path.join(root, "content", "authors", "ada.yml"), "utf8"),
    /^id: ada$/m
  );
});
