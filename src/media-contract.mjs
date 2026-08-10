const ASSET_FILENAME = "asset.dat";

function mediaStorageMode(config) {
  return config?.connectors?.default?.name === "github" ? "github" : "api";
}

export { ASSET_FILENAME, mediaStorageMode };
