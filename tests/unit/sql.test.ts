import { describe, expect, it } from "vitest";

import { quoteIdentifier, quoteQualifiedIdentifier } from "../../src/db/sql.js";

describe("identifier quoting", () => {
  it("quotes embedded quotes without accepting SQL fragments", () => {
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(quoteQualifiedIdentifier("public", "biblios")).toBe('"public"."biblios"');
    expect(() => quoteIdentifier("bad\0name")).toThrow();
  });
});
