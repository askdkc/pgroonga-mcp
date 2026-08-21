import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig, loadProjectEnv } from "../../src/config.js";

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

  it("allows database-backed configuration to be omitted", () => {
    expect(loadConfig({}).databaseUrl).toBeUndefined();
  });

  it("uses a PostgreSQL DATABASE_URL when the PGroonga URL is absent", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://user:pass@localhost/db" }).databaseUrl).toBe(
      "postgres://user:pass@localhost/db",
    );
    expect(loadConfig({ DATABASE_URL: "mysql://localhost/db" }).databaseUrl).toBeUndefined();
  });

  it("prefers the explicit PGroonga URL", () => {
    expect(
      loadConfig({
        PGROONGA_DATABASE_URL: "postgresql://pgroonga@localhost/db",
        DATABASE_URL: "postgresql://application@localhost/db",
      }).databaseUrl,
    ).toBe("postgresql://pgroonga@localhost/db");
  });

  it("loads a project env file without overriding explicit values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pgroonga-mcp-"));
    const path = join(directory, ".env");
    try {
      await writeFile(
        path,
        [
          "PGROONGA_DATABASE_URL=postgresql://specific-from-file@localhost/db",
          "DATABASE_URL=postgresql://from-file@localhost/db",
          "PGROONGA_ALLOWED_SCHEMAS=documents",
          "",
        ].join("\n"),
      );
      const loadedEnv: NodeJS.ProcessEnv = {
        DATABASE_URL: "postgresql://explicit@localhost/db",
        PGROONGA_ENV_FILE: path,
      };
      loadProjectEnv(loadedEnv);

      expect(loadedEnv.DATABASE_URL).toBe("postgresql://explicit@localhost/db");
      expect(loadedEnv.PGROONGA_DATABASE_URL).toBeUndefined();
      expect(loadedEnv.PGROONGA_ALLOWED_SCHEMAS).toBe("documents");
      expect(loadConfig(loadedEnv).databaseUrl).toBe("postgresql://explicit@localhost/db");

      const fileOnlyEnv: NodeJS.ProcessEnv = { PGROONGA_ENV_FILE: path };
      loadProjectEnv(fileOnlyEnv);
      expect(loadConfig(fileOnlyEnv).databaseUrl).toBe(
        "postgresql://specific-from-file@localhost/db",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an unbounded default limit", () => {
    expect(() =>
      loadConfig({
        PGROONGA_DATABASE_URL: "postgresql://localhost/db",
        PGROONGA_DEFAULT_LIMIT: "101",
      }),
    ).toThrow("PGROONGA_DEFAULT_LIMIT must not exceed PGROONGA_MAX_ROWS");
  });
});
