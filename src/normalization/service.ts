import type { QueryResultRow } from "pg";

import type { Capabilities } from "../db/capabilities.js";
import type { CatalogService, IndexMetadata } from "../db/catalog.js";
import { qualifiedFunction } from "../db/capabilities.js";
import type { DbClient } from "../db/pool.js";
import { quoteIdentifier, quoteQualifiedIdentifier } from "../db/sql.js";
import { AppError } from "../errors.js";
import type { Config } from "../config.js";
import { replaceTableReferences, type NormalizationProfile } from "./profile-parser.js";
import {
  validateDictionaryRows,
  type DictionaryRow,
  type NormalizationFinding,
} from "./validator.js";

interface NormalizedRow extends QueryResultRow {
  normalized: string | null;
}

interface DictionaryQueryRow extends QueryResultRow {
  target: string | null;
}

interface IdempotenceRow extends QueryResultRow {
  once: string | null;
  twice: string | null;
}

function matchIndex(indexes: IndexMetadata[], requested: string): IndexMetadata {
  const exact = indexes.find(
    (index) => index.qualifiedIndexName === requested || index.indexName === requested,
  );
  if (!exact)
    throw new AppError(
      "profile_not_found",
      `Normalization profile ${requested} was not discovered`,
    );
  return exact;
}

export class NormalizationService {
  public constructor(
    private readonly config: Config,
    private readonly catalog: CatalogService,
  ) {}

  public async listProfiles(client: DbClient): Promise<NormalizationProfile[]> {
    const indexes = await this.catalog.listIndexes(client);
    return indexes.flatMap((index) =>
      index.normalizationProfile ? [index.normalizationProfile] : [],
    );
  }

  private async resolve(
    client: DbClient,
    requested: string,
  ): Promise<{ index: IndexMetadata; profile: NormalizationProfile }> {
    const indexes = await this.catalog.listIndexes(client);
    const index = matchIndex(indexes, requested);
    if (!index.normalizationProfile)
      throw new AppError(
        "profile_not_found",
        `Index ${requested} has no discovered normalizer profile`,
      );
    return { index, profile: index.normalizationProfile };
  }

  private async resolvedSpec(
    client: DbClient,
    capabilities: Capabilities,
    profile: NormalizationProfile,
    targetColumn?: string,
  ): Promise<string> {
    if (!capabilities.extensionSchema || !capabilities.capabilities.hasNormalize) {
      throw new AppError("normalize_unavailable", "pgroonga_normalize is unavailable");
    }
    const selected = targetColumn ? profile.normalizersMapping[targetColumn] : undefined;
    const normalizerSpec = selected?.normalizerSpec ?? profile.normalizerSpec;
    const dependencies = selected
      ? selected.normalizerChain.flatMap((normalizer) =>
          normalizer.name === "NormalizerTable"
            ? profile.dictionaryDependencies.filter((dependency) =>
                normalizer.raw.includes(dependency.dictionaryIndex),
              )
            : [],
        )
      : profile.dictionaryDependencies;
    const replacements = new Map<string, string>();
    for (const dependency of dependencies) {
      if (replacements.has(dependency.dictionaryIndex)) continue;
      if (!capabilities.capabilities.hasTableName) {
        throw new AppError(
          "normalize_unavailable",
          "pgroonga_table_name is required to resolve NormalizerTable references",
        );
      }
      const result = await client.query<NormalizedRow>(
        `SELECT ${qualifiedFunction(capabilities.extensionSchema, "pgroonga_table_name")}($1::text) AS normalized`,
        [dependency.dictionaryIndex],
      );
      const tableName = result.rows[0]?.normalized;
      if (!tableName)
        throw new AppError(
          "normalize_unavailable",
          `Could not resolve Groonga table for ${dependency.dictionaryIndex}`,
        );
      replacements.set(dependency.dictionaryIndex, tableName);
    }
    return replaceTableReferences(normalizerSpec, replacements);
  }

  public async normalizeText(
    client: DbClient,
    capabilities: Capabilities,
    requested: string,
    text: string,
    targetColumn?: string,
  ): Promise<{ normalized: string; profile: NormalizationProfile }> {
    if (Buffer.byteLength(text, "utf8") > this.config.maxNormalizationInputBytes) {
      throw new AppError(
        "limit_exceeded",
        "Normalization input exceeds PGROONGA_MAX_NORMALIZATION_INPUT_BYTES",
      );
    }
    const { profile } = await this.resolve(client, requested);
    if (
      [
        profile.normalizerChain,
        ...Object.values(profile.normalizersMapping).map((mapping) => mapping.normalizerChain),
      ].some((chain) =>
        chain.some((normalizer) => normalizer.options.unify_iteration_mark === true),
      ) &&
      !capabilities.capabilities.hasUnifyIterationMark
    ) {
      throw new AppError(
        "unsupported_configuration",
        "This PGroonga/Groonga installation does not support unify_iteration_mark",
      );
    }
    const spec = await this.resolvedSpec(client, capabilities, profile, targetColumn);
    const result = await client.query<NormalizedRow>(
      `SELECT ${qualifiedFunction(capabilities.extensionSchema ?? "", "pgroonga_normalize")}($1::text, $2::text) AS normalized`,
      [text, spec],
    );
    const normalized = result.rows[0]?.normalized;
    if (normalized === null || normalized === undefined)
      throw new AppError("normalize_failed", "PGroonga returned no normalized value");
    return { normalized, profile };
  }

