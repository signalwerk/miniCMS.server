#!/usr/bin/env node

import { access } from "node:fs/promises";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import {
  createDevelopmentAuthentication,
  createProductionAuthentication
} from "../src/auth.mjs";
import {
  developmentConfiguration,
  productionConfiguration,
  readProjectRootOption
} from "../src/config.mjs";

const [command, ...args] = process.argv.slice(2);

async function assertProject(rootDir) {
  try {
    await access(path.join(rootDir, "cms.config.yml"));
  } catch {
    throw new Error(
      `No cms.config.yml found in ${rootDir}. Run miniCMS API from the content project's root or pass --project-root.`
    );
  }
}

function listen(app, port, host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}

async function serve(configuration, authentication) {
  await assertProject(configuration.rootDir);
  const server = await listen(
    createApp({
      rootDir: configuration.rootDir,
      authentication
    }),
    configuration.port,
    configuration.host
  );
  console.log(
    `miniCMS API listening on http://${configuration.host}:${configuration.port}`
  );

  const close = () => new Promise((resolve) => server.close(resolve));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, async () => {
      await close();
      process.exit(0);
    });
  }
}

async function main() {
  const projectRoot = readProjectRootOption(args);
  if (command === "dev") {
    const configuration = developmentConfiguration({ projectRoot });
    await serve(configuration, createDevelopmentAuthentication());
    return;
  }
  if (command === "start") {
    const configuration = productionConfiguration({ projectRoot });
    await serve(
      configuration,
      createProductionAuthentication(configuration)
    );
    return;
  }

  console.log(`miniCMS API

Usage:
  minicms-api dev [--project-root <path>]
  minicms-api start [--project-root <path>]

Development is unauthenticated and loopback-only. Production start always
requires the GitHub OAuth and session environment documented in README.md.`);
  if (command) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
