import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENCODE_API_KEY_ENV,
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_PROVIDER_ID,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildOpencodeConfig,
  buildOpencodeEnv,
  buildOpencodeProviderBlock,
  opencodeApiKey,
  opencodeGlobalConfigPath,
  opencodeModelKey,
  opencodeNotFoundHint,
  parseJsonc,
  projectConfigOverridesProvider,
  serializeOpencodeRuntimeConfig,
} from "../src/cli/opencode";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

describe("ocx opencode provider block", () => {
  test("points at the live proxy port over the OpenAI-compatible surface", () => {
    const block = buildOpencodeProviderBlock(10123, [], []);
    expect(block.options.baseURL).toBe("http://127.0.0.1:10123/v1");
    expect(block.npm).toBe("@ai-sdk/openai-compatible");
  });

  test("apiKey is an env reference, never a literal secret", () => {
    const block = buildOpencodeProviderBlock(10100, [], []);
    expect(block.options.apiKey).toBe(`{env:${OPENCODE_API_KEY_ENV}}`);
    expect(JSON.stringify(block)).not.toContain("sk-");
  });

  test("routed models key on provider/id, native slugs stay bare", () => {
    const block = buildOpencodeProviderBlock(10100, ["gpt-5.6-sol"], [
      { provider: "kiro", id: "glm-5" },
    ]);
    expect(Object.keys(block.models).sort()).toEqual(["gpt-5.6-sol", "kiro/glm-5"]);
  });

  test("limit.context is emitted only from an authoritative contextWindow — never guessed", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "with-window", contextWindow: 200_000 },
      { provider: "kiro", id: "no-window" },
      { provider: "kiro", id: "zero-window", contextWindow: 0 },
    ]);
    expect(block.models["kiro/with-window"]?.limit?.context).toBe(200_000);
    expect(block.models["kiro/no-window"]?.limit).toBeUndefined();
    expect(block.models["kiro/zero-window"]?.limit).toBeUndefined();
  });

  test("limit.output rides along with context because opencode's schema requires the pair", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "m", contextWindow: 200_000 },
    ]);
    expect(block.models["kiro/m"]?.limit).toEqual({ context: 200_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
  });

  test("limit.output is clamped to the context window for small-context models", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "local", id: "tiny", contextWindow: 8_192 },
    ]);
    expect(block.models["local/tiny"]?.limit).toEqual({ context: 8_192, output: 8_192 });
  });

  test("native slugs pick up authoritative context windows from the resolver", () => {
    const block = buildOpencodeProviderBlock(10100, ["gpt-5.4", "unknown-native"], [], slug =>
      slug === "gpt-5.4" ? 1_000_000 : undefined);
    expect(block.models["gpt-5.4"]?.limit).toEqual({ context: 1_000_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
    expect(block.models["unknown-native"]?.limit).toBeUndefined();
  });

  test("displayName is used for the label when the catalog provides one", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "glm-5", displayName: "GLM-5" },
      { provider: "kiro", id: "qwen3-coder-next" },
    ]);
    expect(block.models["kiro/glm-5"]?.name).toBe("GLM-5 (kiro)");
    expect(block.models["kiro/qwen3-coder-next"]?.name).toBe("qwen3-coder-next (kiro)");
  });

  test("duplicate keys keep the first entry instead of throwing", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "dup", displayName: "First" },
      { provider: "kiro", id: "dup", displayName: "Second" },
    ]);
    expect(block.models["kiro/dup"]?.name).toBe("First (kiro)");
  });

  test("model key helper distinguishes native from routed", () => {
    expect(opencodeModelKey("native", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(opencodeModelKey("kiro", "glm-5")).toBe("kiro/glm-5");
  });
});

describe("ocx opencode runtime config", () => {
  test("serializes only the generated provider block for OPENCODE_CONFIG_CONTENT", () => {
    const runtime = buildOpencodeConfig(10100, [], [{ provider: "kiro", id: "glm-5" }]);
    const parsed = JSON.parse(serializeOpencodeRuntimeConfig(runtime)) as { provider?: Record<string, unknown> };
    expect(Object.keys(parsed.provider ?? {})).toEqual([OPENCODE_PROVIDER_ID]);
    expect(parsed.provider?.[OPENCODE_PROVIDER_ID]).toBeTruthy();
  });
});

