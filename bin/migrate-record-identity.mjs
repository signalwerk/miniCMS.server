#!/usr/bin/env node

import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dumpYaml,
  parseYaml,
  validateRecord
} from "@signalwerk/minicms/core/content";
import {
  isRemoteCollection,
  validateSourceConfig
} from "@signalwerk/minicms/core/connectors";
import { ID_PATTERN, createId } from "@signalwerk/minicms/core/id";
import { recordIdFromFileStem } from "@signalwerk/minicms/core/slug";

// One-time offline migration to the opaque record identity and per-field
// media folder contract:
// - a collection's generated-ID identity field (hierarchy.id_field or
//   views.reference.value) becomes the record `id`; otherwise records receive
//   a fresh generated ID,
// - files are renamed to `<slug>-<id>` (the old readable name becomes the slug
//   part) or `<id>` for collections without a slug template; records never
//   keep a `filename` key,
// - references, tags, hierarchy parents, and canonical minicms:// links that
//   targeted a readable record id are rewritten to the new id,
// - site.media_folder moves onto every local image/file field and
//   site.public_folder is removed; GitHub file values become repository paths.

const URI_PATTERN =
  /minicms:\/\/(reference|link)\/([A-Za-z0-9_-]+)\/([^\s)"'<>]+)/g;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function migrationError(message) {
  const error = new Error(message);
  error.name = "IdentityMigrationError";
  return error;
}

