import {
  createHmac,
  randomBytes as cryptographicRandomBytes,
  timingSafeEqual
} from "node:crypto";
import express from "express";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_GITHUB_ID = 992878;
const ALLOWED_GITHUB_LOGIN = "signalwerk";
const GITHUB_TOKEN_PATTERN = /^[a-zA-Z0-9._~+\/-]{20,512}={0,2}$/;
const BEARER_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function setAuthSecurityHeaders(response) {
  response.set({
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY"
  });
}

function authSecurityHeaders(_request, response, next) {
  setAuthSecurityHeaders(response);
  next();
}

function loopbackOrigin(value) {
  let origin;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }
  const host = origin.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const ipv4 = host.split(".").map(Number);
  return (
    ["http:", "https:"].includes(origin.protocol) &&
    !origin.username &&
    !origin.password &&
    (host === "localhost" ||
      host === "::1" ||
      (ipv4.length === 4 &&
        ipv4[0] === 127 &&
        ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)))
  );
}

function developmentCors(request, response, next) {
  const origin = request.get("origin");
  if (origin && !loopbackOrigin(origin)) {
    response.status(403).json({ message: "This development origin is not allowed." });
    return;
  }
  if (origin) {
    response.set({
      "access-control-allow-origin": origin,
      vary: "Origin"
    });
  }
  if (request.method === "OPTIONS") {
    response.set({
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods": "DELETE, GET, HEAD, OPTIONS, POST, PUT"
    });
    response.status(204).end();
    return;
  }
  next();
}

function createDevelopmentAuthentication() {
  const router = express.Router();
  router.use(authSecurityHeaders);
  router.get("/session", (_request, response) => {
    response.json({
      authenticated: true,
      authenticationRequired: false,
      provider: "local",
      label: "Local"
    });
  });

  return Object.freeze({
    mode: "development",
    cors: developmentCors,
    router,
    requireSession: (_request, _response, next) => next()
  });
}

