import {
  McpServer,
  type CallToolResult,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { discoverCapabilities, qualifiedFunction } from "./db/capabilities.js";
import { CatalogService, type IndexMetadata } from "./db/catalog.js";
import { Database } from "./db/pool.js";
import type { Config } from "./config.js";
import { AppError, errorMessage } from "./errors.js";
import type { Logger } from "./logging.js";
import { NormalizationService } from "./normalization/service.js";
import { compileSearch } from "./search/compiler.js";
import { serializeRows } from "./search/result-serializer.js";
import { packageVersion } from "./version.js";
import {
  indexOutputSchema,
  lookupVariantsInputSchema,
  normalizeTextInputSchema,
  searchInputSchema,
  searchOutputSchema,
  serverInfoOutputSchema,
  validateProfileInputSchema,
} from "./search/types.js";

type ToolResult = CallToolResult;

function toolResult(value: Record<string, unknown>): ToolResult {
  return {
    structuredContent: value,
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("database_error", errorMessage(error));
}

function serializeIndex(index: IndexMetadata): Record<string, unknown> {
  return {
    index: index.qualifiedIndexName,
    table: index.qualifiedTableName,
    definition: index.indexDefinition,
    targets: index.targets.map((target) => ({
      position: target.position,
      isKey: target.isKey,
      column: target.columnName,
      expression: target.expression,
      type: target.typeName,
      operatorClass: target.operatorClass,
      supportedModes: target.supportedModes,
    })),
    includedColumns: index.includedColumns,
    reloptions: index.reloptions,
    valid: index.valid,
    ready: index.ready,
    sizeBytes: index.sizeBytes,
    predicate: index.predicate,
    supported: index.supported,
    unsupportedReasons: index.unsupportedReasons,
    normalizationProfile: index.normalizationProfile,
  };
}

function registerToolSafely(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: StandardSchemaWithJSON,
  outputSchema: StandardSchemaWithJSON,
  handler: (input: unknown) => Promise<ToolResult>,
): void {
  server.registerTool(name, { description, inputSchema, outputSchema }, async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      const appError = asAppError(error);
      const output = {
        error: {
          code: appError.code,
          message: appError.message,
          details: appError.details ?? null,
        },
      };
      return {
        isError: true,
        structuredContent: output,
        content: [{ type: "text", text: JSON.stringify(output) }],
      };
    }
  });
}

export interface ServerDependencies {
  database?: Database;
  catalog?: CatalogService;
  normalization?: NormalizationService;
}

