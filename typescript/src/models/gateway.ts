import { readFileSync } from "node:fs";
import tls from "node:tls";
import { OpenAIProvider, Usage } from "@openai/agents";
import type {
  AgentInputItem,
  Model,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "@openai/agents";
import OpenAI from "openai";
import { isPrewarm, withoutPromptCacheSettings } from "./prompt-cache.js";

/**
 * CareerX fork: the org's own OpenAI-compatible gateway (vLLM) in place of OpenAI. Everything here
 * is opt-in through the environment; with `POMERADO_OPENAI_BASE_URL` unset, upstream behaviour
 * (the SDK's default provider and `OPENAI_API_KEY`) is untouched.
 */
export interface GatewayConfig {
  readonly baseURL: string;
  readonly apiKey: string;
  /** PEM file of the CA that signed the gateway's certificate, added to this process's trust. */
  readonly caFile?: string;
  /** Request parameters to strip as well as the built-in list, for a gateway that rejects them. */
  readonly stripParams: readonly string[];
  /** Send no `reasoning_effort`, for a model that rejects it. */
  readonly stripReasoningEffort: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;
const set = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
};

/** The gateway the environment names, or none (upstream OpenAI) when the base URL is unset. */
export const gatewayConfigFromEnv = (env: Env): GatewayConfig | undefined => {
  const baseURL = set(env["POMERADO_OPENAI_BASE_URL"]);
  if (baseURL === undefined) return undefined;
  const caFile = set(env["POMERADO_CA_FILE"]);
  return {
    baseURL,
    // Never the upstream OPENAI_API_KEY: it must not travel to the gateway. Most vLLM gateways
    // ignore the value, but the client wants a non-empty one.
    apiKey: set(env["POMERADO_OPENAI_API_KEY"]) ?? "unused",
    ...(caFile === undefined ? {} : { caFile }),
    stripParams: (set(env["POMERADO_STRIP_PARAMS"]) ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== ""),
    stripReasoningEffort: ["1", "true", "yes"].includes(
      (set(env["POMERADO_STRIP_REASONING_EFFORT"]) ?? "").toLowerCase(),
    ),
  };
};

const trustedCaFiles = new Set<string>();
/** Adds the pinned CA to the process's trust (fetch included) once; the system roots stay. */
export const trustCaFile = (caFile: string) => {
  if (trustedCaFiles.has(caFile)) return;
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), readFileSync(caFile, "utf8")]);
  trustedCaFiles.add(caFile);
};

/**
 * Provider data the Responses API takes and Chat Completions on vLLM does not: encrypted
 * reasoning continuity, the prompt-cache family, server-side compaction and truncation.
 */
const responsesOnlyParams = [
  "include",
  "prompt_cache_key",
  "prompt_cache_options",
  "prompt_cache_retention",
  "context_management",
  "truncation",
  "service_tier",
  "previous_response_id",
] as const;

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content
        .map((part: unknown) =>
          typeof part === "object" && part !== null && typeof Reflect.get(part, "text") === "string"
            ? String(Reflect.get(part, "text"))
            : "",
        )
        .join("\n\n")
    : typeof content === "string"
      ? content
      : "";

const providerType = (item: AgentInputItem): unknown =>
  item.type === "unknown" ? item.providerData?.["type"] : undefined;

/** The request ends in the Responses API's compaction trigger, which Chat Completions cannot do. */
export const asksForCompaction = (request: ModelRequest) =>
  typeof request.input !== "string" &&
  request.input.some((item) => providerType(item) === "compaction_trigger");

/**
 * Input items Chat Completions can carry. The cached developer prefix is raw Responses provider
 * data (`input_text` parts); it becomes a system message. Compaction items cannot be sent, and the
 * minter's own compaction never starts on this path (see `asksForCompaction`).
 */
const chatInput = (input: ModelRequest["input"]): ModelRequest["input"] => {
  if (typeof input === "string") return input;
  return input.flatMap((item): AgentInputItem[] => {
    if (item.type === "compaction") return [];
    if (item.type !== "unknown") return [item];
    const raw = item.providerData;
    if (raw?.["type"] === "message" && (raw["role"] === "developer" || raw["role"] === "system"))
      return [{ type: "message", role: "system", content: textOf(raw["content"]) }];
    return [item];
  });
};

