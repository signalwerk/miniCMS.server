import {
  createHash,
  createHmac,
  randomBytes as cryptographicRandomBytes
} from "node:crypto";
import express from "express";

const AUTH_MESSAGE_TYPE = "minicms:api-auth";
const STATE_TTL_MS = 10 * 60 * 1000;
const EXCHANGE_CODE_TTL_MS = 60 * 1000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_API_VERSION = "2022-11-28";
const ALLOWED_GITHUB_LOGIN = "signalwerk";
const NONCE_PATTERN = /^[a-zA-Z0-9_-]{16,256}$/;
const BEARER_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/;
const MAX_PENDING_STATES = 512;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function callbackHtml({ payload, targetOrigin, nonce }) {
  const serializedPayload = JSON.stringify(payload).replace(/</g, "\\u003c");
  const serializedOrigin = JSON.stringify(targetOrigin).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>miniCMS authentication</title>
  </head>
  <body>
    <p>Authentication complete. You can close this window.</p>
    <script nonce="${nonce}">
      const payload = ${serializedPayload};
      if (window.opener) window.opener.postMessage(payload, ${serializedOrigin});
      window.close();
    </script>
  </body>
</html>`;
}

function staticErrorHtml(message) {
  const safeMessage = String(message)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>miniCMS authentication failed</title>
  </head>
  <body><p>${safeMessage}</p></body>
</html>`;
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

function browserOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    value === url.origin
  );
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
  {
    publicUrl,
    githubClientId,
    githubClientSecret,
    sessionSecret
  },
  {
    fetchImpl = fetch,
    now = Date.now,
    randomBytes = cryptographicRandomBytes
  } = {}
) {
  const pendingStates = new Map();
  const exchangeCodes = new Map();
  const sessions = new Map();
  const callbackUrl = `${publicUrl}/api/auth/github/callback`;

  function randomToken(size = 32) {
    return base64Url(randomBytes(size));
  }

  function privateHash(kind, value) {
    return createHmac("sha256", sessionSecret)
      .update(`${kind}:${value}`)
      .digest("base64url");
  }

  function pruneExpired() {
    const currentTime = now();
    for (const [key, state] of pendingStates) {
      if (state.expiresAt <= currentTime) pendingStates.delete(key);
    }
    for (const [key, code] of exchangeCodes) {
      if (code.expiresAt <= currentTime) exchangeCodes.delete(key);
    }
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
    if (!match || !BEARER_PATTERN.test(match[1])) {
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
      const authenticated = sessionForRequest(request);
      request.miniCmsSession = authenticated.session;
      request.miniCmsSessionHash = authenticated.hash;
      next();
    } catch (error) {
      next(error);
    }
  }

  function sendCallback(response, state, payload, status = 200) {
    const cspNonce = randomToken(18);
    response.set(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${cspNonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    );
    response
      .status(status)
      .type("html")
      .send(
        callbackHtml({
          payload: {
            type: AUTH_MESSAGE_TYPE,
            nonce: state.nonce,
            ...payload
          },
          targetOrigin: state.origin,
          nonce: cspNonce
        })
      );
  }

  async function githubIdentity(code, verifier) {
    const tokenResponse = await fetchImpl(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: githubClientId,
        client_secret: githubClientSecret,
        code,
        redirect_uri: callbackUrl,
        code_verifier: verifier
      })
    });
    const tokenResult = await tokenResponse.json().catch(() => null);
    const accessToken = tokenResult?.access_token;
    if (!tokenResponse.ok || typeof accessToken !== "string" || !accessToken) {
      throw httpError(502, "GitHub authentication failed.");
    }

    const userResponse = await fetchImpl(GITHUB_USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": GITHUB_API_VERSION
      }
    });
    const user = await userResponse.json().catch(() => null);
    if (!userResponse.ok || typeof user?.login !== "string") {
      throw httpError(502, "GitHub authentication failed.");
    }
    if (user.login.toLowerCase() !== ALLOWED_GITHUB_LOGIN) {
      throw httpError(403, "This GitHub account is not allowed.");
    }
    return {
      login: user.login,
      avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null
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
          label: "Sign in",
          startUrl: "/api/auth/github/start"
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

  router.get("/github/start", (request, response, next) => {
    try {
      pruneExpired();
      const origin = String(request.query.origin || "");
      const nonce = String(request.query.nonce || "");
      if (!browserOrigin(origin)) {
        throw httpError(400, "A valid browser origin is required.");
      }
      if (!NONCE_PATTERN.test(nonce)) {
        throw httpError(400, "A valid authentication nonce is required.");
      }

      while (pendingStates.size >= MAX_PENDING_STATES) {
        pendingStates.delete(pendingStates.keys().next().value);
      }

      const state = randomToken();
      const verifier = randomToken(48);
      pendingStates.set(privateHash("state", state), {
        origin,
        nonce,
        verifier,
        expiresAt: now() + STATE_TTL_MS
      });

      const authorizationUrl = new URL(GITHUB_AUTHORIZE_URL);
      authorizationUrl.search = new URLSearchParams({
        client_id: githubClientId,
        redirect_uri: callbackUrl,
        state,
        code_challenge: sha256(verifier),
        code_challenge_method: "S256"
      });
      response.redirect(302, authorizationUrl.toString());
    } catch (error) {
      next(error);
    }
  });

  router.get("/github/callback", async (request, response) => {
    pruneExpired();
    const rawState = String(request.query.state || "");
    const stateKey = rawState ? privateHash("state", rawState) : "";
    const state = stateKey ? pendingStates.get(stateKey) : null;
    if (stateKey) pendingStates.delete(stateKey);
    if (!state || state.expiresAt <= now()) {
      response
        .status(400)
        .type("html")
        .send(staticErrorHtml("Authentication expired or is invalid."));
      return;
    }

    if (request.query.error || typeof request.query.code !== "string") {
      sendCallback(
        response,
        state,
        { status: "error", message: "GitHub authentication was not completed." },
        400
      );
      return;
    }

    try {
      const profile = await githubIdentity(request.query.code, state.verifier);
      const code = randomToken();
      exchangeCodes.set(privateHash("code", code), {
        origin: state.origin,
        nonce: state.nonce,
        profile,
        expiresAt: now() + EXCHANGE_CODE_TTL_MS
      });
      sendCallback(response, state, { status: "success", code });
    } catch (error) {
      const status = error.status === 403 ? 403 : 502;
      const message =
        status === 403
          ? "This GitHub account is not allowed."
          : "GitHub authentication failed.";
      sendCallback(response, state, { status: "error", message }, status);
    }
  });

  router.post(
    "/exchange",
    express.json({ type: "application/json", limit: "8kb" }),
    (request, response, next) => {
      try {
        pruneExpired();
        const code = request.body?.code;
        const origin = request.body?.origin;
        const nonce = request.body?.nonce;
        if (
          typeof code !== "string" ||
          typeof origin !== "string" ||
          typeof nonce !== "string"
        ) {
          throw httpError(400, "The authentication exchange is invalid.");
        }
        const codeKey = privateHash("code", code);
        const pending = exchangeCodes.get(codeKey);
        exchangeCodes.delete(codeKey);
        if (!pending || pending.expiresAt <= now()) {
          throw httpError(400, "The authentication code is invalid or expired.");
        }
        if (
          request.get("origin") !== pending.origin ||
          origin !== pending.origin ||
          nonce !== pending.nonce
        ) {
          throw httpError(403, "The authentication exchange does not match its origin.");
        }

        const token = randomToken();
        const expiresAt = now() + SESSION_TTL_MS;
        sessions.set(privateHash("session", token), {
          profile: pending.profile,
          expiresAt
        });
        response.json({
          token,
          session: {
            authenticated: true,
            authenticationRequired: true,
            provider: "github",
            label: pending.profile.login,
            login: pending.profile.login,
            avatarUrl: pending.profile.avatarUrl,
            expiresAt: new Date(expiresAt).toISOString()
          }
        });
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
  AUTH_MESSAGE_TYPE,
  EXCHANGE_CODE_TTL_MS,
  SESSION_TTL_MS,
  STATE_TTL_MS,
  createDevelopmentAuthentication,
  createProductionAuthentication
};
