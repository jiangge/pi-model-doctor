import { isIP } from "node:net";
import { CacheStore } from "./cache.ts";
import { errorMessage, isRecord, isSafeHeaderName, redactSensitiveText } from "./json.ts";
import { capabilityCompat, defaultPolicyCatalog, detectPiApi, inferProviderEndpoint, resolveCache, resolveProviderAdapter, resolveReasoning } from "./capabilities.ts";
import {
  DEFAULT_MODELS_DEV_ENDPOINT,
  type ModelCandidate,
  type ModelsDevCatalog,
  type ModelsDevFetcherOptions,
  type ModelsDevModel,
  type ProviderCacheData,
  type ModelsDevProvider,
  type PolicyCatalog,
  type ProviderMatch,
} from "./types.ts";

export class ModelsDevError extends Error {
  constructor(
    message: string,
    public readonly code: "network-unavailable" | "invalid-catalog" = "network-unavailable",
    public readonly cause?: unknown,
  ) {
    super(redactSensitiveText(message));
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
  private readonly maxResponseBytes: number;
  private readonly trustedEndpoint: boolean;
  private readonly now: () => Date;
  private memory?: CatalogLoadResult;
  private memoryPersisted = false;

  constructor(
    private readonly cache: CacheStore,
    options: ModelsDevFetcherOptions = {},
  ) {
    this.trustedEndpoint = options.trustedEndpoint === true || process.env.PI_MODEL_DOCTOR_TRUSTED_ENDPOINT === "1";
    const configuredEndpoint = options.endpoint ?? process.env.PI_MODEL_DOCTOR_MODELS_DEV_URL ?? DEFAULT_MODELS_DEV_ENDPOINT;
    this.endpoint = validateCatalogEndpoint(configuredEndpoint, this.trustedEndpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60 * 1000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.now = options.now ?? (() => new Date());
  }

  async load(options: { force?: boolean; persist?: boolean; refresh?: boolean } = {}): Promise<CatalogLoadResult> {
    if (this.memory && (options.persist === false || this.memoryPersisted) && !options.force && !options.refresh && this.memory.catalog.fetchedAt !== undefined && isCacheFresh(this.memory.catalog.fetchedAt, this.now(), this.cacheTtlMs)) {
      return this.memory;
    }
    const cached = await this.cache.readModels<ModelsDevCatalog>();
    const validCached = cached && isCatalog(cached.data) ? cached : undefined;
    if (validCached && !options.force && !options.refresh && isCacheFresh(validCached.fetchedAt, this.now(), this.cacheTtlMs)) {
      return this.remember({ catalog: validCached.data, source: "cache", stale: false }, true);
    }

    try {
      const response = await this.fetchCatalog(validCached);
      if (response.status === 304 && validCached) {
        const refreshedCatalog: ModelsDevCatalog = {
          ...validCached.data,
          schemaVersion: 1,
          fetchedAt: this.now().toISOString(),
        };
        if (options.persist !== false) await this.persistCatalog(refreshedCatalog, response, validCached);
        return this.remember({ catalog: refreshedCatalog, source: "cache", stale: false }, options.persist !== false);
      }
      if (!response.ok) throw new ModelsDevError(`models.dev returned HTTP ${response.status}`, "network-unavailable");
      let raw: unknown;
      let bodyText: string;
      try {
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
          throw new ModelsDevError(`models.dev response exceeded the ${this.maxResponseBytes}-byte safety limit`, "invalid-catalog");
        }
        bodyText = await readResponseText(response, this.maxResponseBytes, this.timeoutMs);
      } catch (error) {
        if (error instanceof ModelsDevError) throw error;
        throw new ModelsDevError(`models.dev response body could not be read: ${errorMessage(error)}`, "network-unavailable", error);
      }
      try {
        raw = JSON.parse(bodyText) as unknown;
      } catch (error) {
        throw new ModelsDevError(`models.dev response was not valid JSON: ${errorMessage(error)}`, "invalid-catalog", error);
      }
      const catalog = normalizeCatalog(raw, this.now());
      if (options.persist !== false) await this.persistCatalog(catalog, response);
      return this.remember({ catalog, source: "network", stale: false }, options.persist !== false);
    } catch (error) {
      if (error instanceof ModelsDevError && error.code === "invalid-catalog") throw error;
      if (!(error instanceof ModelsDevError) || error.code !== "network-unavailable") throw error;
      if (validCached) {
        return this.remember({
          catalog: validCached.data,
          source: "cache",
          stale: true,
          warning: `models.dev unavailable; using cached catalog (${errorMessage(error)})`,
        }, true);
      }
      if (error instanceof ModelsDevError) throw error;
      throw new ModelsDevError(`Unable to load models.dev: ${errorMessage(error)}`, "network-unavailable", error);
    }
  }

  async refresh(force = false, persist = true): Promise<CatalogLoadResult> {
    return this.load({ force, persist, refresh: true });
  }

  private remember(result: CatalogLoadResult, persisted: boolean): CatalogLoadResult {
    this.memory = result;
    this.memoryPersisted = persisted;
    return result;
  }

  private async persistCatalog(
    catalog: ModelsDevCatalog,
    response: Response,
    previous?: { etag?: string; lastModified?: string },
  ): Promise<void> {
    const headers = {
      etag: response.headers.get("etag") ?? previous?.etag,
      lastModified: response.headers.get("last-modified") ?? previous?.lastModified,
    };
    await this.cache.writeModels(catalog, headers);
    const providerSummaries: ProviderCacheData["providers"] = Object.fromEntries(Object.entries(catalog.providers).map(([id, provider]) => {
        const adapter = resolveProviderAdapter(provider);
        const capabilities = Object.values(provider.models).reduce((result, model) => {
          const cache = resolveCache(provider, model);
          const reasoning = resolveReasoning(provider, model);
          result.prompt ||= cache.prompt;
          result.context ||= cache.context;
          result.kv ||= cache.kv;
          result.reasoning ||= reasoning.supported;
          result.reasoningControls.add(reasoning.controlType);
          result.cacheSources.add(cache.source);
          result.cacheConfidences.add(cache.confidence);
          result.cacheSignals.push({
            modelId: model.id,
            capability: cache.capability,
            control: cache.control,
            pricing: cache.pricing,
            usageReporting: cache.usageReporting,
            retention: cache.retention,
            sessionAffinity: cache.sessionAffinity,
            confidence: cache.confidence,
            source: cache.source,
          });
          return result;
        }, { prompt: false, context: false, kv: false, reasoning: false, reasoningControls: new Set<string>(), cacheSources: new Set<string>(), cacheConfidences: new Set<string>(), cacheSignals: [] as Array<Record<string, unknown>> });
        return [id, {
          id: provider.id,
          name: provider.name,
          env: provider.env,
          api: provider.api,
          doc: provider.doc,
          required_headers: provider.required_headers,
          adapter: adapter.id,
          capabilities: {
            prompt: capabilities.prompt,
            context: capabilities.context,
            kv: capabilities.kv,
            reasoning: capabilities.reasoning,
            reasoningControls: [...capabilities.reasoningControls],
            cacheSources: [...capabilities.cacheSources],
            cacheConfidences: [...capabilities.cacheConfidences],
            cacheSignals: capabilities.cacheSignals,
          },
        }];
      }));
    await this.cache.writeProviderCache({ schemaVersion: 1, providers: providerSummaries }, headers);
  }

  static match(catalog: ModelsDevCatalog, target: string, modelId?: string, options: { allowPartialModel?: boolean; allowPartialProvider?: boolean } = {}): ProviderMatch[] {
    const normalizedTarget = normalize(target);
    const allowPartialModel = options.allowPartialModel !== false;
    const allowPartialProvider = options.allowPartialProvider !== false;
    const matches: ProviderMatch[] = [];
    for (const provider of Object.values(catalog.providers)) {
      const providerEndpoint = inferProviderEndpoint(provider);
      const providerValues = [provider.id, provider.name, provider.api, providerEndpoint, ...(provider.env ?? [])]
        .filter((value): value is string => typeof value === "string")
        .map(normalize);
      const providerMatch = providerValues.some((value) => value === normalizedTarget)
        ? 100
        : allowPartialProvider && providerValues.some((value) => value.includes(normalizedTarget) || normalizedTarget.includes(value))
          ? 60
          : 0;
      if (!providerMatch && !looksLikeUrl(target)) continue;
      const urlMatch = typeof providerEndpoint === "string" && looksLikeUrl(target) && catalogEndpointMatches(provider, providerEndpoint, target);
      const score = urlMatch ? 110 : providerMatch;
      if (!score) continue;
      const matchedBy = urlMatch ? ["api-url"] : [providerMatch === 100 ? "provider-id-or-name" : "provider-partial"];
      const selected = selectModel(provider, modelId, allowPartialModel);
      matches.push({ provider, model: selected.model, score: score + selected.score, matchedBy: [...matchedBy, ...selected.matchedBy], ambiguous: selected.ambiguous });
    }
    if (matches.length === 0 && modelId === undefined && !looksLikeUrl(target)) {
      const modelTarget = normalize(target);
      for (const provider of Object.values(catalog.providers)) {
        for (const model of Object.values(provider.models)) {
          const modelValues = [model.id, model.name]
            .filter((value): value is string => typeof value === "string")
            .map(normalize);
          if (modelValues.some((value) => value === modelTarget || value.includes(modelTarget) || modelTarget.includes(value))) {
            matches.push({ provider, model, score: 30, matchedBy: ["model-id-or-name"] });
          }
        }
      }
    }
    return matches.sort((left, right) => right.score - left.score);
  }

  static listCandidates(catalog: ModelsDevCatalog, target: string, policy: PolicyCatalog = defaultPolicyCatalog(), modelId?: string, metadataProvider?: string): ModelCandidate[] {
    const matches = this.match(catalog, target, modelId);
    const globalMatches = matches.length === 0 && looksLikeUrl(target)
      ? modelId
        ? globalModelMatches(catalog, modelId, metadataProvider)
        : allCatalogMatches(catalog, metadataProvider)
      : [];
    const selectedMatches = matches.length > 0 ? matches : globalMatches;
    const result: ModelCandidate[] = [];
    const seen = new Set<string>();
    for (const match of selectedMatches) {
      const models = match.model ? [match.model] : Object.values(match.provider.models);
      for (const model of models) {
          const key = `${match.provider.id}/${model.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const reasoning = resolveReasoning(match.provider, model);
        const cache = resolveCache(match.provider, model);
        result.push({
          providerId: match.provider.id,
          providerName: match.provider.name,
          id: model.id,
          name: model.name,
          deprecated: model.deprecated === true || model.status === "deprecated",
          matchedBy: match.matchedBy,
          source: "models.dev",
          adapter: resolveProviderAdapter(match.provider).id,
          confidence: matchConfidence(match),
          reasoningControlType: reasoning.controlType,
          reasoningMappingConfidence: reasoning.mappingConfidence,
          reasoningFallback: reasoning.fallback === true,
          cacheCapabilities: cache.capability,
          cacheResolution: resolveCandidateCacheResolution(match.provider, model, cache, policy),
          metadataOnly: match.metadataOnly,
        });
      }
    }
    return result;
  }

  static find(catalog: ModelsDevCatalog, providerId: string, modelId?: string): ProviderMatch | undefined {
    const normalizedProviderId = normalize(providerId);
    const matchingProviders = Object.entries(catalog.providers)
      .filter(([key, item]) => [key, item.id, item.name]
        .filter((value): value is string => typeof value === "string")
        .some((value) => normalize(value) === normalizedProviderId))
      .map(([, provider]) => provider);
    if (matchingProviders.length > 1) {
      return { provider: matchingProviders[0], score: 0, matchedBy: ["provider-id-or-name", "provider-ambiguous"], ambiguous: true };
    }
    const provider = matchingProviders[0];
    if (!provider) return undefined;
    if (!modelId) return { provider, score: 100, matchedBy: ["provider-id-or-name"] };
    const selected = selectModel(provider, modelId, false);
    return selected.model
      ? { provider, model: selected.model, score: 100 + selected.score, matchedBy: ["provider-id", ...selected.matchedBy], ambiguous: selected.ambiguous }
      : { provider, score: 100, matchedBy: ["provider-id", ...selected.matchedBy], ambiguous: selected.ambiguous };
  }

  static findGlobalModel(catalog: ModelsDevCatalog, modelId: string, metadataProvider?: string): ProviderMatch | undefined {
    const matches = globalModelMatches(catalog, modelId, metadataProvider);
    if (matches.length === 0) return undefined;
    const bestScore = matches[0]?.score ?? 0;
    const bestMatches = matches.filter((match) => match.score === bestScore);
    if (bestMatches.length > 1) {
      return {
        provider: bestMatches[0].provider,
        score: bestScore,
        matchedBy: [...new Set(bestMatches.flatMap((match) => match.matchedBy)), "model-ambiguous", "metadata-only"],
        ambiguous: true,
        metadataOnly: true,
      };
    }
    return { ...bestMatches[0], metadataOnly: true, matchedBy: [...bestMatches[0].matchedBy, "metadata-only"] };
  }

  static findForConfig(catalog: ModelsDevCatalog, providerId: string, endpoint?: string, modelId?: string): ProviderMatch | undefined {
    const direct = this.find(catalog, providerId, modelId);
    // An explicitly configured provider is authoritative. Do not silently
    // resolve a missing/ambiguous model from another provider just because an
    // endpoint or model id happens to look similar.
    if (direct || !endpoint) return direct;
    const endpointMatches = this.match(catalog, endpoint, modelId, { allowPartialModel: false, allowPartialProvider: false }).filter((match) => {
      const providerEndpoint = inferProviderEndpoint(match.provider);
      return providerEndpoint && catalogEndpointMatches(match.provider, providerEndpoint, endpoint);
    });
    if (endpointMatches.length === 0) return direct;
    const bestScore = endpointMatches[0]?.score ?? 0;
    const bestMatches = endpointMatches.filter((match) => match.score === bestScore);
    if (bestMatches.length > 1) {
      return {
        provider: bestMatches[0].provider,
        score: bestScore,
        matchedBy: [...new Set(bestMatches.flatMap((match) => match.matchedBy)), "model-ambiguous"],
        ambiguous: true,
      };
    }
    return endpointMatches[0] ?? direct;
  }

  private async fetchCatalog(cached: { etag?: string; lastModified?: string } | undefined): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = this.fetchImpl(this.endpoint, {
        headers: {
          accept: "application/json",
          ...(cached?.etag ? { "if-none-match": cached.etag } : {}),
          ...(cached?.lastModified ? { "if-modified-since": cached.lastModified } : {}),
        },
        redirect: "error",
        signal: controller.signal,
      });
      const timeout = new Promise<Response>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ModelsDevError(`models.dev request timed out after ${this.timeoutMs}ms`, "network-unavailable"));
        }, this.timeoutMs);
      });
      return await Promise.race([request, timeout]);
    } catch (error) {
      if (error instanceof ModelsDevError) throw error;
      throw new ModelsDevError(`models.dev request failed: ${errorMessage(error)}`, "network-unavailable", error);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

async function readResponseText(response: Response, maxBytes: number, timeoutMs: number): Promise<string> {
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readBody = async (): Promise<string> => {
    activeReader = response.body?.getReader();
    if (!activeReader) {
      const body = await response.arrayBuffer();
      if (body.byteLength > maxBytes) throw new ModelsDevError(`models.dev response exceeded the ${maxBytes}-byte safety limit`, "invalid-catalog");
      return new TextDecoder().decode(body);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await activeReader.read();
        if (next.done) break;
        if (!next.value) continue;
        total += next.value.byteLength;
        if (total > maxBytes) {
          try { await activeReader.cancel(); } catch { /* best effort */ }
          throw new ModelsDevError(`models.dev response exceeded the ${maxBytes}-byte safety limit`, "invalid-catalog");
        }
        chunks.push(next.value);
      }
    } finally {
      activeReader.releaseLock();
      activeReader = undefined;
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(body);
  };
  try {
    return await Promise.race([
      readBody(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          void activeReader?.cancel();
          reject(new ModelsDevError(`models.dev response body timed out after ${timeoutMs}ms`, "network-unavailable"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function normalizeCatalog(raw: unknown, now = new Date()): ModelsDevCatalog {
  const source = isRecord(raw) && isRecord(raw.providers) ? raw.providers : raw;
  if (!isRecord(source)) throw new ModelsDevError("models.dev response must be an object", "invalid-catalog");
  const providerEntries = Object.entries(source);
  if (providerEntries.length === 0) throw new ModelsDevError("models.dev response contains no providers", "invalid-catalog");
  const providers: Record<string, ModelsDevProvider> = {};
  const seenProviderIds = new Set<string>();
  for (const [providerId, value] of providerEntries) {
    if (!isRecord(value)) throw new ModelsDevError(`models.dev provider ${providerId} must be an object`, "invalid-catalog");
    if (!providerId.trim()) throw new ModelsDevError("models.dev provider id must not be empty", "invalid-catalog");
    if (isUnsafeCatalogKey(providerId)) throw new ModelsDevError(`models.dev provider ${providerId} uses an unsafe catalog key`, "invalid-catalog");
    const safeProvider = stripSensitiveCatalogFields(value);
    if (safeProvider.id !== undefined && typeof safeProvider.id !== "string") throw new ModelsDevError(`models.dev provider ${providerId} has invalid id`, "invalid-catalog");
    if (typeof safeProvider.id === "string" && normalizeKey(safeProvider.id) !== normalizeKey(providerId)) throw new ModelsDevError(`models.dev provider ${providerId} id does not match its catalog key`, "invalid-catalog");
    if (seenProviderIds.has(normalizeKey(providerId))) throw new ModelsDevError(`models.dev contains duplicate provider ${providerId}`, "invalid-catalog");
    seenProviderIds.add(normalizeKey(providerId));
    if (safeProvider.name !== undefined && typeof safeProvider.name !== "string") throw new ModelsDevError(`models.dev provider ${providerId} has invalid name`, "invalid-catalog");
    if (safeProvider.api !== undefined && typeof safeProvider.api !== "string") throw new ModelsDevError(`models.dev provider ${providerId} has invalid api`, "invalid-catalog");
    if (typeof safeProvider.api === "string" && looksLikeUrl(safeProvider.api)) validateCatalogApiUrl(safeProvider.api, providerId);
    if (safeProvider.env !== undefined && (!Array.isArray(safeProvider.env) || !safeProvider.env.every((item) => isEnvironmentVariableName(item)))) throw new ModelsDevError(`models.dev provider ${providerId} has invalid env metadata`, "invalid-catalog");
    if (safeProvider.required_headers !== undefined && (!Array.isArray(safeProvider.required_headers) || !safeProvider.required_headers.every((item) => isSafeHeaderName(item)))) throw new ModelsDevError(`models.dev provider ${providerId} has invalid required headers`, "invalid-catalog");
    if (!isOptionalMetadataObject(safeProvider.retention) || !isOptionalMetadataObject(safeProvider.usage) || !isOptionalSessionAffinity(safeProvider.session_affinity)) throw new ModelsDevError(`models.dev provider ${providerId} has invalid cache metadata`, "invalid-catalog");
    const rawModels = safeProvider.models;
    if (!isRecord(rawModels) && !Array.isArray(rawModels)) {
      throw new ModelsDevError(`models.dev provider ${providerId} has invalid models data`, "invalid-catalog");
    }
    const models: Record<string, ModelsDevModel> = {};
    const seenModelIds = new Set<string>();
    if (isRecord(rawModels)) {
      for (const [modelId, rawModel] of Object.entries(rawModels)) {
          if (!isRecord(rawModel)) throw new ModelsDevError(`models.dev provider ${providerId} contains an invalid model ${modelId}`, "invalid-catalog");
        if (isUnsafeCatalogKey(modelId)) throw new ModelsDevError(`models.dev provider ${providerId} contains an unsafe model key`, "invalid-catalog");
        const normalizedId = normalizeKey(modelId);
        if (seenModelIds.has(normalizedId)) throw new ModelsDevError(`models.dev provider ${providerId} contains duplicate model ${modelId}`, "invalid-catalog");
        seenModelIds.add(normalizedId);
        models[modelId] = normalizeModel(modelId, rawModel, providerId);
      }
    } else if (Array.isArray(rawModels)) {
      for (const rawModel of rawModels) {
        if (!isRecord(rawModel) || typeof rawModel.id !== "string" || rawModel.id.trim() === "") {
          throw new ModelsDevError(`models.dev provider ${providerId} contains an invalid model`, "invalid-catalog");
        }
        if (isUnsafeCatalogKey(rawModel.id)) throw new ModelsDevError(`models.dev provider ${providerId} contains an unsafe model key`, "invalid-catalog");
        const normalizedId = normalizeKey(rawModel.id);
        if (seenModelIds.has(normalizedId)) throw new ModelsDevError(`models.dev provider ${providerId} contains duplicate model ${rawModel.id}`, "invalid-catalog");
        seenModelIds.add(normalizedId);
        models[rawModel.id] = normalizeModel(rawModel.id, rawModel, providerId);
      }
    }
    providers[providerId] = {
      ...safeProvider,
      id: typeof safeProvider.id === "string" ? safeProvider.id : providerId,
      name: typeof safeProvider.name === "string" ? safeProvider.name : providerId,
      env: stringArray(safeProvider.env),
      api: typeof safeProvider.api === "string" ? safeProvider.api : undefined,
      required_headers: stringArray(safeProvider.required_headers),
      models,
    };
  }
  return { schemaVersion: 1, providers, fetchedAt: now.toISOString() };
}

function normalizeModel(id: string, rawModel: JsonRecord, providerId: string): ModelsDevModel {
  if (id.trim() === "") throw new ModelsDevError(`models.dev provider ${providerId} contains an empty model id`, "invalid-catalog");
  const safeModel = stripSensitiveCatalogFields(rawModel);
  if (safeModel.name !== undefined && typeof safeModel.name !== "string") throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid name`, "invalid-catalog");
  if (safeModel.id !== undefined && (typeof safeModel.id !== "string" || safeModel.id.trim() === "")) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid id`, "invalid-catalog");
  if (typeof safeModel.id === "string" && safeModel.id !== id) throw new ModelsDevError(`models.dev model ${providerId}/${id} id does not match its catalog key`, "invalid-catalog");
  if (safeModel.reasoning !== undefined && typeof safeModel.reasoning !== "boolean") throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid reasoning metadata`, "invalid-catalog");
  if (safeModel.deprecated !== undefined && typeof safeModel.deprecated !== "boolean") throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid deprecated metadata`, "invalid-catalog");
  if (safeModel.status !== undefined && typeof safeModel.status !== "string") throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid status`, "invalid-catalog");
  if (safeModel.temperature !== undefined && typeof safeModel.temperature !== "boolean") throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid temperature metadata`, "invalid-catalog");
  if (safeModel.limit !== undefined) {
    if (!isRecord(safeModel.limit)) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid limits`, "invalid-catalog");
    for (const key of ["context", "output"] as const) {
      const limit = safeModel.limit[key];
      if (limit !== undefined && !isPositiveInteger(limit)) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid ${key} limit`, "invalid-catalog");
    }
  }
  if (safeModel.cost !== undefined) {
    if (!isRecord(safeModel.cost)) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid cost metadata`, "invalid-catalog");
    for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
      const price = safeModel.cost[key];
      if (price !== undefined && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid ${key} cost`, "invalid-catalog");
    }
    if (safeModel.cost.tiers !== undefined && (!Array.isArray(safeModel.cost.tiers) || !safeModel.cost.tiers.every(isValidCostTier))) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid cost tiers`, "invalid-catalog");
  }
  if (safeModel.modalities !== undefined) {
    if (!isRecord(safeModel.modalities)) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid modalities`, "invalid-catalog");
    for (const key of ["input", "output"] as const) {
      const modalities = safeModel.modalities[key];
      if (modalities !== undefined && (!Array.isArray(modalities) || !modalities.every((item) => typeof item === "string"))) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid ${key} modalities`, "invalid-catalog");
    }
  }
  if (safeModel.reasoning_options !== undefined && (!Array.isArray(safeModel.reasoning_options) || !safeModel.reasoning_options.every(isValidReasoningOption))) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid reasoning options`, "invalid-catalog");
  if (safeModel.required_headers !== undefined && (!Array.isArray(safeModel.required_headers) || !safeModel.required_headers.every((item) => isSafeHeaderName(item)))) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid required headers`, "invalid-catalog");
  if (!isOptionalMetadataObject(safeModel.retention) || !isOptionalMetadataObject(safeModel.usage) || !isOptionalMetadataObject(safeModel.interleaved) || !isOptionalSessionAffinity(safeModel.session_affinity)) throw new ModelsDevError(`models.dev model ${providerId}/${id} has invalid cache metadata`, "invalid-catalog");
  const model: ModelsDevModel = {
    ...safeModel,
    id,
    ...(typeof safeModel.name === "string" ? { name: safeModel.name } : {}),
  };
  if (isRecord(safeModel.limit)) {
    model.limit = {
      context: numberOrUndefined(safeModel.limit.context),
      output: numberOrUndefined(safeModel.limit.output),
    };
  }
  if (isRecord(safeModel.cost)) {
    model.cost = {
      input: numberOrUndefined(safeModel.cost.input),
      output: numberOrUndefined(safeModel.cost.output),
      cache_read: numberOrUndefined(safeModel.cost.cache_read),
      cache_write: numberOrUndefined(safeModel.cost.cache_write),
      tiers: Array.isArray(safeModel.cost.tiers)
        ? safeModel.cost.tiers.filter(isRecord).map((tier) => ({
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
  model.required_headers = stringArray(safeModel.required_headers);
  model.reasoning_options = normalizeReasoningOptions(safeModel.reasoning_options);
  model.modalities = normalizeModalities(safeModel.modalities);
  return model;
}

type JsonRecord = Record<string, unknown>;

function stripSensitiveCatalogFields(value: JsonRecord): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveCatalogKey(key) || isUnsafeCatalogKey(key)) continue;
    if (Array.isArray(child)) {
      result[key] = child.map((item) => isRecord(item)
        ? stripSensitiveCatalogFields(item)
        : typeof item === "string" ? redactSensitiveText(item) : item);
    } else if (isRecord(child)) {
      // Model ids are object keys, not credential fields. Preserve those keys
      // while still sanitizing each model object underneath `models`.
      result[key] = key === "models"
        ? Object.fromEntries(Object.entries(child).map(([modelId, model]) => [
          modelId,
          isRecord(model) ? stripSensitiveCatalogFields(model) : model,
        ]))
        : stripSensitiveCatalogFields(child);
    } else {
      result[key] = typeof child === "string" ? redactSensitiveText(child) : child;
    }
  }
  return result;
}

function isValidReasoningOption(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  if (value.type !== undefined && (typeof value.type !== "string" || value.type.trim() === "")) return false;
  if (value.values !== undefined && (!Array.isArray(value.values) || !value.values.every((item) => typeof item === "string" && item.trim() !== ""))) return false;
  if (value.min !== undefined && (typeof value.min !== "number" || !Number.isFinite(value.min) || !Number.isInteger(value.min) || value.min <= 0)) return false;
  if (value.max !== undefined && (typeof value.max !== "number" || !Number.isFinite(value.max) || !Number.isInteger(value.max) || value.max <= 0)) return false;
  if (typeof value.min === "number" && typeof value.max === "number" && value.min > value.max) return false;
  return true;
}

function isOptionalMetadataObject(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isOptionalSessionAffinity(value: unknown): boolean {
  return value === undefined || typeof value === "string" || isRecord(value);
}

function isValidCostTier(value: unknown): value is JsonRecord {
  if (!isRecord(value)) return false;
  for (const key of ["inputTokensAbove", "input", "output", "cache_read", "cache_write"] as const) {
    const candidate = value[key];
    if (candidate !== undefined && (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)) return false;
  }
  if (value.tier !== undefined) {
    if (!isRecord(value.tier)) return false;
    if (value.tier.type !== undefined && typeof value.tier.type !== "string") return false;
    if (value.tier.size !== undefined && (typeof value.tier.size !== "number" || !Number.isFinite(value.tier.size) || value.tier.size < 0)) return false;
  }
  return typeof value.inputTokensAbove === "number"
    || isRecord(value.tier) && typeof value.tier.size === "number";
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function isEnvironmentVariableName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]*$/.test(value);
}

function normalizeReasoningOptions(value: unknown): ModelsDevModel["reasoning_options"] {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((option) => ({
    ...(typeof option.type === "string" ? { type: option.type } : {}),
    ...(Array.isArray(option.values) ? { values: option.values.filter((item): item is string => typeof item === "string") } : {}),
    ...(numberOrUndefined(option.min) !== undefined ? { min: numberOrUndefined(option.min) } : {}),
    ...(numberOrUndefined(option.max) !== undefined ? { max: numberOrUndefined(option.max) } : {}),
  }));
}

function normalizeModalities(value: unknown): ModelsDevModel["modalities"] {
  if (!isRecord(value)) return undefined;
  return {
    input: stringArray(value.input),
    output: stringArray(value.output),
  };
}

function resolveCandidateCacheResolution(
  provider: ModelsDevProvider,
  model: ModelsDevModel,
  cache: ReturnType<typeof resolveCache>,
  policy: PolicyCatalog,
): NonNullable<import("./types.ts").PiCompat["cacheResolution"]> | undefined {
  return capabilityCompat(detectPiApi(provider), cache, resolveReasoning(provider, model), model, provider.id, policy)?.cacheResolution;
}

export function matchConfidence(match: ProviderMatch): "high" | "medium" | "low" {
  if (match.ambiguous) return "low";
  if (match.matchedBy.some((value) => ["api-url", "provider-id", "provider-id-or-name", "model-exact", "configured-model-id", "configured-model-name"].includes(value))) return "high";
  if (match.matchedBy.some((value) => value.includes("partial") || value.includes("name"))) return "medium";
  return "low";
}

function selectModel(provider: ModelsDevProvider, modelId?: string, allowPartial = true): { model?: ModelsDevModel; score: number; matchedBy: string[]; ambiguous?: boolean } {
  if (!modelId) return { score: 0, matchedBy: [] };
  const target = normalize(modelId);
  const models = Object.values(provider.models);
  const exactMatches = models.filter((model) => [model.id, model.name].filter((value): value is string => typeof value === "string").some((value) => normalize(value) === target));
  if (exactMatches.length === 1) return { model: exactMatches[0], score: 50, matchedBy: ["model-exact"] };
  if (exactMatches.length > 1) return { score: 0, matchedBy: ["model-ambiguous"], ambiguous: true };
  if (!allowPartial) return { score: 0, matchedBy: [] };
  const partialMatches = models.filter((model) => [model.id, model.name].filter((value): value is string => typeof value === "string").some((value) => value && (normalize(value).includes(target) || target.includes(normalize(value)))));
  if (partialMatches.length === 1) return { model: partialMatches[0], score: 20, matchedBy: ["model-partial"] };
  return partialMatches.length > 1 ? { score: 0, matchedBy: ["model-ambiguous"], ambiguous: true } : { score: 0, matchedBy: [] };
}

function validateCatalogEndpoint(value: string, trustedEndpoint = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ModelsDevError(`models.dev endpoint is not a valid URL: ${errorMessage(error)}`, "invalid-catalog", error);
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))) {
    throw new ModelsDevError("models.dev endpoint must use HTTPS; HTTP is allowed only for loopback test endpoints", "invalid-catalog");
  }
  if (parsed.username || parsed.password) {
    throw new ModelsDevError("models.dev endpoint must not contain URL credentials", "invalid-catalog");
  }
  validateNoCredentialQuery(parsed, "models.dev endpoint");
  const loopbackTestEndpoint = parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
  if (!parsed.hostname || (isPrivateHost(parsed.hostname) && !loopbackTestEndpoint && !trustedEndpoint)) {
    throw new ModelsDevError("models.dev endpoint must not target a local or private host", "invalid-catalog");
  }
  return parsed.toString();
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || isExpandedIpv6Loopback(host)) return true;
  const mapped = ipv4MappedHost(host);
  if (mapped) return isLoopbackHost(mapped);
  return isIP(host) === 4 && host === "127.0.0.1";
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return true;
  const mapped = ipv4MappedHost(host);
  if (mapped) return isPrivateHost(mapped);
  if (isIP(host) === 6) {
    const firstHex = Number.parseInt(host.slice(0, 4), 16);
    return host === "::"
      || host.startsWith("fc")
      || host.startsWith("fd")
      || host.startsWith("ff")
      || (firstHex >= 0xfe80 && firstHex <= 0xfebf);
  }
  const octets = host.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 169 && octets[1] === 254);
}

