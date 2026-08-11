export type JsonObject = Record<string, unknown>;

export type PiApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ReasoningControlType = "toggle" | "effort" | "budget" | "adaptive" | "unknown";
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DoctorMetadata {
  managed: true;
  source: string;
  lastCheck: string;
  autoRepair: boolean;
  providerId?: string;
  modelId?: string;
  /** True while a provider-only endpoint is waiting for model/API resolution. */
  endpointNormalizationPending?: boolean;
  /** True when the endpoint API was explicitly supplied rather than inferred. */
  endpointApiExplicit?: boolean;
  /** API family inferred or selected when the provider-only endpoint was created. */
  endpointApiHint?: PiApi;
  /** Exact endpoint value inferred when the provider-only entry was created. */
  endpointValueHint?: string;
  /** True when the user changed the pending endpoint before model resolution. */
  endpointNormalizationBlocked?: boolean;
  /** True when the user changed the pending API before model resolution. */
  endpointApiNormalizationBlocked?: boolean;
  version?: number;
  managedFields?: string[];
  managedValues?: JsonObject;
}

export interface PiCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: Array<PiCostTier>;
}

export interface PiCostTier {
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type CapabilityResolutionLevel = "resolved" | "partial" | "advisory" | "unsupported";

export interface PiCompat extends JsonObject {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsReasoningBudget?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: string;
  thinkingConfig?: JsonObject;
  reasoningControlType?: ReasoningControlType;
  reasoningToggleField?: string;
  reasoningToggleOnValue?: string;
  reasoningToggleOffValue?: string;
  reasoningEffortField?: string;
  reasoningBudgetField?: string;
  reasoningAdaptiveField?: string;
  reasoningBudgetMinTokens?: number;
  minBudgetTokens?: number;
  reasoningBudgetTokens?: number;
  reasoningFallback?: boolean;
  cacheControlFormat?: "anthropic" | string;
  supportsLongCacheRetention?: boolean;
  supportsExplicitPromptCacheMode?: boolean;
  sendSessionAffinityHeaders?: boolean;
  sessionAffinityFormat?: string;
  supportsPromptCaching?: boolean;
  supportsContextCaching?: boolean;
  supportsKvCache?: boolean;
  cachePromptField?: string;
  cacheContextField?: string;
  cacheKvField?: string;
  cacheCapabilities?: {
    prompt: boolean;
    context: boolean;
    kv: boolean;
    readPricing: boolean;
    writePricing: boolean;
  };
  cacheResolution?: {
    prompt: CapabilityResolutionLevel;
    context: CapabilityResolutionLevel;
    kv: CapabilityResolutionLevel;
    control: { prompt: boolean; context: boolean; kv: boolean };
    pricing: { read: boolean; write: boolean };
    usageReporting: { readTokens: boolean; writeTokens: boolean };
    retention: { supported: boolean; values: string[] };
    sessionAffinity: { supported: boolean; format?: string };
    confidence: "high" | "medium" | "low";
    source: "pi" | "provider" | "models.dev" | "fallback";
  };
  cacheWarnings?: string[];
  reasoningWarnings?: string[];
  reasoningPolicy?: {
    controlType: ReasoningControlType;
    minBudgetTokens?: number;
    budgetMinTokens?: number;
    maxBudgetTokens?: number;
    budgetTokens?: number;
    maxOutputTokens?: number;
    mappingConfidence?: "high" | "medium" | "low";
    fallbackReason?: string;
    fallback: boolean;
  };
  capabilityAdapter?: string;
  capabilityPolicyVersion?: number;
  /** True when metadata came from an official catalog model but transport is a third-party channel. */
  metadataOnly?: boolean;
  /** True when an explicitly supplied custom channel owns transport fields. */
  transportOwned?: boolean;
  metadataProviderId?: string;
  supportsEagerToolInputStreaming?: boolean;
  supportsCacheControlOnTools?: boolean;
  supportsTemperature?: boolean;
  forceAdaptiveThinking?: boolean;
  [key: string]: unknown;
}

export interface PiModel extends JsonObject {
  id: string;
  name?: string;
  api?: PiApi | string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ReasoningLevel, string | null>>;
  input?: Array<"text" | "image">;
  cost?: PiCost;
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: PiCompat;
  _piModelDoctor?: DoctorMetadata;
}

export interface PiProvider extends JsonObject {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: PiApi | string;
  oauth?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: PiCompat;
  models?: PiModel[];
  modelOverrides?: Record<string, PiModelOverride>;
  _piModelDoctor?: DoctorMetadata;
}

export interface PiModelsJson {
  providers?: Record<string, PiProvider>;
  [key: string]: unknown;
}

export type PiModelOverride = Omit<PiModel, "id" | "_piModelDoctor"> & { _piModelDoctor?: DoctorMetadata };

export interface ModelsDevProvider {
  id: string;
  name?: string;
  env?: string[];
  npm?: string;
  api?: string;
  doc?: string;
  required_headers?: string[];
  retention?: JsonObject;
  session_affinity?: JsonObject | string;
  usage?: JsonObject;
  models: Record<string, ModelsDevModel>;
  [key: string]: unknown;
}

export interface ModelsDevModel {
  id: string;
  name?: string;
  description?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: Array<{ type?: string; values?: string[]; min?: number; max?: number }>;
  tool_call?: boolean;
  temperature?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tiers?: Array<{
      inputTokensAbove?: number;
      input?: number;
      output?: number;
      cache_read?: number;
      cache_write?: number;
      tier?: { type?: string; size?: number };
    }>;
    [key: string]: unknown;
  };
  required_headers?: string[];
  status?: string;
  deprecated?: boolean;
  last_updated?: string;
  interleaved?: JsonObject;
  retention?: JsonObject;
  session_affinity?: JsonObject | string;
  usage?: JsonObject;
  [key: string]: unknown;
}

