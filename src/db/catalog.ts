import type { QueryResultRow } from "pg";

import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { Logger } from "../logging.js";
import { parseNormalizationProfile } from "../normalization/profile-parser.js";
import { supportedModesForOperatorClass } from "../search/operator-map.js";
import type { DbClient } from "./pool.js";

export interface IndexedTarget {
  position: number;
  isKey: boolean;
  attributeNumber: number;
  columnName: string | null;
  expression: string | null;
  typeName: string | null;
  operatorClass: string;
  supportedModes: string[];
}

export interface IndexMetadata {
  oid: string;
  indexSchema: string;
  indexName: string;
  qualifiedIndexName: string;
  tableOid: string;
  tableSchema: string;
  tableName: string;
  qualifiedTableName: string;
  indexDefinition: string;
  reloptions: string[];
  valid: boolean;
  ready: boolean;
  sizeBytes: string;
  predicate: string | null;
  targets: IndexedTarget[];
  includedColumns: string[];
  supported: boolean;
  unsupportedReasons: string[];
  normalizationProfile: ReturnType<typeof parseNormalizationProfile>;
}

export interface TableColumn {
  name: string;
  typeName: string;
  nullable: boolean;
  ordinal: number;
}

interface IndexRow extends QueryResultRow {
  index_oid: string;
  index_schema: string;
  index_name: string;
  table_oid: string;
  table_schema: string;
  table_name: string;
  index_definition: string;
  reloptions: string[] | null;
  valid: boolean;
  ready: boolean;
  size_bytes: string;
  predicate: string | null;
  position: number;
  is_key: boolean;
  attribute_number: number;
  column_name: string | null;
  type_name: string | null;
  expression: string | null;
  operator_class: string;
}

interface ColumnRow extends QueryResultRow {
  name: string;
  type_name: string;
  nullable: boolean;
  ordinal: number;
}

export interface IndexFilters {
  schema?: string | undefined;
  table?: string | undefined;
}

function allowedTable(config: Config, schema: string, table: string): boolean {
  if (!config.allowedSchemas.includes(schema)) return false;
  if (config.allowedTables.length === 0) return true;
  return (
    config.allowedTables.includes(`${schema}.${table}`) || config.allowedTables.includes(table)
  );
}

