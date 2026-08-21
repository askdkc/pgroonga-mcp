import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";

import type { Config } from "../config.js";
import { AppError, errorMessage } from "../errors.js";
import type { Logger } from "../logging.js";

export type DbClient = Pick<PoolClient, "query">;

export class Database {
  private readonly pool: Pool | undefined;

  public constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    if (!config.databaseUrl) {
      this.pool = undefined;
      return;
    }

    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 5,
      application_name: "pgroonga-mcp",
      statement_timeout: config.statementTimeoutMs,
      query_timeout: config.statementTimeoutMs + 500,
      connectionTimeoutMillis: Math.max(config.lockTimeoutMs, 1000),
    });
    this.pool.on("error", (error) =>
      this.logger.error("postgres pool error", { error: errorMessage(error) }),
    );
  }

  private requirePool(): Pool {
    if (!this.pool) {
      throw new AppError(
        "database_unavailable",
        "A PostgreSQL connection URL is not configured. Set PGROONGA_DATABASE_URL or provide a PostgreSQL DATABASE_URL in .env.",
      );
    }
    return this.pool;
  }

  public async withReadOnly<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL row_security = on");
      await client.query(`SET LOCAL statement_timeout = '${this.config.statementTimeoutMs}ms'`);
      await client.query(`SET LOCAL lock_timeout = '${this.config.lockTimeoutMs}ms'`);
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        this.logger.error("postgres rollback failed", { error: errorMessage(rollbackError) });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.requirePool().query<T>(text, values);
  }

  public async close(): Promise<void> {
    await this.pool?.end();
  }
}
