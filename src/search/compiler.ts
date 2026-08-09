import type { Capabilities } from "../db/capabilities.js";
import type { CatalogService, IndexMetadata, TableColumn } from "../db/catalog.js";
import { AppError } from "../errors.js";
import type { NormalizationProfile } from "../normalization/profile-parser.js";
import { isSupportedMode, operatorForMode } from "./operator-map.js";
import type { SearchInput, SearchMode } from "./types.js";
import { quoteIdentifier, quoteQualifiedIdentifier } from "../db/sql.js";

export interface CompiledSearch {
  sql: string;
  values: unknown[];
  index: IndexMetadata;
  profile: NormalizationProfile | null;
  scoreAvailable: boolean;
  snippetAvailable: boolean;
  warnings: string[];
  selectedColumns: string[];
}

function isSupportedTargetType(typeName: string | null): boolean {
  if (!typeName) return false;
  return (
    typeName === "text" ||
    typeName.startsWith("character varying") ||
    typeName === "text[]" ||
    typeName === "jsonb"
  );
}

function findColumn(columns: TableColumn[], name: string): TableColumn {
  const column = columns.find((item) => item.name === name);
  if (!column)
    throw new AppError("invalid_column", `Column ${name} is not present on the resolved table`);
  return column;
}

function validateValue(value: unknown, label: string): unknown {
  if (typeof value === "string" && value.includes("\0"))
    throw new AppError("invalid_value", `${label} must not contain NUL bytes`);
  if (typeof value === "number" && !Number.isFinite(value))
    throw new AppError("invalid_value", `${label} must be finite`);
  if (Array.isArray(value) && value.length > 100)
    throw new AppError("limit_exceeded", `${label} may contain at most 100 values`);
  return value;
}

function resolveIndex(indexes: IndexMetadata[], input: SearchInput): IndexMetadata {
  const candidates = indexes.filter(
    (index) =>
      index.tableSchema === input.target.schema &&
      index.tableName === input.target.table &&
      index.targets.some((target) => target.columnName === input.target.column && target.isKey),
  );
  const index =
    candidates.find(
      (candidate) =>
        candidate.supported &&
        candidate.targets.some(
          (target) =>
            target.columnName === input.target.column &&
            isSupportedMode(target.operatorClass, input.mode),
        ),
    ) ?? candidates[0];
  if (!index) {
    throw new AppError(
      "no_compatible_index",
      `No PGroonga index covers ${input.target.schema}.${input.target.table}.${input.target.column}`,
    );
  }
  const target = index.targets.find(
    (item) => item.columnName === input.target.column && item.isKey,
  );
  if (!target || !isSupportedMode(target.operatorClass, input.mode)) {
    throw new AppError(
      "incompatible_search_mode",
      `Search mode ${input.mode} is incompatible with the resolved operator class`,
    );
  }
  if (!index.supported) {
    throw new AppError(
      "unsupported_index_shape",
      `The resolved index is discovery-only: ${index.unsupportedReasons.join("; ")}`,
    );
  }
  if (!isSupportedTargetType(target.typeName)) {
    throw new AppError(
      "unsupported_target_type",
      `Target type ${target.typeName ?? "unknown"} is not supported by the MVP`,
    );
  }
  return index;
}

