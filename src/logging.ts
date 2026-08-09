import type { LogLevel } from "./config.js";

const rank: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(postgres(?:ql)?):\/\/[^\s]+/gi, "$1://[redacted]")
      .replace(/(password|passwd|secret|token|api[_-]?key)\s*[=:]\s*[^\s,}]+/gi, "$1=[redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}

export function createLogger(level: LogLevel): Logger {
  const write = (
    messageLevel: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void => {
    if (rank[messageLevel] < rank[level]) return;
    const redactedFields = fields ? (redact(fields) as Record<string, unknown>) : {};
    const entry = { level: messageLevel, message, ...redactedFields };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
}
