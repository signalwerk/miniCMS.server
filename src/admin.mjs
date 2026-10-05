import { promises as fs } from "node:fs";
import express from "express";

const DEFAULT_SCRIPT_URL = "https://signalwerk.github.io/miniCMS/minicms.js";

function escapeAttribute(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

function adminHtml(scriptUrl) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>miniCMS</title>
  </head>
  <body>
    <div id="root"></div>
    <script src="${escapeAttribute(scriptUrl)}"></script>
    <script>
      miniCMS.init({ target: "#root", configUrl: "cms.config.yml" });
    </script>
  </body>
</html>
`;
}

// The service hosts its own editor: /admin/ loads the published miniCMS
// browser bundle, which bootstraps from this project's cms.config.yml and then
// signs in through the configured API connector like any consumer admin page.
// The bootstrap config is public by contract (it never contains secrets), as
// it is on every static consumer site; all content and writes stay behind /api.
export function createAdminRouter({ configFile, scriptUrl = DEFAULT_SCRIPT_URL }) {
  const router = express.Router({ strict: true });
  const html = adminHtml(scriptUrl);
  const headers = {
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer"
  };

  router.get("/admin", (_request, response) => {
    response.redirect(301, "/admin/");
  });
  router.get("/admin/", (_request, response) => {
    response.set({ ...headers, "content-type": "text/html; charset=utf-8" });
    response.send(html);
  });
  router.get("/admin/cms.config.yml", async (_request, response, next) => {
    try {
      response.set({ ...headers, "content-type": "text/yaml; charset=utf-8" });
      response.send(await fs.readFile(configFile, "utf8"));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
