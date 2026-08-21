import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import dotenv from "dotenv";
import { z } from "zod/v4";

import { AppError } from "./errors.js";

const logLevels = ["debug", "info", "warn", "error"] as const;
const databaseEnvNames = [
  "PGROONGA_DATABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
] as const;
const fallbackDatabaseEnvNames = ["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL"] as const;

export type LogLevel = (typeof logLevels)[number];

export interface Config {
  databaseUrl: string | undefined;
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

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function loadProjectEnv(env: NodeJS.ProcessEnv = process.env): void {
  const configuredPath = env.PGROONGA_ENV_FILE?.trim();
  const envFilePath = configuredPath || ".env";
  let content: string;
  try {
    content = readFileSync(resolve(envFilePath), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return;
    throw new AppError(
      "invalid_configuration",
      `Unable to load environment file ${envFilePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const hasExplicitDatabaseEnv = databaseEnvNames.some((name) => env[name]?.trim());
  for (const [key, value] of Object.entries(dotenv.parse(content))) {
    if (hasExplicitDatabaseEnv && (databaseEnvNames as readonly string[]).includes(key)) continue;
    if (env[key] === undefined) env[key] = value;
  }
}

function isPostgresUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  } catch {
    return false;
  }
}

function databaseUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const explicitUrl = env.PGROONGA_DATABASE_URL?.trim();
  if (explicitUrl) return explicitUrl;

  for (const name of fallbackDatabaseEnvNames) {
    const value = env[name]?.trim();
    if (value && isPostgresUrl(value)) return value;
  }
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = databaseUrlFromEnv(env);
  if (databaseUrl?.includes("\0")) {
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
