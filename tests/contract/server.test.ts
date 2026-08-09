import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../../src/config.js";
import { createLogger } from "../../src/logging.js";
import { createServer } from "../../src/server.js";

const config: Config = {
  databaseUrl: "postgresql://localhost/db",
  allowedSchemas: ["public"],
  allowedTables: [],
  statementTimeoutMs: 5000,
  lockTimeoutMs: 1000,
  defaultLimit: 20,
  maxRows: 100,
  maxResponseBytes: 1_000_000,
  maxTextBytes: 10_000,
  maxNormalizationInputBytes: 10_000,
  maxVariants: 100,
  logLevel: "error",
  transport: "stdio",
};

describe("MCP contract", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it("initializes and lists the read-only tool surface", async () => {
    const { server, database } = createServer(config, createLogger("error"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-test", version: "0.1.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => {
      await client.close();
      await server.close();
      await database.close();
    };

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "pgroonga_explain_search",
      "pgroonga_health",
      "pgroonga_list_indexes",
      "pgroonga_list_normalization_profiles",
      "pgroonga_lookup_variants",
      "pgroonga_normalize_text",
      "pgroonga_search",
      "pgroonga_server_info",
      "pgroonga_validate_normalization_profile",
    ]);
  });
});
