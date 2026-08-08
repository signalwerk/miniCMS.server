import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import {
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
const GITHUB_ACCESS_TOKEN = "github-repo-token-delivered-by-the-auth-worker";
const READ_TOKEN = "machine-read-token-with-at-least-32-characters";

function validEnvironment(overrides = {}) {
  return {
    HOST: "127.0.0.1",
    PORT: "8787",
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

function githubFetch({
  id = 992878,
  login = "SignalWerk",
  status = 200,
  body,
  malformed = false,
  failure
} = {}) {
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });
    assert.equal(url, "https://api.github.com/user");
    assert.equal(
      options.headers.authorization,
      `Bearer ${GITHUB_ACCESS_TOKEN}`
    );
    if (failure) throw failure;
    if (malformed) {
      return new Response("{", {
        status,
        headers: { "content-type": "application/json" }
      });
    }
    return Response.json(
      body ?? {
        id,
        login,
        avatar_url: "https://avatars.example/signalwerk.png"
      },
      { status }
    );
  };
  return { calls, fetchImpl };
}

async function withProductionServer(
  run,
  {
    github: githubOptions = {},
    clock = { value: Date.parse("2026-08-02T12:00:00Z") },
    environment = {}
  } = {}
) {
  const rootDir = await makeFixture();
  const github = githubFetch(githubOptions);
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

function authenticate(baseUrl, token = GITHUB_ACCESS_TOKEN) {
  return fetch(`${baseUrl}/api/auth/github`, {
    method: "POST",
    headers: {
      origin: ADMIN_ORIGIN,
      "content-type": "application/json"
    },
    body: JSON.stringify({ token })
  });
}

test("production configuration needs only service session credentials", () => {
  const environment = validEnvironment();
  delete environment.MINICMS_SESSION_SECRET;
  assert.throws(
    () => productionConfiguration({ environment }),
    /MINICMS_SESSION_SECRET is required/
  );
  assert.throws(
    () =>
      productionConfiguration({
        environment: validEnvironment({ MINICMS_SESSION_SECRET: "too-short" })
      }),
    /at least 32 characters/
  );

  const configuration = productionConfiguration({
    environment: validEnvironment()
  });
  assert.equal(configuration.publicUrl, undefined);
  assert.equal(configuration.githubClientId, undefined);
  assert.equal(configuration.githubClientSecret, undefined);
  assert.equal(configuration.readToken, "");
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
      (
        await fetch(`${baseUrl}/api/config`, {
          headers: { origin: "https://hostile.example" }
        })
      ).status,
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
      label: "Sign in"
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
      const authorization = { authorization: `Bearer ${READ_TOKEN}` };
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
    assert.equal(allowed.headers.get("access-control-allow-origin"), "*");
    assert.equal(allowed.headers.get("access-control-allow-credentials"), null);

    const preflight = await fetch(`${baseUrl}/api/auth/github`, {
      method: "OPTIONS",
      headers: {
        origin: ADMIN_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal(
      preflight.headers.get("access-control-allow-headers"),
      "Authorization, Content-Type, If-Match"
    );
    assert.equal(preflight.headers.get("access-control-expose-headers"), "ETag");

    const secondOrigin = await fetch(`${baseUrl}/api/health`, {
      headers: { origin: SECOND_ADMIN_ORIGIN }
    });
    assert.equal(secondOrigin.status, 200);
    assert.equal(secondOrigin.headers.get("access-control-allow-origin"), "*");
  });
});

test("a verified GitHub token becomes an opaque service session", async () => {
  await withProductionServer(async ({ baseUrl, clock, github }) => {
    const authenticated = await authenticate(baseUrl);
    assert.equal(authenticated.status, 200);
    assert.equal(authenticated.headers.get("cache-control"), "no-store");
    assert.equal(authenticated.headers.get("access-control-allow-origin"), "*");
    const result = await authenticated.json();

    assert.equal(github.calls.length, 1);
    assert.equal(github.calls[0].url, "https://api.github.com/user");
    assert.ok(result.token);
    assert.match(result.token, /^[a-zA-Z0-9_-]{32,256}$/);
    assert.notEqual(result.token, GITHUB_ACCESS_TOKEN);
    assert.deepEqual(result.session, {
      authenticated: true,
      authenticationRequired: true,
      provider: "github",
      label: "SignalWerk",
      login: "SignalWerk",
      avatarUrl: "https://avatars.example/signalwerk.png",
      expiresAt: new Date(clock.value + SESSION_TTL_MS).toISOString()
    });
    assert.doesNotMatch(
      JSON.stringify(result),
      new RegExp(GITHUB_ACCESS_TOKEN)
    );

    const authorization = { authorization: `Bearer ${result.token}` };
    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: authorization
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).login, "SignalWerk");
    const config = await fetch(`${baseUrl}/api/config`, { headers: authorization });
    assert.equal(config.status, 200);
    assert.equal(config.headers.get("cache-control"), "private, no-store");
    assert.equal(github.calls.length, 1, "the GitHub token is not retained or reused");
  });
});