  public async lookupVariants(
    client: DbClient,
    capabilities: Capabilities,
    requested: string,
    input: string,
  ): Promise<{ canonical: string; variants: string[]; profile: NormalizationProfile }> {
    const normalized = await this.normalizeText(client, capabilities, requested, input);
    const dependency = normalized.profile.dictionaryDependencies[0];
    if (!dependency)
      return {
        canonical: normalized.normalized,
        variants: [normalized.normalized],
        profile: normalized.profile,
      };
    const indexes = await this.catalog.listIndexes(client);
    const dictionaryIndex = indexes.find(
      (index) =>
        index.qualifiedIndexName === dependency.dictionaryIndex ||
        index.indexName === dependency.dictionaryIndex,
    );
    if (!dictionaryIndex)
      throw new AppError(
        "dictionary_not_found",
        `Dictionary index ${dependency.dictionaryIndex} was not discovered`,
      );
    const dictionaryColumns = await this.catalog.tableColumns(
      client,
      dictionaryIndex.tableSchema,
      dictionaryIndex.tableName,
    );
    if (
      !dictionaryColumns.some((column) => column.name === dependency.targetColumn) ||
      !dictionaryColumns.some((column) => column.name === dependency.normalizedColumn)
    ) {
      throw new AppError(
        "dictionary_invalid",
        "NormalizerTable dictionary columns are not present on the discovered table",
      );
    }
    const table = quoteQualifiedIdentifier(dictionaryIndex.tableSchema, dictionaryIndex.tableName);
    const target = quoteIdentifier(dependency.targetColumn);
    const normalizedColumn = quoteIdentifier(dependency.normalizedColumn);
    const result = await client.query<DictionaryQueryRow>(
      `SELECT ${target} AS target
         FROM ${table}
        WHERE ${normalizedColumn} = $1
          AND ${target} IS NOT NULL
        ORDER BY ${target} ASC
        LIMIT $2`,
      [normalized.normalized, this.config.maxVariants],
    );
    const variants = new Set<string>([normalized.normalized]);
    for (const row of result.rows) if (row.target !== null) variants.add(row.target);
    return {
      canonical: normalized.normalized,
      variants: [...variants].sort((a, b) => a.localeCompare(b)),
      profile: normalized.profile,
    };
  }

