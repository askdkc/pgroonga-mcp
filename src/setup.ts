import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { errorMessage } from "./errors.js";

export const SETUP_CLIENTS = ["codex", "claude", "opencode", "dsh"] as const;
export type SetupClient = (typeof SETUP_CLIENTS)[number];

const CLIENT_LABELS: Record<SetupClient, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  dsh: "DSH (DeepSeek Harness)",
};

const MCP_COMMAND = ["npx", "--no-install", "pgroonga-mcp"];
const OPENCODE_SCHEMA = "https://opencode.ai/config.json";

type JsonObject = Record<string, unknown>;

export interface SetupOptions {
  cwd: string;
  clients: readonly SetupClient[];
  force: boolean;
}

export interface SetupChange {
  client: SetupClient;
  path: string;
  action: "create" | "update" | "unchanged";
}

interface PlannedChange extends SetupChange {
  content: string;
}

export interface SetupIo {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream;
}

export interface ParsedSetupArgs {
  all: boolean;
  clients: SetupClient[];
  cwd: string;
  dryRun: boolean;
  force: boolean;
  help: boolean;
}

export class SetupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

export function parseSetupArgs(args: readonly string[]): ParsedSetupArgs {
  const clients: SetupClient[] = [];
  let all = false;
  let cwd = ".";
  let dryRun = false;
  let force = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;

    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    if (argument === "--clients" || argument === "--client") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new SetupError(`${argument} requires a comma-separated client list.`);
      }
      clients.push(...parseClientList(value));
      index += 1;
      continue;
    }

    if (argument.startsWith("--clients=") || argument.startsWith("--client=")) {
      const value = argument.slice(argument.indexOf("=") + 1);
      clients.push(...parseClientList(value));
      continue;
    }

    if (argument === "--cwd") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        throw new SetupError("--cwd requires a project directory.");
      }
      cwd = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--cwd=")) {
      cwd = argument.slice("--cwd=".length);
      if (!cwd) throw new SetupError("--cwd requires a project directory.");
      continue;
    }

    throw new SetupError(`Unknown setup option: ${argument}`);
  }

  return {
    all,
    clients: uniqueClients(clients),
    cwd,
    dryRun,
    force,
    help,
  };
}

export function parseClientList(value: string): SetupClient[] {
  const parsed = value
    .split(",")
    .map((client) => client.trim().toLowerCase())
    .filter(Boolean);

  if (parsed.length === 0) {
    throw new SetupError("At least one client must be selected.");
  }

  if (parsed.includes("all")) return [...SETUP_CLIENTS];

  const aliases: Record<string, SetupClient> = {
    codex: "codex",
    claude: "claude",
    "claude-code": "claude",
    dsh: "dsh",
    opencode: "opencode",
    "open-code": "opencode",
  };
  const invalid = parsed.find((client) => aliases[client] === undefined);
  if (invalid) {
    throw new SetupError(
      `Unknown MCP client "${invalid}". Choose from: ${SETUP_CLIENTS.join(", ")}.`,
    );
  }

  return uniqueClients(
    parsed
      .map((client) => aliases[client])
      .filter((client): client is SetupClient => client !== undefined),
  );
}

export async function planSetup(options: SetupOptions): Promise<SetupChange[]> {
  const plans = await createPlans(options);
  return plans.map((plan) => ({
    client: plan.client,
    path: plan.path,
    action: plan.action,
  }));
}

export async function applySetup(options: SetupOptions): Promise<SetupChange[]> {
  const plans = await createPlans(options);
  for (const plan of plans) {
    if (plan.action === "unchanged") continue;
    await writeFileAtomically(plan.path, plan.content);
  }
  return plans.map((plan) => ({
    client: plan.client,
    path: plan.path,
    action: plan.action,
  }));
}

