/**
 * `ocx opencode [opencode args...]` — launch opencode wired to the local proxy.
 *
 * Mirrors `ocx claude` (src/cli/claude.ts): ensure the proxy is running, then exec the
 * client with stdio inherited. The wiring channel differs — opencode reads providers
 * from merged JSON config layers rather than env slots.
 *
 * The launcher never reads, copies, or rewrites the user's opencode config files. It
 * injects only the generated `provider.opencodex` block through OpenCode's inline runtime
 * layer (`OPENCODE_CONFIG_CONTENT`), which outranks project/global/custom config and
 * avoids duplicating API keys, MCP credentials, or breaking relative `{file:…}` paths.
 *
 * The admission key is never serialized into that inline config. The provider block
 * carries opencode's documented `{env:VAR}` reference and the real value is passed
 * only through the child process environment.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config";
import { commandInvocation } from "../lib/win-exec";
import { findLiveProxy } from "../server/proxy-liveness";
import type { OcxConfig } from "../types";

export interface OpencodeLaunchEnv {
  [key: string]: string | undefined;
}

/** One proxy-routed model destined for the generated provider block. */
export interface OpencodeRoutedModel {
  provider: string;
  id: string;
  /** Authoritative context window (CatalogModel.contextWindow); optional. */
  contextWindow?: number;
  /** Authoritative display label (CatalogModel.displayName); optional. */
  displayName?: string;
}

export interface OpencodeModelEntry {
  name: string;
  limit?: { context: number; output: number };
}

export interface OpencodeProviderBlock {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey: string };
  models: Record<string, OpencodeModelEntry>;
}

export interface OpencodeGeneratedConfig {
  $schema: string;
  provider: Record<string, OpencodeProviderBlock>;
}

/** Provider key owned by this launcher; the only key it ever injects at runtime. */
export const OPENCODE_PROVIDER_ID = "opencodex";

const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

const PROJECT_CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"] as const;

/**
 * OpenCode's inline runtime config layer. It merges after project/global/custom config
 * and carries only the generated provider block for this launch.
 */
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

/**
 * The proxy speaks the OpenAI-compatible shape at /v1, which opencode reaches through
 * the AI SDK's openai-compatible package (the same wiring users hand-write today).
 */
const OPENCODE_PROVIDER_NPM = "@ai-sdk/openai-compatible";

/**
 * Env var carrying the proxy admission key to the child. The inline config only ever
 * holds the `{env:...}` reference, so the secret never lands on disk (AGENTS.md treats
 * token serialization as a release blocker). opencode substitutes it at load time.
 */
export const OPENCODE_API_KEY_ENV = "OPENCODEX_OPENCODE_API_KEY";

/**
 * opencode's config schema rejects a `limit` block that carries `context` without
 * `output`, but CatalogModel has no authoritative per-model output field. Dropping
 * `limit` entirely would also throw away the authoritative context window we DO have,
 * so the block is emitted with this budget standing in for the missing half.
 *
 * The value matches REASONING_MAX_TOKENS_CEILING in src/adapters/anthropic.ts — the
 * project's existing "safe ceiling across current models" figure. It is a ceiling for
 * schema validity, NOT a claim about any specific model's true maximum, and it is
 * clamped to the context window so a small-context model can never be emitted with
 * output > context.
 */
export const SCHEMA_REQUIRED_OUTPUT_BUDGET = 32_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip `//` and block comments outside string literals. Escape-aware so a quote inside
 * an escaped sequence cannot flip string state and expose config text to the stripper.
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      // Newlines are preserved so JSON.parse error positions stay meaningful.
      if (ch === "\n") out += ch;
      else if (ch === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === "/" && next === "/") { inLine = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

/** Drop commas that sit directly before `}` or `]`, ignoring string contents. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        const escaped = text[i + 1];
        if (escaped !== undefined) { out += escaped; i++; }
        continue;
      }
      if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") { inString = true; out += ch; continue; }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

/**
 * opencode documents opencode.json as JSONC, so a valid user config may carry comments
 * or trailing commas. Strict JSON.parse runs first and untouched — the tolerant path is
 * only attempted when that throws, keeping well-formed configs away from the stripper.
 */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
  }
}

/**
 * Resolve the user's global opencode config path. opencode uses the XDG layout on every
 * platform (including Windows, where it is %USERPROFILE%\.config\opencode).
 */
