import type {
  CapabilityResolution,
  ModelsDevModel,
  ModelsDevProvider,
  NormalizedCache,
  NormalizedReasoning,
  PiApi,
  PiCompat,
  PiCost,
  PiModel,
  ReasoningLevel,
} from "./types.ts";
import { DEFAULT_COST, DEFAULT_MAX_TOKENS } from "./types.ts";

const REASONING_LEVELS: ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

const PROVIDER_ENDPOINTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  "google-vertex": "https://generativelanguage.googleapis.com/v1beta",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  fireworks: "https://api.fireworks.ai/inference/v1",
  together: "https://api.together.xyz/v1",
  perplexity: "https://api.perplexity.ai",
  cohere: "https://api.cohere.com/compatibility/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  zhipuai: "https://open.bigmodel.cn/api/paas/v4",
  moonshot: "https://api.moonshot.cn/v1",
};

export function inferProviderEndpoint(provider: ModelsDevProvider, requestedEndpoint?: string): string | undefined {
  if (requestedEndpoint && /^https?:\/\//i.test(requestedEndpoint)) return requestedEndpoint;
  if (provider.api && /^https?:\/\//i.test(provider.api)) return provider.api;
  return PROVIDER_ENDPOINTS[provider.id.toLowerCase()];
}

export function detectPiApi(provider: ModelsDevProvider, endpoint?: string): PiApi {
  const haystack = `${provider.id} ${provider.name ?? ""} ${provider.api ?? ""} ${endpoint ?? ""}`.toLowerCase();
  if (haystack.includes("anthropic") || haystack.includes("claude") || haystack.includes("minimax.io/anthropic") || haystack.includes("minimaxi.com/anthropic")) {
    return "anthropic-messages";
  }
  if (haystack.includes("google") || haystack.includes("gemini") || haystack.includes("generativelanguage")) {
    return "google-generative-ai";
  }
  if (haystack.includes("responses")) return "openai-responses";
  return "openai-completions";
}

export function resolveReasoning(provider: ModelsDevProvider | undefined, model: ModelsDevModel | undefined): NormalizedReasoning {
  if (!model) {
    return { supported: false, controlType: "unknown", levels: [], maxTokens: DEFAULT_MAX_TOKENS };
  }
  const supported = model.reasoning === true || (Array.isArray(model.reasoning_options) && model.reasoning_options.length > 0);
  const options = model.reasoning_options ?? [];
  const effortOption = options.find((option) => option.type === "effort");
  const budgetOption = options.find((option) => option.type === "budget" || option.type === "budget_tokens");
  const toggleOption = options.find((option) => option.type === "toggle");
  if (!supported) return { supported: false, controlType: "unknown", levels: [], maxTokens: model.limit?.output ?? DEFAULT_MAX_TOKENS };

  if (effortOption) {
    const values = effortOption.values?.filter((value): value is string => typeof value === "string") ?? EFFORT_LEVELS;
    return {
      supported: true,
      controlType: "effort",
      levels: values,
      defaultLevel: values.includes("medium") ? "medium" : values[0],
      maxTokens: model.limit?.output ?? DEFAULT_MAX_TOKENS,
    };
  }
  if (budgetOption) {
    return {
      supported: true,
      controlType: "budget",
      levels: budgetOption.values?.filter((value): value is string => typeof value === "string") ?? [],
      maxTokens: budgetOption.max ?? model.limit?.output ?? DEFAULT_MAX_TOKENS,
    };
  }
  if (toggleOption || options.length === 0) {
    return {
      supported: true,
      controlType: "toggle",
      levels: ["on"],
      defaultLevel: "on",
      maxTokens: model.limit?.output ?? DEFAULT_MAX_TOKENS,
    };
  }
  return {
    supported: true,
    controlType: "unknown",
    levels: [],
    maxTokens: model.limit?.output ?? DEFAULT_MAX_TOKENS,
  };
}

export function resolveCache(provider: ModelsDevProvider | undefined, model: ModelsDevModel | undefined): NormalizedCache {
  const providerKeys = provider ? collectKeyNames(provider).join(" ") : "";
  const modelKeys = model ? collectKeyNames(model).join(" ") : "";
  const providerValues = provider ? collectStringValues(provider).join(" ").toLowerCase() : "";
  const modelValues = model ? collectStringValues(model).join(" ").toLowerCase() : "";
  const keys = `${providerKeys} ${modelKeys}`;
  const values = `${providerValues} ${modelValues}`;
  const cost = model?.cost;
  const priced = typeof cost?.cache_read === "number" || typeof cost?.cache_write === "number";
  const prompt = priced || /prompt.?cache|cache.?prompt|prompt_caching|cache_control|prefix.?cache/.test(keys) || /prompt.?cache|cache.?control|prefix.?cache/.test(values);
  const context = /context.?cache|context_cach/.test(keys) || /context.?cache/.test(values);
  const kv = /kv.?cache|key.?value.?cache|paged.?attention/.test(keys) || /kv.?cache/.test(values);
  return {
    prompt,
    context,
    kv,
    readPricing: typeof cost?.cache_read === "number",
    writePricing: typeof cost?.cache_write === "number",
    strategy: model ? "model" : provider ? "provider" : "unknown",
  };
}

export function resolveCapabilities(provider: ModelsDevProvider | undefined, model: ModelsDevModel | undefined, endpoint?: string): CapabilityResolution {
  const baseProvider = provider ?? { id: "unknown", models: {} };
  return {
    cache: resolveCache(provider, model),
    reasoning: resolveReasoning(provider, model),
    adapter: resolveProviderAdapter(baseProvider, endpoint).id,
  };
}

export function toPiModel(
  provider: ModelsDevProvider,
  source: ModelsDevModel,
  options: { endpoint?: string; now?: Date; sourceName?: string } = {},
): PiModel {
  const api = detectPiApi(provider, options.endpoint ?? provider.api);
  const reasoning = resolveReasoning(provider, source);
  const cache = resolveCache(provider, source);
  const supportedInput = source.modalities?.input?.filter((value): value is "text" | "image" => value === "text" || value === "image") ?? [];
  const input: Array<"text" | "image"> = supportedInput.length > 0 ? supportedInput : ["text"];
  const cost: PiCost = {
    ...DEFAULT_COST,
    ...(typeof source.cost?.input === "number" ? { input: source.cost.input } : {}),
    ...(typeof source.cost?.output === "number" ? { output: source.cost.output } : {}),
    ...(typeof source.cost?.cache_read === "number" ? { cacheRead: source.cost.cache_read } : {}),
    ...(typeof source.cost?.cache_write === "number" ? { cacheWrite: source.cost.cache_write } : {}),
    ...(source.cost?.tiers ? {
      tiers: source.cost.tiers
        .filter((tier) => typeof tier.inputTokensAbove === "number")
        .map((tier) => ({
          inputTokensAbove: tier.inputTokensAbove as number,
          input: typeof tier.input === "number" ? tier.input : (typeof source.cost?.input === "number" ? source.cost.input : 0),
          output: typeof tier.output === "number" ? tier.output : (typeof source.cost?.output === "number" ? source.cost.output : 0),
          cacheRead: typeof tier.cache_read === "number" ? tier.cache_read : (typeof source.cost?.cache_read === "number" ? source.cost.cache_read : 0),
          cacheWrite: typeof tier.cache_write === "number" ? tier.cache_write : (typeof source.cost?.cache_write === "number" ? source.cost.cache_write : 0),
        })),
    } : {}),
  };
  const model: PiModel = {
    id: source.id,
    ...(source.name ? { name: source.name } : {}),
    api,
    reasoning: reasoning.supported,
    input,
    cost,
    contextWindow: source.limit?.context && source.limit.context > 0 ? source.limit.context : 128_000,
    maxTokens: source.limit?.output && source.limit.output > 0 ? source.limit.output : DEFAULT_MAX_TOKENS,
    compat: capabilityCompat(api, cache, reasoning, source, provider.id),
  };
  const thinkingLevelMap = toThinkingLevelMap(reasoning);
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  if (options.now) {
    model._piModelDoctor = {
      managed: true,
      source: options.sourceName ?? "models.dev",
      lastCheck: options.now.toISOString(),
      autoRepair: true,
      providerId: provider.id,
      modelId: source.id,
      version: 1,
      managedFields: ["name", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"],
      managedValues: {},
    };
    const fields = model._piModelDoctor.managedFields ?? [];
    model._piModelDoctor.managedValues = Object.fromEntries(
      fields.map((field) => [field, model[field]]).filter(([, value]) => value !== undefined),
    );
  }
  return model;
}

export interface ProviderAdapter {
  id: string;
  api: PiApi;
  thinkingFormat?: string;
  cacheControlFormat?: "anthropic";
}

export function resolveProviderAdapter(provider: ModelsDevProvider, endpoint?: string): ProviderAdapter {
  const api = detectPiApi(provider, endpoint);
  const id = provider.id.toLowerCase();
  if (api === "anthropic-messages") return { id: "anthropic", api, cacheControlFormat: "anthropic" };
  if (api === "google-generative-ai") return { id: "google", api };
  if (api === "openai-responses") return { id: "openai-responses", api, thinkingFormat: "openai" };
  if (id.includes("openrouter")) return { id: "openrouter", api, thinkingFormat: "openrouter" };
  if (id.includes("deepseek")) return { id: "deepseek", api, thinkingFormat: "deepseek" };
  if (id.includes("together")) return { id: "together", api, thinkingFormat: "together" };
  if (id.includes("zhipu") || id === "zai" || id.includes("glm")) return { id: "zai", api, thinkingFormat: "zai" };
  if (id.includes("qwen") || id.includes("dashscope") || id.includes("alibaba")) return { id: "qwen", api, thinkingFormat: "qwen" };
  return { id: "openai-compatible", api, thinkingFormat: "openai" };
}

export function capabilityCompat(
  api: PiApi,
  cache: NormalizedCache,
  reasoning: NormalizedReasoning,
  source: ModelsDevModel,
  providerId?: string,
): PiCompat | undefined {
  const adapter = resolveProviderAdapter({ id: providerId ?? "unknown", models: {} }, source.api as string | undefined);
  const compat: PiCompat = {};
  if (api === "anthropic-messages" && (cache.prompt || cache.context || cache.kv)) {
    compat.cacheControlFormat = adapter.cacheControlFormat ?? "anthropic";
  }
  if ((api === "anthropic-messages" || api === "openai-completions" || api === "openai-responses") && cache.prompt) {
    compat.supportsLongCacheRetention = true;
  }
  if (api === "openai-completions" && providerId?.toLowerCase().includes("openrouter") && cache.prompt) {
    compat.sendSessionAffinityHeaders = true;
    compat.sessionAffinityFormat = "openrouter";
  }
  if (api === "openai-completions" && reasoning.supported) {
    compat.supportsReasoningEffort = reasoning.controlType === "effort";
    if (reasoning.controlType === "effort") compat.thinkingFormat = adapter.thinkingFormat ?? "openai";
  }
  if (api === "google-generative-ai" && reasoning.supported) compat.supportsTemperature = source.temperature === true;
  if (Object.keys(compat).length === 0) return undefined;
  return compat;
}

export function toThinkingLevelMap(reasoning: NormalizedReasoning): Partial<Record<ReasoningLevel, string | null>> | undefined {
  if (!reasoning.supported) return undefined;
  if (reasoning.controlType === "toggle") {
    return { off: null, minimal: "on", low: "on", medium: "on", high: "on", xhigh: "on", max: "on" };
  }
  if (reasoning.controlType !== "effort") return undefined;
  const supported = new Set(reasoning.levels.map((level) => level.toLowerCase()));
  const map: Partial<Record<ReasoningLevel, string | null>> = { off: null };
  for (const level of REASONING_LEVELS.slice(1)) {
    const selected = supported.has(level) ? level : nearestEffort(level, supported);
    map[level] = selected;
  }
  return map;
}

function nearestEffort(level: ReasoningLevel, supported: Set<string>): string | null {
  const order = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const index = order.indexOf(level);
  for (let distance = 1; distance <= order.length; distance++) {
    const lower = order[index - distance];
    const higher = order[index + distance];
    if (lower && supported.has(lower)) return lower;
    if (higher && supported.has(higher)) return higher;
  }
  return supported.size ? [...supported][0] : null;
}

function adapterName(api: PiApi): string {
  switch (api) {
    case "anthropic-messages": return "anthropic";
    case "google-generative-ai": return "google";
    case "openai-responses": return "openai-responses";
    default: return "openai-compatible";
  }
}

function collectKeyNames(value: unknown, output: string[] = []): string[] {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    for (const child of value) collectKeyNames(child, output);
    return output;
  }
  for (const [key, child] of Object.entries(value)) {
    output.push(key.toLowerCase());
    collectKeyNames(child, output);
  }
  return output;
}

function collectStringValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") output.push(value.toLowerCase());
  else if (Array.isArray(value)) for (const child of value) collectStringValues(child, output);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collectStringValues(child, output);
  return output;
}
