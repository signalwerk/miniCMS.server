import path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const GITHUB_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;

function configurationError(message) {
  const error = new Error(message);
  error.code = "MINICMS_CONFIGURATION_ERROR";
  return error;
}

function requiredEnvironmentValue(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || !value.trim()) {
    throw configurationError(`${name} is required.`);
  }
  return value.trim();
}

function parsePort(value = "8787") {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw configurationError("PORT must be an integer from 1 through 65535.");
  }
  return port;
}

function parseOrigin(value, name, { httpsOnly = false } = {}) {
  if (value.includes("*")) {
    throw configurationError(`${name} must not contain a wildcard.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(`${name} must be a valid absolute origin.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw configurationError(`${name} must use HTTP or HTTPS.`);
  }
  if (httpsOnly && url.protocol !== "https:") {
    throw configurationError(`${name} must use HTTPS.`);
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin !== value
  ) {
    throw configurationError(`${name} must be an exact origin without a path.`);
  }
  return url.origin;
}

function parseAdminOrigins(value) {
  const parts = value.split(",").map((entry) => entry.trim());
  if (!parts.length || parts.some((entry) => !entry)) {
    throw configurationError(
      "MINICMS_ADMIN_ORIGINS must contain exact comma-separated origins."
    );
  }
  const origins = parts.map((entry, index) =>
    parseOrigin(entry, `MINICMS_ADMIN_ORIGINS entry ${index + 1}`, {
      httpsOnly: true
    })
  );
  return Object.freeze([...new Set(origins)]);
}

function commonConfiguration(environment, projectRoot) {
  return {
    rootDir: path.resolve(
      projectRoot || environment.MINICMS_PROJECT_ROOT || process.cwd()
    ),
    host: environment.HOST || "127.0.0.1",
    port: parsePort(environment.PORT)
  };
}

function developmentConfiguration({
  environment = process.env,
  projectRoot
} = {}) {
  const configuration = commonConfiguration(environment, projectRoot);
  if (!LOOPBACK_HOSTS.has(configuration.host)) {
    throw configurationError(
      "The unauthenticated development API may listen only on loopback addresses: 127.0.0.1, ::1, or localhost."
    );
  }
  return Object.freeze(configuration);
}

function productionConfiguration({
  environment = process.env,
  projectRoot
} = {}) {
  const configuration = commonConfiguration(environment, projectRoot);
  const publicUrl = parseOrigin(
    requiredEnvironmentValue(environment, "MINICMS_PUBLIC_URL"),
    "MINICMS_PUBLIC_URL",
    { httpsOnly: true }
  );
  const adminOrigins = parseAdminOrigins(
    requiredEnvironmentValue(environment, "MINICMS_ADMIN_ORIGINS")
  );
  const githubClientId = requiredEnvironmentValue(
    environment,
    "MINICMS_GITHUB_CLIENT_ID"
  );
  const githubClientSecret = requiredEnvironmentValue(
    environment,
    "MINICMS_GITHUB_CLIENT_SECRET"
  );
  const allowedLogin = requiredEnvironmentValue(
    environment,
    "MINICMS_GITHUB_ALLOWED_LOGIN"
  );
  if (!GITHUB_LOGIN_PATTERN.test(allowedLogin)) {
    throw configurationError(
      "MINICMS_GITHUB_ALLOWED_LOGIN must contain exactly one valid GitHub login."
    );
  }
  const sessionSecret = requiredEnvironmentValue(
    environment,
    "MINICMS_SESSION_SECRET"
  );
  if (sessionSecret.length < 32) {
    throw configurationError(
      "MINICMS_SESSION_SECRET must contain at least 32 characters."
    );
  }

  return Object.freeze({
    ...configuration,
    publicUrl,
    adminOrigins,
    githubClientId,
    githubClientSecret,
    allowedLogin,
    sessionSecret
  });
}

function readProjectRootOption(arguments_) {
  const args = [...arguments_];
  let projectRoot = null;
  const optionIndex = args.indexOf("--project-root");
  if (optionIndex >= 0) {
    const value = args[optionIndex + 1];
    if (!value || value.startsWith("--")) {
      throw configurationError("--project-root requires a path.");
    }
    projectRoot = value;
    args.splice(optionIndex, 2);
  }
  if (args.length) {
    throw configurationError(
      `Unknown argument${args.length === 1 ? "" : "s"}: ${args.join(" ")}`
    );
  }
  return projectRoot;
}

export {
  developmentConfiguration,
  parseOrigin,
  productionConfiguration,
  readProjectRootOption
};
