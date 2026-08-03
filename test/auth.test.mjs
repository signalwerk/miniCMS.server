import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import {
  EXCHANGE_CODE_TTL_MS,
  SESSION_TTL_MS,
  createDevelopmentAuthentication,
  createProductionAuthentication
} from "../src/auth.mjs";
import {
  developmentConfiguration,
  productionConfiguration
} from "../src/config.mjs";

const ADMIN_ORIGIN = "https://admin.example";
const SECOND_ADMIN_ORIGIN = "https://another-admin.example:8443";
const PUBLIC_URL = "https://api.example";
const GITHUB_ACCESS_TOKEN = "github-access-token-that-must-stay-server-side";
const READ_TOKEN = "machine-read-token-with-at-least-32-characters";

function validEnvironment(overrides = {}) {
  return {
    HOST: "127.0.0.1",
    PORT: "8787",
    MINICMS_PUBLIC_URL: PUBLIC_URL,
    MINICMS_GITHUB_CLIENT_ID: "github-client-id",
    MINICMS_GITHUB_CLIENT_SECRET: "github-client-secret",
    MINICMS_SESSION_SECRET: "a-test-session-secret-with-at-least-32-characters",
    ...overrides
  };
}

async function makeFixture() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "minicms-api-auth-"));
  await fs.mkdir(path.join(rootDir, "content", "pages"), { recursive: true });
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
      title: { widget: string }
collections:
  pages:
    folder: content/pages
    extension: yml
    node_type: page
    allowed_types: [page]
  empty:
    folder: content/empty
    extension: yml
    node_type: page
    allowed_types: [page]
`,
    "utf8"
  );
  await fs.writeFile(
    path.join(rootDir, "content", "pages", "home.yml"),
    `id: home
type: page
order: 0
properties:
  title: Home
