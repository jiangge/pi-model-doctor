import { CacheStore } from "./cache.ts";
import { errorMessage, isRecord } from "./json.ts";
import { inferProviderEndpoint } from "./capabilities.ts";
import {
  DEFAULT_MODELS_DEV_ENDPOINT,
  type ModelsDevCatalog,
  type ModelsDevFetcherOptions,
  type ModelsDevModel,
  type ModelsDevProvider,
  type ProviderMatch,
} from "./types.ts";

export class ModelsDevError extends Error {
  constructor(
    message: string,
    public readonly code: "network-unavailable" | "invalid-catalog" = "network-unavailable",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ModelsDevError";
  }
}

export interface CatalogLoadResult {
  catalog: ModelsDevCatalog;
  source: "network" | "cache";
  stale: boolean;
  warning?: string;
}

export class ModelsDevClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly cache: CacheStore,
    options: ModelsDevFetcherOptions = {},
  ) {
    this.endpoint = options.endpoint ?? process.env.PI_MODEL_DOCTOR_MODELS_DEV_URL ?? DEFAULT_MODELS_DEV_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  async load(options: { force?: boolean; persist?: boolean; refresh?: boolean } = {}): Promise<CatalogLoadResult> {
    const cached = await this.cache.readModels<ModelsDevCatalog>();
    if (cached && !options.force && !options.refresh && isCatalog(cached.data) && isCacheFresh(cached.fetchedAt, this.now(), this.cacheTtlMs)) {
      return { catalog: cached.data, source: "cache", stale: false };
    }

    try {
      const response = await this.fetchCatalog(options.force ? undefined : cached);
      if (response.status === 304 && cached && isCatalog(cached.data)) {
        if (options.persist !== false) await this.cache.writeModels(cached.data, { etag: cached.etag, lastModified: cached.lastModified });
        return { catalog: cached.data, source: "cache", stale: false };
      }
      if (!response.ok) throw new ModelsDevError(`models.dev returned HTTP ${response.status}`, "network-unavailable");
      const raw: unknown = await response.json();
      const catalog = normalizeCatalog(raw, this.now());
      if (options.persist !== false) await this.persistCatalog(catalog, response);
      return { catalog, source: "network", stale: false };
    } catch (error) {
      if (cached && isCatalog(cached.data)) {
        return {
          catalog: cached.data,
          source: "cache",
          stale: true,
          warning: `models.dev unavailable; using cached catalog (${errorMessage(error)})`,
        };
      }
      if (error instanceof ModelsDevError) throw error;
      throw new ModelsDevError(`Unable to load models.dev: ${errorMessage(error)}`, "network-unavailable", error);
    }
  }

  async refresh(force = false): Promise<CatalogLoadResult> {
    return this.load({ force, persist: true, refresh: true });
  }

  private async persistCatalog(catalog: ModelsDevCatalog, response: Response): Promise<void> {
    const headers = {
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
    await this.cache.writeModels(catalog, headers);
    await this.cache.writeProviders(
      Object.fromEntries(Object.entries(catalog.providers).map(([id, provider]) => [id, {
        id: provider.id,
        name: provider.name,
        env: provider.env,
        api: provider.api,
        doc: provider.doc,
      }])),
      headers,
    );
  }

  static match(catalog: ModelsDevCatalog, target: string, modelId?: string): ProviderMatch[] {
    const normalizedTarget = normalize(target);
    const matches: ProviderMatch[] = [];
    for (const provider of Object.values(catalog.providers)) {
      const providerEndpoint = inferProviderEndpoint(provider);
      const providerValues = [provider.id, provider.name, provider.api, providerEndpoint, ...(provider.env ?? [])].filter((value): value is string => typeof value === "string").map(normalize);
      const providerMatch = providerValues.some((value) => value === normalizedTarget)
        ? 100
        : providerValues.some((value) => value.includes(normalizedTarget) || normalizedTarget.includes(value))
          ? 60
          : 0;
      if (!providerMatch && !looksLikeUrl(target)) continue;
      const urlMatch = typeof providerEndpoint === "string" && looksLikeUrl(target) && normalizeUrl(providerEndpoint) === normalizeUrl(target);
      const score = urlMatch ? 110 : providerMatch;
      if (!score) continue;
      const matchedBy = urlMatch ? ["api-url"] : ["provider-id-or-name"];
      const selected = selectModel(provider, modelId);
      matches.push({ provider, model: selected.model, score: score + selected.score, matchedBy: [...matchedBy, ...selected.matchedBy] });
    }
    if (matches.length === 0 && (modelId || !looksLikeUrl(target))) {
      const modelTarget = normalize(modelId ?? target);
      for (const provider of Object.values(catalog.providers)) {
        for (const model of Object.values(provider.models)) {
          const modelValues = [model.id, model.name].filter((value): value is string => typeof value === "string").map(normalize);
          if (modelValues.some((value) => value === modelTarget || value.includes(modelTarget) || modelTarget.includes(value))) {
            matches.push({ provider, model, score: 30, matchedBy: ["model-id-or-name"] });
          }
        }
      }
    }
    return matches.sort((left, right) => right.score - left.score);
  }

  static find(catalog: ModelsDevCatalog, providerId: string, modelId?: string): ProviderMatch | undefined {
    const provider = catalog.providers[providerId] ?? Object.values(catalog.providers).find((item) => normalize(item.id) === normalize(providerId));
    if (!provider) return undefined;
    if (!modelId) return { provider, score: 100, matchedBy: ["provider-id"] };
    const selected = selectModel(provider, modelId);
    return selected.model ? { provider, model: selected.model, score: 100 + selected.score, matchedBy: ["provider-id", ...selected.matchedBy] } : { provider, score: 100, matchedBy: ["provider-id"] };
  }

  static findForConfig(catalog: ModelsDevCatalog, providerId: string, endpoint?: string, modelId?: string): ProviderMatch | undefined {
    const direct = this.find(catalog, providerId, modelId);
    if (direct) return direct;
    if (!endpoint) return undefined;
    return this.match(catalog, endpoint, modelId)[0];
  }

  private async fetchCatalog(cached: { etag?: string; lastModified?: string } | undefined): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.endpoint, {
        headers: {
          accept: "application/json",
          ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
          ...(cached?.lastModified ? { "if-modified-since": cached.lastModified } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      throw new ModelsDevError(`models.dev request failed: ${errorMessage(error)}`, "network-unavailable", error);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function normalizeCatalog(raw: unknown, now = new Date()): ModelsDevCatalog {
  const source = isRecord(raw) && isRecord(raw.providers) ? raw.providers : raw;
  if (!isRecord(source)) throw new ModelsDevError("models.dev response must be an object", "invalid-catalog");
  const providers: Record<string, ModelsDevProvider> = {};
  for (const [providerId, value] of Object.entries(source)) {
    if (!isRecord(value)) continue;
    const rawModels = value.models;
    const models: Record<string, ModelsDevModel> = {};
    if (isRecord(rawModels)) {
      for (const [modelId, rawModel] of Object.entries(rawModels)) {
        if (!isRecord(rawModel)) continue;
        models[modelId] = normalizeModel(modelId, rawModel);
      }
    } else if (Array.isArray(rawModels)) {
      for (const rawModel of rawModels) {
        if (!isRecord(rawModel) || typeof rawModel.id !== "string") continue;
        models[rawModel.id] = normalizeModel(rawModel.id, rawModel);
      }
    }
    providers[providerId] = {
      ...value,
      id: typeof value.id === "string" ? value.id : providerId,
      name: typeof value.name === "string" ? value.name : providerId,
      env: Array.isArray(value.env) ? value.env.filter((item): item is string => typeof item === "string") : undefined,
      api: typeof value.api === "string" ? value.api : undefined,
      models,
    };
  }
  return { providers, fetchedAt: now.toISOString() };
}

function normalizeModel(id: string, rawModel: JsonRecord): ModelsDevModel {
  const model: ModelsDevModel = { ...rawModel, id };
  if (isRecord(rawModel.limit)) {
    model.limit = {
      context: numberOrUndefined(rawModel.limit.context),
      output: numberOrUndefined(rawModel.limit.output),
    };
  }
  if (isRecord(rawModel.cost)) {
    model.cost = {
      input: numberOrUndefined(rawModel.cost.input),
      output: numberOrUndefined(rawModel.cost.output),
      cache_read: numberOrUndefined(rawModel.cost.cache_read),
      cache_write: numberOrUndefined(rawModel.cost.cache_write),
      tiers: Array.isArray(rawModel.cost.tiers)
        ? rawModel.cost.tiers.filter(isRecord).map((tier) => ({
          inputTokensAbove: numberOrUndefined(tier.inputTokensAbove) ?? (isRecord(tier.tier) && tier.tier.type === "context" ? numberOrUndefined(tier.tier.size) : undefined),
          input: numberOrUndefined(tier.input),
          output: numberOrUndefined(tier.output),
          cache_read: numberOrUndefined(tier.cache_read),
          cache_write: numberOrUndefined(tier.cache_write),
          tier: isRecord(tier.tier) ? {
            type: typeof tier.tier.type === "string" ? tier.tier.type : undefined,
            size: numberOrUndefined(tier.tier.size),
          } : undefined,
        }))
        : undefined,
    };
  }
  return model;
}

type JsonRecord = Record<string, unknown>;

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function selectModel(provider: ModelsDevProvider, modelId?: string): { model?: ModelsDevModel; score: number; matchedBy: string[] } {
  if (!modelId) {
    const first = Object.values(provider.models)[0];
    return first ? { model: first, score: 1, matchedBy: ["default-model"] } : { score: 0, matchedBy: [] };
  }
  const target = normalize(modelId);
  let best: { model?: ModelsDevModel; score: number; matchedBy: string[] } = { score: 0, matchedBy: [] };
  for (const model of Object.values(provider.models)) {
    const values = [model.id, model.name].filter((value): value is string => typeof value === "string").map(normalize);
    const exact = values.some((value) => value === target);
    const partial = values.some((value) => value.includes(target) || target.includes(value));
    const score = exact ? 50 : partial ? 20 : 0;
    if (score > best.score) best = { model, score, matchedBy: [exact ? "model-exact" : "model-partial"] };
  }
  return best;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function normalizeUrl(value: string): string {
  return value.trim().toLowerCase().replace(/\/$/, "");
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isCatalog(value: unknown): value is ModelsDevCatalog {
  return isRecord(value) && isRecord(value.providers);
}

function isCacheFresh(fetchedAt: string, now: Date, ttlMs: number): boolean {
  const timestamp = Date.parse(fetchedAt);
  return Number.isFinite(timestamp) && now.getTime() - timestamp <= ttlMs;
}
