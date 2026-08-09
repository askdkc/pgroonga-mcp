import { AppError } from "../errors.js";

export interface NormalizerDefinition {
  name: string;
  raw: string;
  options: Record<string, string | number | boolean>;
  version: string | null;
}

export interface DictionaryDependency {
  dictionaryIndex: string;
  dictionaryColumn: string;
  targetColumn: string;
  normalizedColumn: string;
}

export interface NormalizationProfile {
  searchIndex: string;
  normalizerChain: NormalizerDefinition[];
  normalizerSpec: string;
  normalizersMapping: Record<
    string,
    { normalizerSpec: string; normalizerChain: NormalizerDefinition[] }
  >;
  tokenizer: string | null;
  dictionaryDependencies: DictionaryDependency[];
  highlightCompatible: boolean;
  staleness: "unknown";
}

function splitTopLevel(value: string, separator = ","): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0)
        throw new AppError(
          "invalid_normalizer",
          "Normalizer specification has an unmatched ')' character",
        );
    } else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote || depth !== 0)
    throw new AppError(
      "invalid_normalizer",
      "Normalizer specification has unbalanced quotes or parentheses",
    );
  const last = value.slice(start).trim();
  if (last) parts.push(last);
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\'", "'");
  }
  return trimmed;
}

function parseOptionValue(value: string): string | number | boolean {
  const unquoted = unquote(value);
  if (unquoted === "true") return true;
  if (unquoted === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/u.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function parseOptions(raw: string): Record<string, string | number | boolean> {
  const options: Record<string, string | number | boolean> = {};
  if (!raw.trim()) return options;
  const tokens = splitTopLevel(raw);
  for (let index = 0; index < tokens.length; index += 2) {
    const key = unquote(tokens[index] ?? "");
    const value = tokens[index + 1];
    if (!key || value === undefined)
      throw new AppError("invalid_normalizer", "Normalizer options must be key/value pairs");
    options[key] = parseOptionValue(value);
  }
  return options;
}

export function parseNormalizerChain(spec: string): NormalizerDefinition[] {
  return splitTopLevel(spec).map((raw) => {
    const match = /^(?<name>[A-Za-z][A-Za-z0-9_]*)\s*(?:\((?<options>[\s\S]*)\))?$/u.exec(raw);
    if (!match?.groups?.name)
      throw new AppError("invalid_normalizer", `Cannot parse normalizer: ${raw}`);
    const name = match.groups.name;
    const options = parseOptions(match.groups.options ?? "");
    const versionValue = options.version;
    return {
      name,
      raw,
      options,
      version: typeof versionValue === "string" ? versionValue : null,
    };
  });
}

function reloptionsMap(reloptions: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const option of reloptions) {
    const separator = option.indexOf("=");
    if (separator <= 0) continue;
    const key = option.slice(0, separator);
    let value = option.slice(separator + 1);
    if (value.startsWith("'") && value.endsWith("'")) value = unquote(value);
    map.set(key, value);
  }
  return map;
}

function getBoolean(options: Record<string, string | number | boolean>, key: string): boolean {
  return options[key] === true || options[key] === "true";
}

function dictionaryDependencies(normalizers: NormalizerDefinition[]): DictionaryDependency[] {
  const dependencies: DictionaryDependency[] = [];
  for (const normalizer of normalizers) {
    if (normalizer.name !== "NormalizerTable") continue;
    const values = Object.entries(normalizer.options);
    let dictionaryIndex: string | null = null;
    let dictionaryColumn: string | null = null;
    let targetColumn: string | null = null;
    let normalizedColumn: string | null = null;
    for (const [key, value] of values) {
      if (typeof value !== "string") continue;
      const reference = /\$\{table:(?<index>[^}]+)\}\.(?<column>[A-Za-z_][A-Za-z0-9_$]*)/u.exec(
        value,
      );
      if (reference?.groups?.index && reference.groups.column) {
        dictionaryIndex = reference.groups.index;
        dictionaryColumn = reference.groups.column;
        normalizedColumn = reference.groups.column;
      } else if (key === "target") {
        targetColumn = value;
      }
    }
    if (dictionaryIndex && dictionaryColumn && targetColumn && normalizedColumn) {
      dependencies.push({ dictionaryIndex, dictionaryColumn, targetColumn, normalizedColumn });
    }
  }
  return dependencies;
}

function chainHighlightCompatible(
  tokenizer: string | null,
  normalizers: NormalizerDefinition[],
  hasDictionary: boolean,
): boolean {
  if (!hasDictionary) return true;
  const hasLocation = tokenizer
    ? /report_source_location["']?\s*,\s*true/iu.test(tokenizer)
    : false;
  const normalizerOffsets = normalizers
    .filter(
      (normalizer) =>
        normalizer.name.startsWith("NormalizerNFKC") || normalizer.name === "NormalizerTable",
    )
    .every((normalizer) => getBoolean(normalizer.options, "report_source_offset"));
  return hasLocation && normalizerOffsets;
}

export function parseNormalizationProfile(
  searchIndex: string,
  reloptions: string[],
): NormalizationProfile | null {
  const options = reloptionsMap(reloptions);
  const normalizerSpec = options.get("normalizers") ?? options.get("normalizer") ?? "";
  const normalizersMapping: Record<
    string,
    { normalizerSpec: string; normalizerChain: NormalizerDefinition[] }
  > = {};
  const mappingValue = options.get("normalizers_mapping");
  if (mappingValue) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(mappingValue);
    } catch {
      throw new AppError("invalid_normalizer", "normalizers_mapping is not valid JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AppError("invalid_normalizer", "normalizers_mapping must be a JSON object");
    }
    for (const [column, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new AppError("invalid_normalizer", `normalizers_mapping.${column} must be a string`);
      }
      normalizersMapping[column] = {
        normalizerSpec: value,
        normalizerChain: value.trim() ? parseNormalizerChain(value) : [],
      };
    }
  }
  if (normalizerSpec === "" && Object.keys(normalizersMapping).length === 0) return null;
  const normalizerChain = normalizerSpec.trim() ? parseNormalizerChain(normalizerSpec) : [];
  const tokenizer = options.get("tokenizer") ?? null;
  const allChains = [
    normalizerChain,
    ...Object.values(normalizersMapping).map((item) => item.normalizerChain),
  ];
  const dictionary = [
    ...new Map(
      allChains
        .flatMap(dictionaryDependencies)
        .map((item) => [
          `${item.dictionaryIndex}\u0000${item.targetColumn}\u0000${item.normalizedColumn}`,
          item,
        ]),
    ).values(),
  ];
  const highlightCompatible = allChains.every((chain) =>
    chainHighlightCompatible(tokenizer, chain, dictionaryDependencies(chain).length > 0),
  );
  return {
    searchIndex,
    normalizerChain,
    normalizerSpec,
    normalizersMapping,
    tokenizer,
    dictionaryDependencies: dictionary,
    highlightCompatible,
    staleness: "unknown",
  };
}

export function parseTableReference(value: string): { index: string; column: string } | null {
  const match = /^\$\{table:(?<index>[^}]+)\}\.(?<column>[A-Za-z_][A-Za-z0-9_$]*)$/u.exec(
    value.trim(),
  );
  if (!match?.groups?.index || !match.groups.column) return null;
  return { index: match.groups.index, column: match.groups.column };
}

export function replaceTableReferences(
  spec: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return spec.replaceAll(
    /\$\{table:(?<index>[^}]+)\}/gu,
    (whole, index: string) => replacements.get(index) ?? whole,
  );
}