slots: {}
`,
    "utf8"
  );
  return rootDir;
}

function deterministicRandomBytes() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Buffer.alloc(size, counter % 256);
  };
}

function githubFetch({ login = "SignalWerk" } = {}) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: GITHUB_ACCESS_TOKEN });
    }
    if (url === "https://api.github.com/user") {
      assert.equal(
        options.headers.authorization,
        `Bearer ${GITHUB_ACCESS_TOKEN}`
      );
      return Response.json({
        login,
        avatar_url: "https://avatars.example/signalwerk.png"
      });
    }
    throw new Error(`Unexpected GitHub request: ${url}`);
  };
  return { calls, fetchImpl };
}

async function withProductionServer(
  run,
  {
    login = "SignalWerk",
    clock = { value: Date.parse("2026-08-02T12:00:00Z") },
    environment = {}
  } = {}
) {
  const rootDir = await makeFixture();
  const github = githubFetch({ login });
  const configuration = productionConfiguration({
    environment: validEnvironment(environment),
    projectRoot: rootDir
  });
  const authentication = createProductionAuthentication(configuration, {
    fetchImpl: github.fetchImpl,
    now: () => clock.value,
    randomBytes: deterministicRandomBytes()
  });
  const server = createApp({ rootDir, authentication }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run({ baseUrl, clock, github, rootDir });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

async function beginAuthentication(baseUrl, nonce, origin = ADMIN_ORIGIN) {
  const url = new URL("/api/auth/github/start", baseUrl);
  url.searchParams.set("origin", origin);
  url.searchParams.set("nonce", nonce);
  const response = await fetch(url, {
    redirect: "manual",
    headers: { origin }
  });
  assert.equal(response.status, 302);
  const authorizationUrl = new URL(response.headers.get("location"));
  assert.equal(authorizationUrl.origin, "https://github.com");
  assert.equal(authorizationUrl.pathname, "/login/oauth/authorize");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "github-client-id");
  assert.equal(
    authorizationUrl.searchParams.get("redirect_uri"),
    `${PUBLIC_URL}/api/auth/github/callback`
  );
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorizationUrl.searchParams.get("scope"), null);
  return authorizationUrl;
}

function callbackPayload(html) {
  const match = html.match(/const payload = (\{[^;]+\});/);
  assert.ok(match, "callback HTML contains a postMessage payload");
  return JSON.parse(match[1]);
}

async function completeCallback(baseUrl, state, code = "github-code") {
  const callback = new URL("/api/auth/github/callback", baseUrl);
  callback.searchParams.set("state", state);
  callback.searchParams.set("code", code);
  return fetch(callback);
}

async function exchange(baseUrl, payload, origin = ADMIN_ORIGIN) {
  return fetch(`${baseUrl}/api/auth/exchange`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      code: payload.code,
      nonce: payload.nonce,
      origin
    })
  });
}

test("production configuration fails closed and development refuses a public host", () => {
  const required = [
    "MINICMS_PUBLIC_URL",
    "MINICMS_GITHUB_CLIENT_ID",
    "MINICMS_GITHUB_CLIENT_SECRET",
    "MINICMS_SESSION_SECRET"
  ];
  for (const name of required) {
    const environment = validEnvironment();
    delete environment[name];
    assert.throws(
      () => productionConfiguration({ environment }),
      new RegExp(`${name} is required`)
    );
  }

  assert.throws(
    () =>
      productionConfiguration({
        environment: validEnvironment({ MINICMS_PUBLIC_URL: "http://api.example" })
      }),
    /must use HTTPS/
  );
  assert.throws(
    () =>
      productionConfiguration({
        environment: validEnvironment({ MINICMS_SESSION_SECRET: "too-short" })
      }),
    /at least 32 characters/
  );
  assert.equal(
    productionConfiguration({ environment: validEnvironment() }).readToken,
    ""
  );
  assert.equal(
    productionConfiguration({
      environment: validEnvironment({ MINICMS_READ_TOKEN: READ_TOKEN })
    }).readToken,
    READ_TOKEN
  );
  assert.throws(
    () =>
      productionConfiguration({
        environment: validEnvironment({ MINICMS_READ_TOKEN: "too-short" })
      }),
    /MINICMS_READ_TOKEN.*at least 32 characters/
  );
  assert.throws(
    () =>
      productionConfiguration({
        environment: validEnvironment({
          MINICMS_READ_TOKEN:
            "machine-read-token-with-internal whitespace-characters"
        })
      }),
    /MINICMS_READ_TOKEN.*whitespace/
  );
  assert.throws(
    () => developmentConfiguration({ environment: { HOST: "0.0.0.0" } }),
    /loopback/
  );
  assert.equal(
    developmentConfiguration({
      environment: { MINICMS_READ_TOKEN: READ_TOKEN }
    }).readToken,
    undefined
  );
});

test("development session stays locally authenticated without a login", async () => {
  const rootDir = await makeFixture();
  const server = createApp({
    rootDir,
    authentication: createDevelopmentAuthentication()
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const session = await fetch(`${baseUrl}/api/auth/session`).then((response) =>
      response.json()
    );
    assert.deepEqual(session, {
      authenticated: true,
      authenticationRequired: false,
      provider: "local",
      label: "Local"
    });
    assert.equal((await fetch(`${baseUrl}/api/config`)).status, 200);
    const loopback = await fetch(`${baseUrl}/api/config`, {
      headers: { origin: "http://localhost:4321" }
    });
    assert.equal(loopback.status, 200);
    assert.equal(
      loopback.headers.get("access-control-allow-origin"),
      "http://localhost:4321"
    );
    assert.equal(
      (await fetch(`${baseUrl}/api/config`, {
        headers: { origin: "https://hostile.example" }
      })).status,
      403
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("anonymous production requests cannot read or mutate content", async () => {
  await withProductionServer(async ({ baseUrl, rootDir }) => {
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/ready`)).status, 200);

    const session = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(session.status, 200);
    assert.deepEqual(await session.json(), {
      authenticated: false,
      authenticationRequired: true,
      provider: "github",
      label: "Sign in",
      startUrl: "/api/auth/github/start"
    });

    assert.equal((await fetch(`${baseUrl}/api/config`)).status, 401);
    const sourceBefore = await fs.readFile(
      path.join(rootDir, "cms.config.yml"),
      "utf8"
    );
    const rejectedWrite = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ collections: {}, node_types: {} })
    });
    assert.equal(rejectedWrite.status, 401);
    assert.equal(
      await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
      sourceBefore
    );
  });
});

