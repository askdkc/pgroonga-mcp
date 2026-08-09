import { describe, expect, it } from "vitest";

import type { Capabilities } from "../../src/db/capabilities.js";
import type { IndexMetadata, TableColumn } from "../../src/db/catalog.js";
import { CatalogService } from "../../src/db/catalog.js";
import { compileSearch } from "../../src/search/compiler.js";
import { searchInputSchema } from "../../src/search/types.js";
import type { Config } from "../../src/config.js";

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
  logLevel: "info",
  transport: "stdio",
};

const index: IndexMetadata = {
  oid: "1",
  indexSchema: "public",
  indexName: "titles_idx",
  qualifiedIndexName: "public.titles_idx",
  tableOid: "2",
  tableSchema: "public",
  tableName: "books",
  qualifiedTableName: "public.books",
  indexDefinition: "CREATE INDEX titles_idx ON public.books USING pgroonga (title)",
  reloptions: [],
  valid: true,
  ready: true,
  sizeBytes: "4096",
  predicate: null,
  targets: [
    {
      position: 1,
      isKey: true,
      attributeNumber: 1,
      columnName: "title",
      expression: null,
      typeName: "text",
      operatorClass: "pgroonga_text_full_text_search_ops_v2",
      supportedModes: ["keyword", "query"],
    },
  ],
  includedColumns: [],
  supported: true,
  unsupportedReasons: [],
  normalizationProfile: null,
};

const capabilities: Capabilities = {
  postgresVersion: "PostgreSQL 18",
  extensionVersion: "4.0.7",
  extensionSchema: "extensions",
  groongaVersion: "15.1.7",
  databaseName: "db",
  roleName: "pgroonga_mcp",
  readOnly: false,
  capabilities: {
    hasExtension: true,
    hasNormalize: true,
    hasTokenize: true,
    hasUnifyIterationMark: true,
    hasBrokenIndexCheck: true,
    hasLaggedIndexCheck: true,
    hasWalStatus: true,
    hasWritableCheck: true,
    hasScore: true,
    hasHighlight: true,
    hasTableName: true,
    hasSemanticSearch: false,
  },
  notes: [],
};

describe("safe search compiler", () => {
  it("quotes resolved identifiers, qualifies operators, and binds values", async () => {
    const catalog = new CatalogService(config, { debug() {}, info() {}, warn() {}, error() {} });
    const fakeClient = { query: async () => ({ rows: [] }) } as never;
    const listIndexes = catalog.listIndexes.bind(catalog);
    const tableColumns = catalog.tableColumns.bind(catalog);
    Object.assign(catalog, {
      listIndexes: async () => [index],
      tableColumns: async () =>
        [
          { name: "id", typeName: "bigint", nullable: false, ordinal: 1 },
          { name: "title", typeName: "text", nullable: false, ordinal: 2 },
        ] as TableColumn[],
    });
    const input = searchInputSchema.parse({
      target: { schema: "public", table: "books", column: "title" },
      mode: "query",
      query: "x' OR 1=1 --",
      returnColumns: ["id", "title"],
      filters: [{ column: "id", operator: ">", value: 10 }],
      limit: 5,
    });
    const compiled = await compileSearch(fakeClient, catalog, capabilities, input, 20, 100);
    expect(compiled.sql).toContain('"extensions".&@~');
    expect(compiled.sql).not.toContain(input.query);
    expect(compiled.values).toEqual([input.query, 10, 5]);
    Object.assign(catalog, { listIndexes, tableColumns });
  });
});