function isExpandedIpv6Loopback(host: string): boolean {
  if (isIP(host) !== 6 || !host.includes(":")) return false;
  const halves = host.split("::");
  if (halves.length > 2) return false;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return false;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return false;
  return groups.slice(0, 7).every((group) => Number.parseInt(group, 16) === 0) && Number.parseInt(groups[7], 16) === 1;
}

function ipv4MappedHost(host: string): string | undefined {
  if (!host.startsWith("::ffff:")) return undefined;
  const tail = host.slice("::ffff:".length);
  if (tail.includes(".")) return tail;
  const groups = tail.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  const high = Number.parseInt(groups[0], 16);
  const low = Number.parseInt(groups[1], 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function validateCatalogApiUrl(value: string, providerId: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new ModelsDevError(`models.dev provider ${providerId} has invalid API URL: ${errorMessage(error)}`, "invalid-catalog", error);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isPrivateHost(parsed.hostname)) {
    throw new ModelsDevError(`models.dev provider ${providerId} has an unsafe API URL`, "invalid-catalog");
  }
  validateNoCredentialQuery(parsed, `models.dev provider ${providerId} API URL`);
}

function validateNoCredentialQuery(parsed: URL, label: string): void {
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveCatalogKey(key)) throw new ModelsDevError(`${label} must not contain credential query parameters`, "invalid-catalog");
  }
}