export interface ModelsDevCatalog {
  /** Internal normalized catalog schema version; raw models.dev has no stable wrapper schema. */
  schemaVersion?: 1;
  providers: Record<string, ModelsDevProvider>;
  fetchedAt?: string;
  etag?: string;
  lastModified?: string;
}

export interface ProviderCacheSummary {
  id: string;
  name?: string;
  env?: string[];
  api?: string;
  doc?: string;
  required_headers?: string[];
  adapter: string;
  capabilities: JsonObject;
}

export interface ProviderCacheData {
  schemaVersion: 1;
  providers: Record<string, ProviderCacheSummary>;
}

export interface ProviderMatch {
  provider: ModelsDevProvider;
  model?: ModelsDevModel;
  score: number;
  matchedBy: string[];
  ambiguous?: boolean;
  /** The provider is metadata-only; the configured channel owns transport fields. */
  metadataOnly?: boolean;
}

export interface ModelCandidate {
  providerId: string;
  providerName?: string;
  id: string;
  name?: string;
  deprecated: boolean;
  matchedBy: string[];
  source?: "network" | "cache" | "fallback" | "models.dev";
  adapter?: string;
  confidence?: "high" | "medium" | "low";
  reasoningControlType?: ReasoningControlType;
  reasoningMappingConfidence?: NormalizedReasoning["mappingConfidence"];
  reasoningFallback?: boolean;
  cacheCapabilities?: NormalizedCache["capability"];
  cacheResolution?: NonNullable<PiCompat["cacheResolution"]>;
  metadataOnly?: boolean;
}

export interface NormalizedReasoning {
  supported: boolean;
  controlType: ReasoningControlType;
  levels: string[];
  defaultLevel?: string;
  canDisable?: boolean;
  toggleOnValue?: string;
  toggleOffValue?: string;
  /** Backward-compatible alias for maxOutputTokens. */
  maxTokens?: number;
  maxOutputTokens?: number;
  /** Canonical minimum reasoning budget; budgetMinTokens is retained for compatibility. */
  minBudgetTokens?: number;
  budgetMinTokens?: number;
  maxBudgetTokens?: number;
  budgetTokens?: number;
  mappingConfidence: "high" | "medium" | "low";
  fallback?: boolean;
  fallbackReason?: string;
}

