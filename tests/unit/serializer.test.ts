import { describe, expect, it } from "vitest";

import { serializeRows } from "../../src/search/result-serializer.js";
import type { Config } from "../../src/config.js";

const config: Config = {
  databaseUrl: "postgresql://localhost/db",
  allowedSchemas: ["public"],
  allowedTables: [],
  statementTimeoutMs: 5000,
  lockTimeoutMs: 1000,
  defaultLimit: 20,
  maxRows: 100,
  maxResponseBytes: 90,
  maxTextBytes: 7,
  maxNormalizationInputBytes: 100,
  maxVariants: 10,
  logLevel: "info",
  transport: "stdio",
};

describe("result serialization", () => {
  it("serializes bigint, truncates fields, and bounds the response", () => {
    const result = serializeRows(
      [
        { id: BigInt(10), text: "123456789" },
        { id: BigInt(11), text: "another row" },
      ],
      config,
    );
    expect(result.rows[0]?.id).toBe("10");
    expect(result.rows[0]?.text).toEqual({ value: "1234…", truncated: true });
    expect(result.truncated).toBe(true);
  });
});
