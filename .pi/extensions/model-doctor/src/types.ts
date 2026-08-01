export type JsonObject = Record<string, unknown>;

export type PiApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type ReasoningControlType = "toggle" | "effort" | "budget" | "unknown";
export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface DoctorMetadata {
  managed: true;
  source: string;
  lastCheck: string;
  autoRepair: boolean;
  providerId?: string;
  modelId?: string;
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

export interface PiCompat extends JsonObject {
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: string;
  cacheControlFormat?: "anthropic";
  supportsLongCacheRetention?: boolean;
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
  status?: string;
  deprecated?: boolean;
  last_updated?: string;
  interleaved?: JsonObject;
  [key: string]: unknown;
}

export interface ModelsDevCatalog {
  providers: Record<string, ModelsDevProvider>;
  fetchedAt?: string;
  etag?: string;
  lastModified?: string;
}

export interface ProviderMatch {
  provider: ModelsDevProvider;
  model?: ModelsDevModel;
  score: number;
  matchedBy: string[];
}

export interface NormalizedReasoning {
  supported: boolean;
  controlType: ReasoningControlType;
  levels: string[];
  defaultLevel?: string;
  maxTokens?: number;
}

export interface NormalizedCache {
  prompt: boolean;
  context: boolean;
  kv: boolean;
  readPricing: boolean;
  writePricing: boolean;
  strategy: "provider" | "model" | "unknown";
}

export interface CapabilityResolution {
  cache: NormalizedCache;
  reasoning: NormalizedReasoning;
  adapter: string;
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
  | "cache-mismatch"
  | "reasoning-mismatch"
  | "headers-preserved"
  | "metadata-stale"
  | "metadata-missing"
  | "metadata-version"
  | "network-unavailable"
  | "invalid-config";

export interface Finding {
  severity: FindingSeverity;
  code: FindingCode;
  target: string;
  message: string;
  repairable: boolean;
  userOwned?: boolean;
}

export interface CheckResult {
  target?: string;
  findings: Finding[];
  plan?: ChangePlan;
  checkedAt: string;
}

export interface CommandResult {
  ok: boolean;
  code: string;
  message: string;
  data?: unknown;
}

export interface AddInput {
  target: string;
  modelId?: string;
  apiKey?: string;
  dryRun?: boolean;
}

export interface FixOptions {
  persistCache?: boolean;
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
export const DEFAULT_MODELS_DEV_ENDPOINT = "https://models.dev/api.json";
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 16_384;
export const DEFAULT_COST: PiCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
