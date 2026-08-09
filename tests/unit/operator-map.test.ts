import { describe, expect, it } from "vitest";

import {
  isSupportedMode,
  operatorForMode,
  supportedModesForOperatorClass,
} from "../../src/search/operator-map.js";

describe("PGroonga operator map", () => {
  it("maps modes to the planned operators", () => {
    expect(operatorForMode("keyword")).toBe("&@");
    expect(operatorForMode("query")).toBe("&@~");
    expect(operatorForMode("prefix")).toBe("&^");
    expect(operatorForMode("exact")).toBe("&=");
    expect(operatorForMode("regexp")).toBe("&~");
  });

  it("recognizes compatible v2 operator classes", () => {
    const modes = supportedModesForOperatorClass("pgroonga_text_full_text_search_ops_v2");
    expect(modes).toEqual(expect.arrayContaining(["keyword", "query"]));
    expect(isSupportedMode("pgroonga_text_term_search_ops_v2", "prefix")).toBe(true);
    expect(isSupportedMode("pgroonga_text_full_text_search_ops_v2", "regexp")).toBe(false);
  });
});
