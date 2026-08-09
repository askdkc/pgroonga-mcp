import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("loads bounded defaults and allowlists", () => {
    const config = loadConfig({
      PGROONGA_DATABASE_URL: "postgresql://user:pass@localhost/db",
      PGROONGA_ALLOWED_SCHEMAS: "public, extensions",
      PGROONGA_ALLOWED_TABLES: "public.biblios",
    });
    expect(config.defaultLimit).toBe(20);
    expect(config.maxRows).toBe(100);
    expect(config.allowedSchemas).toEqual(["public", "extensions"]);
    expect(config.allowedTables).toEqual(["public.biblios"]);
  });

  it("rejects an unbounded default limit and missing URL", () => {
    expect(() => loadConfig({})).toThrow("PGROONGA_DATABASE_URL is required");
    expect(() =>
      loadConfig({
        PGROONGA_DATABASE_URL: "postgresql://localhost/db",
        PGROONGA_DEFAULT_LIMIT: "101",
      }),
    ).toThrow("PGROONGA_DEFAULT_LIMIT must not exceed PGROONGA_MAX_ROWS");
  });
});
