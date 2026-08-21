# pgroonga-mcp

Read-only PostgreSQL search and diagnostics over the [Model Context Protocol](https://modelcontextprotocol.io/). The server discovers the installed PGroonga schema and capabilities, resolves search targets from PostgreSQL catalogs, and binds query/filter values as parameters.

It does not expose arbitrary SQL, `pgroonga_command`, DDL, dictionary mutation, or repair operations.

## Requirements

- Node.js 22 or newer.
- PostgreSQL with the PGroonga extension installed.
- A dedicated PostgreSQL role that is neither a superuser nor `BYPASSRLS`.
- An MCP host that supports local stdio servers.

The npm package supplies the MCP server only. It does not install PostgreSQL or PGroonga.

## Install

For a project installation:

```sh
npm i @askdkc/pgroonga-mcp
```

The server can start without a database URL, so an MCP host or AI agent can use it for
tool discovery and SQL-generation workflows. Database-backed tools return a structured
`database_unavailable` error until a PostgreSQL URL is configured.

For a global installation:

```sh
npm i --global @askdkc/pgroonga-mcp
pgroonga-mcp
```

The server communicates over stdin/stdout. Logs go to stderr so they do not corrupt the MCP protocol stream.

## MCP host configuration

The exact configuration file depends on the MCP host. A generic stdio configuration looks like this:

```json
{
  "mcpServers": {
    "pgroonga": {
      "command": "npx",
      "args": ["--yes", "@askdkc/pgroonga-mcp"],
      "env": {
        "PGROONGA_DATABASE_URL": "postgresql://pgroonga_mcp@127.0.0.1:5432/app",
        "PGROONGA_ALLOWED_SCHEMAS": "public",
        "PGROONGA_ALLOWED_TABLES": "public.documents"
      }
    }
  }
}
```

The npm package name is `@askdkc/pgroonga-mcp`, while the installed executable remains `pgroonga-mcp`. Use that executable instead of `npx` when the package is installed globally. Do not put database passwords in a committed configuration file; use the MCP host's environment/secret facility. The server loads `.env` from its current working directory when present, without overriding existing process environment variables. Set `PGROONGA_ENV_FILE` when the project env file is elsewhere.

## Database grants

Use a least-privilege role. Replace the schema, tables, and PGroonga extension schema with the names from your deployment:

```sql
CREATE ROLE pgroonga_mcp LOGIN PASSWORD 'use-a-secret-manager';
GRANT CONNECT ON DATABASE app TO pgroonga_mcp;
GRANT USAGE ON SCHEMA public, extensions TO pgroonga_mcp;
GRANT SELECT ON TABLE public.documents TO pgroonga_mcp;
```

Grant `SELECT` on any NormalizerTable dictionary tables used by the configured indexes. Do not grant `SUPERUSER`, `BYPASSRLS`, or `CREATE` on application schemas. Keep row-level security policies enabled; each operation runs in a read-only transaction with `row_security = on`.

## Configuration

All settings are environment variables. `PGROONGA_DATABASE_URL` is optional. If it is absent, a PostgreSQL URL in `DATABASE_URL`, `POSTGRES_URL`, or `POSTGRESQL_URL` is used when available. Non-PostgreSQL values are ignored. The default allowlist is the `public` schema; an empty `PGROONGA_ALLOWED_TABLES` allows all tables in the allowed schemas, so set it explicitly in production. Tables may be written as `schema.table` or as a table name.

| Variable                                 |   Default | Description                         |
| ---------------------------------------- | --------: | ----------------------------------- |
| `PGROONGA_DATABASE_URL`                  |         — | Optional PostgreSQL connection URL  |
| `PGROONGA_ENV_FILE`                      |    `.env` | Project env file to load            |
| `PGROONGA_ALLOWED_SCHEMAS`               |  `public` | Comma-separated schema allowlist    |
| `PGROONGA_ALLOWED_TABLES`                |     empty | Comma-separated table allowlist     |
| `PGROONGA_STATEMENT_TIMEOUT_MS`          |    `5000` | PostgreSQL statement timeout        |
| `PGROONGA_LOCK_TIMEOUT_MS`               |    `1000` | PostgreSQL lock timeout             |
| `PGROONGA_DEFAULT_LIMIT`                 |      `20` | Default search row limit            |
| `PGROONGA_MAX_ROWS`                      |     `100` | Maximum search row limit            |
| `PGROONGA_MAX_RESPONSE_BYTES`            | `1048576` | Serialized response limit           |
| `PGROONGA_MAX_TEXT_BYTES`                |  `131072` | Per-string result limit             |
| `PGROONGA_MAX_NORMALIZATION_INPUT_BYTES` |   `16384` | Normalization input limit           |
| `PGROONGA_MAX_VARIANTS`                  |     `500` | Variant lookup limit                |
| `PGROONGA_LOG_LEVEL`                     |    `info` | `debug`, `info`, `warn`, or `error` |
| `PGROONGA_TRANSPORT`                     |   `stdio` | Only `stdio` is currently supported |

A complete development example is in [.env.example](.env.example). The environment example and the compact NormalizerTable fixture under `examples/itaiji/` are included in the npm tarball.

## Tools

- `pgroonga_server_info` — PostgreSQL, PGroonga, Groonga, and feature capabilities.
- `pgroonga_list_indexes` — catalog-resolved PGroonga indexes and supported modes.
- `pgroonga_search` — bounded search with structured filters.
- `pgroonga_explain_search` — non-executing `EXPLAIN (FORMAT JSON)` for a validated search.
- `pgroonga_health` — available PGroonga health checks.
- `pgroonga_list_normalization_profiles` — discovered index normalizer chains.
- `pgroonga_normalize_text` — normalize text using a discovered index profile.
- `pgroonga_lookup_variants` — bounded NormalizerTable variant lookup.
- `pgroonga_validate_normalization_profile` — validate dictionary mappings without modifying them.

Example `pgroonga_search` input:

```json
{
  "target": { "schema": "public", "table": "documents", "column": "body" },
  "mode": "keyword",
  "query": "PGroonga",
  "returnColumns": ["id", "body"],
  "limit": 20
}
```

Search supports `text`, `varchar`, `text[]`, and `jsonb` targets when a compatible, valid, ready PGroonga index is discovered. Supported modes are `keyword`, `query`, `prefix`, `exact`, and `regexp`. `similar` is reserved for a later release. Compound, expression, and partial indexes are reported but are discovery-only in this release.

Normalizer profiles are read from trusted index reloptions. `NormalizerTable` dependencies are resolved through `pgroonga_table_name`; dictionary changes are reported as requiring `REINDEX`, and dictionary freshness remains `unknown` unless a future managed revision table is installed. Highlighting is disabled unless the required source-location and source-offset options are present.

## Development and release checks

```sh
npm ci
npm run verify
npm pack --dry-run
```

`npm run verify` runs formatting, linting, type checking, the unit/contract tests, and the TypeScript build. The package uses `prepublishOnly` and `prepack` to repeat the relevant checks/build before publication. Once authenticated with npm and after reviewing `npm pack --dry-run`, publish the current version with:

```sh
npm publish
```

The repository is [askdkc/pgroonga-mcp](https://github.com/askdkc/pgroonga-mcp). The compact NormalizerTable fixture is in [examples/itaiji/schema.sql](examples/itaiji/schema.sql).
