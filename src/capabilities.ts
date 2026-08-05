import { isRecord, looksLikeCredentialValue } from "./json.ts";
import type {
  AdapterPolicy,
  CapabilityResolution,
  ModelsDevModel,
  ModelsDevProvider,
  NormalizedCache,
  NormalizedReasoning,
  PiApi,
  PiCompat,
  PiCost,
  CapabilityResolutionLevel,
  PiModel,
  PolicyCatalog,
  ReasoningLevel,
} from "./types.ts";
import { DEFAULT_COST, DEFAULT_MAX_TOKENS, MODELS_DEV_OBSERVED_AT_BASELINE, MODELS_DEV_SCHEMA_BASELINE, MODELS_DEV_SCHEMA_VERSION_BASELINE, MODEL_DOCTOR_VERSION, PI_RUNTIME_VERSION_BASELINE } from "./types.ts";

const REASONING_LEVELS: ReasoningLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// Pi treats xhigh/max as opt-in levels. Do not infer those levels when the
// catalog only says that an adapter accepts a generic effort value.
const EFFORT_LEVELS = ["minimal", "low", "medium", "high"];
const DEFAULT_REASONING_BUDGET = 16_384;

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

export function defaultPolicyCatalog(now = new Date()): PolicyCatalog {
  const openAiReasoning = {
    effortField: "reasoning_effort",
    budgetField: "reasoning_budget_tokens",
    fallbackField: "reasoningFallback",
  };
  const openAiCache: AdapterPolicy["cache"] = {
    // Pi has no generic OpenAI cache-enable flag. Keep catalog signals in the
    // Doctor namespace and only emit formal Pi compat fields when the adapter
    // has one (for example retention or session-affinity support).
    retentionField: "supportsLongCacheRetention",
    sessionAffinityField: "sessionAffinityFormat",
    sessionAffinityFormat: "openai",
    unsupported: [
      "Prompt cache execution has no generic Pi control field for this adapter.",
      "Context cache execution is provider/runtime-specific and is represented as capability metadata.",
      "KV cache execution is provider/runtime-specific and is represented as capability metadata.",
    ],
  };
  const adapters: Record<string, AdapterPolicy> = {
    anthropic: {
      id: "anthropic",
      reasoning: {
        toggleField: "thinking.type",
        budgetField: "thinking.budget_tokens",
        adaptiveField: "thinking.type",
        fallbackField: "reasoningFallback",
      },
      cache: {
        promptField: "cacheControlFormat",
        retentionField: "supportsLongCacheRetention",
        sessionAffinityField: "sendSessionAffinityHeaders",
        unsupported: [
          "Context cache is not directly configurable through Pi compat metadata.",
          "KV cache is not directly configurable through Pi compat metadata.",
        ],
      },
    },
    google: {
      id: "google",
      reasoning: {
        toggleField: "thinkingConfig.includeThoughts",
        effortField: "thinkingConfig.thinkingLevel",
        budgetField: "thinkingConfig.thinkingBudget",
        fallbackField: "reasoningFallback",
      },
      cache: {
        // The current Pi Google adapter has no cache-control or cachedContent
        // runtime field; retain these as advisory policy metadata only.
        unsupported: [
          "Prompt cache execution has no verified Google Pi control field.",
          "Context cache execution has no verified Google Pi control field.",
          "KV cache execution is provider-managed.",
        ],
      },
    },
    "openai-responses": {
      id: "openai-responses",
      reasoning: openAiReasoning,
      cache: {
        ...openAiCache,
        explicitPromptField: "supportsExplicitPromptCacheMode",
        sessionAffinityField: "sessionAffinityFormat",
      },
    },
    "openai-compatible": {
      id: "openai-compatible",
      reasoning: openAiReasoning,
      cache: openAiCache,
    },
    openrouter: {
      id: "openrouter",
      reasoning: {
        effortField: "reasoning.effort",
        budgetField: "reasoning.max_tokens",
        fallbackField: "reasoningFallback",
      },
      cache: {
        retentionField: "supportsLongCacheRetention",
        sessionAffinityField: "sessionAffinityFormat",
        sessionAffinityFormat: "openrouter",
        unsupported: [
          "Prompt cache execution is routed through the selected upstream model and has no generic Pi control field.",
          "Context cache execution is routed through the selected upstream model and has no generic Pi control field.",
          "KV cache execution is routed through the selected upstream model and has no generic Pi control field.",
        ],
      },
    },
    deepseek: {
      id: "deepseek",
      reasoning: {
        effortField: "thinkingFormat",
        budgetField: "reasoning_budget_tokens",
        fallbackField: "reasoningFallback",
      },
      cache: openAiCache,
    },
    together: {
      id: "together",
      reasoning: {
        effortField: "thinkingFormat",
        budgetField: "reasoning_budget_tokens",
        fallbackField: "reasoningFallback",
      },
      cache: openAiCache,
    },
    zai: {
      id: "zai",
      reasoning: {
        effortField: "thinkingFormat",
        budgetField: "reasoning_budget_tokens",
        fallbackField: "reasoningFallback",
      },
      cache: openAiCache,
    },
    qwen: {
      id: "qwen",
      reasoning: {
        effortField: "thinkingFormat",
        budgetField: "reasoning_budget_tokens",
        fallbackField: "reasoningFallback",
      },
      cache: openAiCache,
    },
  };
  const fallback: AdapterPolicy = {
    id: "fallback",
    reasoning: {
      effortField: "reasoning_effort",
      budgetField: "reasoning_budget_tokens",
      fallbackField: "reasoningFallback",
    },
    cache: {
      unsupported: ["Provider-specific cache behavior is unknown; capability metadata is advisory only."],
    },
  };
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    baseline: {
      piVersion: PI_RUNTIME_VERSION_BASELINE,
      modelsDevSchema: MODELS_DEV_SCHEMA_BASELINE,
      modelsDevSchemaVersion: MODELS_DEV_SCHEMA_VERSION_BASELINE,
      modelsDevObservedAt: MODELS_DEV_OBSERVED_AT_BASELINE,
      policyCatalogSchemaVersion: 1,
      modelDoctorMetadataVersion: MODEL_DOCTOR_VERSION,
    },
    adapters,
    fallback,
    capabilityMapping: {
      reasoning: { budgetSeparateFromOutputTokens: true, unknown: "fallback" },
      cache: {
        independentSignals: ["prompt", "context", "kv"],
        pricingDoesNotEnableRuntime: true,
        unsupportedRuntime: "advisory",
      },
    },
  };
}

