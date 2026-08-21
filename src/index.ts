#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { loadConfig, loadProjectEnv } from "./config.js";
import { CatalogService } from "./db/catalog.js";
import { Database } from "./db/pool.js";
import { createLogger } from "./logging.js";
import { NormalizationService } from "./normalization/service.js";
import { createServer } from "./server.js";

loadProjectEnv();
const config = loadConfig();
const logger = createLogger(config.logLevel);
const database = new Database(config, logger);
const catalog = new CatalogService(config, logger);
const normalization = new NormalizationService(config, catalog);
const activeServers = new Set<ReturnType<typeof createServer>["server"]>();
const buildConnectionServer = (): ReturnType<typeof createServer>["server"] => {
  const server = createServer(config, logger, { database, catalog, normalization }).server;
  activeServers.add(server);
  return server;
};

let closing = false;
const close = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  logger.info("shutting down", { signal });
  try {
    await Promise.all([...activeServers].map((server) => server.close()));
    await database.close();
  } finally {
    process.exit(0);
  }
};

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

await serveStdio(buildConnectionServer);
