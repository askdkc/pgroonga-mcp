export type FindingSeverity = "error" | "warning" | "info";

export interface NormalizationFinding {
  severity: FindingSeverity;
  code: string;
  message: string;
  evidence?: Record<string, unknown>;
}

export interface DictionaryRow {
  target: string | null;
  normalized: string | null;
}

function finding(
  severity: FindingSeverity,
  code: string,
  message: string,
  evidence?: Record<string, unknown>,
): NormalizationFinding {
  return { severity, code, message, ...(evidence ? { evidence } : {}) };
}

export function validateDictionaryRows(rows: DictionaryRow[]): NormalizationFinding[] {
  const findings: NormalizationFinding[] = [];
  const pairCounts = new Map<string, number>();
  const mappings = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.target === null || row.target.trim() === "") {
      findings.push(
        finding("error", "empty_target", "Dictionary target is null or empty", { row }),
      );
    }
    if (row.normalized === null || row.normalized.trim() === "") {
      findings.push(
        finding("error", "empty_normalized", "Dictionary normalized value is null or empty", {
          row,
        }),
      );
    }
    if (row.target === null || row.normalized === null) continue;
    const pair = `${row.target}\u0000${row.normalized}`;
    pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
    const targets = mappings.get(row.target) ?? new Set<string>();
    targets.add(row.normalized);
    mappings.set(row.target, targets);
  }
  for (const [pair, count] of pairCounts) {
    if (count > 1) {
      const [target, normalized] = pair.split("\u0000");
      findings.push(
        finding(
          "warning",
          "duplicate_mapping",
          "The same dictionary mapping occurs more than once",
          { target, normalized, count },
        ),
      );
    }
  }
  for (const [target, normalizeds] of mappings) {
    if (normalizeds.size > 1) {
      findings.push(
        finding("error", "conflicting_mapping", "One target maps to multiple normalized values", {
          target,
          normalizeds: [...normalizeds],
        }),
      );
    }
  }

  const graph = new Map<string, string>();
  for (const [target, normalizeds] of mappings) {
    const normalized = [...normalizeds][0];
    if (normalized !== undefined && normalized !== target) graph.set(target, normalized);
    if (normalized !== undefined && mappings.has(normalized) && normalized !== target) {
      findings.push(
        finding(
          "warning",
          "mapping_chain",
          "A mapping points to another dictionary target; normalization may require multiple passes",
          { target, normalized },
        ),
      );
    }
  }
  const state = new Map<string, "visiting" | "visited">();
  const path: string[] = [];
  const visit = (node: string): void => {
    const currentState = state.get(node);
    if (currentState === "visited") return;
    if (currentState === "visiting") {
      const start = path.indexOf(node);
      findings.push(
        finding("error", "mapping_cycle", "Dictionary mappings contain a cycle", {
          cycle: path.slice(Math.max(start, 0)),
        }),
      );
      return;
    }
    state.set(node, "visiting");
    path.push(node);
    const next = graph.get(node);
    if (next) visit(next);
    path.pop();
    state.set(node, "visited");
  };
  for (const node of graph.keys()) visit(node);

  for (const [target, normalized] of graph) {
    if (target !== normalized && graph.has(normalized)) {
      findings.push(
        finding(
          "warning",
          "non_idempotent_mapping",
          "A mapping is not idempotent as a single dictionary lookup",
          { target, normalized, next: graph.get(normalized) },
        ),
      );
    }
  }
  const targets = [...mappings.keys()];
  for (const target of targets) {
    for (const other of targets) {
      if (target !== other && (target.startsWith(other) || other.startsWith(target))) {
        findings.push(
          finding(
            "info",
            "overlapping_targets",
            "Overlapping targets are informational; NormalizerTable uses longest-prefix behavior",
            { target, other },
          ),
        );
      }
    }
  }
  return findings;
}

export function validateIdempotence(
  rows: DictionaryRow[],
  normalize: (value: string) => string,
): NormalizationFinding[] {
  const findings: NormalizationFinding[] = [];
  for (const row of rows) {
    if (row.target === null) continue;
    const once = normalize(row.target);
    const twice = normalize(once);
    if (once !== twice) {
      findings.push(
        finding(
          "error",
          "non_idempotent_normalizer",
          "Applying the discovered normalizer twice changes the value",
          { target: row.target, once, twice },
        ),
      );
    }
  }
  return findings;
}
