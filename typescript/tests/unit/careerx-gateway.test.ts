import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRequest } from "@openai/agents";
import { expect, it } from "vitest";
import {
  asksForCompaction,
  forChatCompletions,
  gatewayConfigFromEnv,
  makeGatewayProvider,
} from "../../src/models/gateway.js";
import { lunaModel, modelFromEnv, solModel } from "../../src/models/models.js";
import {
  parseProxyUrl,
  proxyFromEnv,
  proxyModeFromEnv,
} from "../../src/execution/proxy-settings.js";
import { attemptBrowser, siteBlocked } from "../../src/standalone/careerx-main.js";
import type { LocalMintOutcome } from "../../src/standalone/contracts.js";

const none = { stripParams: [], stripReasoningEffort: false } as const;

it("keeps the upstream model IDs unless the environment names others", () => {
  expect(modelFromEnv({}, "POMERADO_MODEL_SOL", "upstream")).toBe("upstream");
  expect(modelFromEnv({ POMERADO_MODEL_SOL: "  " }, "POMERADO_MODEL_SOL", "upstream")).toBe(
    "upstream",
  );
  expect(modelFromEnv({ POMERADO_MODEL_SOL: " ours-big " }, "POMERADO_MODEL_SOL", "x")).toBe(
    "ours-big",
  );
  // The test process sets neither variable, so the exported constants are upstream's.
  if (process.env["POMERADO_MODEL_SOL"] === undefined) expect(solModel).toMatch(/^gpt-/);
  if (process.env["POMERADO_MODEL_LUNA"] === undefined) expect(lunaModel).toMatch(/^gpt-/);
});

it("reads no gateway without a base URL, and never the upstream key", () => {
  expect(gatewayConfigFromEnv({ OPENAI_API_KEY: "sk-upstream" })).toBeUndefined();
  const config = gatewayConfigFromEnv({
    POMERADO_OPENAI_BASE_URL: " https://10.70.0.1:8443/v1 ",
    OPENAI_API_KEY: "sk-upstream",
    POMERADO_CA_FILE: "/etc/ca.pem",
    POMERADO_STRIP_PARAMS: "a, b,,",
    POMERADO_STRIP_REASONING_EFFORT: "1",
  });
  expect(config).toEqual({
    baseURL: "https://10.70.0.1:8443/v1",
    apiKey: "unused",
    caFile: "/etc/ca.pem",
    stripParams: ["a", "b"],
    stripReasoningEffort: true,
  });
  expect(
    gatewayConfigFromEnv({ POMERADO_OPENAI_BASE_URL: "https://g/v1", POMERADO_OPENAI_API_KEY: "k" })
      ?.apiKey,
  ).toBe("k");
});

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  systemInstructions: "Be brief.",
  input: [
    {
      type: "unknown",
      providerData: {
        type: "message",
        role: "developer",
        content: [
          { type: "input_text", text: "one" },
          {
            type: "input_text",
            text: "two",
            prompt_cache_breakpoint: { mode: "explicit", ttl: "12h" },
          },
        ],
      },
    },
    { type: "message", role: "user", content: "hello" },
  ],
  modelSettings: {
    store: false,
    promptCacheOptions: { mode: "implicit" },
    parallelToolCalls: true,
    reasoning: { effort: "medium", summary: "auto", context: "all_turns" },
    providerData: {
      include: ["reasoning.encrypted_content"],
      prompt_cache_options: { mode: "implicit" },
      prompt_cache_key: "k",
      context_management: [{ type: "compaction" }],
      tool_choice: {
        type: "allowed_tools",
        mode: "auto",
        tools: [{ type: "function", name: "read_source" }],
      },
      keep_me: 1,
    },
  },
  tools: [
    { type: "function", name: "read_source", description: "", parameters: {}, strict: false },
    { type: "function", name: "finish_build", description: "", parameters: {}, strict: false },
  ] as unknown as ModelRequest["tools"],
  outputType: "text",
  handoffs: [],
  tracing: false,
  ...overrides,
});

it("strips what Chat Completions on vLLM does not take", () => {
  const sent = forChatCompletions(request(), none);
  expect(sent.modelSettings).toEqual({
    parallelToolCalls: true,
    reasoning: { effort: "medium" },
    providerData: { keep_me: 1 },
  });
  // The cached developer prefix is a plain system message, breakpoints gone.
  expect(sent.input).toEqual([
    { type: "message", role: "system", content: "one\n\ntwo" },
    { type: "message", role: "user", content: "hello" },
  ]);
  // allowed_tools became a filtered tool list.
  expect(sent.tools.map((tool) => tool.name)).toEqual(["read_source"]);
});