export function isPolicyCatalog(value: unknown): value is PolicyCatalog {
  if (!isRecord(value) || hasSensitivePolicyKey(value) || hasUnsafePolicyKey(value) || value.schemaVersion !== 1 || typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) return false;
  if (!isRecord(value.baseline)
    || value.baseline.piVersion !== PI_RUNTIME_VERSION_BASELINE
    || value.baseline.modelsDevSchema !== MODELS_DEV_SCHEMA_BASELINE
    || value.baseline.modelsDevSchemaVersion !== MODELS_DEV_SCHEMA_VERSION_BASELINE
    || value.baseline.modelsDevObservedAt !== MODELS_DEV_OBSERVED_AT_BASELINE
    || value.baseline.policyCatalogSchemaVersion !== 1
    || value.baseline.modelDoctorMetadataVersion !== MODEL_DOCTOR_VERSION) return false;
  if (!isRecord(value.adapters) || !isAdapterPolicy(value.fallback)) return false;
  if (!isRecord(value.capabilityMapping)) return false;
  const reasoning = value.capabilityMapping.reasoning;
  const cache = value.capabilityMapping.cache;
  if (!isRecord(reasoning) || reasoning.budgetSeparateFromOutputTokens !== true || reasoning.unknown !== "fallback") return false;
  if (!isRecord(cache) || cache.pricingDoesNotEnableRuntime !== true || cache.unsupportedRuntime !== "advisory") return false;
  if (!Array.isArray(cache.independentSignals) || cache.independentSignals.length !== 3
    || new Set(cache.independentSignals).size !== 3
    || cache.independentSignals.some((signal) => !["prompt", "context", "kv"].includes(signal))) return false;
  return Object.entries(value.adapters).every(([key, adapter]) => isAdapterPolicy(adapter) && adapter.id === key);
}

function isAdapterPolicy(value: unknown): value is AdapterPolicy {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.trim() === "" || isUnsafePolicyIdentifier(value.id)) return false;
  if (!isRecord(value.reasoning) || typeof value.reasoning.fallbackField !== "string" || !isSafePolicyField(value.reasoning.fallbackField)) return false;
  if (!isRecord(value.cache)) return false;
  for (const field of ["toggleField", "effortField", "budgetField", "adaptiveField"] as const) {
    if (value.reasoning[field] !== undefined && (typeof value.reasoning[field] !== "string" || !isSafePolicyField(value.reasoning[field]))) return false;
  }
  for (const field of ["promptField", "contextField", "kvField", "retentionField", "explicitPromptField", "sessionAffinityField"] as const) {
    if (value.cache[field] !== undefined && (typeof value.cache[field] !== "string" || !isSafePolicyField(value.cache[field]))) return false;
  }
  if (value.cache.sessionAffinityFormat !== undefined && (typeof value.cache.sessionAffinityFormat !== "string" || value.cache.sessionAffinityFormat.trim() === "")) return false;
  return value.cache.unsupported === undefined
    || (Array.isArray(value.cache.unsupported) && value.cache.unsupported.every((item) => typeof item === "string" && item.trim() !== "" && !looksLikeCredentialValue(item)));
}

