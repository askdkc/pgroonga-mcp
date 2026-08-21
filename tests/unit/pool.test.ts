import { describe, expect, it } from "vitest";

import type { Config } from "../../src/config.js";
import { Database } from "../../src/db/pool.js";
import { createLogger } from "../../src/logging.js";

const config: Config = {
  databaseUrl: undefined,
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

describe("Database", () => {
  it("defers missing database configuration until a query is requested", async () => {
    const database = new Database(config, createLogger("error"));

    await expect(database.withReadOnly(async () => "unreachable")).rejects.toMatchObject({
      code: "database_unavailable",
      message: expect.stringContaining("PGROONGA_DATABASE_URL"),
    });
    await expect(database.query("SELECT 1")).rejects.toMatchObject({
      code: "database_unavailable",
    });
    await expect(database.close()).resolves.toBeUndefined();
  });
});