export interface NormalizedCache {
  /** Backward-compatible flat capability fields. */
  prompt: boolean;
  context: boolean;
  kv: boolean;
  readPricing: boolean;
  writePricing: boolean;
  capability: { prompt: boolean; context: boolean; kv: boolean };
  control: { prompt: boolean; context: boolean; kv: boolean };
  pricing: { read: boolean; write: boolean };
  usageReporting: { readTokens: boolean; writeTokens: boolean };
  retention: { supported: boolean; values: string[] };
  sessionAffinity: { supported: boolean; format?: string };
  confidence: "high" | "medium" | "low";
  source: "pi" | "provider" | "models.dev" | "fallback";
  strategy: "provider" | "model" | "unknown";
}

export interface AdapterPolicy {
  id: string;
  reasoning: {
    toggleField?: string;
    effortField?: string;
    budgetField?: string;
    adaptiveField?: string;
    fallbackField: string;
  };
  cache: {
    promptField?: string;
    contextField?: string;
    kvField?: string;
    retentionField?: string;
    explicitPromptField?: string;
    sessionAffinityField?: string;
    sessionAffinityFormat?: string;
    unsupported?: string[];
  };
}

export interface CapabilityMappingPolicy {
  reasoning: {
    budgetSeparateFromOutputTokens: true;
    unknown: "fallback";
  };
  cache: {
    independentSignals: ["prompt", "context", "kv"];
    pricingDoesNotEnableRuntime: true;
    unsupportedRuntime: "advisory";
  };
}

export interface CompatibilityBaseline {
  piVersion: string;
  modelsDevSchema: string;
  modelsDevSchemaVersion: 1;
  modelsDevObservedAt: string;
  policyCatalogSchemaVersion: 1;
  modelDoctorMetadataVersion: 1;
}

export interface PolicyCatalog {
  schemaVersion: 1;
  generatedAt: string;
  baseline: CompatibilityBaseline;
  adapters: Record<string, AdapterPolicy>;
  fallback: AdapterPolicy;
  capabilityMapping: CapabilityMappingPolicy;
}

export interface CapabilityResolution {
  cache: NormalizedCache;
  reasoning: NormalizedReasoning;
  adapter: string;
  adapterPolicy?: AdapterPolicy;
  compat?: PiCompat;
  policyVersion: number;
}

export interface Change {
  path: string;
  before: unknown;
  after: unknown;
  reason: string;
  ownership: "managed" | "user" | "unknown";
}

export interface ChangePlan {
  target: string;
  changes: Change[];
  conflicts: Finding[];
  warnings: string[];
}

export type FindingSeverity = "error" | "warning" | "info";
export type FindingCode =
  | "missing-provider"
  | "missing-model"
  | "endpoint-mismatch"
  | "api-mismatch"
  | "model-id-mismatch"
  | "deprecated-model"
  | "context-window-mismatch"
  | "max-tokens-mismatch"
  | "input-mismatch"
  | "cost-mismatch"
  | "cache-mismatch"
  | "reasoning-mismatch"
  | "headers-preserved"
  | "provider-headers-present"
  | "model-headers-present"
  | "header-missing"
  | "header-mismatch"
  | "capability-fallback"
  | "metadata-stale"
  | "metadata-missing"
  | "metadata-version"
  | "policy-stale"
  | "network-unavailable"
  | "invalid-config"
  | "model-selection-required"
  | "selection-required"
  | "authorization-required"
  | "migration-conflict"
  | "third-party-channel";

