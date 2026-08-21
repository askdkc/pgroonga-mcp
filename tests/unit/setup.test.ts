import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applySetup,
  parseClientList,
  parseSetupArgs,
  planSetup,
  SETUP_CLIENTS,
} from "../../src/setup.js";

const projectDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    projectDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("setup argument parsing", () => {
  it("parses explicit clients and setup flags", () => {
    expect(
      parseSetupArgs([
        "--clients",
        "claude,opencode",
        "--force",
        "--dry-run",
        "--cwd",
        "./project",
      ]),
    ).toEqual({
      all: false,
      clients: ["claude", "opencode"],
      cwd: "./project",
      dryRun: true,
      force: true,
      help: false,
    });
  });

  it("supports aliases and the all selection", () => {
    expect(parseClientList("claude-code,open-code")).toEqual(["claude", "opencode"]);
    expect(parseClientList("all")).toEqual([...SETUP_CLIENTS]);
  });
});

describe("project MCP setup", () => {
  it("creates all supported project configurations and is idempotent", async () => {
    const directory = await createProjectDirectory();

    const created = await applySetup({
      cwd: directory,
      clients: SETUP_CLIENTS,
      force: false,
    });
    expect(created.map((change) => change.action)).toEqual([
      "create",
      "create",
      "create",
      "create",
    ]);

    const claude = JSON.parse(await readFile(join(directory, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(claude.mcpServers.pgroonga).toEqual({
      command: "npx",
      args: ["--no-install", "pgroonga-mcp"],
    });

    const opencode = JSON.parse(await readFile(join(directory, "opencode.json"), "utf8")) as {
      $schema: string;
      mcp: Record<string, Record<string, unknown>>;
    };
    expect(opencode.$schema).toBe("https://opencode.ai/config.json");
    expect(opencode.mcp.pgroonga).toEqual({
      type: "local",
      command: ["npx", "--no-install", "pgroonga-mcp"],
      cwd: ".",
      enabled: true,
    });

    expect(await readFile(join(directory, ".codex", "config.toml"), "utf8")).toContain(
      '[mcp_servers.pgroonga]\ncommand = "npx"\nargs = ["--no-install", "pgroonga-mcp"]',
    );
    expect(await readFile(join(directory, "cordis.yml"), "utf8")).toContain(
      "name: '@deepseek-ai/dsh-mcp-client'",
    );

    const repeated = await applySetup({
      cwd: directory,
      clients: SETUP_CLIENTS,
      force: false,
    });
    expect(repeated.map((change) => change.action)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
  });

  it("preserves unrelated JSON and JSONC settings", async () => {
    const directory = await createProjectDirectory();
    await writeFile(
      join(directory, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other" } }, private: true }),
    );
    await writeFile(
      join(directory, "opencode.jsonc"),
      [
        "{",
        "  // Keep the existing model setting.",
        '  "model": "provider/model",',
        '  "mcp": {},',
        "}",
        "",
      ].join("\n"),
    );

    await applySetup({ cwd: directory, clients: ["claude", "opencode"], force: false });

    const claude = JSON.parse(await readFile(join(directory, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
      private: boolean;
    };
    expect(claude.private).toBe(true);
    expect(claude.mcpServers.other).toEqual({ command: "other" });

    const opencode = JSON.parse(await readFile(join(directory, "opencode.jsonc"), "utf8")) as {
      model: string;
      mcp: Record<string, unknown>;
    };
    expect(opencode.model).toBe("provider/model");
    expect(opencode.mcp.pgroonga).toBeDefined();
  });

  it("rejects a conflicting entry unless force is explicit", async () => {
    const directory = await createProjectDirectory();
    await writeFile(
      join(directory, ".mcp.json"),
      JSON.stringify({ mcpServers: { pgroonga: { command: "custom-server" } } }),
    );

    await expect(planSetup({ cwd: directory, clients: ["claude"], force: false })).rejects.toThrow(
      "Use --force",
    );

    await applySetup({ cwd: directory, clients: ["claude"], force: true });
    const claude = JSON.parse(await readFile(join(directory, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(claude.mcpServers.pgroonga.command).toBe("npx");
  });

  it("appends the DSH plugin to an existing plugin list", async () => {
    const directory = await createProjectDirectory();
    await writeFile(join(directory, "cordis.yml"), "- id: existing\n  name: existing-plugin\n");

    await applySetup({ cwd: directory, clients: ["dsh"], force: false });
    const cordis = await readFile(join(directory, "cordis.yml"), "utf8");
    expect(cordis).toContain("- id: existing");
    expect(cordis).toContain("- id: mcp-pgroonga");
  });
});

async function createProjectDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pgroonga-mcp-setup-"));
  projectDirectories.push(directory);
  return directory;
}