test("the production machine token can only read config and records", async () => {
  await withProductionServer(
    async ({ baseUrl, rootDir }) => {
      const authorization = {
        authorization: `Bearer ${READ_TOKEN}`
      };
      const readablePaths = [
        "/api/config",
        "/api/collections",
        "/api/collections/pages",
        "/api/collections/empty",
        "/api/collections/pages/home"
      ];
      for (const pathname of readablePaths) {
        const response = await fetch(`${baseUrl}${pathname}`, {
          headers: authorization
        });
        assert.equal(response.status, 200, pathname);
        assert.equal(response.headers.get("cache-control"), "private, no-store");
      }
      await assert.rejects(
        fs.access(path.join(rootDir, "content", "empty")),
        (error) => error.code === "ENOENT"
      );

      const head = await fetch(`${baseUrl}/api/collections/pages/home`, {
        method: "HEAD",
        headers: authorization
      });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");

      const configBefore = await fs.readFile(
        path.join(rootDir, "cms.config.yml"),
        "utf8"
      );
      const forbiddenRequests = [
        ["POST", "/api/auth/logout"],
        ["PUT", "/api/config"],
        ["POST", "/api/collections/pages"],
        ["PUT", "/api/collections/pages/home"],
        ["DELETE", "/api/collections/pages/home"],
        ["POST", "/api/collections/pages/home/rename"],
        ["POST", "/api/media/pages?filename=blocked.png"]
      ];
      for (const [method, pathname] of forbiddenRequests) {
        const response = await fetch(`${baseUrl}${pathname}`, {
          method,
          headers: {
            ...authorization,
            "content-type": "application/json"
          },
          body: method === "DELETE" ? undefined : "{}"
        });
        assert.equal(response.status, 403, `${method} ${pathname}`);
      }
      assert.equal(
        await fs.readFile(path.join(rootDir, "cms.config.yml"), "utf8"),
        configBefore
      );

      assert.equal(
        (
          await fetch(`${baseUrl}/api/config`, {
            headers: { authorization: `Bearer ${READ_TOKEN}-wrong` }
          })
        ).status,
        401
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/auth/session`, {
            headers: authorization
          })
        ).status,
        401
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/collections/pages/home/rename`, {
            headers: authorization
          })
        ).status,
        403
      );
    },
    { environment: { MINICMS_READ_TOKEN: READ_TOKEN } }
  );
});

test("production CORS permits every origin without credential cookies", async () => {
  await withProductionServer(async ({ baseUrl }) => {
    const allowed = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: ADMIN_ORIGIN }
    });
    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "*"
    );
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);

    const preflight = await fetch(`${baseUrl}/api/config`, {
      method: "OPTIONS",
      headers: {
        origin: ADMIN_ORIGIN,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "authorization,content-type"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-headers"),
      "Authorization, Content-Type"
    );

    const secondOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: SECOND_ADMIN_ORIGIN }
    });
    assert.equal(secondOrigin.status, 200);
    assert.equal(
      secondOrigin.headers.get("access-control-allow-origin"),
      "*"
    );
  });
});

test("OAuth accepts every valid browser origin and rejects malformed targets", async () => {
  await withProductionServer(async ({ baseUrl }) => {
    const authorizationUrl = await beginAuthentication(
      baseUrl,
      "second_origin_nonce_123456",
      SECOND_ADMIN_ORIGIN
    );
    const callback = await completeCallback(
      baseUrl,
      authorizationUrl.searchParams.get("state")
    );
    assert.equal(callback.status, 200);
    const callbackSource = await callback.text();
    assert.match(callbackSource, /https:\/\/another-admin\.example:8443/);

    for (const origin of [
      "not-an-origin",
      "https://admin.example/path",
      "file:///tmp/admin.html"
    ]) {
      const start = new URL("/api/auth/github/start", baseUrl);
      start.searchParams.set("origin", origin);
      start.searchParams.set("nonce", "invalid_origin_nonce_1234");
      const response = await fetch(start, {
        redirect: "manual",
        headers: { origin: SECOND_ADMIN_ORIGIN }
      });
      assert.equal(response.status, 400);
    }
  });
});

test("a valid OAuth state reports provider cancellation to its bound opener", async () => {
  await withProductionServer(async ({ baseUrl, github }) => {
    const nonce = "cancel_nonce_1234567890";
    const authorizationUrl = await beginAuthentication(baseUrl, nonce);
    const callback = new URL("/api/auth/github/callback", baseUrl);
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state"));
    callback.searchParams.set("error", "access_denied");
    const response = await fetch(callback);
    assert.equal(response.status, 400);
    const source = await response.text();
    const payload = callbackPayload(source);
    assert.deepEqual(payload, {
      type: "minicms:api-auth",
      nonce,
      status: "error",
      message: "GitHub authentication was not completed."
    });
    assert.match(source, /https:\/\/admin\.example/);
    assert.equal(github.calls.length, 0);
  });
});

