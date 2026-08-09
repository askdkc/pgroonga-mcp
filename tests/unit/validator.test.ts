import { describe, expect, it } from "vitest";

import { validateDictionaryRows, validateIdempotence } from "../../src/normalization/validator.js";

describe("normalization dictionary validation", () => {
  it("reports empty, conflicting, chained, cyclic, and overlapping mappings", () => {
    const findings = validateDictionaryRows([
      { target: null, normalized: "x" },
      { target: "A", normalized: "B" },
      { target: "A", normalized: "C" },
      { target: "B", normalized: "C" },
      { target: "C", normalized: "B" },
      { target: "AB", normalized: "D" },
      { target: "A", normalized: "B" },
    ]);
    const codes = findings.map((finding) => finding.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "empty_target",
        "conflicting_mapping",
        "mapping_cycle",
        "mapping_chain",
        "overlapping_targets",
        "duplicate_mapping",
      ]),
    );
  });

  it("checks actual idempotence separately from graph structure", () => {
    const findings = validateIdempotence([{ target: "A", normalized: "B" }], (value) =>
      value === "A" ? "B" : value === "B" ? "C" : value,
    );
    expect(findings[0]?.code).toBe("non_idempotent_normalizer");
  });
});