function globalModelMatches(catalog: ModelsDevCatalog, modelId: string, metadataProvider?: string): ProviderMatch[] {
  const target = normalize(modelId);
  if (!target) return [];
  const providerTarget = metadataProvider ? normalize(metadataProvider) : undefined;
  const providers = Object.values(catalog.providers).filter((provider) => !providerTarget || [provider.id, provider.name]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalize(value) === providerTarget));
  const matches: ProviderMatch[] = [];
  for (const provider of providers) {
    for (const model of Object.values(provider.models)) {
      const normalizedId = normalize(model.id);
      const normalizedName = typeof model.name === "string" ? normalize(model.name) : undefined;
      if (normalizedId === target) {
        matches.push({ provider, model, score: 100, matchedBy: ["global-model-id"], metadataOnly: true });
      } else if (normalizedName === target) {
        matches.push({ provider, model, score: 90, matchedBy: ["global-model-name"], metadataOnly: true });
      }
    }
  }
  return sortProviderMatches(matches);
}

function allCatalogMatches(catalog: ModelsDevCatalog, metadataProvider?: string): ProviderMatch[] {
  const providerTarget = metadataProvider ? normalize(metadataProvider) : undefined;
  return sortProviderMatches(Object.values(catalog.providers)
    .filter((provider) => !providerTarget || [provider.id, provider.name]
      .filter((value): value is string => typeof value === "string")
      .some((value) => normalize(value) === providerTarget))
    .flatMap((provider) => Object.values(provider.models).map((model) => ({
      provider,
      model,
      score: 1,
      matchedBy: ["global-candidate"],
      metadataOnly: true,
    }))));
}