function isMapping(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isRemoteType(type) {
  return Object.hasOwn(type ?? {}, "remote_type");
}

function collectionTypes(collection) {
  return [
    ...new Set([
      collection.node_type,
      ...(collection.allowed_types ?? []),
      ...(collection.hierarchy?.allowed_child_types ?? [])
    ].filter(Boolean))
  ];
}

function identityField(name, collection, config) {
  const candidates = new Set(
    [
      collection.hierarchy?.id_field,
      collection.views?.reference?.value
    ].filter((field) => field && !["id", "$id"].includes(field))
  );
  if (candidates.size > 1) {
    throw migrationError(
      `Collection "${name}" uses different identity fields (${[...candidates].join(", ")}).`
    );
  }
  const [field] = candidates;
  if (!field) return null;
  for (const typeName of collectionTypes(collection)) {
    const widget = config.node_types?.[typeName]?.fields?.[field]?.widget;
    if (!["id", "uuid"].includes(widget)) {
      throw migrationError(
        `Collection "${name}" identity field "${field}" must be a generated-ID field on type "${typeName}".`
      );
    }
  }
  return field;
}

function replaceFieldWithRecordId(type, fieldName) {
  delete type.fields?.[fieldName];
  for (const panel of Object.values(type.views?.detail?.panels ?? {})) {
    for (const group of Object.values(panel.groups ?? {})) {
      if (!Array.isArray(group.fields)) continue;
      const fieldKey = (entry) =>
        typeof entry === "string" ? entry : entry?.field;
      const hasRecordId = group.fields.some((entry) => fieldKey(entry) === "$id");
      group.fields = group.fields.flatMap((entry) =>
        fieldKey(entry) !== fieldName ? [entry] : hasRecordId ? [] : ["$id"]
      );
    }
  }
}

function removeListReferences(collection, fieldName) {
  const list = collection.views?.list;
  if (!list) return;
  if (Array.isArray(list.columns)) {
    list.columns = list.columns.filter((column) =>
      (typeof column === "string" ? column : column?.field) !== fieldName
    );
  }
  if (Array.isArray(list.search?.fields)) {
    list.search.fields = list.search.fields.filter((field) => field !== fieldName);
  }
  if (list.sort?.field === fieldName) delete list.sort;
}

function slugReferencesField(template, fieldName) {
  return new RegExp(`{{\\s*(?:fields\\.)?${fieldName}\\s*}}`).test(
    String(template ?? "")
  );
}

function migrateConfig(source) {
  const config = structuredClone(source);
  const changes = [];
  const site = isMapping(config.site) ? config.site : (config.site = {});
  const mediaFolder = String(site.media_folder || "content/media")
    .replace(/^\/+|\/+$/g, "");
  const publicFolder = String(site.public_folder || "/media").replace(/\/+$/, "");
  if ("media_folder" in site || "public_folder" in site) {
    delete site.media_folder;
    delete site.public_folder;
    changes.push("site media folders");
  }
  for (const type of Object.values(config.node_types ?? {})) {
    if (isRemoteType(type)) continue;
    for (const field of Object.values(type.fields ?? {})) {
      if (!["image", "file"].includes(field?.widget) || field.media_folder) {
        continue;
      }
      field.media_folder = mediaFolder;
      changes.push("field media folder");
    }
  }

  const identities = {};
  for (const [name, collection] of Object.entries(config.collections ?? {})) {
    if (isRemoteCollection(collection)) continue;
    const field = identityField(name, collection, source);
    identities[name] = field;
    if (!field) continue;
    if (collection.hierarchy?.id_field) delete collection.hierarchy.id_field;
    if (collection.views?.reference?.value) delete collection.views.reference.value;
    removeListReferences(collection, field);
    changes.push(`collection ${name} identity`);
  }

  const promoted = new Map();
  for (const [name, field] of Object.entries(identities)) {
    if (!field) continue;
    for (const typeName of collectionTypes(config.collections[name])) {
      promoted.set(typeName, field);
    }
  }
  for (const [name, collection] of Object.entries(config.collections ?? {})) {
    if (isRemoteCollection(collection)) continue;
    for (const typeName of collectionTypes(collection)) {
      const field = promoted.get(typeName);
      if (field && identities[name] !== field) {
        throw migrationError(
          `Type "${typeName}" is shared by collection "${name}", which does not use "${field}" as its identity.`
        );
      }
      if (field && slugReferencesField(collection.slug, field)) {
        throw migrationError(
          `Collection "${name}" slug "${collection.slug}" uses identity field "${field}". Change the slug template before migrating.`
        );
      }
    }
  }
  for (const [typeName, field] of promoted) {
    replaceFieldWithRecordId(config.node_types[typeName], field);
  }
  for (const type of Object.values(config.node_types ?? {})) {
    for (const field of Object.values(type.fields ?? {})) {
      if (
        ["reference", "tags"].includes(field?.widget) &&
        field.value_field &&
        identities[field.collection] === field.value_field
      ) {
        delete field.value_field;
        changes.push("reference value field");
      }
    }
  }
  for (const set of Object.values(config.site?.reference_sets ?? {})) {
    for (const key of ["item_template", "link_field"]) {
      if (typeof set?.[key] !== "string") continue;
      for (const collectionName of set.collections ?? []) {
        const field = identities[collectionName];
        if (!field) continue;
        set[key] = set[key].replaceAll(
          `record.properties.${field}`,
          "record.id"
        );
      }
    }
  }
  return { config, identities, mediaFolder, publicFolder, changes };
}

function mapReference(value, ids) {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (isMapping(value) && typeof value.ref === "string") {
    return { ...value, ref: ids.get(value.ref) ?? value.ref };
  }
  return value;
}

function rewriteUris(text, idMaps) {
  return text.replace(URI_PATTERN, (match, kind, collection, encoded) => {
    const ids = idMaps.get(collection);
    if (!ids) return match;
    let decoded;
    try {
      decoded = decodeURIComponent(encoded);
    } catch {
      return match;
    }
    const next = ids.get(decoded);
    return next ? `minicms://${kind}/${collection}/${encodeURIComponent(next)}` : match;
  });
}

function migrateNode(node, context) {
  const type = context.sourceConfig.node_types?.[node?.type];
  if (!isMapping(node) || !type || isRemoteType(type)) return;
  const properties = isMapping(node.properties) ? node.properties : {};
  for (const [name, field] of Object.entries(type.fields ?? {})) {
    if (!(name in properties)) continue;
    const value = properties[name];
    const targetIds = context.idMaps.get(field.collection);
    if (field.widget === "reference" && targetIds && !field.value_field) {
      properties[name] = Array.isArray(value)
        ? value.map((entry) => mapReference(entry, targetIds))
        : mapReference(value, targetIds);
    } else if (field.widget === "tags" && targetIds && Array.isArray(value)) {
      properties[name] = value.map((entry) => targetIds.get(entry) ?? entry);
    } else if (["markdown", "url"].includes(field.widget) && typeof value === "string") {
      properties[name] = rewriteUris(value, context.idMaps);
    } else if (
      field.widget === "file" &&
      context.storage === "github" &&
      typeof value === "string" &&
      value.startsWith(`${context.publicFolder}/`)
    ) {
      properties[name] =
        `${context.mediaFolder}/${value.slice(context.publicFolder.length + 1)}`;
    }
  }
  for (const children of Object.values(node.slots ?? {})) {
    if (Array.isArray(children)) {
      for (const child of children) migrateNode(child, context);
    }
  }
}

async function readCollection(projectRoot, name, collection) {
  const folder = path.resolve(projectRoot, collection.folder);
  if (!isInside(path.join(projectRoot, "content"), folder)) {
    throw migrationError(`Collection "${name}" folder is outside content/.`);
  }
  const entries = await fs.readdir(folder, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records = [];
  for (const entry of entries) {
    const extension = path.extname(entry.name).toLowerCase();
    if (![".yml", ".yaml"].includes(extension)) continue;
    if (!entry.isFile()) {
      throw migrationError(`Record "${name}/${entry.name}" must be a regular file.`);
    }
    const filePath = path.join(folder, entry.name);
    const [source, stat] = await Promise.all([
      fs.readFile(filePath, "utf8"),
      fs.stat(filePath)
    ]);
    records.push({
      filePath,
      stem: path.basename(entry.name, path.extname(entry.name)),
      record: parseYaml(source),
      source,
      mode: stat.mode
    });
  }
  return records;
}

async function buildPlan(projectRoot) {
  const root = path.resolve(projectRoot);
  const configPath = path.join(root, "cms.config.yml");
  const configSource = await fs.readFile(configPath, "utf8");
  const sourceConfig = parseYaml(configSource);
  const { config, identities, mediaFolder, publicFolder } =
    migrateConfig(sourceConfig);
  const storage = sourceConfig.connectors?.default?.name === "api" ? "api" : "github";

  const collections = [];
  const idMaps = new Map();
  for (const [name, collection] of Object.entries(sourceConfig.collections ?? {})) {
    if (isRemoteCollection(collection)) continue;
    const records = await readCollection(root, name, collection);
    const field = identities[name];
    const used = new Set();
    const ids = new Map();
    for (const entry of records) {
      const { record } = entry;
      if (!isMapping(record)) {
        throw migrationError(`${entry.filePath} is not a record mapping.`);
      }
      if (typeof record.filename === "string") {
        // Intermediate contract: opaque id plus a stored filename key.
        if (record.filename !== entry.stem || !ID_PATTERN.test(record.id)) {
          throw migrationError(`${entry.filePath} is partially migrated.`);
        }
        entry.state = "filename";
      } else if (
        ID_PATTERN.test(record.id) &&
        recordIdFromFileStem(entry.stem) === record.id
      ) {
        entry.state = "current";
      }
      if (entry.state) {
        if (used.has(record.id)) {
          throw migrationError(`Collection "${name}" repeats id "${record.id}".`);
        }
        used.add(record.id);
        continue;
      }
      if (record.id !== entry.stem || !SAFE_NAME.test(record.id)) {
        throw migrationError(`${entry.filePath} id must match its filename stem.`);
      }
      const promotedId = field ? record.properties?.[field] : undefined;
      if (field && promotedId !== undefined && !ID_PATTERN.test(promotedId)) {
        throw migrationError(
          `${entry.filePath} ${field} "${promotedId}" is not a generated ID.`
        );
      }
      if (promotedId && used.has(promotedId)) {
        throw migrationError(`Collection "${name}" repeats ${field} "${promotedId}".`);
      }
      entry.nextId = promotedId || null;
      if (entry.nextId) used.add(entry.nextId);
    }
    for (const entry of records) {
      if (entry.state) continue;
      entry.nextId ??= createId(used);
      if (!field) ids.set(entry.record.id, entry.nextId);
    }
    if (ids.size) idMaps.set(name, ids);
    collections.push({ name, collection, field, records });
  }

  const validatedConfig = validateSourceConfig(structuredClone(config), 400);
  const context = { sourceConfig, idMaps, storage, mediaFolder, publicFolder };
  const rewrites = [];
  for (const { name, collection, field, records } of collections) {
    const parentField = collection.hierarchy?.parent_field;
    const ownIds = idMaps.get(name);
    for (const entry of records) {
      const record = structuredClone(entry.record);
      // The readable part of the old name becomes the `<slug>` prefix.
      let readableName;
      if (entry.state === "filename") {
        readableName = record.filename;
        delete record.filename;
      } else if (entry.state === "current") {
        readableName = entry.stem === record.id
          ? ""
          : entry.stem.slice(0, -record.id.length - 1);
      } else {
        if (field) delete record.properties?.[field];
        readableName = record.id;
        record.id = entry.nextId;
      }
      const stem = config.collections[name].slug &&
        readableName &&
        readableName !== record.id
        ? `${readableName}-${record.id}`
        : record.id;
      const targetPath = path.join(
        path.dirname(entry.filePath),
        `${stem}${path.extname(entry.filePath)}`
      );
      migrateNode(record, context);
      if (ownIds) {
        if (parentField && record.properties?.[parentField]) {
          const parent = record.properties[parentField];
          record.properties[parentField] = ownIds.get(parent) ?? parent;
        }
        if (!parentField && typeof record.parent === "string") {
          record.parent = ownIds.get(record.parent) ?? record.parent;
        }
      }
      const output = dumpYaml(record);
      try {
        validateRecord(
          parseYaml(output),
          { name, ...validatedConfig.collections[name] },
          validatedConfig
        );
      } catch (error) {
        throw migrationError(`${entry.filePath}: ${error.message}`);
      }
      if (output !== entry.source || targetPath !== entry.filePath) {
        rewrites.push({
          filePath: entry.filePath,
          targetPath,
          output,
          mode: entry.mode
        });
      }
    }
  }
  const targets = new Set();
  for (const { filePath, targetPath } of rewrites) {
    if (targets.has(targetPath)) {
      throw migrationError(`Two records would be written to ${targetPath}.`);
    }
    targets.add(targetPath);
    if (targetPath !== filePath && (await fs.lstat(targetPath).catch(() => null))) {
      throw migrationError(`${targetPath} already exists.`);
    }
  }
  const configOutput = dumpYaml(config);
  return {
    projectRoot: root,
    configPath,
    configOutput: configOutput !== dumpYaml(sourceConfig) ? configOutput : null,
    rewrites,
    remapped: Object.fromEntries(
      [...idMaps].map(([name, ids]) => [name, Object.fromEntries(ids)])
    )
  };
}

async function executePlan(plan, backupDir) {
  if (!plan.configOutput && !plan.rewrites.length) return { backupRoot: null };
  const backupRoot = path.resolve(backupDir);
  if (isInside(plan.projectRoot, backupRoot)) {
    throw migrationError("The backup directory must be outside the project root.");
  }
  await fs.mkdir(backupRoot, { recursive: false });
  const files = [
    plan.configPath,
    ...plan.rewrites.map(({ filePath }) => filePath)
  ];
  for (const filePath of files) {
    const destination = path.join(
      backupRoot,
      path.relative(plan.projectRoot, filePath)
    );
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(filePath, destination, fsConstants.COPYFILE_EXCL);
  }
  await fs.writeFile(
    path.join(backupRoot, "id-map.json"),
    `${JSON.stringify(plan.remapped, null, 2)}\n`,
    { flag: "wx" }
  );
  for (const { filePath, targetPath, output, mode } of plan.rewrites) {
    await writeAtomic(targetPath, output, mode);
    if (targetPath !== filePath) await fs.unlink(filePath);
  }
  if (plan.configOutput) {
    const { mode } = await fs.stat(plan.configPath);
    await writeAtomic(plan.configPath, plan.configOutput, mode);
  }
  const verified = await buildPlan(plan.projectRoot);
  if (verified.configOutput || verified.rewrites.length) {
    throw migrationError("Post-migration verification did not reach the current state.");
  }
  return { backupRoot };
}

async function writeAtomic(filePath, output, mode) {
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.migration.tmp`
  );
  try {
    await fs.writeFile(temporary, output, { flag: "wx", mode });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function parseArguments(argv) {
  let projectRoot = "";
  let backupDir = "";
  let write = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--project-root") projectRoot = argv[++index] || "";
    else if (argument === "--backup-dir") backupDir = argv[++index] || "";
    else if (argument === "--write") write = true;
    else if (argument === "--check") write = false;
    else throw migrationError(`Unknown argument: ${argument}`);
  }
  if (!projectRoot) throw migrationError("--project-root is required.");
  if (write && !backupDir) {
    throw migrationError("--write requires an absent --backup-dir outside the project root.");
  }
  return { projectRoot, backupDir, write };
}

async function main(argv) {
  const options = parseArguments(argv);
  const plan = await buildPlan(options.projectRoot);
  const pending = Boolean(plan.configOutput || plan.rewrites.length);
  const summary = {
    mode: options.write ? "write" : "check",
    config_changes: Boolean(plan.configOutput),
    records_to_rewrite: plan.rewrites.length,
    remapped_records: Object.values(plan.remapped).reduce(
      (total, ids) => total + Object.keys(ids).length,
      0
    )
  };
  if (options.write) {
    summary.backup = (await executePlan(plan, options.backupDir)).backupRoot;
    summary.status = pending ? "migrated" : "already-current";
  } else {
    summary.status = pending ? "migration-required" : "current";
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

export { buildPlan, executePlan, main, migrateConfig };