it("keeps every tool and a required choice when allowed_tools asked for required", () => {
  const sent = forChatCompletions(
    request({
      modelSettings: {
        providerData: {
          tool_choice: { type: "allowed_tools", mode: "required", tools: [] },
        },
      },
    }),
    none,
  );
  expect(sent.tools).toEqual([]);
  expect(sent.modelSettings.toolChoice).toBe("required");
});

it("drops reasoning effort and extra parameters when told to", () => {
  const sent = forChatCompletions(request(), {
    stripParams: ["keep_me"],
    stripReasoningEffort: true,
  });
  expect(sent.modelSettings.reasoning).toBeUndefined();
  expect(sent.modelSettings.providerData).toEqual({});
});

it("recognises the Responses compaction trigger, which the gateway cannot do", () => {
  const trigger = request({
    input: [
      { type: "message", role: "user", content: "x" },
      { type: "unknown", providerData: { type: "compaction_trigger" } },
    ],
  });
  expect(asksForCompaction(trigger)).toBe(true);
  expect(asksForCompaction(request())).toBe(false);
});

it("builds a Chat Completions model for the gateway, pinning its CA, without any network", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pomerado-ca-"));
  const provider = makeGatewayProvider({ baseURL: "https://127.0.0.1:1/v1", apiKey: "k", ...none });
  const model = await provider.getModel("ours");
  expect(typeof model.getResponse).toBe("function");
  // A missing CA file fails at build time, not at the first model call.
  expect(() =>
    makeGatewayProvider({
      baseURL: "https://127.0.0.1:1/v1",
      apiKey: "k",
      caFile: join(directory, "missing.pem"),
      ...none,
    }),
  ).toThrow();
});

it("splits proxy credentials from the server and never quotes the URL", () => {
  expect(parseProxyUrl("http://us%40er:p%3Ass@proxy.example:3128")).toEqual({
    server: "http://proxy.example:3128",
    username: "us@er",
    password: "p:ss",
  });
  expect(parseProxyUrl("http://proxy.example:3128")).toEqual({
    server: "http://proxy.example:3128",
  });
  let message = "";
  try {
    parseProxyUrl("ftp://user:secret@proxy.example");
  } catch (error) {
    message = String(error);
  }
  expect(message).toContain("http, https or socks5");
  expect(message).not.toContain("secret");
  try {
    parseProxyUrl("not a url with secret");
  } catch (error) {
    message = String(error);
  }
  expect(message).not.toContain("secret");
});

it("defaults the proxy mode from whether a URL is set, and refuses an unusable one", () => {
  expect(proxyModeFromEnv({})).toBe("off");
  expect(proxyModeFromEnv({ POMERADO_PROXY_URL: "http://p:1" })).toBe("fallback");
  expect(proxyModeFromEnv({ POMERADO_PROXY_URL: "http://p:1", POMERADO_PROXY_MODE: "ALWAYS" })).toBe(
    "always",
  );
  expect(() => proxyModeFromEnv({ POMERADO_PROXY_MODE: "sometimes" })).toThrow();
  expect(() => proxyFromEnv({ POMERADO_PROXY_MODE: "always" })).toThrow();
  expect(proxyFromEnv({ POMERADO_PROXY_MODE: "fallback" })).toBeUndefined();
  expect(proxyFromEnv({ POMERADO_PROXY_URL: "http://u:p@h:1" })).toEqual({
    server: "http://h:1",
    username: "u",
    password: "p",
  });
});

it("identifies direct requests and presents proxied ones as the browser", () => {
  const env = { POMERADO_USER_AGENT: "CareerXBot/1.0 (+https://example.org/bot)" };
  expect(attemptBrowser(undefined, env)).toEqual({ userAgent: env.POMERADO_USER_AGENT });
  expect(attemptBrowser({ server: "http://h:1" }, env)).toEqual({ proxy: { server: "http://h:1" } });
  expect(attemptBrowser(undefined, {})).toEqual({});
});

const outcome = (fields: Record<string, unknown>) =>
  ({ executions: [], diagnostics: [], summary: "", ...fields }) as unknown as LocalMintOutcome;

it("retries through the proxy only when the site, not the task, stopped the mint", () => {
  expect(siteBlocked(outcome({ stopReason: "site_declined" }))).toBe(true);
  expect(siteBlocked(outcome({ stopReason: "site_unavailable" }))).toBe(true);
  expect(
    siteBlocked(outcome({ executions: [{ siteAccess: { code: "site_rate_limited" } }] })),
  ).toBe(true);
  expect(siteBlocked(outcome({ stopReason: "turn_budget_spent" }))).toBe(false);
  expect(siteBlocked(outcome({ stopReason: "site_declined", artifact: {} }))).toBe(false);
});