export function opencodeGlobalConfigPath(
  env: OpencodeLaunchEnv = process.env,
  home: string = homedir(),
): string {
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0 ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(xdg, "opencode", "opencode.json");
}

/** Model key as the proxy routes it: `provider/id` for routed models, bare slug for native OpenAI entries. */
export function opencodeModelKey(provider: string, id: string): string {
  return provider === "native" ? id : `${provider}/${id}`;
}

/**
 * Build the `opencodex` provider block from the proxy's visible catalog.
 *
 * `limit.context` is emitted ONLY from an authoritative context window — never guessed.
 * When none is available the whole `limit` block is dropped and opencode keeps its own
 * defaults; when one is present, `limit.output` rides along (opencode's schema requires
 * the pair) clamped to the context window.
 */
export function buildOpencodeProviderBlock(
  port: number,
  nativeSlugs: readonly string[],
  routedModels: readonly OpencodeRoutedModel[],
  nativeContextWindow: (slug: string) => number | undefined = () => undefined,
): OpencodeProviderBlock {
  const models: Record<string, OpencodeModelEntry> = {};
  const candidates: OpencodeRoutedModel[] = [
    ...nativeSlugs.map(id => ({ provider: "native", id, contextWindow: nativeContextWindow(id) })),
    ...routedModels,
  ];
  for (const { provider, id, contextWindow, displayName } of candidates) {
    const key = opencodeModelKey(provider, id);
    if (models[key]) continue; // first entry wins; native slugs are registered first
    const entry: OpencodeModelEntry = {
      name: displayName && displayName.length > 0 ? `${displayName} (${provider})` : `${id} (${provider})`,
    };
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0) {
      const context = Math.floor(contextWindow);
      entry.limit = { context, output: Math.min(SCHEMA_REQUIRED_OUTPUT_BUDGET, context) };
    }
    models[key] = entry;
  }
  return {
    npm: OPENCODE_PROVIDER_NPM,
    name: "OpenCodex",
    options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: `{env:${OPENCODE_API_KEY_ENV}}` },
    models,
  };
}

/** Inline runtime config carrying only the provider block this launcher owns. */
export function buildOpencodeConfig(
  port: number,
  nativeSlugs: readonly string[],
  routedModels: readonly OpencodeRoutedModel[],
  nativeContextWindow: (slug: string) => number | undefined = () => undefined,
): OpencodeGeneratedConfig {
  return {
    $schema: OPENCODE_CONFIG_SCHEMA,
    provider: { [OPENCODE_PROVIDER_ID]: buildOpencodeProviderBlock(port, nativeSlugs, routedModels, nativeContextWindow) },
  };
}

/** Serialize the inline runtime config OpenCode merges on launch. */
export function serializeOpencodeRuntimeConfig(config: OpencodeGeneratedConfig): string {
  return JSON.stringify(config);
}

function findGitRoot(start: string): string | null {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function projectConfigDefinesProvider(dir: string): string | null {
  for (const name of PROJECT_CONFIG_FILENAMES) {
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      const parsed = parseJsonc(readFileSync(candidate, "utf8"));
      if (isRecord(parsed) && isRecord(parsed.provider) && OPENCODE_PROVIDER_ID in parsed.provider) {
        return candidate;
      }
    } catch {
      // opencode will report its own parse failure; not this command's business.
    }
  }
  return null;
}

/**
 * Detect a project-level opencode.json/jsonc that defines our provider key anywhere
 * between cwd and the nearest Git root. Useful only for an informational note: the inline
 * runtime layer from `OPENCODE_CONFIG_CONTENT` outranks project config.
 */