function sortProviderMatches(matches: ProviderMatch[]): ProviderMatch[] {
  return matches.sort((left, right) => right.score - left.score
    || left.provider.id.localeCompare(right.provider.id)
    || (left.model?.id ?? "").localeCompare(right.model?.id ?? ""));
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeUrl(value: string): string {
  return value.trim().toLowerCase().replace(/\/$/, "");
}

function catalogEndpointMatches(provider: ModelsDevProvider, providerEndpoint: string, target: string): boolean {
  if (normalizeUrl(providerEndpoint) === normalizeUrl(target)) return true;
  try {
    const expected = new URL(providerEndpoint);
    const actual = new URL(target);
    const expectedPath = expected.pathname.replace(/\/+$/u, "") || "/";
    const actualPath = actual.pathname.replace(/\/+$/u, "") || "/";
    if (expected.protocol !== actual.protocol || expected.hostname !== actual.hostname || expected.port !== actual.port
      || expected.search !== actual.search || expected.hash !== actual.hash) return false;
    const api = detectPiApi(provider, providerEndpoint);
    if (api !== "openai-completions" && api !== "openai-responses") return false;
    const rootToV1 = (expectedPath === "/" && actualPath === "/v1")
      || (expectedPath === "/v1" && actualPath === "/");
    return rootToV1;
  } catch {
    return false;
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isSensitiveCatalogKey(key: string): boolean {
  return /^(?:headers?|authentication|auth|credentials?|api[-_]?key|authorization(?:[-_]?header)?|auth[-_]?header|oauth|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|set-cookie)$/i.test(key)
    || /^(?:x[-_]?api[-_]?key|x[-_]?auth[-_]?token)$/i.test(key);
}

function isUnsafeCatalogKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isCatalog(value: unknown): value is ModelsDevCatalog {
  if (!isRecord(value) || hasSensitiveCatalogKey(value) || value.schemaVersion !== 1 || !isRecord(value.providers) || Object.keys(value.providers).length === 0) return false;
  if (value.fetchedAt !== undefined && (typeof value.fetchedAt !== "string" || !Number.isFinite(Date.parse(value.fetchedAt)))) return false;
  if (value.etag !== undefined && typeof value.etag !== "string") return false;
  if (value.lastModified !== undefined && typeof value.lastModified !== "string") return false;
  const seenProviders = new Set<string>();
  return Object.entries(value.providers).every(([providerKey, provider]) => {
    if (isUnsafeCatalogKey(providerKey) || !isNormalizedProvider(provider) || normalizeKey(providerKey) !== normalizeKey(provider.id)) return false;
    const providerId = normalizeKey(provider.id);
    if (seenProviders.has(providerId)) return false;
    seenProviders.add(providerId);
    return Object.entries(provider.models).every(([modelKey, model]) => !isUnsafeCatalogKey(modelKey) && !isUnsafeCatalogKey(model.id) && normalizeKey(modelKey) === normalizeKey(model.id));
  });
}

function isNormalizedProvider(value: unknown): value is ModelsDevProvider {
  if (!isRecord(value) || hasSensitiveCatalogKey(value) || typeof value.id !== "string" || value.id.trim() === "" || isUnsafeCatalogKey(value.id) || !isRecord(value.models)) return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.api !== undefined && (typeof value.api !== "string" || !isSafeCachedApiUrl(value.api))) return false;
  if (value.env !== undefined && (!Array.isArray(value.env) || !value.env.every((item) => isEnvironmentVariableName(item)))) return false;
  if (value.required_headers !== undefined && (!Array.isArray(value.required_headers) || !value.required_headers.every((item) => isSafeHeaderName(item)))) return false;
  if (!isOptionalMetadataObject(value.retention) || !isOptionalMetadataObject(value.usage) || !isOptionalSessionAffinity(value.session_affinity)) return false;
  return Object.values(value.models).every((model) => isNormalizedModel(model));
}

function isNormalizedModel(value: unknown): value is ModelsDevModel {
  if (!isRecord(value) || hasSensitiveCatalogKey(value) || typeof value.id !== "string" || value.id.trim() === "" || isUnsafeCatalogKey(value.id)) return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.reasoning !== undefined && typeof value.reasoning !== "boolean") return false;
  if (value.deprecated !== undefined && typeof value.deprecated !== "boolean") return false;
  if (value.status !== undefined && typeof value.status !== "string") return false;
  if (value.temperature !== undefined && typeof value.temperature !== "boolean") return false;
  if (value.reasoning_options !== undefined && !Array.isArray(value.reasoning_options)) return false;
  if (Array.isArray(value.reasoning_options) && !value.reasoning_options.every(isValidReasoningOption)) return false;
  if (value.modalities !== undefined && (!isRecord(value.modalities)
    || (value.modalities.input !== undefined && (!Array.isArray(value.modalities.input) || !value.modalities.input.every((item) => typeof item === "string")))
    || (value.modalities.output !== undefined && (!Array.isArray(value.modalities.output) || !value.modalities.output.every((item) => typeof item === "string"))))) return false;
  if (value.limit !== undefined && (!isRecord(value.limit)
    || (value.limit.context !== undefined && !isPositiveInteger(value.limit.context))
    || (value.limit.output !== undefined && !isPositiveInteger(value.limit.output)))) return false;
  if (value.cost !== undefined) {
    if (!isRecord(value.cost)) return false;
    for (const key of ["input", "output", "cache_read", "cache_write"] as const) {
      const price = value.cost[key];
      if (price !== undefined && (typeof price !== "number" || !Number.isFinite(price) || price < 0)) return false;
    }
    if (value.cost.tiers !== undefined && (!Array.isArray(value.cost.tiers) || !value.cost.tiers.every(isValidCostTier))) return false;
  }
  if (value.required_headers !== undefined && (!Array.isArray(value.required_headers) || !value.required_headers.every((item) => isSafeHeaderName(item)))) return false;
  if (!isOptionalMetadataObject(value.retention) || !isOptionalMetadataObject(value.usage) || !isOptionalMetadataObject(value.interleaved) || !isOptionalSessionAffinity(value.session_affinity)) return false;
  return true;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value > 0;
}

function isSafeCachedApiUrl(value: string): boolean {
  if (!looksLikeUrl(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !isPrivateHost(parsed.hostname)
      && [...parsed.searchParams.keys()].every((key) => !isSensitiveCatalogKey(key));
  } catch {
    return false;
  }
}

function hasSensitiveCatalogKey(value: unknown, modelMap = false): boolean {
  if (Array.isArray(value)) return value.some((child) => hasSensitiveCatalogKey(child));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (isUnsafeCatalogKey(key)) return true;
    if (!modelMap && isSensitiveCatalogKey(key)) return true;
    if (modelMap) return hasSensitiveCatalogKey(child);
    return hasSensitiveCatalogKey(child, key === "models");
  });
}

function isCacheFresh(fetchedAt: string, now: Date, ttlMs: number): boolean {
  const timestamp = Date.parse(fetchedAt);
  const age = now.getTime() - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age <= ttlMs;
}