/** The tools an `allowed_tools` choice admits, as a plain tool list (vLLM has no such choice). */
const withoutAllowedToolsChoice = (request: ModelRequest): ModelRequest => {
  const choice: unknown = request.modelSettings.providerData?.["tool_choice"];
  if (typeof choice !== "object" || choice === null) return request;
  if (Reflect.get(choice, "type") !== "allowed_tools") return request;
  const listed: unknown = Reflect.get(choice, "tools");
  const names = new Set(
    (Array.isArray(listed) ? listed : []).flatMap((entry: unknown) =>
      typeof entry === "object" &&
      entry !== null &&
      Reflect.get(entry, "type") === "function" &&
      typeof Reflect.get(entry, "name") === "string"
        ? [String(Reflect.get(entry, "name"))]
        : [],
    ),
  );
  const { tool_choice: _choice, ...providerData } = request.modelSettings.providerData ?? {};
  return {
    ...request,
    tools: request.tools.filter((tool) => tool.type !== "function" || names.has(tool.name)),
    modelSettings: {
      ...request.modelSettings,
      ...(Reflect.get(choice, "mode") === "required" ? { toolChoice: "required" as const } : {}),
      providerData,
    },
  };
};

/**
 * The request as a Chat Completions gateway takes it: no prompt-cache settings or breakpoints,
 * no `store`, no reasoning `summary`/`context` (the SDK warns on them), no Responses-only
 * provider data, `allowed_tools` turned into a filtered tool list, and the cached developer
 * prefix as a system message. `reasoning.effort` stays unless the config strips it.
 */
export const forChatCompletions = (
  request: ModelRequest,
  config: Pick<GatewayConfig, "stripParams" | "stripReasoningEffort">,
): ModelRequest => {
  const cleaned = withoutAllowedToolsChoice(withoutPromptCacheSettings(request));
  const {
    store: _store,
    promptCacheRetention: _retention,
    reasoning,
    ...settings
  } = cleaned.modelSettings;
  const drop = new Set<string>([...responsesOnlyParams, ...config.stripParams]);
  const providerData = Object.fromEntries(
    Object.entries(settings.providerData ?? {}).filter(([name]) => !drop.has(name)),
  );
  const effort = config.stripReasoningEffort ? undefined : reasoning?.effort;
  return {
    ...cleaned,
    input: chatInput(cleaned.input),
    modelSettings: {
      ...settings,
      providerData,
      ...(effort === undefined ? {} : { reasoning: { effort } }),
    },
  };
};

/** A model whose requests pass through `forChatCompletions`. */
const chatModel = (model: Model, config: GatewayConfig): Model => {
  const refuse = () =>
    new Error("The gateway speaks Chat Completions, which has no server-side compaction.");
  return {
    ...model,
    getResponse: (request: ModelRequest): Promise<ModelResponse> => {
      // A prewarm only writes the provider's cache; this gateway has none to write.
      if (isPrewarm(request)) return Promise.resolve({ usage: new Usage(), output: [] });
      if (asksForCompaction(request)) return Promise.reject(refuse());
      return model.getResponse(forChatCompletions(request, config));
    },
    getStreamedResponse: (request: ModelRequest) => {
      if (asksForCompaction(request)) throw refuse();
      return model.getStreamedResponse(forChatCompletions(request, config));
    },
  };
};

/**
 * The model provider for the gateway: the SDK's Chat Completions models over the gateway's client,
 * with the requests above. The Responses API is not used, since vLLM serves chat completions.
 */
export const makeGatewayProvider = (config: GatewayConfig): ModelProvider => {
  if (config.caFile !== undefined) trustCaFile(config.caFile);
  const inner = new OpenAIProvider({
    openAIClient: new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey }),
    useResponses: false,
  });
  return { getModel: async (name) => chatModel(await inner.getModel(name), config) };
};