export function projectConfigOverridesProvider(cwd: string): string | null {
  const gitRoot = findGitRoot(cwd);
  let dir = cwd;
  while (true) {
    const hit = projectConfigDefinesProvider(dir);
    if (hit) return hit;
    if (gitRoot && dir === gitRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Env assembly (unit-tested). The inline runtime config carries only the generated
 * provider block; the user's existing config layers and `OPENCODE_CONFIG` export stay
 * untouched. The admission key travels here rather than in the inline config.
 */
export function buildOpencodeEnv(
  runtimeConfig: OpencodeGeneratedConfig,
  apiKey: string,
  base: OpencodeLaunchEnv,
): OpencodeLaunchEnv {
  return {
    ...base,
    [OPENCODE_CONFIG_CONTENT_ENV]: serializeOpencodeRuntimeConfig(runtimeConfig),
    [OPENCODE_API_KEY_ENV]: apiKey,
  };
}

/**
 * Admission key for the proxy. The environment token wins over a configured API key —
 * a non-loopback bind requires OPENCODEX_API_AUTH_TOKEN and may have no apiKeys at all,
 * in which case a placeholder would 401 every request. Same precedence as
 * fetchClaudeContextWindows in src/cli/claude.ts.
 */
export function opencodeApiKey(config: OcxConfig, env: OpencodeLaunchEnv = process.env): string {
  return env.OPENCODEX_API_AUTH_TOKEN || config.apiKeys?.[0]?.key || "ocx";
}

async function ensureProxyForOpencode(config: OcxConfig): Promise<number | null> {
  const live = await findLiveProxy();
  if (live) return live.port;
  const cfgPort = config.port;
  const pinPort = typeof cfgPort === "number" && cfgPort > 0 ? cfgPort : 10100;
  const child = spawn(process.execPath, [process.argv[1], "start", "--port", String(pinPort)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  // Without a listener an 'error' (bad argv[1], EMFILE, AV denial) throws synchronously
  // and kills this process; the health poll below already reports the failure properly.
  child.on("error", () => { /* handled by the deadline loop returning null */ });
  child.unref();
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const started = await findLiveProxy();
    if (started) return started.port;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

const OPENCODE_INSTALL_HINT = "❌ `opencode` CLI not found. Install it first: npm install -g opencode-ai";

/**
 * cmd.exe reports command-not-found as exit 9009 (the win32 launcher routes `.cmd`
 * shims through cmd.exe, so ENOENT never fires there). Signal exits are not hints.
 * Same contract as claudeNotFoundHint (devlog 260715_cross_platform_audit/020).
 */
export function opencodeNotFoundHint(
  code: number | null,
  signal: NodeJS.Signals | null,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return platform === "win32" && code === 9009 && !signal ? OPENCODE_INSTALL_HINT : null;
}

export async function cmdOpencode(args: string[]): Promise<number> {
  const config = loadConfig();
  const port = await ensureProxyForOpencode(config);
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    return 1;
  }

  const { fetchAllModels } = await import("../server/management-api");
  const { filterCatalogVisibleModels, nativeOpenAiContextWindow, visibleNativeSlugs } = await import("../codex/catalog");
  let allModels: Awaited<ReturnType<typeof fetchAllModels>>;
  try {
    allModels = await fetchAllModels(config);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`❌ Could not fetch the model catalog from the proxy: ${reason}`);
    return 1;
  }
  const routed = filterCatalogVisibleModels(allModels, config).map(m => ({
    provider: m.provider,
    id: m.id,
    contextWindow: m.contextWindow,
    displayName: m.displayName,
  }));
  const nativeSlugs = [...visibleNativeSlugs(config)];

  const runtimeConfig = buildOpencodeConfig(port, nativeSlugs, routed, nativeOpenAiContextWindow);
  const modelCount = nativeSlugs.length + routed.length;
  console.error(`✅ opencode wired to http://127.0.0.1:${port}/v1 — ${modelCount} model(s) under provider \`${OPENCODE_PROVIDER_ID}\`.`);
  console.error("   Your existing opencode config files are left untouched; only the runtime provider block is injected.");
  const projectOverride = projectConfigOverridesProvider(process.cwd());
  if (projectOverride) {
    console.error(`ℹ ${projectOverride} also defines provider.${OPENCODE_PROVIDER_ID}; the runtime layer from ocx opencode overrides it for this launch.`);
  }

  const env = buildOpencodeEnv(runtimeConfig, opencodeApiKey(config), process.env);
  return await new Promise<number>(resolve => {
    const inv = commandInvocation("opencode", args);
    const child = spawn(inv.file, inv.args, { stdio: "inherit", env: env as NodeJS.ProcessEnv, ...inv.options });
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        console.error(OPENCODE_INSTALL_HINT);
      } else {
        console.error(`❌ Failed to launch opencode: ${err.message}`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      const hint = opencodeNotFoundHint(code, signal);
      if (hint) console.error(hint);
      resolve(signal ? 1 : code ?? 0);
    });
  });
}