export class CatalogService {
  public constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  public async listIndexes(client: DbClient, filters: IndexFilters = {}): Promise<IndexMetadata[]> {
    const values: unknown[] = [];
    const conditions = ["am.amname = 'pgroonga'", "ns.nspname = ANY($1::text[])"];
    values.push(this.config.allowedSchemas);
    if (filters.schema) {
      values.push(filters.schema);
      conditions.push(`ns.nspname = $${values.length}`);
    }
    if (filters.table) {
      values.push(filters.table);
      conditions.push(`tbl.relname = $${values.length}`);
    }
    const result = await client.query<IndexRow>(
      `SELECT idx.oid::text AS index_oid,
              ns.nspname AS index_schema,
              idx.relname AS index_name,
              tbl.oid::text AS table_oid,
              tbl_ns.nspname AS table_schema,
              tbl.relname AS table_name,
              pg_get_indexdef(idx.oid) AS index_definition,
              idx.reloptions,
              i.indisvalid AS valid,
              i.indisready AS ready,
              pg_relation_size(idx.oid)::text AS size_bytes,
              pg_get_expr(i.indpred, i.indrelid) AS predicate,
              targets.position,
              targets.is_key,
              targets.attribute_number,
              targets.column_name,
              targets.type_name,
              targets.expression,
              targets.operator_class
         FROM pg_index AS i
         JOIN pg_class AS idx ON idx.oid = i.indexrelid
         JOIN pg_namespace AS ns ON ns.oid = idx.relnamespace
         JOIN pg_am AS am ON am.oid = idx.relam
         JOIN pg_class AS tbl ON tbl.oid = i.indrelid
         JOIN pg_namespace AS tbl_ns ON tbl_ns.oid = tbl.relnamespace
         JOIN LATERAL (
           SELECT sub.position,
                  sub.is_key,
                  sub.attribute_number,
                  att.attname AS column_name,
                  format_type(att.atttypid, att.atttypmod) AS type_name,
                  CASE WHEN sub.attribute_number = 0 THEN pg_get_expr(i.indexprs, i.indrelid) END AS expression,
                  opc.opcname AS operator_class
             FROM generate_subscripts(i.indkey, 1) AS subscript(position)
             CROSS JOIN LATERAL (
               SELECT subscript.position AS position,
                      subscript.position <= i.indnkeyatts AS is_key,
                      i.indkey[subscript.position]::integer AS attribute_number
             ) AS sub
             LEFT JOIN pg_attribute AS att
               ON att.attrelid = i.indrelid
              AND att.attnum = sub.attribute_number
             JOIN pg_opclass AS opc ON opc.oid = i.indclass[sub.position]
         ) AS targets ON true
        WHERE ${conditions.join(" AND ")}
        ORDER BY ns.nspname, idx.relname, targets.position`,
      values,
    );

    const byOid = new Map<string, IndexMetadata>();
    for (const row of result.rows) {
      if (!allowedTable(this.config, row.table_schema, row.table_name)) continue;
      let index = byOid.get(row.index_oid);
      if (!index) {
        const reloptions = row.reloptions ?? [];
        index = {
          oid: row.index_oid,
          indexSchema: row.index_schema,
          indexName: row.index_name,
          qualifiedIndexName: `${row.index_schema}.${row.index_name}`,
          tableOid: row.table_oid,
          tableSchema: row.table_schema,
          tableName: row.table_name,
          qualifiedTableName: `${row.table_schema}.${row.table_name}`,
          indexDefinition: row.index_definition,
          reloptions,
          valid: row.valid,
          ready: row.ready,
          sizeBytes: row.size_bytes,
          predicate: row.predicate,
          targets: [],
          includedColumns: [],
          supported: true,
          unsupportedReasons: [],
          normalizationProfile: parseNormalizationProfile(
            `${row.index_schema}.${row.index_name}`,
            reloptions,
          ),
        };
        byOid.set(row.index_oid, index);
      }
      const target: IndexedTarget = {
        position: row.position,
        isKey: row.is_key,
        attributeNumber: row.attribute_number,
        columnName: row.column_name,
        expression: row.expression,
        typeName: row.type_name,
        operatorClass: row.operator_class,
        supportedModes: supportedModesForOperatorClass(row.operator_class),
      };
      index.targets.push(target);
      if (!target.isKey && target.columnName) index.includedColumns.push(target.columnName);
      if (!target.columnName || target.expression) {
        index.supported = false;
        index.unsupportedReasons.push(`index target ${row.position} is an expression`);
      }
    }
    for (const index of byOid.values()) {
      const keyTargets = index.targets.filter((target) => target.isKey);
      if (keyTargets.length !== 1) {
        index.supported = false;
        index.unsupportedReasons.push("compound PGroonga indexes are discovery-only in the MVP");
      }
      if (index.predicate) {
        index.supported = false;
        index.unsupportedReasons.push("partial PGroonga indexes are discovery-only in the MVP");
      }
      if (!index.valid || !index.ready) {
        index.supported = false;
        index.unsupportedReasons.push("index is not valid and ready");
      }
    }
    this.logger.debug("listed PGroonga indexes", { count: byOid.size });
    return [...byOid.values()];
  }

  public async tableColumns(
    client: DbClient,
    schema: string,
    table: string,
  ): Promise<TableColumn[]> {
    if (!allowedTable(this.config, schema, table)) {
      throw new AppError("not_allowlisted", `Table ${schema}.${table} is not allowlisted`);
    }
    const result = await client.query<ColumnRow>(
      `SELECT a.attname AS name,
              format_type(a.atttypid, a.atttypmod) AS type_name,
              NOT a.attnotnull AS nullable,
              a.attnum AS ordinal
         FROM pg_attribute AS a
         JOIN pg_class AS c ON c.oid = a.attrelid
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
          AND c.relname = $2
          AND a.attnum > 0
          AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, table],
    );
    return result.rows.map((row) => ({
      name: row.name,
      typeName: row.type_name,
      nullable: row.nullable,
      ordinal: row.ordinal,
    }));
  }
}