export async function runSetup(
  args: readonly string[] = [],
  io: SetupIo = {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  try {
    const parsed = parseSetupArgs(args);
    if (parsed.help) {
      writeLine(io.stdout, setupUsage());
      return 0;
    }

    const clients = parsed.all
      ? [...SETUP_CLIENTS]
      : parsed.clients.length > 0
        ? parsed.clients
        : await promptForClients(io);
    const options: SetupOptions = {
      cwd: resolve(parsed.cwd),
      clients,
      force: parsed.force,
    };
    const changes = parsed.dryRun ? await planSetup(options) : await applySetup(options);

    writeLine(io.stdout, `pgroonga-mcp setup in ${options.cwd}`);
    for (const change of changes) {
      const displayPath = relative(options.cwd, change.path) || ".";
      const action =
        parsed.dryRun && change.action !== "unchanged" ? `would-${change.action}` : change.action;
      writeLine(io.stdout, `  ${CLIENT_LABELS[change.client]}: ${action} ${displayPath}`);
    }
    if (changes.every((change) => change.action === "unchanged")) {
      writeLine(io.stdout, "No changes were needed.");
    } else if (!parsed.dryRun) {
      writeLine(io.stdout, "Restart the selected MCP clients to load the new configuration.");
    }
    return 0;
  } catch (error) {
    writeLine(io.stderr, `pgroonga-mcp setup: ${errorMessage(error)}`);
    return 1;
  }
}

function setupUsage(): string {
  return [
    "Usage: pgroonga-mcp setup [options]",
    "",
    "Configure a project-local MCP entry for Codex, Claude Code, OpenCode, or DSH.",
    "",
    "Options:",
    "  --clients <list>  Comma-separated list: codex,claude,opencode,dsh",
    "  --all             Configure all supported clients",
    "  --cwd <path>      Project directory (default: current directory)",
    "  --dry-run         Show changes without writing files",
    "  --force           Replace an existing pgroonga entry",
    "  -h, --help        Show this help",
  ].join("\n");
}

async function promptForClients(io: SetupIo): Promise<SetupClient[]> {
  if (!io.stdin.isTTY || !io.stdout.isTTY) {
    throw new SetupError("Select clients with --all or --clients when running without a TTY.");
  }

  writeLine(io.stdout, "Select MCP clients to configure:");
  SETUP_CLIENTS.forEach((client, index) => {
    writeLine(io.stdout, `  ${index + 1}. ${CLIENT_LABELS[client]}`);
  });
  writeLine(io.stdout, "  5. All");

  const readline = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answer = await readline.question("Choice (comma-separated, default: all): ");
    if (!answer.trim()) return [...SETUP_CLIENTS];
    if (answer.trim() === "5" || answer.trim().toLowerCase() === "all") {
      return [...SETUP_CLIENTS];
    }

    const selected = answer
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => {
        const index = Number(value);
        if (!Number.isInteger(index) || index < 1 || index > SETUP_CLIENTS.length) {
          throw new SetupError(`Invalid client choice "${value}".`);
        }
        const client = SETUP_CLIENTS[index - 1];
        if (client === undefined) throw new SetupError(`Invalid client choice "${value}".`);
        return client;
      });
    return uniqueClients(selected);
  } finally {
    readline.close();
  }
}

async function createPlans(options: SetupOptions): Promise<PlannedChange[]> {
  const cwd = resolve(options.cwd);
  const clients = uniqueClients(options.clients);
  if (clients.length === 0) throw new SetupError("At least one MCP client must be selected.");

  const plans: PlannedChange[] = [];
  for (const client of clients) {
    plans.push(await createPlan(client, cwd, options.force));
  }
  return plans;
}

async function createPlan(
  client: SetupClient,
  cwd: string,
  force: boolean,
): Promise<PlannedChange> {
  switch (client) {
    case "claude":
      return createClaudePlan(cwd, force);
    case "codex":
      return createCodexPlan(cwd, force);
    case "dsh":
      return createDshPlan(cwd, force);
    case "opencode":
      return createOpenCodePlan(cwd, force);
  }
}

async function createClaudePlan(cwd: string, force: boolean): Promise<PlannedChange> {
  const path = resolve(cwd, ".mcp.json");
  const existing = await readOptional(path);
  const root = existing === undefined ? {} : parseJsonc(existing, path);
  const servers = getObject(root, "mcpServers", path);
  const desired = {
    command: "npx",
    args: [...MCP_COMMAND.slice(1)],
  };
  const content = mergeJsonEntry(root, servers, "pgroonga", desired, path, force);
  return createChange("claude", path, existing, content);
}

async function createOpenCodePlan(cwd: string, force: boolean): Promise<PlannedChange> {
  const jsonPath = resolve(cwd, "opencode.json");
  const jsoncPath = resolve(cwd, "opencode.jsonc");
  const path =
    (await readOptional(jsonPath)) === undefined && (await readOptional(jsoncPath)) !== undefined
      ? jsoncPath
      : jsonPath;
  const existing = await readOptional(path);
  const root = existing === undefined ? {} : parseJsonc(existing, path);
  if (root.$schema === undefined) root.$schema = OPENCODE_SCHEMA;
  const servers = getObject(root, "mcp", path);
  const desired = {
    type: "local",
    command: [...MCP_COMMAND],
    cwd: ".",
    enabled: true,
  };
  const content = mergeJsonEntry(root, servers, "pgroonga", desired, path, force);
  return createChange("opencode", path, existing, content);
}

async function createCodexPlan(cwd: string, force: boolean): Promise<PlannedChange> {
  const path = resolve(cwd, ".codex", "config.toml");
  const existing = await readOptional(path);
  const block = [
    "[mcp_servers.pgroonga]",
    'command = "npx"',
    'args = ["--no-install", "pgroonga-mcp"]',
    'cwd = "."',
  ].join("\n");
  const content = mergeCodexConfig(existing, block, path, force);
  return createChange("codex", path, existing, content);
}

async function createDshPlan(cwd: string, force: boolean): Promise<PlannedChange> {
  const path = resolve(cwd, "cordis.yml");
  const existing = await readOptional(path);
  const block = [
    "# Added by pgroonga-mcp setup.",
    "- id: mcp-pgroonga",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: pgroonga",
    "    transport: stdio",
    "    command: npx",
    "    args: ['--no-install', 'pgroonga-mcp']",
    "    cwd: .",
  ].join("\n");
  const content = mergeDshConfig(existing, block, path, force);
  return createChange("dsh", path, existing, content);
}