export async function compileSearch(
  client: Parameters<CatalogService["tableColumns"]>[0],
  catalog: CatalogService,
  capabilities: Capabilities,
  input: SearchInput,
  defaultLimit: number,
  maxRows: number,
): Promise<CompiledSearch> {
  if (input.mode === "similar") {
    throw new AppError(
      "unsupported_search_mode",
      "Semantic search is reserved for a later milestone",
    );
  }
  const indexes = await catalog.listIndexes(client, {
    schema: input.target.schema,
    table: input.target.table,
  });
  const index = resolveIndex(indexes, input);
  const target = index.targets.find(
    (item) => item.columnName === input.target.column && item.isKey,
  );
  if (!target)
    throw new AppError("catalog_error", "Resolved index target disappeared during compilation");
  const columns = await catalog.tableColumns(client, input.target.schema, input.target.table);
  const selectedColumns = input.returnColumns.includes("*")
    ? columns.map((column) => column.name)
    : input.returnColumns;
  for (const column of selectedColumns) {
    if (column.startsWith("_"))
      throw new AppError("invalid_column", `Output column ${column} is reserved`);
    findColumn(columns, column);
  }
  if (input.snippet && input.snippet.column !== input.target.column) {
    throw new AppError("invalid_snippet", "MVP snippets must use the search target column");
  }
  const qualifiedTable = quoteQualifiedIdentifier(input.target.schema, input.target.table);
  const tableAlias = quoteIdentifier("t");
  const qualifiedExtension = capabilities.extensionSchema;
  if (!qualifiedExtension) throw new AppError("pgroonga_unavailable", "PGroonga is not installed");
  const values: unknown[] = [input.query];
  const searchExpression = `${tableAlias}.${quoteIdentifier(input.target.column)} OPERATOR(${quoteIdentifier(qualifiedExtension)}.${operatorForMode(input.mode)}) $1`;
  const filters: string[] = [searchExpression];
  for (const filter of input.filters) {
    const column = findColumn(columns, filter.column);
    const field = `${tableAlias}.${quoteIdentifier(column.name)}`;
    if (filter.operator === "IS NULL" || filter.operator === "IS NOT NULL") {
      if (filter.value !== undefined)
        throw new AppError("invalid_filter", `${filter.operator} does not accept a value`);
      filters.push(`${field} ${filter.operator}`);
      continue;
    }
    if (filter.value === undefined)
      throw new AppError("invalid_filter", `${filter.operator} requires a value`);
    if (filter.operator === "IN") {
      if (!Array.isArray(filter.value) || filter.value.length === 0 || filter.value.length > 100) {
        throw new AppError("invalid_filter", "IN requires between 1 and 100 values");
      }
      const placeholders = filter.value.map((value) => {
        values.push(validateValue(value, `filter ${filter.column}`));
        return `$${values.length}`;
      });
      filters.push(`${field} IN (${placeholders.join(", ")})`);
      continue;
    }
    values.push(validateValue(filter.value, `filter ${filter.column}`));
    filters.push(`${field} ${filter.operator} $${values.length}`);
  }
  const warnings: string[] = [];
  const scoreAvailable =
    capabilities.capabilities.hasScore && (input.mode === "keyword" || input.mode === "query");
  if (input.order === "score" && !scoreAvailable)
    warnings.push("Relevance score is unavailable for this mode or PGroonga version");
  const profile = index.normalizationProfile;
  const snippetAvailable = Boolean(
    input.snippet &&
      capabilities.capabilities.hasHighlight &&
      (!profile || profile.highlightCompatible),
  );
  if (input.snippet && !snippetAvailable)
    warnings.push(
      "Highlighting is disabled because source-location/source-offset support is not verified",
    );
  const selections = selectedColumns.map((column) => `${tableAlias}.${quoteIdentifier(column)}`);
  if (scoreAvailable)
    selections.push(
      `${quoteIdentifier(qualifiedExtension)}.${quoteIdentifier("pgroonga_score")}(${tableAlias}.tableoid, ${tableAlias}.ctid) AS ${quoteIdentifier("_score")}`,
    );
  if (snippetAvailable && input.snippet) {
    selections.push(
      `${quoteIdentifier(qualifiedExtension)}.${quoteIdentifier("pgroonga_highlight_html")}(${tableAlias}.${quoteIdentifier(input.snippet.column)}, ARRAY[$1]) AS ${quoteIdentifier("_snippet")}`,
    );
  }
  const limit = Math.min(input.limit ?? defaultLimit, maxRows);
  values.push(limit);
  const order =
    input.order === "score" && scoreAvailable
      ? ` ORDER BY ${quoteIdentifier(qualifiedExtension)}.${quoteIdentifier("pgroonga_score")}(${tableAlias}.tableoid, ${tableAlias}.ctid) DESC`
      : input.order === "ascending"
        ? ` ORDER BY ${tableAlias}.${quoteIdentifier(input.target.column)} ASC`
        : "";
  const sql = `SELECT ${selections.join(", ")} FROM ${qualifiedTable} AS ${tableAlias} WHERE ${filters.join(" AND ")}${order} LIMIT $${values.length}`;
  return {
    sql,
    values,
    index,
    profile,
    scoreAvailable,
    snippetAvailable,
    warnings,
    selectedColumns,
  };
}

export function supportedSearchModes(): SearchMode[] {
  return ["keyword", "query", "prefix", "exact", "regexp", "similar"];
}