export interface Finding {
  severity: FindingSeverity;
  code: FindingCode;
  target: string;
  message: string;
  repairable: boolean;
  userOwned?: boolean;
  source?: string;
  confidence?: "high" | "medium" | "low";
}

export interface CheckResult {
  target?: string;
  findings: Finding[];
  plan?: ChangePlan;
  checkedAt: string;
}

export interface RefreshResult {
  source: "network" | "cache";
  stale: boolean;
  warning?: string;
  providers: number;
  models: number;
  findings: Finding[];
  changes: number;
  conflicts: number;
  checkedAt: string;
  policyVersion: number;
}

export interface CommandResult {
  ok: boolean;
  code: string;
  message: string;
  data?: unknown;
}

export type RuntimeActivationStatus = "persisted-and-active" | "persisted-reload-required" | "activation-failed" | "not-persisted";

export interface AddInput {
  target: string;
  /** Explicit storage id for channel setup, as in `add providerA https://gateway.example/v1 [model]`. */
  providerId?: string;
  /** When omitted and target is a URL, a provider-only entry with no model is created. */
  modelId?: string;
  /** Optional models.dev provider id used only to disambiguate metadata. */
  metadataProvider?: string;
  /** Transport protocol for a third-party channel; inferred when omitted. */
  api?: PiApi;
  /** An env/auth-store/command reference such as $OPENAI_API_KEY or !pi-auth. */
  apiKey?: string;
  /** Explicit opt-in for persisting a literal API key; never enabled by default. */
  allowLiteralApiKey?: boolean;
  dryRun?: boolean;
  persistCache?: boolean;
}

export interface SyncInput {
  target: string;
  modelIds: string[];
  /** Optional models.dev provider id used to scope third-party channel metadata. */
  metadataProvider?: string;
  /** Transport protocol for a third-party channel; inferred when omitted. */
  api?: PiApi;
  /** An env/auth-store/command reference such as $OPENAI_API_KEY or !pi-auth. */
  apiKey?: string;
  /** Explicit opt-in for persisting a literal API key; never enabled by default. */
  allowLiteralApiKey?: boolean;
  dryRun?: boolean;
  persistCache?: boolean;
}

export interface FixOptions {
  persistCache?: boolean;
  dryRun?: boolean;
}

export interface MigrateInput {
  source: string;
  destination: string;
  dryRun?: boolean;
  persistCache?: boolean;
  removeSource?: boolean;
}

export interface BackupRetentionOptions {
  /** Keep this many newest backups regardless of age. */
  keep?: number;
  /** Delete backups older than this age; this cleanup is never automatic. */
  maxAgeMs?: number;
  now?: Date;
}

export interface DoctorPaths {
  modelsPath: string;
  doctorDir: string;
  modelsCachePath: string;
  providersCachePath: string;
  policiesCachePath: string;
}

export interface StoredCache<T> {
  version: 1;
  fetchedAt: string;
  etag?: string;
  lastModified?: string;
  data: T;
}

export interface ModelsDevFetcherOptions {
  endpoint?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cacheTtlMs?: number;
  maxResponseBytes?: number;
  /** Explicitly trust a non-default models.dev endpoint. */
  trustedEndpoint?: boolean;
  now?: () => Date;
}

export interface DoctorOptions {
  paths: DoctorPaths;
  fetcher?: ModelsDevFetcherOptions;
  now?: () => Date;
  source?: string;
}

export const MODEL_DOCTOR_METADATA_KEY = "_piModelDoctor";
export const MODEL_DOCTOR_VERSION = 1;
export const PI_RUNTIME_VERSION_BASELINE = "0.82.1";
export const MODELS_DEV_SCHEMA_BASELINE = "api.json";
export const MODELS_DEV_SCHEMA_VERSION_BASELINE = 1 as const;
export const MODELS_DEV_OBSERVED_AT_BASELINE = "2026-08-01T00:00:00.000Z";
export const DEFAULT_MODELS_DEV_ENDPOINT = "https://models.dev/api.json";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_COST: PiCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
