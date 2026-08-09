import { createRequire } from "node:module";

interface PackageMetadata {
  version?: unknown;
}

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as PackageMetadata;

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json must contain a non-empty version");
}

export const packageVersion = packageMetadata.version;