test("signalwerk gets an origin-bound one-time bearer session", async () => {
  await withProductionServer(async ({ baseUrl, github }) => {
    const nonce = "client_nonce_1234567890";
    const authorizationUrl = await beginAuthentication(baseUrl, nonce);
    const state = authorizationUrl.searchParams.get("state");
    const challenge = authorizationUrl.searchParams.get("code_challenge");

    const callback = await completeCallback(baseUrl, state);
    assert.equal(callback.status, 200);
    assert.equal(callback.headers.get("cache-control"), "no-store");
    assert.equal(callback.headers.get("x-content-type-options"), "nosniff");
    assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
    assert.match(callback.headers.get("content-security-policy"), /script-src 'nonce-/);
    const callbackSource = await callback.text();
    const payload = callbackPayload(callbackSource);
    assert.deepEqual(
      {
        type: payload.type,
        status: payload.status,
        nonce: payload.nonce
      },
      {
        type: "minicms:api-auth",
        status: "success",
        nonce
      }
    );
    assert.ok(payload.code);
    assert.doesNotMatch(callbackSource, new RegExp(GITHUB_ACCESS_TOKEN));
    assert.doesNotMatch(callbackSource, /github-client-secret/);

    const tokenCall = github.calls.find((call) =>
      call.url.endsWith("/login/oauth/access_token")
    );
    const tokenBody = new URLSearchParams(tokenCall.options.body);
    const verifier = tokenBody.get("code_verifier");
    assert.equal(
      createHash("sha256").update(verifier).digest("base64url"),
      challenge
    );

    const replayedState = await completeCallback(baseUrl, state);
    assert.equal(replayedState.status, 400);

    const exchanged = await exchange(baseUrl, payload);
    assert.equal(exchanged.status, 200);
    const exchangeResult = await exchanged.json();
    assert.ok(exchangeResult.token);
    assert.notEqual(exchangeResult.token, GITHUB_ACCESS_TOKEN);
    assert.equal(exchangeResult.session.login, "SignalWerk");
    assert.equal(exchangeResult.session.authenticationRequired, true);
    assert.doesNotMatch(JSON.stringify(exchangeResult), new RegExp(GITHUB_ACCESS_TOKEN));

    const replayedCode = await exchange(baseUrl, payload);
    assert.equal(replayedCode.status, 400);

    const authorization = { authorization: `Bearer ${exchangeResult.token}` };
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: authorization
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).login, "SignalWerk");
    const config = await fetch(`${baseUrl}/api/config`, { headers: authorization });
    assert.equal(config.status, 200);
    assert.equal(config.headers.get("cache-control"), "private, no-store");

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: authorization
    });
    assert.equal(logout.status, 204);
    assert.equal(
      (await fetch(`${baseUrl}/api/config`, { headers: authorization })).status,
      401
    );
  });
});

test("a different GitHub user is denied without an exchange code", async () => {
  await withProductionServer(
    async ({ baseUrl }) => {
      const authorizationUrl = await beginAuthentication(
        baseUrl,
        "denied_nonce_1234567890"
      );
      const callback = await completeCallback(
        baseUrl,
        authorizationUrl.searchParams.get("state")
      );
      assert.equal(callback.status, 403);
      const source = await callback.text();
      const payload = callbackPayload(source);
      assert.equal(payload.status, "error");
      assert.equal(payload.code, undefined);
      assert.doesNotMatch(source, new RegExp(GITHUB_ACCESS_TOKEN));
      assert.doesNotMatch(source, /another-user/i);
    },
    { login: "another-user" }
  );
});

test("exchange codes and bearer sessions expire at their configured TTL", async () => {
  const clock = { value: Date.parse("2026-08-02T12:00:00Z") };
  await withProductionServer(
    async ({ baseUrl }) => {
      const first = await beginAuthentication(baseUrl, "expiry_nonce_1234567890");
      const firstCallback = await completeCallback(
        baseUrl,
        first.searchParams.get("state")
      );
      const firstPayload = callbackPayload(await firstCallback.text());
      clock.value += EXCHANGE_CODE_TTL_MS + 1;
      assert.equal((await exchange(baseUrl, firstPayload)).status, 400);

      const second = await beginAuthentication(baseUrl, "session_nonce_123456789");
      const secondCallback = await completeCallback(
        baseUrl,
        second.searchParams.get("state")
      );
      const secondPayload = callbackPayload(await secondCallback.text());
      const exchanged = await exchange(baseUrl, secondPayload);
      assert.equal(exchanged.status, 200);
      const { token } = await exchanged.json();
      clock.value += SESSION_TTL_MS + 1;
      assert.equal(
        (
          await fetch(`${baseUrl}/api/config`, {
            headers: { authorization: `Bearer ${token}` }
          })
        ).status,
        401
      );
    },
    { clock }
  );
});
