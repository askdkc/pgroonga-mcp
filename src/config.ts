import { z } from "zod/v4";

import { AppError } from "./errors.js";

const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];

export interface Config {
  databaseUrl: string;
  allowedSchemas: string[];
  allowedTables: string[];
  statementTimeoutMs: number;
  lockTimeoutMs: number;
  defaultLimit: number;
  maxRows: number;
  maxResponseBytes: number;
  maxTextBytes: number;
  maxNormalizationInputBytes: number;
  maxVariants: number;
  logLevel: LogLevel;
  transport: "stdio";
}

function csv(value: string | undefined, fallback: string[]): string[] {
  if (value === undefined || value.trim() === "") return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function integerEnv(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new AppError("invalid_configuration", `${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function rejectNul(values: string[], name: string): void {
  if (values.some((value) => value.includes("\0"))) {
    throw new AppError("invalid_configuration", `${name} must not contain NUL bytes`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.PGROONGA_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new AppError("invalid_configuration", "PGROONGA_DATABASE_URL is required");
  }
  if (databaseUrl.includes("\0")) {
    throw new AppError("invalid_configuration", "PGROONGA_DATABASE_URL must not contain NUL bytes");
  }

  const allowedSchemas = csv(env.PGROONGA_ALLOWED_SCHEMAS, ["public"]);
  const allowedTables = csv(env.PGROONGA_ALLOWED_TABLES, []);
  rejectNul(allowedSchemas, "PGROONGA_ALLOWED_SCHEMAS");
  rejectNul(allowedTables, "PGROONGA_ALLOWED_TABLES");

  const maxRows = integerEnv("PGROONGA_MAX_ROWS", env.PGROONGA_MAX_ROWS, 100, 1);
  const defaultLimit = integerEnv("PGROONGA_DEFAULT_LIMIT", env.PGROONGA_DEFAULT_LIMIT, 20, 1);
  if (defaultLimit > maxRows) {
    throw new AppError(
      "invalid_configuration",
      "PGROONGA_DEFAULT_LIMIT must not exceed PGROONGA_MAX_ROWS",
    );
  }

  const logLevelValue = env.PGROONGA_LOG_LEVEL ?? "info";
  const logLevel = z.enum(logLevels).safeParse(logLevelValue);
  if (!logLevel.success) {
    throw new AppError(
      "invalid_configuration",
      `PGROONGA_LOG_LEVEL must be one of ${logLevels.join(", ")}`,
    );
  }

  const transport = env.PGROONGA_TRANSPORT ?? "stdio";
  if (transport !== "stdio") {
    throw new AppError("invalid_configuration", "Only PGROONGA_TRANSPORT=stdio is implemented");
  }

  return {
    databaseUrl,
    allowedSchemas,
    allowedTables,
    statementTimeoutMs: integerEnv(
      "PGROONGA_STATEMENT_TIMEOUT_MS",
      env.PGROONGA_STATEMENT_TIMEOUT_MS,
      5000,
      1,
    ),
    lockTimeoutMs: integerEnv("PGROONGA_LOCK_TIMEOUT_MS", env.PGROONGA_LOCK_TIMEOUT_MS, 1000, 1),
    defaultLimit,
    maxRows,
    maxResponseBytes: integerEnv(
      "PGROONGA_MAX_RESPONSE_BYTES",
      env.PGROONGA_MAX_RESPONSE_BYTES,
      1_048_576,
      1024,
    ),
    maxTextBytes: integerEnv("PGROONGA_MAX_TEXT_BYTES", env.PGROONGA_MAX_TEXT_BYTES, 131_072, 1),
    maxNormalizationInputBytes: integerEnv(
      "PGROONGA_MAX_NORMALIZATION_INPUT_BYTES",
      env.PGROONGA_MAX_NORMALIZATION_INPUT_BYTES,
      16_384,
      1,
    ),
    maxVariants: integerEnv("PGROONGA_MAX_VARIANTS", env.PGROONGA_MAX_VARIANTS, 500, 1),
    logLevel: logLevel.data,
    transport: "stdio",
  };
}
