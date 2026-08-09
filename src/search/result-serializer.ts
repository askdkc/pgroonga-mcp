import { Buffer } from "node:buffer";

import type { Config } from "../config.js";

export type SerializedValue =
  | string
  | number
  | boolean
  | null
  | SerializedValue[]
  | { value: string; truncated: true }
  | { bytea: "omitted" }
  | { [key: string]: SerializedValue };

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (result && Buffer.byteLength(`${result}…`, "utf8") > maxBytes) result = result.slice(0, -1);
  return `${result}…`;
}

export function serializePostgresValue(value: unknown, config: Config, depth = 0): SerializedValue {
  if (depth > 8) return { value: "[depth limit]", truncated: true };
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const truncated = truncateUtf8(value, config.maxTextBytes);
    return truncated === value ? value : { value: truncated, truncated: true };
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytea: "omitted" };
  if (Array.isArray(value))
    return value.map((item) => serializePostgresValue(item, config, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        serializePostgresValue(item, config, depth + 1),
      ]),
    );
  }
  return String(value);
}

export interface SerializedRows {
  rows: Record<string, SerializedValue>[];
  truncated: boolean;
  warnings: string[];
}

export function serializeRows(rows: Record<string, unknown>[], config: Config): SerializedRows {
  const result: Record<string, SerializedValue>[] = [];
  const warnings: string[] = [];
  let truncated = false;
  for (const row of rows) {
    const serialized = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, serializePostgresValue(value, config)]),
    );
    const candidate = JSON.stringify([...result, serialized]);
    if (Buffer.byteLength(candidate, "utf8") > config.maxResponseBytes) {
      truncated = true;
      warnings.push(
        `Response stopped at ${result.length} rows to stay within the response byte limit`,
      );
      break;
    }
    result.push(serialized);
  }
  return { rows: result, truncated, warnings };
}