export function createServer(
  config: Config,
  logger: Logger,
  dependencies: ServerDependencies = {},
): { server: McpServer; database: Database } {
  const database = dependencies.database ?? new Database(config, logger);
  const catalog = dependencies.catalog ?? new CatalogService(config, logger);
  const normalization = dependencies.normalization ?? new NormalizationService(config, catalog);
  const server = new McpServer({ name: "pgroonga-mcp", version: packageVersion });

  registerToolSafely(
    server,
    "pgroonga_server_info",
    "Discover PostgreSQL, PGroonga, Groonga, and feature capabilities.",
    z.object({}),
    serverInfoOutputSchema,
    async () => {
      const output = await database.withReadOnly(async (client) => {
        const capabilities = await discoverCapabilities(client, logger);
        return {
          postgresVersion: capabilities.postgresVersion,
          extensionVersion: capabilities.extensionVersion,
          extensionSchema: capabilities.extensionSchema,
          groongaVersion: capabilities.groongaVersion,
          databaseName: capabilities.databaseName,
          roleName: capabilities.roleName,
          readOnly: capabilities.readOnly,
          supportedSearchModes: ["keyword", "query", "prefix", "exact", "regexp"],
          capabilities: capabilities.capabilities,
          notes: capabilities.notes,
        };
      });
      return toolResult(output);
    },
  );

  const listIndexesInput = z.object({
    schema: z.string().min(1).max(255).optional(),
    table: z.string().min(1).max(255).optional(),
  });
  const listIndexesOutput = z.object({ indexes: z.array(indexOutputSchema) });
  registerToolSafely(
    server,
    "pgroonga_list_indexes",
    "List catalog-resolved PGroonga indexes and supported search modes.",
    listIndexesInput,
    listIndexesOutput,
    async (rawInput) => {
      const input = listIndexesInput.parse(rawInput);
      const output = await database.withReadOnly(async (client) => ({
        indexes: (await catalog.listIndexes(client, input)).map(serializeIndex),
      }));
      return toolResult(output);
    },
  );

  registerToolSafely(
    server,
    "pgroonga_search",
    "Execute a bounded, catalog-validated PGroonga search with structured filters.",
    searchInputSchema,
    searchOutputSchema,
    async (rawInput) => {
      const input = searchInputSchema.parse(rawInput);
      const started = performance.now();
      const output = await database.withReadOnly(async (client) => {
        const capabilities = await discoverCapabilities(client, logger);
        const compiled = await compileSearch(
          client,
          catalog,
          capabilities,
          input,
          config.defaultLimit,
          config.maxRows,
        );
        const result = await client.query(compiled.sql, compiled.values);
        const serialized = serializeRows(result.rows, config);
        let normalizedQuery: string | null = null;
        if (compiled.profile && capabilities.capabilities.hasNormalize) {
          normalizedQuery = (
            await normalization.normalizeText(
              client,
              capabilities,
              compiled.index.qualifiedIndexName,
              input.query,
              input.target.column,
            )
          ).normalized;
        }
        const warnings = [...compiled.warnings, ...serialized.warnings];
        if (!compiled.scoreAvailable && input.order === "score")
          warnings.push(
            "Use pgroonga_explain_search to verify whether PostgreSQL used the expected PGroonga index",
          );
        return {
          target: input.target,
          query: input.query,
          normalizedQuery,
          normalizationProfile: compiled.profile?.searchIndex ?? null,
          rows: serialized.rows,
          rowCount: serialized.rows.length,
          truncated: serialized.truncated,
          executionMs: performance.now() - started,
          scoreAvailable: compiled.scoreAvailable,
          snippetAvailable: compiled.snippetAvailable,
          warnings,
        };
      });
      return toolResult(output);
    },
  );

  const explainOutput = z.object({
    plan: z.unknown(),
    usesExpectedPgroongaIndex: z.boolean(),
    warnings: z.array(z.string()),
  });
  registerToolSafely(
    server,
    "pgroonga_explain_search",
    "Return a non-executing EXPLAIN (FORMAT JSON) for a validated search.",
    searchInputSchema,
    explainOutput,
    async (rawInput) => {
      const input = searchInputSchema.parse(rawInput);
      const output = await database.withReadOnly(async (client) => {
        const capabilities = await discoverCapabilities(client, logger);
        const compiled = await compileSearch(
          client,
          catalog,
          capabilities,
          input,
          config.defaultLimit,
          config.maxRows,
        );
        const planResult = await client.query<{ "QUERY PLAN": unknown }>(
          `EXPLAIN (FORMAT JSON) ${compiled.sql}`,
          compiled.values,
        );
        const plan = planResult.rows[0]?.["QUERY PLAN"] ?? null;
        const text = JSON.stringify(plan);
        const usesExpectedPgroongaIndex =
          text.includes("Index Scan") && text.includes(compiled.index.indexName);
        return { plan, usesExpectedPgroongaIndex, warnings: compiled.warnings };
      });
      return toolResult(output);
    },
  );

  const profileOutput = z.object({ profiles: z.array(z.unknown()) });
  registerToolSafely(
    server,
    "pgroonga_list_normalization_profiles",
    "Discover trusted index-level normalizer chains and NormalizerTable dependencies.",
    z.object({}),
    profileOutput,
    async () => {
      const output = await database.withReadOnly(async (client) => ({
        profiles: await normalization.listProfiles(client),
      }));
      return toolResult(output);
    },
  );

  const normalizeOutput = z.object({
    input: z.string(),
    normalized: z.string(),
    changed: z.boolean(),
    profile: z.string(),
  });
  registerToolSafely(
    server,
    "pgroonga_normalize_text",
    "Normalize text with a discovered PGroonga index profile.",
    normalizeTextInputSchema,
    normalizeOutput,
    async (rawInput) => {
      const input = normalizeTextInputSchema.parse(rawInput);
      const output = await database.withReadOnly(async (client) => {
        const capabilities = await discoverCapabilities(client, logger);
        const result = await normalization.normalizeText(
          client,
          capabilities,
          input.index,
          input.text,
        );
        return {
          input: input.text,
          normalized: result.normalized,
          changed: result.normalized !== input.text,
          profile: result.profile.searchIndex,
        };
      });
      return toolResult(output);
    },
  );

  const variantsOutput = z.object({
    input: z.string(),
    canonical: z.string(),
    variants: z.array(z.string()),
    profile: z.string(),
  });
  registerToolSafely(
    server,
    "pgroonga_lookup_variants",
    "Normalize text and return bounded dictionary variants for the discovered profile.",
    lookupVariantsInputSchema,
    variantsOutput,
    async (rawInput) => {
      const input = lookupVariantsInputSchema.parse(rawInput);
      const output = await database.withReadOnly(async (client) => {
        const capabilities = await discoverCapabilities(client, logger);
        const result = await normalization.lookupVariants(
          client,
          capabilities,
          input.index,
          input.input,
        );
        return {
          input: input.input,
          canonical: result.canonical,
          variants: result.variants,
          profile: result.profile.searchIndex,
        };
      });
      return toolResult(output);
    },
  );

  const validationOutput = z.object({ profile: z.unknown(), findings: z.array(z.unknown()) });
  registerToolSafely(
    server,
    "pgroonga_validate_normalization_profile",
    "Validate dictionary mappings and report normalization hazards without modifying data.",
    validateProfileInputSchema,
    validationOutput,
    async (rawInput) => {
      const input = validateProfileInputSchema.parse(rawInput);
      const output = await database.withReadOnly(async (client) => {
        const capabilities = await discoverCapabilities(client, logger);
        return normalization.validateProfile(client, capabilities, input.index);
      });
      return toolResult(output);
    },
  );

  const healthOutput = z.object({
    extensionAvailable: z.boolean(),
    writable: z.unknown(),
    potentiallyBrokenIndexes: z.unknown(),
    laggedIndexes: z.unknown(),
    walStatus: z.unknown(),
    unavailable: z.array(z.object({ check: z.string(), reason: z.string() })),
  });
  registerToolSafely(
    server,
    "pgroonga_health",
    "Report limited PGroonga health checks and explicitly unavailable diagnostics.",
    z.object({}),
    healthOutput,
    async () => {
      const output = await database.withReadOnly(async (client) => {
        const capabilities = await discoverCapabilities(client, logger);
        const unavailable: { check: string; reason: string }[] = [];
        const callOptional = async (check: string, functionName: string): Promise<unknown> => {
          if (
            !capabilities.extensionSchema ||
            !capabilities.capabilities[check as keyof typeof capabilities.capabilities]
          ) {
            unavailable.push({
              check,
              reason: "Function is not exposed by the installed PGroonga extension",
            });
            return null;
          }
          try {
            const result = await client.query(
              `SELECT ${qualifiedFunction(capabilities.extensionSchema, functionName)}() AS value`,
            );
            return result.rows[0]?.value ?? null;
          } catch (error) {
            unavailable.push({ check, reason: errorMessage(error) });
            return null;
          }
        };
        const writable = await callOptional("hasWritableCheck", "pgroonga_is_writable");
        const potentiallyBrokenIndexes = await callOptional(
          "hasBrokenIndexCheck",
          "pgroonga_list_broken_indexes",
        );
        const laggedIndexes = await callOptional(
          "hasLaggedIndexCheck",
          "pgroonga_list_lagged_indexes",
        );
        const walStatus = await callOptional("hasWalStatus", "pgroonga_wal_status");
        return {
          extensionAvailable: capabilities.capabilities.hasExtension,
          writable,
          potentiallyBrokenIndexes,
          laggedIndexes,
          walStatus,
          unavailable,
        };
      });
      return toolResult(output);
    },
  );

  return { server, database };
}