function createProductionAuthentication(
  { sessionSecret, readToken = "" },
  {
    fetchImpl = fetch,
    now = Date.now,
    randomBytes = cryptographicRandomBytes
  } = {}
) {
  const sessions = new Map();

  function randomToken(size = 32) {
    return base64Url(randomBytes(size));
  }

  function privateHash(kind, value) {
    return createHmac("sha256", sessionSecret)
      .update(`${kind}:${value}`)
      .digest("base64url");
  }

  function privateDigest(kind, value) {
    return createHmac("sha256", sessionSecret)
      .update(`${kind}:${value}`)
      .digest();
  }

  const readTokenDigest = readToken
    ? privateDigest("read-token", readToken)
    : null;

  function matchesReadToken(value) {
    return Boolean(
      readTokenDigest &&
        timingSafeEqual(privateDigest("read-token", value), readTokenDigest)
    );
  }

  function permitsMachineRead(request) {
    if (!["GET", "HEAD"].includes(request.method)) return false;
    const segments = request.path.split("/").filter(Boolean);
    return (
      (segments.length === 1 && segments[0] === "config") ||
      (segments[0] === "collections" &&
        segments.length >= 1 &&
        segments.length <= 3)
    );
  }

  function pruneExpired() {
    const currentTime = now();
    for (const [key, session] of sessions) {
      if (session.expiresAt <= currentTime) sessions.delete(key);
    }
  }

  function cors(request, response, next) {
    if (request.path.startsWith("/auth/")) {
      setAuthSecurityHeaders(response);
    }
    response.set({
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "Authorization, Content-Type",
      "access-control-allow-methods":
        "DELETE, GET, HEAD, OPTIONS, POST, PUT",
      "access-control-max-age": "600"
    });
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  }

  function bearerFromRequest(request) {
    const authorization = request.get("authorization");
    if (!authorization) return null;
    const match = /^Bearer ([^\s]+)$/.exec(authorization);
    if (!match) {
      throw httpError(401, "The miniCMS API session is invalid.");
    }
    return match[1];
  }

  function sessionForRequest(request, { required = true } = {}) {
    pruneExpired();
    const bearer = bearerFromRequest(request);
    if (!bearer) {
      if (required) throw httpError(401, "Authentication is required.");
      return null;
    }
    if (!BEARER_PATTERN.test(bearer)) {
      throw httpError(401, "The miniCMS API session is invalid.");
    }
    const hash = privateHash("session", bearer);
    const session = sessions.get(hash);
    if (!session) {
      throw httpError(401, "The miniCMS API session is invalid or expired.");
    }
    return { hash, session };
  }

  function requireSession(request, response, next) {
    response.set("cache-control", "private, no-store");
    try {
      const bearer = bearerFromRequest(request);
      if (bearer && matchesReadToken(bearer)) {
        if (!permitsMachineRead(request)) {
          throw httpError(403, "The miniCMS API read token cannot modify content.");
        }
        request.miniCmsMachineRead = true;
        next();
        return;
      }
      const authenticated = sessionForRequest(request);
      request.miniCmsSession = authenticated.session;
      request.miniCmsSessionHash = authenticated.hash;
      next();
    } catch (error) {
      next(error);
    }
  }

  async function githubProfile(githubToken) {
    let response;
    try {
      response = await fetchImpl(GITHUB_USER_URL, {
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${githubToken}`,
          "user-agent": "minicms-api",
          "x-github-api-version": GITHUB_API_VERSION
        }
      });
    } catch {
      throw httpError(502, "GitHub authentication failed.");
    }
    const user = await response.json().catch(() => null);
    if (!response.ok) {
      throw httpError(
        [401, 403].includes(response.status) ? 401 : 502,
        "GitHub authentication failed."
      );
    }
    if (!user || typeof user.id !== "number" || typeof user.login !== "string") {
      throw httpError(502, "GitHub authentication failed.");
    }
    if (
      user.id !== ALLOWED_GITHUB_ID ||
      user.login.toLowerCase() !== ALLOWED_GITHUB_LOGIN
    ) {
      throw httpError(403, "This GitHub account is not allowed.");
    }
    return {
      login: user.login,
      avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null
    };
  }

  function issueSession(profile) {
    const token = randomToken();
    const expiresAt = now() + SESSION_TTL_MS;
    sessions.set(privateHash("session", token), { profile, expiresAt });
    return {
      token,
      session: {
        authenticated: true,
        authenticationRequired: true,
        provider: "github",
        label: profile.login,
        login: profile.login,
        avatarUrl: profile.avatarUrl,
        expiresAt: new Date(expiresAt).toISOString()
      }
    };
  }

  const router = express.Router();
  router.use(authSecurityHeaders);

  router.get("/session", (request, response, next) => {
    try {
      const authenticated = sessionForRequest(request, { required: false });
      if (!authenticated) {
        response.json({
          authenticated: false,
          authenticationRequired: true,
          provider: "github",
          label: "Sign in"
        });
        return;
      }
      response.json({
        authenticated: true,
        authenticationRequired: true,
        provider: "github",
        label: authenticated.session.profile.login,
        login: authenticated.session.profile.login,
        avatarUrl: authenticated.session.profile.avatarUrl,
        expiresAt: new Date(authenticated.session.expiresAt).toISOString()
      });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/github",
    express.json({ type: "application/json", limit: "8kb" }),
    async (request, response, next) => {
      try {
        const body = request.body;
        if (
          !body ||
          Array.isArray(body) ||
          typeof body !== "object" ||
          Object.keys(body).length !== 1 ||
          typeof body.token !== "string" ||
          !GITHUB_TOKEN_PATTERN.test(body.token)
        ) {
          throw httpError(400, "A valid GitHub token is required.");
        }
        const profile = await githubProfile(body.token);
        response.json(issueSession(profile));
      } catch (error) {
        next(error);
      }
    }
  );

  router.post("/logout", requireSession, (request, response) => {
    sessions.delete(request.miniCmsSessionHash);
    response.status(204).end();
  });

  return Object.freeze({
    mode: "production",
    cors,
    router,
    requireSession
  });
}

export {
  SESSION_TTL_MS,
  createDevelopmentAuthentication,
  createProductionAuthentication
};