describe("ocx opencode JSONC parsing", () => {
  test("plain JSON parses unchanged", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });

  test("line and block comments are accepted", () => {
    expect(parseJsonc('{\n // lead\n "a": 1 /* trail */\n}')).toEqual({ a: 1 });
  });

  test("trailing commas are accepted", () => {
    expect(parseJsonc('{"a":[1,2,],"b":2,}')).toEqual({ a: [1, 2], b: 2 });
  });

  test("comment-like and comma-like text inside strings is preserved", () => {
    expect(parseJsonc('{"url":"http://x/v1","note":"a // b /* c */","t":"x,"}'))
      .toEqual({ url: "http://x/v1", note: "a // b /* c */", t: "x," });
  });

  test("escaped quotes do not break string tracking", () => {
    expect(parseJsonc('{"a":"he said \\"hi\\" // not a comment"}'))
      .toEqual({ a: 'he said "hi" // not a comment' });
  });

  test("genuinely malformed input still throws", () => {
    expect(() => parseJsonc("{ not json")).toThrow();
  });
});

describe("ocx opencode project-layer detection", () => {
  test("detects a project config that redefines our provider key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(projectConfigOverridesProvider(dir)).toBe(join(dir, "opencode.json"));
  });

  test("detects opencode.jsonc and parent directories up to the git root", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-root-"));
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "packages", "opencode.jsonc"), `{
      // project override
      "provider": { "${OPENCODE_PROVIDER_ID}": { "npm": "x" } }
    }`);
    expect(projectConfigOverridesProvider(join(root, "packages", "app"))).toBe(join(root, "packages", "opencode.jsonc"));
  });

  test("does not walk above the git root", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-stop-"));
    const parent = join(root, "parent");
    const repo = join(parent, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(projectConfigOverridesProvider(join(repo, "src"))).toBeNull();
  });

  test("ignores a project config that defines other providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { other: { npm: "x" } } }));
    expect(projectConfigOverridesProvider(dir)).toBeNull();
  });

  test("no project config is not a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    expect(projectConfigOverridesProvider(dir)).toBeNull();
  });
});

describe("ocx opencode env assembly", () => {
  test("OPENCODE_CONFIG_CONTENT carries only the runtime provider block", () => {
    const runtime = buildOpencodeConfig(10100, [], [{ provider: "kiro", id: "glm-5" }]);
    const env = buildOpencodeEnv(runtime, "sk-ocx-123", { OPENCODE_CONFIG: "/user/mine.json", PATH: "/bin" });
    expect(env.OPENCODE_CONFIG).toBe("/user/mine.json");
    expect(env.PATH).toBe("/bin");
    const parsed = JSON.parse(env[OPENCODE_CONFIG_CONTENT_ENV]!) as { provider?: Record<string, unknown> };
    expect(Object.keys(parsed.provider ?? {})).toEqual([OPENCODE_PROVIDER_ID]);
  });

  test("the admission key travels in the child env, matching the config's {env:…} reference", () => {
    const env = buildOpencodeEnv(buildOpencodeConfig(10100, [], []), "sk-ocx-123", {});
    expect(env[OPENCODE_API_KEY_ENV]).toBe("sk-ocx-123");
  });
});

describe("ocx opencode admission key", () => {
  test("the environment token wins over a configured API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, { OPENCODEX_API_AUTH_TOKEN: "sk-env" })).toBe("sk-env");
  });

  test("falls back to the configured proxy API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, {})).toBe("sk-cfg");
  });

  test("falls back to a placeholder on an open loopback proxy", () => {
    expect(opencodeApiKey(cfg(), {})).toBe("ocx");
  });
});

describe("ocx opencode global config path", () => {
  test("global path follows XDG_CONFIG_HOME when set", () => {
    expect(opencodeGlobalConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(join("/xdg", "opencode", "opencode.json"));
    expect(opencodeGlobalConfigPath({}, "/home/u")).toBe(join("/home/u", ".config", "opencode", "opencode.json"));
  });
});

describe("ocx opencode not-found hint", () => {
  test("cmd.exe reports command-not-found as 9009", () => {
    expect(opencodeNotFoundHint(9009, null, "win32")).toContain("npm install -g opencode-ai");
  });

  test("signal exits and other platforms are not hints", () => {
    expect(opencodeNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(opencodeNotFoundHint(9009, null, "linux")).toBeNull();
    expect(opencodeNotFoundHint(0, null, "win32")).toBeNull();
  });
});
