import { AppError } from "../errors.js";

const IDENTIFIER_PATTERN = /^[^\0]+$/u;

/** Quote an identifier only after the caller has resolved it from PostgreSQL catalogs. */
export function quoteIdentifier(identifier: string): string {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new AppError("invalid_identifier", "Identifiers must be non-empty and NUL-free");
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function quoteQualifiedIdentifier(schema: string, name: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
}

export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function qualifiedName(schema: string, name: string): string {
  return `${schema}.${name}`;
}