  public async validateProfile(
    client: DbClient,
    capabilities: Capabilities,
    requested: string,
  ): Promise<{ profile: NormalizationProfile; findings: NormalizationFinding[] }> {
    const { profile } = await this.resolve(client, requested);
    const findings: NormalizationFinding[] = [];
    const dictionaryRows: DictionaryRow[] = [];
    for (const dependency of profile.dictionaryDependencies) {
      const indexes = await this.catalog.listIndexes(client);
      const dictionaryIndex = indexes.find(
        (index) =>
          index.qualifiedIndexName === dependency.dictionaryIndex ||
          index.indexName === dependency.dictionaryIndex,
      );
      if (!dictionaryIndex) {
        findings.push({
          severity: "error",
          code: "missing_dictionary_index",
          message: `Dictionary index ${dependency.dictionaryIndex} was not discovered`,
        });
        continue;
      }
      const columns = await this.catalog.tableColumns(
        client,
        dictionaryIndex.tableSchema,
        dictionaryIndex.tableName,
      );
      if (!columns.some((column) => column.name === dependency.targetColumn)) {
        findings.push({
          severity: "error",
          code: "missing_target_column",
          message: `Dictionary target column ${dependency.targetColumn} is missing`,
        });
        continue;
      }
      if (!columns.some((column) => column.name === dependency.normalizedColumn)) {
        findings.push({
          severity: "error",
          code: "missing_normalized_column",
          message: `Dictionary normalized column ${dependency.normalizedColumn} is missing`,
        });
        continue;
      }
      if (
        !dictionaryIndex.targets.some((target) => target.columnName === dependency.normalizedColumn)
      ) {
        findings.push({
          severity: "error",
          code: "missing_included_normalized_column",
          message: `Dictionary index ${dependency.dictionaryIndex} does not include ${dependency.normalizedColumn}`,
        });
      }
      const targetType = columns.find(
        (column) => column.name === dependency.targetColumn,
      )?.typeName;
      const normalizedType = columns.find(
        (column) => column.name === dependency.normalizedColumn,
      )?.typeName;
      if (targetType !== normalizedType) {
        findings.push({
          severity: "error",
          code: "incompatible_column_types",
          message: "Dictionary target and normalized columns have incompatible types",
          evidence: { targetType, normalizedType },
        });
      }
      const dictionaryTarget = dictionaryIndex.targets.find(
        (target) => target.columnName === dependency.targetColumn,
      );
      if (!dictionaryTarget || !dictionaryTarget.operatorClass.includes("term_search")) {
        findings.push({
          severity: "warning",
          code: "incorrect_dictionary_operator_class",
          message: "Dictionary target should use a PGroonga term-search operator class",
        });
      }
      const rowsResult = await client.query<DictionaryRow>(
        `SELECT ${quoteIdentifier(dependency.targetColumn)} AS target,
                ${quoteIdentifier(dependency.normalizedColumn)} AS normalized
           FROM ${quoteQualifiedIdentifier(dictionaryIndex.tableSchema, dictionaryIndex.tableName)}
          LIMIT $1`,
        [Math.max(this.config.maxVariants * 20, 1000)],
      );
      dictionaryRows.push(...rowsResult.rows);
      findings.push(...validateDictionaryRows(rowsResult.rows));
      if (rowsResult.rows.length >= Math.max(this.config.maxVariants * 20, 1000)) {
        findings.push({
          severity: "warning",
          code: "dictionary_validation_truncated",
          message: "Dictionary validation was bounded and may not include every row",
        });
      }
    }
    if (profile.normalizerSpec && dictionaryRows.length > 0) {
      try {
        const spec = await this.resolvedSpec(client, capabilities, profile);
        for (const row of dictionaryRows.slice(0, this.config.maxVariants)) {
          if (row.target === null) continue;
          const idempotence = await client.query<IdempotenceRow>(
            `SELECT ${qualifiedFunction(capabilities.extensionSchema ?? "", "pgroonga_normalize")}($1::text, $2::text) AS once,
                      ${qualifiedFunction(capabilities.extensionSchema ?? "", "pgroonga_normalize")}(${qualifiedFunction(capabilities.extensionSchema ?? "", "pgroonga_normalize")}($1::text, $2::text), $2::text) AS twice`,
            [row.target, spec],
          );
          const result = idempotence.rows[0];
          if (result?.once !== null && result?.once !== undefined && result.twice !== result.once) {
            findings.push({
              severity: "error",
              code: "non_idempotent_normalizer",
              message: "Applying the configured normalizer twice changes a dictionary target",
              evidence: { target: row.target, once: result.once, twice: result.twice },
            });
          }
        }
      } catch (error) {
        findings.push({
          severity: "warning",
          code: "idempotence_check_unavailable",
          message: "The server could not execute the bounded idempotence check",
          evidence: { reason: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    if (
      capabilities.capabilities.hasUnifyIterationMark &&
      profile.normalizerChain.some((normalizer) => normalizer.options.unify_iteration_mark === true)
    ) {
      for (const row of dictionaryRows.slice(0, this.config.maxVariants)) {
        if (row.target === null || row.normalized === null || !/[ゝゞヽヾ々〻]/u.test(row.target))
          continue;
        const builtIn = await client.query<NormalizedRow>(
          `SELECT ${qualifiedFunction(capabilities.extensionSchema ?? "", "pgroonga_normalize")}($1::text, $2::text) AS normalized`,
          [row.target, 'NormalizerNFKC("unify_iteration_mark", true)'],
        );
        if (builtIn.rows[0]?.normalized === row.normalized) {
          findings.push({
            severity: "info",
            code: "redundant_builtin_mapping",
            message:
              "A dictionary row duplicates the configured built-in iteration-mark normalization",
            evidence: { target: row.target, normalized: row.normalized },
          });
        }
      }
    }
    if (profile.dictionaryDependencies.length > 0) {
      findings.push({
        severity: "warning",
        code: "reindex_required_after_dictionary_change",
        message:
          "Changing a NormalizerTable dictionary requires REINDEX of each dependent search index; freshness is unknown",
      });
    }
    if (!profile.highlightCompatible && profile.dictionaryDependencies.length > 0) {
      findings.push({
        severity: "warning",
        code: "highlighting_disabled",
        message:
          "NormalizerTable highlighting requires tokenizer source locations and source offsets on each relevant normalizer",
      });
    }
    if (
      profile.normalizerChain.some(
        (normalizer) =>
          normalizer.name.startsWith("NormalizerNFKC") &&
          normalizer.options.unify_iteration_mark === true,
      )
    ) {
      findings.push({
        severity: "info",
        code: "built_in_iteration_mark_normalization",
        message:
          "unify_iteration_mark is configured as a built-in normalizer option; redundant iteration-mark dictionary rows should be removed",
      });
      if (!capabilities.capabilities.hasUnifyIterationMark) {
        findings.push({
          severity: "error",
          code: "unsupported_iteration_mark_option",
          message: "The installed Groonga version does not advertise unify_iteration_mark support",
        });
      }
    }
    return { profile, findings };
  }
}