function isSafePolicyField(value: string): boolean {
  const segments = value.split(".").map((segment) => segment.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((segment) => !isUnsafePolicyIdentifier(segment) && !isSensitivePolicyField(segment));
}

function isUnsafePolicyIdentifier(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

function isSensitivePolicyField(value: string): boolean {
  return /^(?:headers?|authentication|auth|credentials?|api[-_]?key|authorization(?:[-_]?header)?|auth[-_]?header|oauth|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|set-cookie)$/i.test(value)
    || /^(?:x[-_]?api[-_]?key|x[-_]?auth[-_]?token)$/i.test(value);
}

function hasSensitivePolicyKey(value: unknown): boolean {
  if (typeof value === "string") return looksLikeCredentialValue(value);
  if (Array.isArray(value)) return value.some((item) => hasSensitivePolicyKey(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (/^(?:headers?|authentication|auth|credentials?|api[-_]?key|authorization(?:[-_]?header)?|auth[-_]?header|oauth|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|set-cookie)$/i.test(key)
      || /^(?:x[-_]?api[-_]?key|x[-_]?auth[-_]?token)$/i.test(key)) return true;
    return hasSensitivePolicyKey(child);
  });
}

function hasUnsafePolicyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasUnsafePolicyKey(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => key === "__proto__" || key === "constructor" || key === "prototype" || hasUnsafePolicyKey(child));
}

function policyForAdapter(adapterId: string, policy: PolicyCatalog): AdapterPolicy {
  return policy.adapters[adapterId] ?? policy.fallback;
}

export function inferProviderEndpoint(provider: ModelsDevProvider, requestedEndpoint?: string): string | undefined {
  if (requestedEndpoint && /^https?:\/\//i.test(requestedEndpoint)) return requestedEndpoint;
  if (provider.api && /^https?:\/\//i.test(provider.api)) return provider.api;
  return PROVIDER_ENDPOINTS[provider.id.toLowerCase()];
}

export function detectChannelApi(endpoint?: string, explicitApi?: PiApi): PiApi {
  if (explicitApi) return explicitApi;
  const haystack = (endpoint ?? "").toLowerCase();
  if (haystack.includes("anthropic") || haystack.includes("claude")) return "anthropic-messages";
  if (haystack.includes("google") || haystack.includes("gemini") || haystack.includes("generativelanguage")) return "google-generative-ai";
  if (haystack.includes("responses")) return "openai-responses";
  return "openai-completions";
}

export function detectPiApi(provider: ModelsDevProvider, endpoint?: string, explicitApi?: PiApi): PiApi {
  if (explicitApi) return explicitApi;
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
  const outputTokens = positiveNumber(model?.limit?.output) ?? DEFAULT_MAX_TOKENS;
  if (!model) {
    return {
      supported: false,
      controlType: "unknown",
      levels: [],
      canDisable: false,
      maxTokens: outputTokens,
      maxOutputTokens: outputTokens,
      mappingConfidence: "low",
      fallback: true,
      fallbackReason: "Reasoning metadata is unavailable.",
    };
  }
  const options = model.reasoning_options ?? [];
  const supported = model.reasoning === true || options.length > 0;
  const adaptiveOption = options.find((option) => option.type?.toLowerCase() === "adaptive");
  const budgetOption = options.find((option) => {
    const type = option.type?.toLowerCase();
    return type === "budget" || type === "budget_tokens";
  });
  const effortOption = options.find((option) => option.type?.toLowerCase() === "effort");
  const toggleOption = options.find((option) => option.type?.toLowerCase() === "toggle");
  if (!supported) {
    return {
      supported: false,
      controlType: "unknown",
      levels: [],
      canDisable: false,
      maxTokens: outputTokens,
      maxOutputTokens: outputTokens,
      mappingConfidence: model.reasoning === false ? "high" : "low",
      fallback: model.reasoning === undefined,
      fallbackReason: model.reasoning === undefined ? "Reasoning metadata is absent." : undefined,
    };
  }

  if (adaptiveOption) {
    const declaredLevels = adaptiveOption.values?.filter((value): value is string => typeof value === "string") ?? [];
    const levels = declaredLevels.length > 0 ? declaredLevels : ["low", "medium", "high"];
    return {
      supported: true,
      controlType: "adaptive",
      levels,
      defaultLevel: levels.includes("medium") ? "medium" : levels[0],
      canDisable: false,
      maxTokens: outputTokens,
      maxOutputTokens: outputTokens,
      mappingConfidence: "high",
    };
  }
  if (budgetOption) {
    const minTokens = integerBudgetOrDefault(budgetOption.min, 1024);
    const declaredMaxTokens = minTokens === undefined
      ? undefined
      : integerBudgetOrDefault(budgetOption.max, Math.max(minTokens, DEFAULT_REASONING_BUDGET));
    if (minTokens === undefined || declaredMaxTokens === undefined || declaredMaxTokens < minTokens) {
      return {
        supported: true,
        controlType: "unknown",
        levels: [],
        canDisable: false,
        maxTokens: outputTokens,
        maxOutputTokens: outputTokens,
        mappingConfidence: "low",
        fallback: true,
        fallbackReason: "Reasoning budget metadata is invalid; the provider-specific budget mapping is advisory only.",
      };
    }
    return {
      supported: true,
      controlType: "budget",
      levels: budgetOption.values?.filter((value): value is string => typeof value === "string") ?? [],
      defaultLevel: "medium",
      canDisable: true,
      maxTokens: outputTokens,
      maxOutputTokens: outputTokens,
      minBudgetTokens: minTokens,
      budgetMinTokens: minTokens,
      maxBudgetTokens: declaredMaxTokens,
      budgetTokens: declaredMaxTokens,
      mappingConfidence: "high",
    };
  }
  if (effortOption) {
    const declaredValues = effortOption.values?.filter((value): value is string => typeof value === "string") ?? [];
    const values = declaredValues.length > 0 ? declaredValues : EFFORT_LEVELS;
    return {
      supported: true,
      controlType: "effort",
      levels: values,
      defaultLevel: values.includes("medium") ? "medium" : values[0],
      canDisable: true,
      maxTokens: outputTokens,
      maxOutputTokens: outputTokens,
      mappingConfidence: "high",
    };
  }
  if (toggleOption || options.length === 0) {
    const toggleValues = toggleOption?.values?.filter((value): value is string => typeof value === "string" && value.trim() !== "") ?? [];
    const toggleOffValue = toggleValues.find((value) => /^(?:off|false|disabled|disable|none|no)$/i.test(value));
    const toggleOnValue = toggleValues.find((value) => value !== toggleOffValue) ?? "on";
    return {
      supported: true,
      controlType: "toggle",
      levels: [toggleOnValue],
      defaultLevel: toggleOnValue,
      canDisable: toggleOption ? toggleOffValue !== undefined : false,
      ...(toggleOnValue !== "on" ? { toggleOnValue } : {}),
      ...(toggleOffValue ? { toggleOffValue } : {}),
      maxTokens: outputTokens,
      maxOutputTokens: outputTokens,
      mappingConfidence: toggleOption ? "high" : "medium",
    };
  }
  const unknownType = options.find((option) => typeof option.type === "string")?.type ?? "unknown";
  return {
    supported: true,
    controlType: "unknown",
    levels: [],
    canDisable: false,
    maxTokens: outputTokens,
    maxOutputTokens: outputTokens,
    mappingConfidence: "low",
    fallback: true,
    fallbackReason: `Unsupported reasoning option type: ${unknownType}.`,
  };
}

export function resolveCache(provider: ModelsDevProvider | undefined, model: ModelsDevModel | undefined, sourceOverride?: NormalizedCache["source"]): NormalizedCache {
  const providerKeys = provider ? collectKeyNames(provider).join(" ") : "";
  const modelKeys = model ? collectKeyNames(model).join(" ") : "";
  const keys = `${providerKeys} ${modelKeys}`;
  const cost = model?.cost;
  const prompt = hasPositiveSignal(provider, model, /prompt.?cache|cache.?prompt|prompt_caching|cache_control|prefix.?cache/, /prompt.?cache|cache.?control|prefix.?cache/);
  const context = hasPositiveSignal(provider, model, /context.?cache|context_cach|cached.?content/, /context.?cache|cached.?content/);
  const kv = hasPositiveSignal(provider, model, /kv.?cache|key.?value.?cache|paged.?attention/, /kv.?cache|paged.?attention/);
  const promptControl = prompt && /cache.?control|prompt.?cach(?:e|ing).?(?:field|control)|prompt_cache_control/.test(keys);
  const contextControl = context && /cached.?content|context.?cache.?(?:field|control)/.test(keys);
  const kvControl = kv && /kv.?cache.?(?:field|control)|key.?value.?cache.?(?:field|control)/.test(keys);
  const readPricing = typeof cost?.cache_read === "number";
  const writePricing = typeof cost?.cache_write === "number";
  const usageRead = /input[_ -]?tokens|cache[_ -]?read[_ -]?tokens|read[_ -]?tokens/.test(keys)
    || hasTruthyKeySignal(model?.usage, /input|cache.?read|read.?tokens/)
    || hasTruthyKeySignal(provider?.usage, /input|cache.?read|read.?tokens/);
  const usageWrite = /output[_ -]?tokens|cache[_ -]?write[_ -]?tokens|write[_ -]?tokens/.test(keys)
    || hasTruthyKeySignal(model?.usage, /output|cache.?write|write.?tokens/)
    || hasTruthyKeySignal(provider?.usage, /output|cache.?write|write.?tokens/);
  const retentionValues = [...new Set([
    ...collectStringValues(model?.retention),
    ...collectStringValues(provider?.retention),
  ])].filter((value) => /cache|hour|day|session|ttl|ephemeral|persistent/.test(value));
  const retentionExplicit = firstBooleanMetadata(model?.retention, ["supported", "enabled", "available"])
    ?? firstBooleanMetadata(provider?.retention, ["supported", "enabled", "available"]);
  const retentionSignal = hasTruthyKeySignal(model?.retention, /ttl|duration|persistent|ephemeral/)
    || hasTruthyKeySignal(provider?.retention, /ttl|duration|persistent|ephemeral/);
  const retentionSupported = retentionExplicit
    ?? (retentionSignal || retentionValues.length > 0);
  const affinityFormat = firstStringMetadata(model?.session_affinity, ["format", "type"])
    ?? firstStringMetadata(provider?.session_affinity, ["format", "type"])
    ?? [typeof model?.session_affinity === "string" ? model.session_affinity : undefined, typeof provider?.session_affinity === "string" ? provider.session_affinity : undefined].find(Boolean);
  const affinityExplicit = firstBooleanMetadata(model?.session_affinity, ["supported", "enabled", "available"])
    ?? firstBooleanMetadata(provider?.session_affinity, ["supported", "enabled", "available"]);
  const affinitySignal = hasTruthyKeySignal(model?.session_affinity, /session.?affinity|session.?cache|cache.?key|format|type/)
    || hasTruthyKeySignal(provider?.session_affinity, /session.?affinity|session.?cache|cache.?key|format|type/);
  const sessionAffinitySupported = affinityExplicit
    ?? (affinitySignal || affinityFormat !== undefined);
  const explicitSignals = /prompt.?cache|context.?cache|kv.?cache|cache_control|cached.?content|paged.?attention/.test(keys);
  const hasAnySignal = prompt || context || kv || readPricing || writePricing || retentionSupported || sessionAffinitySupported;
  const confidence: NormalizedCache["confidence"] = explicitSignals ? "high" : hasAnySignal ? "medium" : "low";
  const source: NormalizedCache["source"] = sourceOverride ?? (model ? "models.dev" : provider ? "provider" : "fallback");
  const strategy: NormalizedCache["strategy"] = model ? "model" : provider ? "provider" : "unknown";
  return {
    prompt,
    context,
    kv,
    readPricing,
    writePricing,
    capability: { prompt, context, kv },
    control: { prompt: promptControl, context: contextControl, kv: kvControl },
    pricing: { read: readPricing, write: writePricing },
    usageReporting: { readTokens: usageRead, writeTokens: usageWrite },
    retention: { supported: retentionSupported, values: retentionValues },
    sessionAffinity: { supported: sessionAffinitySupported, ...(affinityFormat ? { format: affinityFormat } : {}) },
    confidence,
    source,
    strategy,
  };
}

export function resolveCapabilities(
  provider: ModelsDevProvider | undefined,
  model: ModelsDevModel | undefined,
  endpoint?: string,
  policy = defaultPolicyCatalog(),
): CapabilityResolution {
  const baseProvider = provider ?? { id: "unknown", models: {} };
  const adapter = resolveProviderAdapter(baseProvider, endpoint);
  const cache = resolveCache(provider, model);
  const reasoning = resolveReasoning(provider, model);
  const api = detectPiApi(baseProvider, endpoint);
  return {
    cache,
    reasoning,
    adapter: adapter.id,
    adapterPolicy: policyForAdapter(adapter.id, policy),
    compat: model ? capabilityCompat(api, cache, reasoning, model, baseProvider.id, policy, endpoint) : undefined,
    policyVersion: policy.schemaVersion,
  };
}

export function toPiModel(
  provider: ModelsDevProvider,
  source: ModelsDevModel,
  options: { endpoint?: string; now?: Date; sourceName?: string; capabilitySource?: NormalizedCache["source"]; policy?: PolicyCatalog; api?: PiApi; metadataOnly?: boolean; transportOwned?: boolean; providerId?: string; adapterProviderId?: string } = {},
): PiModel {
  const policy = options.policy ?? defaultPolicyCatalog(options.now);
  const api = detectPiApi(provider, options.endpoint ?? provider.api, options.api);
  const reasoning = resolveReasoning(provider, source);
  const cache = resolveCache(provider, source, options.capabilitySource);
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
    compat: capabilityCompat(api, cache, reasoning, source, provider.id, policy, options.endpoint ?? provider.api, options.metadataOnly, options.transportOwned, options.adapterProviderId),
  };
  const thinkingLevelMap = toThinkingLevelMap(reasoning);
  if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
  if (options.now) {
    model._piModelDoctor = {
      managed: true,
      source: options.sourceName ?? "models.dev",
      lastCheck: options.now.toISOString(),
      autoRepair: true,
      providerId: options.providerId ?? provider.id,
      modelId: source.id,
      version: 1,
      managedFields: ["name", ...(options.metadataOnly || options.transportOwned ? [] : ["api"]), "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"],
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

export function adapterIdForPiApi(api: PiApi): string {
  switch (api) {
    case "anthropic-messages": return "anthropic";
    case "google-generative-ai": return "google";
    case "openai-responses": return "openai-responses";
    default: return "openai-compatible";
  }
}

export function resolveProviderAdapter(provider: ModelsDevProvider, endpoint?: string, explicitApi?: PiApi): ProviderAdapter {
  const api = detectPiApi(provider, endpoint, explicitApi);
  const id = provider.id.toLowerCase();
  if (api === "anthropic-messages") return { id: "anthropic", api, cacheControlFormat: "anthropic" };
  if (api === "google-generative-ai") return { id: "google", api };
  if (api === "openai-responses") return { id: "openai-responses", api, thinkingFormat: "openai" };
  if (id.includes("openrouter")) return { id: "openrouter", api, thinkingFormat: "openrouter" };
  if (id.includes("deepseek")) return { id: "deepseek", api, thinkingFormat: "deepseek" };
  if (id.includes("together")) return { id: "together", api, thinkingFormat: "together" };
  if (id.includes("zhipu") || id === "zai" || id.includes("glm")) return { id: "zai", api, thinkingFormat: "zai" };
  if (id.includes("qwen") || id.includes("dashscope") || id.includes("alibaba")) return { id: "qwen", api, thinkingFormat: "qwen" };
  const knownOpenAiCompatible = ["openai", "groq", "mistral", "xai", "fireworks", "together", "perplexity", "cohere", "nvidia", "zhipuai", "moonshot"];
  if (id === "openai-compatible" || id.includes("openai-compatible") || knownOpenAiCompatible.some((known) => id === known || id.startsWith(`${known}-`))) return { id: "openai-compatible", api, thinkingFormat: "openai" };
  return { id: "fallback", api, thinkingFormat: "openai" };
}

export function capabilityCompat(
  api: PiApi,
  cache: NormalizedCache,
  reasoning: NormalizedReasoning,
  source: ModelsDevModel,
  providerId?: string,
  policy = defaultPolicyCatalog(),
  endpoint?: string,
  metadataOnly = false,
  transportOwnedOrAdapterProviderId: boolean | string = false,
  adapterProviderId?: string,
): PiCompat | undefined {
  // Keep the pre-transportOwned positional form source-compatible: callers
  // that passed the adapter provider id as the ninth argument still get the
  // same adapter resolution while new callers can pass the ownership flag
  // followed by the adapter id.
  const transportOwned = typeof transportOwnedOrAdapterProviderId === "boolean" ? transportOwnedOrAdapterProviderId : false;
  const resolvedAdapterProviderId = typeof transportOwnedOrAdapterProviderId === "string" ? transportOwnedOrAdapterProviderId : adapterProviderId;
  const adapter = resolveProviderAdapter({ id: resolvedAdapterProviderId ?? providerId ?? "unknown", api, models: {} }, endpoint, api);
  const adapterPolicy = policyForAdapter(adapter.id, policy);
  const promptAdvisory = isUnsupportedCacheSignal(adapterPolicy, "prompt");
  const contextAdvisory = isUnsupportedCacheSignal(adapterPolicy, "context");
  const kvAdvisory = isUnsupportedCacheSignal(adapterPolicy, "kv");
  const compat: PiCompat = {
    capabilityAdapter: adapter.id,
    capabilityPolicyVersion: policy.schemaVersion,
    ...(metadataOnly ? { metadataOnly: true, metadataProviderId: providerId } : {}),
    ...(transportOwned ? { transportOwned: true } : {}),
    cacheCapabilities: {
      prompt: cache.prompt,
      context: cache.context,
      kv: cache.kv,
      readPricing: cache.readPricing,
      writePricing: cache.writePricing,
    },
    cacheResolution: {
      prompt: cacheResolutionLevel(cache.prompt, cache.control.prompt && Boolean(adapterPolicy.cache.promptField), promptAdvisory),
      context: cacheResolutionLevel(cache.context, cache.control.context && Boolean(adapterPolicy.cache.contextField), contextAdvisory),
      kv: cacheResolutionLevel(cache.kv, cache.control.kv && Boolean(adapterPolicy.cache.kvField), kvAdvisory),
      control: cache.control,
      pricing: { read: cache.readPricing, write: cache.writePricing },
      usageReporting: cache.usageReporting,
      retention: cache.retention,
      sessionAffinity: cache.sessionAffinity,
      confidence: cache.confidence,
      source: cache.source,
    },
  };
  const cacheWarnings: string[] = [];
  compat.supportsPromptCaching = cache.prompt && cache.control.prompt && Boolean(adapterPolicy.cache.promptField) && !promptAdvisory;
  compat.cachePromptField = adapterPolicy.cache.promptField;
  if (api === "anthropic-messages" && cache.prompt && cache.control.prompt) {
    // cacheControlFormat is a formal Pi adapter field, but it must not be
    // enabled merely because context/KV signals were observed.
    compat.cacheControlFormat = adapter.cacheControlFormat ?? "anthropic";
  }
  if (cache.prompt && !adapterPolicy.cache.promptField) cacheWarnings.push("Prompt cache is detected but has no provider-specific Pi field.");
  if (cache.retention.supported && adapterPolicy.cache.retentionField) {
    compat.supportsLongCacheRetention = true;
  }
  if (cache.sessionAffinity.supported && adapterPolicy.cache.sessionAffinityField) {
    compat.sendSessionAffinityHeaders = true;
    compat.sessionAffinityFormat = adapterPolicy.cache.sessionAffinityFormat ?? cache.sessionAffinity.format;
  }
  if (cache.sessionAffinity.supported && !adapterPolicy.cache.sessionAffinityField) {
    cacheWarnings.push("Session-affinity cache routing is detected but has no provider-specific Pi field.");
  }
  if (cache.prompt && adapterPolicy.cache.explicitPromptField) {
    compat.supportsExplicitPromptCacheMode = true;
  }
  compat.supportsContextCaching = cache.context && cache.control.context && Boolean(adapterPolicy.cache.contextField) && !contextAdvisory;
  compat.cacheContextField = adapterPolicy.cache.contextField;
  if (cache.context && !adapterPolicy.cache.contextField) cacheWarnings.push("Context cache is detected but has no provider-specific Pi field.");
  compat.supportsKvCache = cache.kv && cache.control.kv && Boolean(adapterPolicy.cache.kvField) && !kvAdvisory;
  compat.cacheKvField = adapterPolicy.cache.kvField;
  if (cache.kv && !adapterPolicy.cache.kvField) cacheWarnings.push("KV cache is detected but has no provider-specific Pi field.");
  if (adapterPolicy.cache.unsupported) {
    for (const warning of adapterPolicy.cache.unsupported) {
      if (/\bkv\b|key.?value/i.test(warning) && !cache.kv) continue;
      if (/\bcontext\b/i.test(warning) && !cache.context) continue;
      if (/\bprompt\b/i.test(warning) && !cache.prompt) continue;
      if (cache.prompt || cache.context || cache.kv) cacheWarnings.push(warning);
    }
  }
  if (cacheWarnings.length > 0) compat.cacheWarnings = [...new Set(cacheWarnings)];

  if (reasoning.supported || reasoning.fallback) {
    compat.reasoningControlType = reasoning.controlType;
    compat.canDisable = reasoning.canDisable;
    compat.maxOutputTokens = reasoning.maxOutputTokens;
    compat.mappingConfidence = reasoning.mappingConfidence;
    if (reasoning.fallbackReason) compat.fallbackReason = reasoning.fallbackReason;
    if (reasoning.maxBudgetTokens !== undefined) compat.maxBudgetTokens = reasoning.maxBudgetTokens;
    compat.reasoningPolicy = {
      controlType: reasoning.controlType,
      ...(reasoning.minBudgetTokens !== undefined ? { minBudgetTokens: reasoning.minBudgetTokens } : {}),
      ...(reasoning.budgetMinTokens !== undefined ? { budgetMinTokens: reasoning.budgetMinTokens } : {}),
      ...(reasoning.maxBudgetTokens !== undefined ? { maxBudgetTokens: reasoning.maxBudgetTokens } : {}),
      ...(reasoning.budgetTokens !== undefined ? { budgetTokens: reasoning.budgetTokens } : {}),
      ...(reasoning.maxOutputTokens !== undefined ? { maxOutputTokens: reasoning.maxOutputTokens } : {}),
      mappingConfidence: reasoning.mappingConfidence,
      ...(reasoning.fallbackReason ? { fallbackReason: reasoning.fallbackReason } : {}),
      fallback: reasoning.fallback === true || adapter.id === "fallback",
    };
    const reasoningWarnings: string[] = [];
    if (reasoning.supported && reasoning.controlType === "effort") {
      compat.supportsReasoningEffort = adapter.id !== "fallback" && Boolean(adapterPolicy.reasoning.effortField);
      compat.reasoningEffortField = adapterPolicy.reasoning.effortField;
      compat.thinkingFormat = adapter.thinkingFormat ?? "openai";
      if (api === "google-generative-ai") {
        compat.thinkingConfig = { includeThoughts: true, thinkingLevel: reasoning.defaultLevel };
      }
      if (!adapterPolicy.reasoning.effortField) reasoningWarnings.push("Effort reasoning is detected but has no provider-specific field.");
    } else if (reasoning.supported && reasoning.controlType === "adaptive") {
      compat.reasoningAdaptiveField = adapterPolicy.reasoning.adaptiveField;
      compat.thinkingFormat = adapter.thinkingFormat ?? "adaptive";
      if (api === "anthropic-messages" && adapterPolicy.reasoning.adaptiveField) {
        compat.forceAdaptiveThinking = true;
        compat.thinkingConfig = { type: "adaptive" };
      } else {
        reasoningWarnings.push("Adaptive reasoning is detected but this Pi/provider adapter has no verified runtime field; policy is advisory only.");
      }
    } else if (reasoning.supported && reasoning.controlType === "budget") {
      compat.supportsReasoningBudget = adapter.id !== "fallback" && Boolean(adapterPolicy.reasoning.budgetField);
      compat.reasoningBudgetField = adapterPolicy.reasoning.budgetField;
      compat.minBudgetTokens = reasoning.minBudgetTokens ?? reasoning.budgetMinTokens;
      compat.reasoningBudgetMinTokens = reasoning.minBudgetTokens ?? reasoning.budgetMinTokens;
      compat.reasoningBudgetTokens = reasoning.budgetTokens;
      compat.thinkingFormat = adapter.thinkingFormat ?? "budget";
      if (api === "google-generative-ai") {
        compat.thinkingConfig = { includeThoughts: true, thinkingBudget: reasoning.budgetTokens };
      } else if (api === "anthropic-messages") {
        compat.thinkingConfig = { type: "enabled", budget_tokens: reasoning.budgetTokens };
      } else if (adapter.id === "openrouter") {
        compat.thinkingConfig = {
          reasoning: {
            effort: reasoning.defaultLevel ?? "medium",
            max_tokens: reasoning.budgetTokens,
          },
        };
      } else if (adapter.id === "openai-compatible" || adapter.id === "openai-responses") {
        compat.thinkingConfig = {
          reasoning_effort: reasoning.defaultLevel ?? "medium",
          reasoning_budget_tokens: reasoning.budgetTokens,
        };
      } else {
        const budgetField = adapterPolicy.reasoning.budgetField ?? "reasoning_budget_tokens";
        compat.thinkingConfig = budgetField.includes(".")
          ? { field: budgetField, value: reasoning.budgetTokens }
          : { [budgetField]: reasoning.budgetTokens };
      }
      if (!adapterPolicy.reasoning.budgetField) reasoningWarnings.push("Budget reasoning is detected but has no provider-specific budget field; fallback metadata is advisory only.");
    } else if (reasoning.supported && reasoning.controlType === "toggle") {
      compat.reasoningToggleField = adapterPolicy.reasoning.toggleField;
      compat.reasoningToggleOnValue = reasoning.toggleOnValue;
      compat.reasoningToggleOffValue = reasoning.toggleOffValue;
      if (api === "google-generative-ai") compat.thinkingConfig = { includeThoughts: true };
      if (api === "anthropic-messages") compat.thinkingConfig = { type: "enabled" };
      if (!adapterPolicy.reasoning.toggleField) reasoningWarnings.push("Toggle reasoning is detected but has no provider-specific field.");
    } else if (reasoning.fallback) {
      compat.reasoningFallback = true;
      reasoningWarnings.push(reasoning.fallbackReason ?? `Reasoning option type is unknown; use ${adapterPolicy.reasoning.fallbackField} fallback policy.`);
    }
    if (adapter.id === "fallback") {
      compat.reasoningFallback = true;
      reasoningWarnings.push("Provider adapter is unknown; normalized reasoning fields are compatibility metadata and require provider-specific runtime validation.");
    }
    if (reasoning.controlType === "unknown") {
      compat.reasoningFallback = true;
      reasoningWarnings.push(`Reasoning option type is unknown; use ${adapterPolicy.reasoning.fallbackField} fallback policy.`);
    }
    if (reasoningWarnings.length > 0) compat.reasoningWarnings = [...new Set(reasoningWarnings)];
  }
  if (api === "google-generative-ai" && reasoning.supported) compat.supportsTemperature = source.temperature === true;
  return Object.keys(compat).length === 0 ? undefined : compat;
}

export function toThinkingLevelMap(reasoning: NormalizedReasoning): Partial<Record<ReasoningLevel, string | null>> | undefined {
  if (!reasoning.supported) return undefined;
  if (reasoning.controlType === "toggle") {
    // A toggle has one provider value. Standard levels map to it, while
    // xhigh/max stay omitted because Pi only enables those when explicitly
    // opted into by the metadata.
    const onValue = reasoning.toggleOnValue ?? "on";
    const offValue = reasoning.toggleOffValue;
    return reasoning.canDisable === false
      ? { off: null, minimal: onValue, low: onValue, medium: onValue, high: onValue }
      : { ...(offValue ? { off: offValue } : {}), minimal: onValue, low: onValue, medium: onValue, high: onValue };
  }
  if (reasoning.controlType === "budget") {
    const min = reasoning.minBudgetTokens ?? reasoning.budgetMinTokens ?? 1024;
    const max = Math.max(min, reasoning.budgetTokens ?? reasoning.maxBudgetTokens ?? min);
    const declared = new Set(reasoning.levels.map((level) => level.toLowerCase()));
    return {
      minimal: String(min),
      low: String(Math.round(min + (max - min) * 0.25)),
      medium: String(Math.round(min + (max - min) * 0.5)),
      high: String(Math.round(min + (max - min) * 0.75)),
      ...(declared.has("xhigh") ? { xhigh: String(max) } : {}),
      ...(declared.has("max") ? { max: String(max) } : {}),
    };
  }
  if (reasoning.controlType !== "effort" && reasoning.controlType !== "adaptive") return undefined;
  const declared = new Map(reasoning.levels.map((level) => [level.toLowerCase(), level]));
  const hasExplicitLevels = reasoning.levels.length > 0;
  const map: Partial<Record<ReasoningLevel, string | null>> = {};
  if (reasoning.canDisable === false) map.off = null;
  for (const level of REASONING_LEVELS.slice(1)) {
    const selected = declared.get(level);
    if (selected !== undefined) {
      map[level] = selected;
    } else if (!hasExplicitLevels) {
      map[level] = level;
    } else if (level !== "xhigh" && level !== "max") {
      map[level] = null;
    }
  }
  return map;
}

function cacheResolutionLevel(detected: boolean, hasControlField: boolean, advisory: boolean): CapabilityResolutionLevel {
  if (!detected) return "unsupported";
  if (advisory) return hasControlField ? "partial" : "advisory";
  return hasControlField ? "resolved" : "advisory";
}

function isUnsupportedCacheSignal(policy: AdapterPolicy, signal: "prompt" | "context" | "kv"): boolean {
  return policy.cache.unsupported?.some((warning) => signal === "kv"
    ? /\bkv\b|key.?value/i.test(warning)
    : signal === "context"
      ? /\bcontext\b/i.test(warning)
      : /\bprompt\b/i.test(warning)) ?? false;
}

function hasPositiveSignal(left: unknown, right: unknown, keyPattern: RegExp, valuePattern: RegExp): boolean {
  return hasTruthyKeySignal(left, keyPattern)
    || hasTruthyKeySignal(right, keyPattern)
    || [left, right].some((value) => collectStringValues(value).some((item) => valuePattern.test(item)));
}

function hasTruthyKeySignal(value: unknown, keyPattern: RegExp): boolean {
  if (Array.isArray(value)) return value.some((child) => hasTruthyKeySignal(child, keyPattern));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => {
    if (keyPattern.test(key)) return child !== false && child !== null && child !== 0;
    return hasTruthyKeySignal(child, keyPattern);
  });
}

function firstBooleanMetadata(value: unknown, keys: string[]): boolean | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "boolean") return candidate;
  }
  return undefined;
}

function firstStringMetadata(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
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

function integerBudgetOrDefault(value: number | undefined, fallback: number): number | undefined {
  const selected = value === undefined ? fallback : value;
  if (!Number.isFinite(selected) || !Number.isInteger(selected) || selected <= 0) return undefined;
  return selected;
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