test("both the immutable GitHub ID and login are required", async () => {
  for (const github of [
    { id: 1234567, login: "signalwerk" },
    { id: 992878, login: "another-user" }
  ]) {
    await withProductionServer(
      async ({ baseUrl, github: client }) => {
        const response = await authenticate(baseUrl);
        assert.equal(response.status, 403);
        const source = await response.text();
        assert.doesNotMatch(source, new RegExp(GITHUB_ACCESS_TOKEN));
        assert.doesNotMatch(source, /another-user/);
        assert.equal(client.calls.length, 1);
        const session = await fetch(`${baseUrl}/api/auth/session`).then(
          (result) => result.json()
        );
        assert.equal(session.authenticated, false);
      },
      { github }
    );
  }
});

test("invalid GitHub-token requests are rejected before contacting GitHub", async () => {
  await withProductionServer(async ({ baseUrl, github }) => {
    const requests = [
      fetch(`${baseUrl}/api/auth/github`, { method: "POST" }),
      fetch(`${baseUrl}/api/auth/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      fetch(`${baseUrl}/api/auth/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "too-short" })
      }),
      fetch(`${baseUrl}/api/auth/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: GITHUB_ACCESS_TOKEN, extra: true })
      }),
      fetch(`${baseUrl}/api/auth/github`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      }),
      fetch(`${baseUrl}/api/auth/github`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ token: GITHUB_ACCESS_TOKEN })
      })
    ];
    const responses = await Promise.all(requests);
    for (const response of responses) {
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), new RegExp(GITHUB_ACCESS_TOKEN));
    }

    const oversized = await fetch(`${baseUrl}/api/auth/github`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(9 * 1024) })
    });
    assert.equal(oversized.status, 413);
    assert.doesNotMatch(await oversized.text(), /x{100}/);
    assert.equal(github.calls.length, 0);
  });
});

test("GitHub lookup failures never establish or echo a session", async () => {
  const failures = [
    [{ status: 401 }, 401],
    [{ status: 403 }, 401],
    [{ status: 500 }, 502],
    [{ malformed: true }, 502],
    [{ body: { id: "992878", login: "signalwerk" } }, 502],
    [{ failure: new Error("network failure") }, 502]
  ];

  for (const [github, expectedStatus] of failures) {
    await withProductionServer(
      async ({ baseUrl, github: client }) => {
        const response = await authenticate(baseUrl);
        assert.equal(response.status, expectedStatus);
        const source = await response.text();
        assert.doesNotMatch(source, new RegExp(GITHUB_ACCESS_TOKEN));
        assert.equal(client.calls.length, 1);
        const session = await fetch(`${baseUrl}/api/auth/session`).then(
          (result) => result.json()
        );
        assert.equal(session.authenticated, false);
      },
      { github }
    );
  }
});

test("the removed service-local OAuth routes have no handlers", async () => {
  await withProductionServer(async ({ baseUrl, github }) => {
    const requests = [
      fetch(`${baseUrl}/api/auth/github/start`, { redirect: "manual" }),
      fetch(`${baseUrl}/api/auth/github/callback?code=unused`),
      fetch(`${baseUrl}/api/auth/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ];
    for (const response of await Promise.all(requests)) {
      assert.equal([401, 404].includes(response.status), true);
      assert.equal(response.headers.get("location"), null);
    }
    assert.equal(github.calls.length, 0);
  });
});

test("opaque sessions expire and logout revokes them", async () => {
  const clock = { value: Date.parse("2026-08-02T12:00:00Z") };
  await withProductionServer(
    async ({ baseUrl }) => {
      const first = await authenticate(baseUrl).then((response) => response.json());
      const firstAuthorization = {
        authorization: `Bearer ${first.token}`
      };
      const logout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: firstAuthorization
      });
      assert.equal(logout.status, 204);
      assert.equal(
        (
          await fetch(`${baseUrl}/api/config`, {
            headers: firstAuthorization
          })
        ).status,
        401
      );

      const second = await authenticate(baseUrl).then((response) => response.json());
      assert.notEqual(second.token, first.token);
      clock.value += SESSION_TTL_MS + 1;
      assert.equal(
        (
          await fetch(`${baseUrl}/api/config`, {
            headers: { authorization: `Bearer ${second.token}` }
          })
        ).status,
        401
      );
    },
    { clock }
  );
});
