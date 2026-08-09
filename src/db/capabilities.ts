import type { QueryResultRow } from "pg";

import { AppError } from "../errors.js";
import type { Logger } from "../logging.js";
import type { DbClient } from "./pool.js";
import { quoteIdentifier } from "./sql.js";

interface ExtensionRow extends QueryResultRow {
  extension_version: string;
  extension_schema: string;
}

interface FunctionRow extends QueryResultRow {
  name: string;
}

interface ServerRow extends QueryResultRow {
  postgres_version: string;
  database_name: string;
  role_name: string;
  in_recovery: boolean;
  default_read_only: string;
  libgroonga_version: string | null;
  role_superuser: boolean;
  role_bypass_rls: boolean;
}

export interface CapabilityFlags {
  hasExtension: boolean;
  hasNormalize: boolean;
  hasTokenize: boolean;
  hasUnifyIterationMark: boolean;
  hasBrokenIndexCheck: boolean;
  hasLaggedIndexCheck: boolean;
  hasWalStatus: boolean;
  hasWritableCheck: boolean;
  hasScore: boolean;
  hasHighlight: boolean;
  hasTableName: boolean;
  hasSemanticSearch: boolean;
}

export interface Capabilities {
  postgresVersion: string;
  extensionVersion: string | null;
  extensionSchema: string | null;
  groongaVersion: string | null;
  databaseName: string;
  roleName: string;
  readOnly: boolean;
  capabilities: CapabilityFlags;
  notes: string[];
}

export async function discoverCapabilities(
  client: DbClient,
  logger: Logger,
): Promise<Capabilities> {
  const serverResult = await client.query<ServerRow>(
    `SELECT version() AS postgres_version,
            current_database() AS database_name,
            current_user AS role_name,
            pg_is_in_recovery() AS in_recovery,
            current_setting('default_transaction_read_only') AS default_read_only,
            current_setting('pgroonga.libgroonga_version', true) AS libgroonga_version,
            COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS role_superuser,
            COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false) AS role_bypass_rls`,
  );
  const server = serverResult.rows[0];
  if (!server) throw new AppError("database_error", "PostgreSQL did not return server information");
  if (server.role_superuser || server.role_bypass_rls) {
    throw new AppError(
      "unsafe_database_role",
      "The configured PostgreSQL role must not be a superuser or have BYPASSRLS",
    );
  }

  const extensionResult = await client.query<ExtensionRow>(
    `SELECT e.extversion AS extension_version, n.nspname AS extension_schema
       FROM pg_extension AS e
       JOIN pg_namespace AS n ON n.oid = e.extnamespace
      WHERE e.extname = 'pgroonga'`,
  );
  const extension = extensionResult.rows[0] ?? null;
  const names = [
    "pgroonga_normalize",
    "pgroonga_tokenize",
    "pgroonga_list_broken_indexes",
    "pgroonga_list_lagged_indexes",
    "pgroonga_wal_status",
    "pgroonga_is_writable",
    "pgroonga_score",
    "pgroonga_highlight_html",
    "pgroonga_table_name",
    "pgroonga_language_model_vectorize",
  ];
  const functionResult = extension
    ? await client.query<FunctionRow>(
        `SELECT DISTINCT p.proname AS name
           FROM pg_proc AS p
           JOIN pg_namespace AS n ON n.oid = p.pronamespace
          WHERE n.oid = $1::regnamespace
            AND p.proname = ANY($2::text[])
            AND p.prokind = 'f'`,
        [extension.extension_schema, names],
      )
    : { rows: [] as FunctionRow[] };
  const available = new Set(functionResult.rows.map((row) => row.name));
  let hasUnifyIterationMark = false;
  const notes: string[] = [];
  if (extension && available.has("pgroonga_normalize")) {
    try {
      await client.query(
        `SELECT ${qualifiedFunction(extension.extension_schema, "pgroonga_normalize")}($1::text, $2::text)`,
        ["", 'NormalizerNFKC("unify_iteration_mark", true)'],
      );
      hasUnifyIterationMark = true;
    } catch (error) {
      notes.push(
        `unify_iteration_mark capability probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const flags: CapabilityFlags = {
    hasExtension: extension !== null,
    hasNormalize: available.has("pgroonga_normalize"),
    hasTokenize: available.has("pgroonga_tokenize"),
    hasUnifyIterationMark,
    hasBrokenIndexCheck: available.has("pgroonga_list_broken_indexes"),
    hasLaggedIndexCheck: available.has("pgroonga_list_lagged_indexes"),
    hasWalStatus: available.has("pgroonga_wal_status"),
    hasWritableCheck: available.has("pgroonga_is_writable"),
    hasScore: available.has("pgroonga_score"),
    hasHighlight: available.has("pgroonga_highlight_html"),
    hasTableName: available.has("pgroonga_table_name"),
    hasSemanticSearch: available.has("pgroonga_language_model_vectorize"),
  };
  if (!extension) notes.push("PGroonga extension is not installed in this database");
  if (!server.libgroonga_version) {
    notes.push(
      "Groonga version is unavailable; capability probes are authoritative for exposed features",
    );
  }
  logger.debug("discovered database capabilities", {
    extensionSchema: extension?.extension_schema,
    extensionVersion: extension?.extension_version,
  });
  return {
    postgresVersion: server.postgres_version,
    extensionVersion: extension?.extension_version ?? null,
    extensionSchema: extension?.extension_schema ?? null,
    groongaVersion: server.libgroonga_version,
    databaseName: server.database_name,
    roleName: server.role_name,
    readOnly: server.in_recovery || server.default_read_only === "on",
    capabilities: flags,
    notes,
  };
}

export function qualifiedFunction(schema: string, functionName: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(functionName)}`;
}
