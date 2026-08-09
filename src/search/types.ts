import { z } from "zod/v4";

const identifier = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !value.includes("\0"), "must not contain NUL bytes");

export const searchModeSchema = z.enum([
  "keyword",
  "query",
  "prefix",
  "exact",
  "regexp",
  "similar",
]);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchTargetSchema = z.object({
  schema: identifier,
  table: identifier,
  column: identifier,
});

const filterSchema = z.object({
  column: identifier,
  operator: z.enum(["=", "!=", "<", "<=", ">", ">=", "IS NULL", "IS NOT NULL", "IN"]),
  value: z.unknown().optional(),
});

export const searchInputSchema = z.object({
  target: searchTargetSchema,
  mode: searchModeSchema,
  query: z
    .string()
    .max(131_072)
    .refine((value) => !value.includes("\0"), "must not contain NUL bytes"),
  returnColumns: z.array(identifier).min(1).max(64).default(["*"]),
  filters: z.array(filterSchema).max(50).default([]),
  limit: z.number().int().min(1).max(100).optional(),
  order: z.enum(["score", "ascending", "none"]).default("score"),
  snippet: z
    .object({
      column: identifier,
      maxFragments: z.number().int().min(1).max(10).default(3),
    })
    .optional(),
});

export type SearchInput = z.infer<typeof searchInputSchema>;

export const outputColumnSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);
export const searchOutputSchema = z.object({
  target: searchTargetSchema,
  query: z.string(),
  normalizedQuery: z.string().nullable(),
  normalizationProfile: z.string().nullable(),
  rows: z.array(z.record(z.string(), outputColumnSchema)),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  executionMs: z.number().nonnegative(),
  scoreAvailable: z.boolean(),
  snippetAvailable: z.boolean(),
  warnings: z.array(z.string()),
});
export type SearchOutput = z.infer<typeof searchOutputSchema>;

export const serverInfoOutputSchema = z.object({
  postgresVersion: z.string(),
  extensionVersion: z.string().nullable(),
  extensionSchema: z.string().nullable(),
  groongaVersion: z.string().nullable(),
  databaseName: z.string(),
  roleName: z.string(),
  readOnly: z.boolean(),
  supportedSearchModes: z.array(searchModeSchema),
  capabilities: z.record(z.string(), z.boolean()),
  notes: z.array(z.string()),
});

export const indexOutputSchema = z.object({
  index: z.string(),
  table: z.string(),
  definition: z.string(),
  targets: z.array(z.record(z.string(), z.unknown())),
  includedColumns: z.array(z.string()),
  reloptions: z.array(z.string()),
  valid: z.boolean(),
  ready: z.boolean(),
  sizeBytes: z.string(),
  predicate: z.string().nullable(),
  supported: z.boolean(),
  unsupportedReasons: z.array(z.string()),
  normalizationProfile: z.unknown().nullable(),
});

export const normalizeTextInputSchema = z.object({
  index: identifier,
  text: z.string().refine((value) => !value.includes("\0"), "must not contain NUL bytes"),
});

export const lookupVariantsInputSchema = z.object({
  index: identifier,
  input: z.string().refine((value) => !value.includes("\0"), "must not contain NUL bytes"),
});

export const validateProfileInputSchema = z.object({ index: identifier });