function createChange(
  client: SetupClient,
  path: string,
  existing: string | undefined,
  content: string,
): PlannedChange {
  return {
    client,
    path,
    action: existing === undefined ? "create" : content === existing ? "unchanged" : "update",
    content,
  };
}

function mergeJsonEntry(
  root: JsonObject,
  entries: JsonObject,
  name: string,
  desired: JsonObject,
  path: string,
  force: boolean,
): string {
  const current = entries[name];
  if (current !== undefined && !deepEqual(current, desired) && !force) {
    throw new SetupError(
      `${path} already contains a different "${name}" entry. Use --force to replace only that entry.`,
    );
  }
  entries[name] = desired;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function mergeCodexConfig(
  existing: string | undefined,
  block: string,
  path: string,
  force: boolean,
): string {
  if (existing === undefined || existing.trim() === "") return `${block}\n`;

  const source = existing.replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === "[mcp_servers.pgroonga]");
  if (start === -1) return `${source.trimEnd()}\n\n${block}\n`;

  const end = findTomlSectionEnd(lines, start);
  const current = lines.slice(start, end).join("\n").trim();
  if (current === block) return existing;
  if (!force) {
    throw new SetupError(
      `${path} already contains a different [mcp_servers.pgroonga] section. Use --force to replace it.`,
    );
  }

  const updated = [...lines.slice(0, start), block, ...lines.slice(end)].join("\n");
  return `${updated.trimEnd()}\n`;
}

function findTomlSectionEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const header = lines[index]?.trim() ?? "";
    if (header.startsWith("[") && !header.startsWith("[mcp_servers.pgroonga.")) return index;
  }
  return lines.length;
}

function mergeDshConfig(
  existing: string | undefined,
  block: string,
  path: string,
  force: boolean,
): string {
  if (existing === undefined || existing.trim() === "") return `${block}\n`;

  const source = existing.replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line.trim() === "- id: mcp-pgroonga");
  if (start === -1) {
    if (lines.some((line) => line.trim() === "plugins:")) {
      throw new SetupError(`${path} does not use the cordis.yml top-level plugin list format.`);
    }
    return `${source.trimEnd()}\n\n${block}\n`;
  }

  const end = findYamlEntryEnd(lines, start);
  const current = lines
    .slice(Math.max(0, start - 1), end)
    .join("\n")
    .trim();
  if (current === block) return existing;
  if (!force) {
    throw new SetupError(
      `${path} already contains a different mcp-pgroonga entry. Use --force to replace it.`,
    );
  }

  const blockStart =
    lines[start - 1]?.trim() === "# Added by pgroonga-mcp setup" ? start - 1 : start;
  const updated = [...lines.slice(0, blockStart), block, ...lines.slice(end)].join("\n");
  return `${updated.trimEnd()}\n`;
}

function findYamlEntryEnd(lines: string[], start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*-\s+id:\s*/.test(lines[index] ?? "")) return index;
  }
  return lines.length;
}

function getObject(root: JsonObject, key: string, path: string): JsonObject {
  const current = root[key];
  if (current === undefined) {
    const created: JsonObject = {};
    root[key] = created;
    return created;
  }
  if (!isJsonObject(current)) throw new SetupError(`${path} has a non-object "${key}" value.`);
  return current;
}

function parseJsonc(source: string, path: string): JsonObject {
  try {
    const value: unknown = JSON.parse(removeTrailingCommas(removeJsonComments(source)));
    if (!isJsonObject(value)) throw new Error("the root value must be an object");
    return value;
  } catch (error) {
    throw new SetupError(`Could not parse ${path}: ${errorMessage(error)}`);
  }
}

function removeJsonComments(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        result += character;
      } else {
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        result += "  ";
        index += 1;
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (!inString && character === "/" && next === "/") {
      lineComment = true;
      result += "  ";
      index += 1;
      continue;
    }
    if (!inString && character === "/" && next === "*") {
      blockComment = true;
      result += "  ";
      index += 1;
      continue;
    }

    result += character;
    if (character === '"' && !escaped) inString = !inString;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }

  return result;
}

function removeTrailingCommas(source: string): string {
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === '"' && !escaped) inString = !inString;
    if (!inString && character === ",") {
      let next = index + 1;
      while (/\s/.test(source[next] ?? "")) next += 1;
      if (source[next] === "}" || source[next] === "]") {
        escaped = false;
        continue;
      }
    }
    result += character;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  return result;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueClients(clients: readonly SetupClient[]): SetupClient[] {
  return SETUP_CLIENTS.filter((client) => clients.includes(client));
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw error;
  }
}

async function writeFileAtomically(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.pgroonga-mcp-${process.pid}-${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await removeTemporaryFile(temporaryPath);
    throw error;
  }
  await removeTemporaryFile(temporaryPath);
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function writeLine(stream: NodeJS.WritableStream, value: string): void {
  stream.write(`${value}\n`);
}
