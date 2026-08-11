import { CacheStore } from "./cache.ts";
import {
  buildMetadata,
  canManageField,
  cleanupBackups,
  cloneJson,
  DoctorError,
  errorMessage,
  getModels,
  getProviders,
  hasDoctorMetadata,
  isRecord,
  jsonEqual,
  looksLikeCredentialValue,
  redactSensitiveText,
  restoreBackup,
  stripDoctorMetadata,
  fileFingerprint,
  readModelsJson,
  writeModelsJson,
} from "./json.ts";
import { ModelsDevClient, ModelsDevError } from "./models-dev.ts";
import {
  adapterIdForPiApi,
  capabilityCompat,
  defaultPolicyCatalog,
  detectChannelApi,
  detectPiApi,
  endpointApiForModel,
  inferProviderEndpoint,
  normalizeEndpointForApi,
  isPolicyCatalog,
  resolveCache,
  resolveProviderAdapter,
  resolveReasoning,
  toPiModel,
} from "./capabilities.ts";
import type {
  AddInput,
  Change,
  ChangePlan,
  CheckResult,
  DoctorOptions,
  Finding,
  FindingCode,
  FixOptions,
  MigrateInput,
  ModelCandidate,
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevProvider,
  DoctorMetadata,
  PiApi,
  PiModel,
  PiModelsJson,
  PiProvider,
  PolicyCatalog,
  ProviderMatch,
  RefreshResult,
  SyncInput,
} from "./types.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COST,
  DEFAULT_MAX_TOKENS,
  MODEL_DOCTOR_VERSION,
} from "./types.ts";

export interface AddProposal {
  target: string;
  matchedBy: string[];
  adapter: string;
  confidence: "high" | "medium" | "low";
  reasoningControlType: string;
  cacheCapabilities: { prompt: boolean; context: boolean; kv: boolean };
  requiredHeaders: string[];
  baseFingerprint?: string;
  baseExisted?: boolean;
  providerId: string;
  /** Model id, or empty string for provider-only adds. */
  modelId: string;
  config: PiModelsJson;
  plan: ChangePlan;
  catalogSource: "network" | "cache" | "fallback";
  metadataOnly?: boolean;
  metadataProviderId?: string;
  warning?: string;
  dryRun?: boolean;
}

export interface SyncProposal {
  target: string;
  providerId: string;
  modelIds: string[];
  config: PiModelsJson;
  baseFingerprint?: string;
  baseExisted?: boolean;
  plan: ChangePlan;
  warnings: string[];
  dryRun?: boolean;
}

export interface FixProposal {
  config: PiModelsJson;
  baseFingerprint?: string;
  baseExisted?: boolean;
  result: CheckResult;
  dryRun?: boolean;
}

export interface RemoveProposal {
  config: PiModelsJson;
  baseFingerprint?: string;
  baseExisted?: boolean;
  plan: ChangePlan;
  dryRun?: boolean;
}

export interface MigrateProposal {
  config: PiModelsJson;
  baseFingerprint?: string;
  baseExisted?: boolean;
  plan: ChangePlan;
  source: string;
  destination: string;
  dryRun?: boolean;
}

export interface DoctorListItem {
  provider: string;
  providerName?: string;
  model: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  managed: boolean;
  lastCheck?: string;
}

export class ModelDoctor {
  readonly cache: CacheStore;
  readonly modelsDev: ModelsDevClient;
  private readonly now: () => Date;
  private readonly source: string;

  constructor(private readonly options: DoctorOptions) {
    this.now = options.now ?? (() => new Date());
    this.source = options.source ?? "models.dev";
    this.cache = new CacheStore(options.paths, this.now);
    this.modelsDev = new ModelsDevClient(this.cache, {
      ...options.fetcher,
      now: options.fetcher?.now ?? this.now,
    });
  }

  async cleanupBackups(options: { keep?: number; maxAgeMs?: number; dryRun?: boolean } = {}): Promise<string[]> {
    return cleanupBackups(this.options.paths.modelsPath, options);
  }

  async rollback(backupPath: string, options: { dryRun?: boolean } = {}): Promise<{ sourcePath: string; safetyBackupPath?: string }> {
    return restoreBackup(this.options.paths.modelsPath, backupPath, this.now(), options.dryRun === true);
  }

  getModelsPath(): string {
    return this.options.paths.modelsPath;
  }

  async list(providerId?: string): Promise<DoctorListItem[]> {
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const providers = getProviders(data);
    const result: DoctorListItem[] = [];
    for (const [id, provider] of Object.entries(providers)) {
      if (providerId && ![id, provider.name, provider.baseUrl]
        .filter((value): value is string => typeof value === "string")
        .some((value) => normalizeIdentifier(value) === normalizeIdentifier(providerId))) continue;
      for (const model of getModels(provider)) {
        result.push({
          provider: id,
          providerName: typeof provider.name === "string" ? provider.name : undefined,
          model: model.id,
          name: typeof model.name === "string" ? model.name : undefined,
          api: typeof model.api === "string" ? model.api : typeof provider.api === "string" ? provider.api : undefined,
          baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : typeof provider.baseUrl === "string" ? provider.baseUrl : undefined,
          reasoning: model.reasoning === true,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          managed: hasDoctorMetadata(model),
          lastCheck: hasDoctorMetadata(model) ? model._piModelDoctor.lastCheck : undefined,
        });
      }
    }
    return result;
  }

  async listCandidates(target: string, persistCache = true, modelId?: string, metadataProvider?: string): Promise<ModelCandidate[]> {
    const loaded = await this.modelsDev.load({ persist: persistCache });
    const policy = await this.getPolicyCatalog(persistCache);
    const direct = ModelsDevClient.listCandidates(loaded.catalog, target, policy, modelId, metadataProvider);
    if (direct.length > 0 || looksLikeUrl(target)) {
      return direct.map((candidate) => ({ ...candidate, source: loaded.source }));
    }
    // An already configured unlisted channel is commonly addressed by its
    // local provider id rather than its URL. Use that channel URL only as a
    // discovery fallback; catalog provider identity still wins when the id
    // itself matched a models.dev provider above.
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const configured = findConfiguredProvider(getProviders(data), target);
    const endpoint = configured?.provider.baseUrl;
    if (!endpoint) return direct.map((candidate) => ({ ...candidate, source: loaded.source }));
    return ModelsDevClient.listCandidates(loaded.catalog, endpoint, policy, modelId, metadataProvider)
      .map((candidate) => ({ ...candidate, metadataOnly: true, source: loaded.source }));
  }

  async listMigrationCandidates(sourceTarget: string, persistCache = true): Promise<ModelCandidate[]> {
    const selected = parseTarget(sourceTarget, true);
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const providerEntry = findConfiguredProviderById(getProviders(data), selected.providerId);
    const provider = providerEntry?.provider;
    const sourceProviderId = providerEntry?.id ?? selected.providerId;
    const sourceModel = provider ? getModels(provider).find((model) => model.id === selected.modelId) : undefined;
    if (!provider) throw new DoctorError(`Migration source provider ${selected.providerId} is not configured`, "invalid-target");
    if (!sourceModel) throw new DoctorError(`Migration source model ${sourceTarget} is not configured`, "invalid-target");
    const loaded = await this.modelsDev.load({ persist: persistCache });
    const policy = await this.getPolicyCatalog(persistCache);
    const matches = ModelsDevClient.listCandidates(loaded.catalog, sourceModel.id, policy).map((candidate) => ({ ...candidate, source: loaded.source }));
    const namedMatches = sourceModel.name ? ModelsDevClient.listCandidates(loaded.catalog, sourceModel.name, policy).map((candidate) => ({ ...candidate, source: loaded.source })) : [];
    const discovered = [...matches, ...namedMatches];
    const candidates = discovered.length > 0
      ? discovered
      : Object.values(loaded.catalog.providers).flatMap((candidateProvider) => Object.values(candidateProvider.models).map((candidateModel) => ({
        providerId: candidateProvider.id,
        providerName: candidateProvider.name,
        id: candidateModel.id,
        name: candidateModel.name,
        deprecated: candidateModel.deprecated === true || candidateModel.status === "deprecated",
        matchedBy: ["migration-candidate"],
      })));
    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const key = `${candidate.providerId}/${candidate.id}`;
      if (seen.has(key) || (normalizeIdentifier(candidate.providerId) === normalizeIdentifier(sourceProviderId) && candidate.id === selected.modelId)) return false;
      seen.add(key);
      return true;
    });
  }

  async refresh(force = false, persist = true): Promise<RefreshResult> {
    const result = await this.modelsDev.refresh(force, persist);
    const policy = await this.getPolicyCatalog(persist);
    const models = Object.values(result.catalog.providers).reduce((count, provider) => count + Object.keys(provider.models).length, 0);
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const networkFinding = result.warning ? finding("network-unavailable", "warning", "models.json", result.warning, false) : undefined;
    const checked = this.checkDataWithCatalog(data, result.catalog, undefined, networkFinding, policy, true);
    return {
      source: result.source,
      stale: result.stale,
      warning: result.warning,
      providers: Object.keys(result.catalog.providers).length,
      models,
      findings: checked.findings,
      changes: checked.plan?.changes.length ?? 0,
      conflicts: checked.plan?.conflicts.length ?? 0,
      checkedAt: checked.checkedAt,
      policyVersion: policy.schemaVersion,
    };
  }

  async proposeAdd(input: AddInput): Promise<AddProposal> {
    const target = input.target.trim();
    if (!target) throw new DoctorError("Add target is required", "invalid-target");
    if (target.includes("://") && !looksLikeUrl(target)) throw new DoctorError("Add provider URL must use http:// or https://", "invalid-target");
    if (!looksLikeUrl(target) && (isUnsafeIdentifier(target) || /[\\/]/.test(target))) throw new DoctorError("Add provider target must be a safe provider identifier", "invalid-target");
    if (looksLikeUrl(target)) validateExplicitProviderUrl(target);
    const requestedModelId = input.modelId?.trim();
    if (input.modelId !== undefined && (!requestedModelId || isUnsafeIdentifier(requestedModelId))) throw new DoctorError("Model id must be a safe non-empty identifier", "invalid-target");
    const requestedProviderId = input.providerId?.trim();
    if (input.providerId !== undefined && (!requestedProviderId || isUnsafeIdentifier(requestedProviderId) || /[\\/]/.test(requestedProviderId))) {
      throw new DoctorError("Explicit provider id must be a safe non-empty identifier", "invalid-target");
    }
    if (requestedProviderId && !looksLikeUrl(target)) {
      throw new DoctorError("Explicit provider id requires a provider endpoint URL", "invalid-target");
    }
    const requestedMetadataProvider = input.metadataProvider?.trim();
    if (input.metadataProvider !== undefined && (!requestedMetadataProvider || isUnsafeIdentifier(requestedMetadataProvider))) throw new DoctorError("Metadata provider must be a safe non-empty identifier", "invalid-target");
    if (input.api !== undefined && !isPiApi(input.api)) throw new DoctorError("API protocol must be a supported Pi API identifier", "invalid-target");
    const loadedConfig = await readModelsJson(this.options.paths.modelsPath);
    const { data } = loadedConfig;
    let catalog: ModelsDevCatalog | undefined;
    let catalogSource: AddProposal["catalogSource"] = "fallback";
    let warning: string | undefined;
    try {
      const loaded = await this.modelsDev.load({ persist: input.persistCache !== false && !input.dryRun });
      catalog = loaded.catalog;
      catalogSource = loaded.source;
      warning = loaded.warning;
    } catch (error) {
      if (!(error instanceof ModelsDevError)) throw error;
      if (error.code === "invalid-catalog") throw error;
      warning = error.message;
    }

    const configuredProviders = getProviders(data);
    const configuredByTarget = findConfiguredProvider(configuredProviders, target);
    const configuredByExplicitId = requestedProviderId ? findConfiguredProviderById(configuredProviders, requestedProviderId) : undefined;
    if (requestedProviderId && configuredByTarget && configuredByTarget.id !== configuredByExplicitId?.id) {
      throw new DoctorError(`Endpoint ${target} is already configured as provider ${configuredByTarget.id}; choose a different provider id or reuse that provider`, "invalid-target");
    }
    if (requestedProviderId && configuredByExplicitId?.provider.baseUrl && !sameChannelEndpoint(configuredByExplicitId.provider.baseUrl, target, configuredByExplicitId.provider.api)) {
      throw new DoctorError(`Provider ${requestedProviderId} is already configured with a different endpoint; use its existing endpoint or choose a different provider id`, "invalid-target");
    }
    const configuredEntry = configuredByExplicitId ?? (requestedProviderId ? undefined : configuredByTarget);
    const match = catalog ? chooseMatch(catalog, target, requestedModelId, requestedMetadataProvider, Boolean(configuredEntry || looksLikeUrl(target))) : undefined;
    if (match?.ambiguous || match?.matchedBy.includes("model-ambiguous")) {
      throw new DoctorError(`Model selection for ${target}${requestedModelId ? `/${requestedModelId}` : ""} is ambiguous; choose an exact model id`, "selection-required");
    }
    if (!requestedModelId && !looksLikeUrl(target)) {
      throw new DoctorError(catalog
        ? `A model id is required for ${target}; select one from /model-doctor add candidates`
        : "A model id is required when models.dev metadata is unavailable", "selection-required");
    }
    const providerOnly = !requestedModelId && looksLikeUrl(target);
    if (!requestedModelId && !providerOnly) {
      throw new DoctorError(catalog
        ? `A model id is required for ${target}; select one from /model-doctor add candidates`
        : "A model id is required when models.dev metadata is unavailable", "selection-required");
    }
    const canUseExplicitFallback = providerOnly || !catalog || (!match?.model && !requestedMetadataProvider && Boolean(configuredEntry || looksLikeUrl(target)));
    if (catalog && !match?.model && !canUseExplicitFallback) {
      throw new DoctorError(`No models.dev model matched ${target}/${requestedModelId}`, "invalid-target");
    }
    const fallback = match?.model || providerOnly
      ? undefined
      : canUseExplicitFallback && requestedModelId
        ? fallbackProvider(target, requestedModelId, configuredEntry, configuredProviders, catalog ? Object.keys(catalog.providers) : [])
        : undefined;
    if (fallback) {
      catalogSource = "fallback";
      warning = [warning, `No models.dev metadata matched ${target}/${requestedModelId}; using the explicit model and configured endpoint.`]
        .filter((item): item is string => Boolean(item))
        .join(" ");
    }
    const provider = match?.provider ?? fallback?.provider;
    const sourceModel = providerOnly ? undefined : (match?.model ?? fallback?.model);
    if (providerOnly) {
      // Provider-only add: create a provider entry with no model. A URL that
      // exactly matches a models.dev provider keeps the official provider id;
      // unlisted URLs get a channel-derived id.
      if (configuredEntry) throw new DoctorError(`Provider ${requestedProviderId ?? target} is already configured; use sync to add models`, "invalid-target");
      const endpoint = target;
      const channelApi = input.api ?? detectChannelApi(endpoint);
      const providerName = requestedProviderId ?? provider?.name ?? providerIdFromUrl(target);
      const requestedApiKey = input.apiKey?.trim();
      if (input.apiKey !== undefined && !requestedApiKey) throw new DoctorError("API key reference must not be empty", "invalid-target");
      const apiKeyReference = requestedApiKey && (isCredentialReference(requestedApiKey) || input.allowLiteralApiKey === true)
        ? requestedApiKey
        : undefined;
      if (requestedApiKey && !isCredentialReference(requestedApiKey) && input.allowLiteralApiKey !== true) {
        warning = [warning, "Literal API key input was not persisted; use $ENV_VAR, ${ENV_VAR}, !command, or explicitly opt in with --allow-literal-api-key."]
          .filter((item): item is string => Boolean(item))
          .join(" ");
      }
      const configuredProvider: PiProvider = {
        name: providerName,
        baseUrl: endpoint,
        api: channelApi,
        ...(apiKeyReference ? { apiKey: apiKeyReference } : {}),
        models: [],
      };
      const next = cloneJson(data);
      const catalogMatch = match?.provider !== undefined && requestedProviderId === undefined;
      const pid = requestedProviderId
        ?? providerIdForAddTarget(target, undefined, configuredProviders, provider?.id ?? providerName, !catalogMatch, catalog ? Object.keys(catalog.providers) : []);
      const plan = mergeProvider(next, pid, configuredProvider, this.now(), {
        preserveProviderIdentity: true,
        endpointApiExplicit: input.api !== undefined,
      });
      let proposalConfig = next;
      if (jsonEqual(stripDoctorMetadata(data), stripDoctorMetadata(next))) {
        plan.changes = [];
        plan.warnings.push("Add produced no runtime or user-data changes; no backup will be created.");
        proposalConfig = cloneJson(data);
      }
      return {
        target: pid,
        matchedBy: [requestedProviderId ? "provider-only-explicit-url" : "provider-only-url"],
        adapter: "fallback",
        confidence: "low",
        reasoningControlType: "unknown",
        cacheCapabilities: { prompt: false, context: false, kv: false },
        requiredHeaders: [],
        baseFingerprint: loadedConfig.fingerprint,
        baseExisted: loadedConfig.existed,
        providerId: pid,
        modelId: "",
        config: proposalConfig,
        plan,
        catalogSource: "fallback",
        metadataOnly: !catalogMatch,
        warning,
        dryRun: input.dryRun,
      };
    }
    if (!provider || !sourceModel) {
      throw new DoctorError(`Unable to discover ${target}; pass an explicit provider URL and model id`, "invalid-target");
    }
    if (sourceModel.deprecated === true || sourceModel.status === "deprecated") {
      warning = [warning, `models.dev marks ${provider.id}/${sourceModel.id} as deprecated; add is explicit and no automatic deletion will occur.`]
        .filter((item): item is string => Boolean(item))
        .join(" ");
    }
    const policy = await this.getPolicyCatalog(input.persistCache !== false && !input.dryRun);
    const metadataOnly = requestedProviderId !== undefined || match?.metadataOnly === true;
    const provisionalProviderOnly = isProvisionalProviderOnly(configuredEntry?.provider);
    const transportOwned = metadataOnly || looksLikeUrl(target) || provisionalProviderOnly;
    const providerId = requestedProviderId ?? providerIdForAddTarget(
      target,
      configuredEntry,
      configuredProviders,
      match?.provider.id ?? provider.id,
      metadataOnly,
      catalog ? Object.keys(catalog.providers) : [],
    );
    const modelId = sourceModel.id;
    const requestedEndpoint = looksLikeUrl(target)
      ? target
      : (provisionalProviderOnly || metadataOnly)
        ? configuredEntry?.provider.baseUrl
        : undefined;
    const inferredEndpoint = inferProviderEndpoint(provider, requestedEndpoint);
    if (!inferredEndpoint && !findConfiguredProviderById(getProviders(data), providerId)) {
      throw new DoctorError(`Unable to infer an API endpoint for provider ${providerId}; pass a provider URL to add`, "invalid-target");
    }
    const pendingMetadata = provisionalProviderOnly ? configuredEntry?.provider._piModelDoctor : undefined;
    const pendingEndpointAutoRepair = provisionalProviderOnly && configuredEntry?.provider !== undefined
      ? isPendingEndpointAutoRepair(configuredEntry.provider)
      : false;
    const pendingApiAutoRepair = provisionalProviderOnly && configuredEntry?.provider !== undefined
      ? isPendingApiAutoRepair(configuredEntry.provider)
      : false;
    const pendingApiChanged = provisionalProviderOnly && configuredEntry?.provider !== undefined
      ? isPendingApiChanged(configuredEntry.provider)
      : false;
    const configuredChannelApi = configuredEntry && isPiApi(configuredEntry.provider.api)
      && (!provisionalProviderOnly || pendingMetadata?.endpointApiExplicit === true || pendingApiChanged)
      ? configuredEntry.provider.api
      : undefined;
    // While a provider-only channel is pending, resolve the API family from
    // the selected model/provider metadata rather than locking in the URL's
    // initial heuristic. Explicit --api or a later user edit remains owned by
    // the channel and takes precedence.
    const modelApi = endpointApiForModel(provider, provisionalProviderOnly ? undefined : inferredEndpoint, input.api ?? configuredChannelApi);
    const inferredChannelApi = provisionalProviderOnly && modelApi
      ? modelApi
      : (metadataOnly || looksLikeUrl(target))
        ? detectChannelApi(inferredEndpoint)
        : detectPiApi(provider, inferredEndpoint);
    const channelApi = input.api ?? configuredChannelApi ?? inferredChannelApi;
    // A direct channel URL can be a bare host while its resolved metadata tells
    // us that the model speaks an API family with a conventional version path.
    // Only root URLs are normalized; existing paths remain channel-owned.
    const endpointApi = provisionalProviderOnly
      ? (input.api ?? configuredChannelApi ?? modelApi)
      : endpointApiForModel(provider, inferredEndpoint, input.api ?? configuredChannelApi);
    const endpoint = transportOwned && (configuredEntry === undefined || provisionalProviderOnly)
      && (!provisionalProviderOnly || pendingEndpointAutoRepair)
      ? normalizeEndpointForApi(inferredEndpoint, endpointApi)
      : inferredEndpoint;
    const normalizeConfiguredEndpoint = provisionalProviderOnly
      && pendingEndpointAutoRepair
      && isAutoEndpointNormalization(inferredEndpoint, endpoint, endpointApi);
    const generatedModel = toPiModel(provider, sourceModel, {
      endpoint,
      api: channelApi,
      providerId,
      adapterProviderId: transportOwned && isPiApi(channelApi) ? adapterIdForPiApi(channelApi) : undefined,
      metadataOnly,
      transportOwned,
      now: this.now(),
      sourceName: this.source,
      capabilitySource: catalogSource === "fallback" ? "fallback" : "models.dev",
      policy,
    });
    const requestedApiKey = input.apiKey?.trim();
    if (input.apiKey !== undefined && !requestedApiKey) throw new DoctorError("API key reference must not be empty", "invalid-target");
    const apiKeyReference = requestedApiKey && (isCredentialReference(requestedApiKey) || input.allowLiteralApiKey === true)
      ? requestedApiKey
      : requestedApiKey ? undefined : transportOwned ? undefined : firstEnvironmentKey(provider);
    if (requestedApiKey && !isCredentialReference(requestedApiKey) && input.allowLiteralApiKey !== true) {
      warning = [warning, "Literal API key input was not persisted; use $ENV_VAR, ${ENV_VAR}, !command, or explicitly opt in with --allow-literal-api-key."]
        .filter((item): item is string => Boolean(item))
        .join(" ");
    } else if (requestedApiKey && !isCredentialReference(requestedApiKey)) {
      warning = [warning, "A literal API key was explicitly allowed and will be persisted; review the backup and configure a safer auth reference when possible."]
        .filter((item): item is string => Boolean(item))
        .join(" ");
    }
    const configuredProvider: PiProvider = {
      name: configuredEntry?.provider.name ?? (metadataOnly ? providerId : provider.name ?? provider.id),
      ...(endpoint ? { baseUrl: endpoint } : {}),
      api: channelApi,
      ...(apiKeyReference ? { apiKey: apiKeyReference } : {}),
      models: [generatedModel],
    };
    const next = cloneJson(data);
    const plan = mergeProvider(next, providerId, configuredProvider, this.now(), {
      preserveProviderIdentity: transportOwned,
      normalizeEndpoint: normalizeConfiguredEndpoint,
      normalizeApi: provisionalProviderOnly && pendingApiAutoRepair && configuredChannelApi === undefined,
      endpointApiExplicit: input.api !== undefined || configuredEntry?.provider._piModelDoctor?.endpointApiExplicit === true,
      endpointNormalizationBlocked: provisionalProviderOnly && configuredEntry?.provider !== undefined && isPendingEndpointChanged(configuredEntry.provider),
      endpointApiNormalizationBlocked: provisionalProviderOnly && pendingApiChanged,
    });
    if (provisionalProviderOnly && configuredEntry?.provider && isPendingEndpointChanged(configuredEntry.provider)) {
      plan.conflicts.push(finding("endpoint-mismatch", "warning", `${providerId}/${modelId}`, "Provider-only endpoint was changed after setup; the user-owned endpoint was preserved", false, true));
    }
    if (provisionalProviderOnly && pendingApiChanged) {
      plan.conflicts.push(finding("api-mismatch", "warning", `${providerId}/${modelId}`, "Provider-only API protocol was changed after setup; the user-owned API was preserved", false, true));
    }
    let proposalConfig = next;
    if (jsonEqual(stripDoctorMetadata(data), stripDoctorMetadata(next))) {
      plan.changes = [];
      plan.warnings.push("Add produced no runtime or user-data changes; no backup will be created.");
      proposalConfig = cloneJson(data);
    }
    const normalizedReasoning = resolveReasoning(provider, sourceModel);
    const normalizedCache = resolveCache(provider, sourceModel, catalogSource === "fallback" ? "fallback" : "models.dev");
    const adapter = metadataOnly || looksLikeUrl(target)
      ? resolveProviderAdapter({ id: isPiApi(channelApi) ? adapterIdForPiApi(channelApi) : provider.id, models: {} }, endpoint, isPiApi(channelApi) ? channelApi : undefined)
      : resolveProviderAdapter(provider, endpoint, channelApi);
    if (metadataOnly) {
      warning = [warning, `Third-party channel ${providerId} is not a models.dev provider; using ${provider.id}/${sourceModel.id} as metadata only. Endpoint, protocol, headers, and authentication remain channel-owned.`]
        .filter((item): item is string => Boolean(item))
        .join(" ");
    }
    return {
      target: `${providerId}/${modelId}`,
      matchedBy: match?.matchedBy ?? ["explicit-fallback"],
      adapter: adapter.id,
      confidence: catalogSource === "fallback" ? "low" : normalizedCache.confidence,
      reasoningControlType: normalizedReasoning.controlType,
      cacheCapabilities: normalizedCache.capability,
      requiredHeaders: transportOwned ? [] : [...new Set([...(provider.required_headers ?? []), ...(sourceModel.required_headers ?? [])])],
      baseFingerprint: loadedConfig.fingerprint,
      baseExisted: loadedConfig.existed,
      providerId,
      modelId,
      config: proposalConfig,
      plan,
      catalogSource,
      metadataOnly,
      metadataProviderId: metadataOnly ? provider.id : undefined,
      warning,
      dryRun: input.dryRun,
    };
  }

  async applyAdd(proposal: AddProposal): Promise<{ backupPath?: string; target: string; plan: ChangePlan }> {
    if (proposal.dryRun) return { target: proposal.target, plan: proposal.plan };
    const blocking = proposal.plan.conflicts.filter((item) => item.severity === "error");
    if (blocking.length > 0) {
      throw new DoctorError(`Cannot add ${proposal.target}: ${blocking.map((item) => item.message).join("; ")}`, "invalid-config");
    }
    if (proposal.plan.changes.length === 0) return { target: proposal.target, plan: proposal.plan };
    await this.ensureProposalBaseUnchanged(proposal.baseFingerprint, proposal.baseExisted);
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, target: proposal.target, plan: proposal.plan };
  }

  async proposeSync(input: SyncInput): Promise<SyncProposal> {
    const target = input.target.trim();
    validateAddTarget(target);
    const modelIds: string[] = [];
    for (const rawModelId of input.modelIds) {
      const modelId = rawModelId.trim();
      if (modelId && !modelIds.some((existing) => existing.toLowerCase() === modelId.toLowerCase())) modelIds.push(modelId);
    }
    if (modelIds.length === 0) throw new DoctorError("Sync requires at least one model id", "selection-required");
    if (modelIds.some((modelId) => isUnsafeIdentifier(modelId))) throw new DoctorError("Model id must be a safe identifier", "invalid-target");
    const metadataProvider = input.metadataProvider?.trim();
    if (input.metadataProvider !== undefined && (!metadataProvider || isUnsafeIdentifier(metadataProvider))) {
      throw new DoctorError("Metadata provider must be a safe non-empty identifier", "invalid-target");
    }
    if (input.api !== undefined && !isPiApi(input.api)) throw new DoctorError("API protocol must be a supported Pi API identifier", "invalid-target");

    const loadedConfig = await readModelsJson(this.options.paths.modelsPath);
    let catalog: ModelsDevCatalog | undefined;
    const warnings: string[] = [];
    try {
      const loaded = await this.modelsDev.load({ persist: input.persistCache !== false && !input.dryRun });
      catalog = loaded.catalog;
      if (loaded.warning) warnings.push(loaded.warning);
    } catch (error) {
      if (!(error instanceof ModelsDevError)) throw error;
      if (error.code === "invalid-catalog") throw error;
      if (!looksLikeUrl(target) && !findConfiguredProvider(getProviders(loadedConfig.data), target)) throw error;
      warnings.push(`models.dev unavailable; each explicitly selected model will use conservative fallback metadata (${error.message})`);
    }
    const policy = await this.getPolicyCatalog(input.persistCache !== false && !input.dryRun);
    const candidates = catalog ? ModelsDevClient.listCandidates(catalog, target, policy, undefined, metadataProvider) : [];
    const config = cloneJson(loadedConfig.data);
    const plans: ChangePlan[] = [];
    const resolvedModelIds: string[] = [];
    let providerId: string | undefined;

    for (const modelId of modelIds) {
      const matchingCandidates = candidates.filter((candidate) => candidate.id.toLowerCase() === modelId.toLowerCase());
      if (matchingCandidates.length > 1 && !metadataProvider) {
        throw new DoctorError(`Model ${modelId} is ambiguous for ${target}; pass --metadata-provider`, "selection-required");
      }
      if (matchingCandidates.length === 0 && catalog) {
        // Let proposeAdd produce the same explicit-fallback/error semantics as
        // add, but do not silently fall back when a catalog match exists under
        // another provider and was not selected. An explicit URL may still
        // use a conservative fallback when it has no catalog match.
        const globalMatches = looksLikeUrl(target) ? ModelsDevClient.findGlobalModel(catalog, modelId, metadataProvider) : undefined;
        const canFallback = looksLikeUrl(target) && !metadataProvider;
        if (!globalMatches && !canFallback && !findConfiguredProvider(getProviders(loadedConfig.data), target)) {
          throw new DoctorError(`No models.dev model matched ${target}/${modelId}`, "invalid-target");
        }
      }
      const add = await this.proposeAdd({
        target,
        modelId,
        metadataProvider,
        api: input.api,
        apiKey: input.apiKey,
        allowLiteralApiKey: input.allowLiteralApiKey,
        dryRun: true,
        persistCache: false,
      });
      providerId ??= add.providerId;
      if (providerId !== add.providerId) throw new DoctorError(`Sync target resolved to more than one provider id (${providerId}, ${add.providerId})`, "invalid-target");
      if (!resolvedModelIds.some((existing) => existing.toLowerCase() === add.modelId.toLowerCase())) resolvedModelIds.push(add.modelId);
      const addProvider = getProviders(add.config)[add.providerId];
      const desiredModel = addProvider ? getModels(addProvider).find((model) => model.id === add.modelId) : undefined;
      if (!addProvider || !desiredModel) throw new DoctorError(`Unable to prepare ${target}/${modelId} for sync`, "invalid-config");
      const syncProvider = cloneJson(addProvider);
      syncProvider.models = [cloneJson(desiredModel)];
      const preserveProviderIdentity = desiredModel.compat?.transportOwned === true || add.metadataOnly === true;
      const existingSyncProvider = getProviders(config)[add.providerId];
      if (existingSyncProvider && preserveProviderIdentity && getModels(existingSyncProvider).length > 0
        && isPiApi(existingSyncProvider.api) && isPiApi(syncProvider.api)
        && existingSyncProvider.api !== syncProvider.api) {
        throw new DoctorError(`Sync selected models require different channel API protocols (${existingSyncProvider.api} and ${syncProvider.api}); split the sync or pass an explicit --api`, "invalid-target");
      }
      const providerPrefix = `providers.${add.providerId}`;
      const normalizeEndpoint = add.plan.changes.some((change) => change.path === `${providerPrefix}.baseUrl` && change.ownership === "managed");
      const normalizeApi = add.plan.changes.some((change) => change.path === `${providerPrefix}.api` && change.ownership === "managed");
      const endpointNormalizationBlocked = existingSyncProvider !== undefined
        && (isPendingEndpointChanged(existingSyncProvider)
          || add.plan.conflicts.some((finding) => finding.code === "endpoint-mismatch" && finding.userOwned === true));
      const endpointApiNormalizationBlocked = existingSyncProvider !== undefined
        && (isPendingApiChanged(existingSyncProvider)
          || add.plan.conflicts.some((finding) => finding.code === "api-mismatch" && finding.userOwned === true));
      const mergePlan = mergeProvider(config, add.providerId, syncProvider, this.now(), {
        preserveProviderIdentity,
        normalizeEndpoint,
        normalizeApi,
        endpointApiExplicit: input.api !== undefined || existingSyncProvider?._piModelDoctor?.endpointApiExplicit === true,
        endpointNormalizationBlocked,
        endpointApiNormalizationBlocked,
      });
      plans.push({
        ...mergePlan,
        conflicts: [...mergePlan.conflicts, ...add.plan.conflicts],
        warnings: [...mergePlan.warnings, ...add.plan.warnings],
      });
      if (add.warning) warnings.push(add.warning);
      warnings.push(...add.plan.warnings);
    }

    if (!providerId) throw new DoctorError(`Unable to resolve sync target ${target}`, "invalid-target");
    let plan = sanitizePlan(combinePlans(`${providerId}/*`, plans));
    if (jsonEqual(stripDoctorMetadata(loadedConfig.data), stripDoctorMetadata(config))) {
      plan = sanitizePlan({ ...plan, changes: [], warnings: [...plan.warnings, "Sync produced no runtime or user-data changes; no backup will be created."] });
    }
    return {
      target,
      providerId,
      modelIds: resolvedModelIds,
      config: plan.changes.length === 0 ? cloneJson(loadedConfig.data) : config,
      baseFingerprint: loadedConfig.fingerprint,
      baseExisted: loadedConfig.existed,
      plan,
      warnings: [...new Set(warnings)],
      dryRun: input.dryRun,
    };
  }

  async applySync(proposal: SyncProposal): Promise<{ backupPath?: string; plan: ChangePlan }> {
    if (proposal.dryRun) return { plan: proposal.plan };
    const blocking = proposal.plan.conflicts.filter((item) => item.severity === "error");
    if (blocking.length > 0) throw new DoctorError(`Cannot sync ${proposal.target}: ${blocking.map((item) => item.message).join("; ")}`, "invalid-config");
    if (proposal.plan.changes.length === 0) return { plan: proposal.plan };
    await this.ensureProposalBaseUnchanged(proposal.baseFingerprint, proposal.baseExisted);
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, plan: proposal.plan };
  }

  async check(target?: string): Promise<CheckResult> {
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const checkedAt = this.now().toISOString();
    let catalog: ModelsDevCatalog;
    let networkFinding: Finding | undefined;
    try {
      const loaded = await this.modelsDev.load();
      catalog = loaded.catalog;
      if (loaded.warning) networkFinding = finding("network-unavailable", "warning", target ?? "models.json", loaded.warning, false);
    } catch (error) {
      if (!(error instanceof ModelsDevError)) throw error;
      if (error.code === "invalid-catalog") throw error;
      const policy = await this.getPolicyCatalog(false);
      return this.checkLocalData(data, target, finding("network-unavailable", "warning", target ?? "models.json", error.message, false), policy);
    }
    return this.checkDataWithCatalog(data, catalog, target, networkFinding, await this.getPolicyCatalog(true), true);
  }

  async proposeFix(target: string, options: FixOptions = {}): Promise<FixProposal> {
    const loadedConfig = await readModelsJson(this.options.paths.modelsPath);
    const { data } = loadedConfig;
    let catalog: ModelsDevCatalog;
    let networkFinding: Finding | undefined;
    try {
      const loaded = await this.modelsDev.load({ persist: options.persistCache !== false && options.dryRun !== true });
      catalog = loaded.catalog;
      if (loaded.warning) networkFinding = finding("network-unavailable", "warning", target, loaded.warning, false);
    } catch (error) {
      if (error instanceof ModelsDevError) {
        if (error.code === "invalid-catalog") throw error;
        const policy = await this.getPolicyCatalog(false);
        return { config: data, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, result: this.checkLocalData(data, target, finding("network-unavailable", "warning", target, error.message, false), policy) };
      }
      throw error;
    }
    const policy = await this.getPolicyCatalog(options.persistCache !== false && options.dryRun !== true);
    const result = await this.checkWithCatalog(data, catalog, target, networkFinding, policy);
    const config = cloneJson(data);
    result.plan = applyRepairPlan(config, target, catalog, result.findings, this.now(), this.source, policy);
    return { config, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, result, dryRun: options.dryRun };
  }

  async proposeFixAll(options: FixOptions = {}): Promise<FixProposal> {
    const loadedConfig = await readModelsJson(this.options.paths.modelsPath);
    const { data } = loadedConfig;
    let catalog: ModelsDevCatalog;
    let networkFinding: Finding | undefined;
    try {
      const loaded = await this.modelsDev.load({ persist: options.persistCache !== false && options.dryRun !== true });
      catalog = loaded.catalog;
      if (loaded.warning) networkFinding = finding("network-unavailable", "warning", "models.json", loaded.warning, false);
    } catch (error) {
      if (error instanceof ModelsDevError) {
        if (error.code === "invalid-catalog") throw error;
        const policy = await this.getPolicyCatalog(false);
        return { config: data, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, result: this.checkLocalData(data, undefined, finding("network-unavailable", "warning", "models.json", error.message, false), policy) };
      }
      throw error;
    }
    const policy = await this.getPolicyCatalog(options.persistCache !== false && options.dryRun !== true);
    const config = cloneJson(data);
    const findings = networkFinding ? [networkFinding] : [];
    const plans: ChangePlan[] = [];
    for (const [providerId, provider] of Object.entries(getProviders(data))) {
      for (const model of getModels(provider)) {
        const target = `${providerId}/${model.id}`;
        const result = await this.checkWithCatalog(data, catalog, target, undefined, policy);
        findings.push(...result.findings);
        plans.push(applyRepairPlan(config, target, catalog, result.findings, this.now(), this.source, policy));
      }
    }
    const plan = combinePlans("models.json", plans);
    return { config, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, result: { checkedAt: this.now().toISOString(), findings, plan }, dryRun: options.dryRun };
  }

  async applyFix(proposal: FixProposal): Promise<{ backupPath?: string; plan?: ChangePlan }> {
    if (!proposal.result.plan) return {};
    const blocking = proposal.result.plan.conflicts.filter((item) => item.severity === "error");
    if (!proposal.dryRun && blocking.length > 0) {
      throw new DoctorError(`Cannot fix ${proposal.result.target ?? "models.json"}: ${blocking.map((item) => item.message).join("; ")}`, "invalid-config");
    }
    if (proposal.dryRun || proposal.result.plan.changes.length === 0) return { plan: proposal.result.plan };
    await this.ensureProposalBaseUnchanged(proposal.baseFingerprint, proposal.baseExisted);
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, plan: proposal.result.plan };
  }

  async proposeRemove(target: string, options: { dryRun?: boolean } = {}): Promise<RemoveProposal> {
    const selected = parseTarget(target, true);
    const loadedConfig = await readModelsJson(this.options.paths.modelsPath);
    const { data } = loadedConfig;
    const next = cloneJson(data);
    const providers = getProviders(next);
    const providerEntry = findConfiguredProviderById(providers, selected.providerId);
    const providerId = providerEntry?.id ?? selected.providerId;
    const provider = providerEntry?.provider;
    if (!provider) return { config: next, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, plan: sanitizePlan({ target, changes: [], conflicts: [finding("missing-provider", "error", target, `Provider ${selected.providerId} is not configured`, false)], warnings: [] }), dryRun: options.dryRun };
    const models = getModels(provider);
    const index = models.findIndex((model) => model.id === selected.modelId);
    if (index < 0) return { config: next, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, plan: sanitizePlan({ target, changes: [], conflicts: [finding("missing-model", "error", target, `Model ${selected.modelId} is not configured`, false)], warnings: [] }), dryRun: options.dryRun };
    const model = models[index];
    models.splice(index, 1);
    const changes: Change[] = [{ path: `providers.${providerId}.models[${selected.modelId}]`, before: model, after: undefined, reason: "Remove explicitly requested model", ownership: "user" }];
    if (models.length === 0 && safeToDeleteProvider(provider)) {
      delete providers[providerId];
      changes.push({ path: `providers.${providerId}`, before: provider, after: undefined, reason: "Remove empty Doctor-managed provider", ownership: "managed" });
    }
    return { config: next, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, plan: sanitizePlan({ target, changes, conflicts: [], warnings: [] }), dryRun: options.dryRun };
  }

  async applyRemove(proposal: RemoveProposal): Promise<{ backupPath?: string; plan: ChangePlan }> {
    if (proposal.dryRun) return { plan: proposal.plan };
    if (proposal.plan.conflicts.length > 0) throw new DoctorError(proposal.plan.conflicts.map((item) => item.message).join("; "), "invalid-config");
    await this.ensureProposalBaseUnchanged(proposal.baseFingerprint, proposal.baseExisted);
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, plan: proposal.plan };
  }

  async proposeMigrate(input: MigrateInput): Promise<MigrateProposal> {
    const source = parseTarget(input.source, true);
    const destination = parseTarget(input.destination, true);
    if (normalizeIdentifier(source.providerId) === normalizeIdentifier(destination.providerId)
      && normalizeIdentifier(source.modelId ?? "") === normalizeIdentifier(destination.modelId ?? "")) {
      throw new DoctorError("Migration source and destination must differ", "invalid-target");
    }
    const loadedConfig = await readModelsJson(this.options.paths.modelsPath);
    const { data } = loadedConfig;
    const sourceModelId = source.modelId;
    const sourceEntry = findConfiguredProviderById(getProviders(data), source.providerId);
    const sourceProviderId = sourceEntry?.id ?? source.providerId;
    const sourceProvider = sourceEntry?.provider;
    const sourceModel = sourceProvider ? getModels(sourceProvider).find((model) => model.id === sourceModelId) : undefined;
    if (!sourceProvider) throw new DoctorError(`Migration source provider ${source.providerId} is not configured`, "invalid-target");
    if (!sourceModelId || !sourceModel) throw new DoctorError(`Migration source model ${input.source} is not configured`, "invalid-target");
    let catalog: ModelsDevCatalog;
    try {
      const loaded = await this.modelsDev.load({ persist: input.persistCache !== false && !input.dryRun });
      catalog = loaded.catalog;
    } catch (error) {
      if (error instanceof ModelsDevError) throw new DoctorError(`Unable to resolve migration destination: ${error.message}`, "invalid-target", error);
      throw error;
    }
    const directDestination = ModelsDevClient.find(catalog, destination.providerId, destination.modelId);
    const destinationMatches = directDestination?.model
      ? [directDestination]
      : ModelsDevClient.match(catalog, destination.providerId, destination.modelId, { allowPartialProvider: false, allowPartialModel: false });
    const destinationBestScore = destinationMatches[0]?.score ?? 0;
    const destinationBestMatches = destinationMatches.filter((match) => match.score === destinationBestScore);
    if (destinationBestMatches.length > 1) {
      throw new DoctorError(`Migration destination ${input.destination} is ambiguous; choose an exact provider/model`, "invalid-target");
    }
    const destinationMatch = destinationBestMatches[0];
    if (!destinationMatch?.model) throw new DoctorError(`Migration destination ${input.destination} was not found in models.dev`, "invalid-target");
    const policy = await this.getPolicyCatalog(input.persistCache !== false && !input.dryRun);
    const destinationProviderId = destinationMatch.provider.id;
    const destinationModelId = destinationMatch.model.id;
    const endpoint = inferProviderEndpoint(destinationMatch.provider);
    const generatedModel = toPiModel(destinationMatch.provider, destinationMatch.model, { endpoint, now: this.now(), sourceName: this.source, policy });
    const configuredProvider: PiProvider = {
      name: destinationMatch.provider.name ?? destinationMatch.provider.id,
      ...(endpoint ? { baseUrl: endpoint } : {}),
      api: detectPiApi(destinationMatch.provider, endpoint),
      models: [generatedModel],
    };
    const next = cloneJson(data);
    const plan = mergeProvider(next, destinationProviderId, configuredProvider, this.now());
    const targetProvider = findConfiguredProvider(getProviders(next), destinationProviderId)?.provider;
    const targetModel = targetProvider ? getModels(targetProvider).find((model) => model.id === destinationModelId) : undefined;
    if (!targetProvider || !targetModel) throw new DoctorError(`Unable to create migration destination ${destinationProviderId}/${destinationModelId}`, "invalid-config");
    if (normalizeIdentifier(sourceProviderId) !== normalizeIdentifier(destinationProviderId)) {
      mergeMigrationProviderFields(sourceProvider, targetProvider, plan, `${destinationProviderId}/${destinationModelId}`);
    }
    mergeMigrationUserFields(sourceModel, targetModel, plan, `${destinationProviderId}/${destinationModelId}`);
    if (input.removeSource) removeSourceModel(next, sourceProviderId, sourceModelId, plan);
    if (destinationMatch.model.deprecated === true || destinationMatch.model.status === "deprecated") {
      plan.conflicts.push(finding("deprecated-model", "error", `${destinationProviderId}/${destinationModelId}`, `Destination ${destinationProviderId}/${destinationModelId} is deprecated according to models.dev; migration is advisory only`, false));
      plan.warnings.push("Deprecated destinations are never automatically migrated; choose a current model instead.");
    }
    plan.target = `${input.source} -> ${destinationProviderId}/${destinationModelId}`;
    // Metadata timestamps and ownership snapshots are implementation state, not
    // a migration result. If the destination already has the same runtime and
    // user-owned data, discard metadata-only churn so applyMigrate remains a
    // true no-op and cannot create an unnecessary backup.
    if (jsonEqual(stripDoctorMetadata(data), stripDoctorMetadata(next))) {
      plan.changes = [];
      plan.warnings.push("Migration produced no runtime or user-data changes; no backup will be created.");
      return { config: cloneJson(data), baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, plan: sanitizePlan(plan), source: input.source, destination: `${destinationProviderId}/${destinationModelId}`, dryRun: input.dryRun };
    }
    return { config: next, baseFingerprint: loadedConfig.fingerprint, baseExisted: loadedConfig.existed, plan: sanitizePlan(plan), source: input.source, destination: `${destinationProviderId}/${destinationModelId}`, dryRun: input.dryRun };
  }

  async applyMigrate(proposal: MigrateProposal): Promise<{ backupPath?: string; plan: ChangePlan }> {
    if (!proposal.dryRun && proposal.plan.conflicts.some((item) => item.severity === "error")) throw new DoctorError(proposal.plan.conflicts.map((item) => item.message).join("; "), "invalid-config");
    if (proposal.dryRun || proposal.plan.changes.length === 0) return { plan: proposal.plan };
    await this.ensureProposalBaseUnchanged(proposal.baseFingerprint, proposal.baseExisted);
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, plan: proposal.plan };
  }

  private checkLocalData(data: PiModelsJson, target: string | undefined, networkFinding: Finding, policy: PolicyCatalog): CheckResult {
    const findings: Finding[] = [networkFinding];
    const providers = getProviders(data);
    const selected = target ? parseTarget(target, true) : undefined;
    const entries: Array<[string, PiProvider, PiModel]> = [];
    if (selected) {
      const providerEntry = findConfiguredProviderById(providers, selected.providerId);
      const provider = providerEntry?.provider;
      if (!provider) {
        findings.push(finding("missing-provider", "error", target ?? selected.providerId, `Provider ${selected.providerId} is not configured`, false));
      } else {
        const model = getModels(provider).find((item) => item.id === selected.modelId);
        if (!model) findings.push(finding("missing-model", "error", target ?? selected.providerId, `Model ${selected.modelId} is not configured`, false));
        else entries.push([providerEntry?.id ?? selected.providerId, provider, model]);
      }
    } else {
      for (const [providerId, provider] of Object.entries(providers)) {
        for (const model of getModels(provider)) entries.push([providerId, provider, model]);
      }
    }
    for (const [providerId, provider, model] of entries) findings.push(...checkLocalModel(providerId, provider, model, policy));
    return { target, checkedAt: this.now().toISOString(), findings };
  }

  private async ensureProposalBaseUnchanged(expectedFingerprint: string | undefined, expectedExisted: boolean | undefined): Promise<void> {
    if (expectedFingerprint === undefined && expectedExisted === undefined) return;
    const currentFingerprint = await fileFingerprint(this.options.paths.modelsPath);
    const currentExisted = currentFingerprint !== undefined;
    if (expectedFingerprint !== currentFingerprint || expectedExisted !== undefined && expectedExisted !== currentExisted) {
      throw new DoctorError("models.json changed after the proposal was created; regenerate the plan before applying", "concurrent-modification");
    }
  }

  private async getPolicyCatalog(persist: boolean): Promise<PolicyCatalog> {
    const cached = await this.cache.readPolicyCatalog();
    if (cached && isPolicyCatalog(cached)) return cached;
    const policy = defaultPolicyCatalog(this.now());
    if (persist) await this.cache.writePolicyCatalog(policy);
    return policy;
  }

  private async checkWithCatalog(data: PiModelsJson, catalog: ModelsDevCatalog, target: string, networkFinding: Finding | undefined, policy: PolicyCatalog): Promise<CheckResult> {
    const selected = parseTarget(target, true);
    const providers = getProviders(data);
    const providerEntry = findConfiguredProviderById(providers, selected.providerId);
    const provider = providerEntry?.provider;
    const providerId = providerEntry?.id ?? selected.providerId;
    const findings = networkFinding ? [networkFinding] : [];
    if (!provider) {
      findings.push(finding("missing-provider", "error", target, `Provider ${selected.providerId} is not configured`, false));
      return { target, checkedAt: this.now().toISOString(), findings };
    }
    const model = getModels(provider).find((item) => item.id === selected.modelId);
    if (!model) {
      findings.push(finding("missing-model", "error", target, `Model ${selected.modelId} is not configured`, false));
      return { target, checkedAt: this.now().toISOString(), findings };
    }
    const match = findConfiguredMatch(catalog, providerId, provider.baseUrl, model);
    if (!match?.model) {
      findings.push(finding(match?.ambiguous ? "model-selection-required" : "missing-model", "warning", target, match?.ambiguous ? `Model metadata selection for ${target} is ambiguous` : `No models.dev metadata found for ${target}`, false));
      findings.push(...checkLocalModel(providerId, provider, model, policy));
      return { target, checkedAt: this.now().toISOString(), findings };
    }
    findings.push(...checkModel(providerId, provider, model, match.provider, match.model, policy, match.metadataOnly));
    return { target, checkedAt: this.now().toISOString(), findings };
  }

  private checkDataWithCatalog(
    data: PiModelsJson,
    catalog: ModelsDevCatalog,
    target: string | undefined,
    networkFinding: Finding | undefined,
    policy: PolicyCatalog,
    includePlan: boolean,
  ): CheckResult {
    const findings = networkFinding ? [networkFinding] : [];
    const targets: string[] = [];
    const providers = getProviders(data);
    const selected = target ? parseTarget(target, true) : undefined;
    const selectedProvider = selected ? findConfiguredProviderById(providers, selected.providerId) : undefined;
    if (selected && !selectedProvider) {
      findings.push(finding("missing-provider", "error", target ?? selected.providerId, `Provider ${selected.providerId} is not configured`, false));
      return { target, checkedAt: this.now().toISOString(), findings };
    }
    for (const [providerId, provider] of Object.entries(providers)) {
      if (selected && normalizeIdentifier(selectedProvider?.id ?? selected.providerId) !== normalizeIdentifier(providerId)) continue;
      const providerMatch = ModelsDevClient.findForConfig(catalog, providerId, provider.baseUrl)
        ?? (provider.name ? ModelsDevClient.findForConfig(catalog, provider.name, provider.baseUrl) : undefined);
      const configuredModels = selected?.modelId
        ? getModels(provider).filter((item) => item.id === selected.modelId)
        : getModels(provider);
      if (selected?.modelId && configuredModels.length === 0) {
        findings.push(finding("missing-model", "error", target ?? providerId, `Model ${selected.modelId} is not configured`, false));
        continue;
      }
      let metadataMatched = false;
      for (const model of configuredModels) {
        const match = findConfiguredMatch(catalog, providerId, provider.baseUrl, model, provider.name);
        targets.push(`${providerId}/${model.id}`);
        if (match?.ambiguous) {
          findings.push(finding("model-selection-required", "warning", `${providerId}/${model.id}`, `Model metadata selection for ${providerId}/${model.id} is ambiguous`, false));
          continue;
        }
        if (match?.model) {
          metadataMatched = true;
          findings.push(...checkModel(providerId, provider, model, match.provider, match.model, policy, match.metadataOnly));
        } else {
          findings.push(finding("missing-model", "warning", `${providerId}/${model.id}`, `No models.dev model metadata found for ${providerId}/${model.id}; local configuration and ownership remain checkable`, false));
          findings.push(...checkLocalModel(providerId, provider, model, policy));
        }
      }
      if (!providerMatch && !metadataMatched && configuredModels.length > 0) {
        findings.push(finding("missing-provider", "warning", providerId, `No models.dev provider metadata found for third-party channel ${providerId}`, false));
      }
    }
    let plan: ChangePlan | undefined;
    if (includePlan) {
      // Build the refresh/check plan against a private clone. The read-only
      // paths must be able to calculate repair counts without mutating the
      // caller's parsed models.json object.
      const planConfig = cloneJson(data);
      const selectedTarget = selected?.modelId && selectedProvider ? `${selectedProvider.id}/${selected.modelId}` : undefined;
      const planTargets = selectedTarget ? [selectedTarget] : targets;
      plan = combinePlans(target ?? "models.json", planTargets.map((item) => (
        applyRepairPlan(planConfig, item, catalog, findings.filter((entry) => entry.target === item), this.now(), this.source, policy)
      )));
    }
    return { target, checkedAt: this.now().toISOString(), findings, plan };
  }
}

function mergeProvider(config: PiModelsJson, providerId: string, desired: PiProvider, now: Date, options: { preserveProviderIdentity?: boolean; normalizeEndpoint?: boolean; normalizeApi?: boolean; endpointApiExplicit?: boolean; endpointNormalizationBlocked?: boolean; endpointApiNormalizationBlocked?: boolean } = {}): ChangePlan {
  if (isUnsafeIdentifier(providerId)) throw new DoctorError("Provider id uses an unsafe identifier", "invalid-target");
  const providers = getProviders(config);
  const existingEntry = findConfiguredProvider(providers, providerId);
  const storageId = existingEntry?.id ?? providerId;
  const existing = existingEntry?.provider;
  const changes: Change[] = [];
  const conflicts: Finding[] = [];
  if (!existing) {
    const providerManagedFields = options.preserveProviderIdentity ? [] : ["name", "baseUrl", "api"];
    desired._piModelDoctor = buildMetadata(undefined, {
      source: "models.dev",
      lastCheck: now.toISOString(),
      autoRepair: true,
      providerId: storageId,
      endpointNormalizationPending: getModels(desired).length === 0,
      endpointApiExplicit: options.endpointApiExplicit === true,
      endpointApiHint: getModels(desired).length === 0 && isPiApi(desired.api) ? desired.api : undefined,
      endpointValueHint: getModels(desired).length === 0 && typeof desired.baseUrl === "string" ? desired.baseUrl : undefined,
      endpointNormalizationBlocked: options.endpointNormalizationBlocked === true,
      endpointApiNormalizationBlocked: options.endpointApiNormalizationBlocked === true,
    }, providerManagedFields, Object.fromEntries(providerManagedFields.map((field) => [field, desired[field]]).filter(([, value]) => value !== undefined)));
    providers[storageId] = desired;
    changes.push({ path: `providers.${storageId}`, before: undefined, after: desired, reason: "Add provider from models.dev", ownership: "managed" });
    return sanitizePlan({ target: storageId, changes, conflicts, warnings: [] });
  }
  const provider = existing;
  const providerManagedFields: string[] = [];
  for (const field of ["name", "baseUrl", "api"] as const) {
    if (options.preserveProviderIdentity && !((field === "baseUrl" && options.normalizeEndpoint) || (field === "api" && options.normalizeApi))) continue;
    const value = desired[field];
    if (value === undefined) continue;
    if (canManageField(provider, field)) {
      providerManagedFields.push(field);
      if (!jsonEqual(provider[field], value)) {
        changes.push({ path: `providers.${storageId}.${field}`, before: provider[field], after: value, reason: `Sync ${field} from models.dev`, ownership: "managed" });
        provider[field] = value;
      }
    } else if (!jsonEqual(provider[field], value)) {
      const endpointNormalization = field === "baseUrl" && options.normalizeEndpoint === true;
      const apiNormalization = field === "api" && options.normalizeApi === true;
      if (endpointNormalization || apiNormalization) {
        changes.push({ path: `providers.${storageId}.${field}`, before: provider[field], after: value, reason: endpointNormalization ? "Normalize channel endpoint for resolved model API" : "Normalize channel API for resolved model metadata", ownership: "managed" });
        provider[field] = value;
      } else {
        conflicts.push(finding(field === "baseUrl" ? "endpoint-mismatch" : "api-mismatch", "warning", storageId, `Preserved user-owned provider ${field}`, false, true));
      }
    }
  }
  if (desired.apiKey !== undefined && provider.apiKey === undefined) {
    provider.apiKey = desired.apiKey;
    changes.push({ path: `providers.${storageId}.apiKey`, before: undefined, after: "[redacted]", reason: "Configure provider authentication reference", ownership: "user" });
  }
  const desiredModel = getModels(desired)[0];
  const models = getModels(provider);
  const existingModel = models.find((model) => model.id === desiredModel.id);
  if (!existingModel) {
    models.push(desiredModel);
    changes.push({ path: `providers.${storageId}.models[${desiredModel.id}]`, before: undefined, after: desiredModel, reason: "Add model metadata from models.dev", ownership: "managed" });
  } else {
    mergeModel(storageId, existingModel, desiredModel, changes, conflicts, now, { preserveTransport: options.preserveProviderIdentity === true });
  }
  const previousProviderMetadata = hasDoctorMetadata(provider) ? provider._piModelDoctor : undefined;
  if (previousProviderMetadata || providerManagedFields.length > 0) {
    let nextProviderMetadata = buildMetadata(previousProviderMetadata, {
      source: "models.dev",
      lastCheck: now.toISOString(),
      autoRepair: true,
      providerId: storageId,
      endpointNormalizationPending: false,
      endpointApiExplicit: options.endpointApiExplicit ?? previousProviderMetadata?.endpointApiExplicit ?? false,
      endpointApiHint: options.endpointApiNormalizationBlocked === true || previousProviderMetadata?.endpointApiNormalizationBlocked === true
        ? previousProviderMetadata?.endpointApiHint
        : undefined,
      endpointValueHint: options.endpointNormalizationBlocked === true || previousProviderMetadata?.endpointNormalizationBlocked === true
        ? previousProviderMetadata?.endpointValueHint
        : undefined,
      endpointNormalizationBlocked: options.endpointNormalizationBlocked ?? previousProviderMetadata?.endpointNormalizationBlocked ?? false,
      endpointApiNormalizationBlocked: options.endpointApiNormalizationBlocked ?? previousProviderMetadata?.endpointApiNormalizationBlocked ?? false,
    }, providerManagedFields, Object.fromEntries(providerManagedFields.map((field) => [field, provider[field]]).filter(([, value]) => value !== undefined)));
    if (options.preserveProviderIdentity) nextProviderMetadata = withoutManagedFields(nextProviderMetadata, ["name", "baseUrl", "api"]);
    if (!jsonEqual(previousProviderMetadata, nextProviderMetadata)) {
      provider._piModelDoctor = nextProviderMetadata;
      changes.push({ path: `providers.${storageId}._piModelDoctor`, before: previousProviderMetadata, after: nextProviderMetadata, reason: "Record provider ownership metadata", ownership: "managed" });
    }
  }
  return sanitizePlan({ target: `${storageId}/${desiredModel.id}`, changes, conflicts, warnings: [] });
}

function withoutManagedFields(metadata: DoctorMetadata, fields: string[]): DoctorMetadata {
  const excluded = new Set(fields);
  const managedFields = (metadata.managedFields ?? []).filter((field) => !excluded.has(field));
  const managedValues = metadata.managedValues
    ? Object.fromEntries(Object.entries(metadata.managedValues).filter(([field]) => !excluded.has(field)))
    : undefined;
  return {
    ...metadata,
    managedFields,
    ...(managedValues ? { managedValues } : {}),
  };
}

function isProvisionalProviderOnly(provider: PiProvider | undefined): boolean {
  return provider?._piModelDoctor?.endpointNormalizationPending === true && getModels(provider).length === 0;
}

function isPendingEndpointAutoRepair(provider: PiProvider): boolean {
  const metadata = provider._piModelDoctor;
  if (metadata?.endpointNormalizationPending !== true || typeof metadata.endpointValueHint !== "string") return false;
  if (isPendingEndpointChanged(provider) || isPendingApiChanged(provider)) return false;
  return typeof provider.baseUrl === "string" && provider.baseUrl === metadata.endpointValueHint;
}

function isPendingApiAutoRepair(provider: PiProvider, model?: PiModel): boolean {
  const metadata = provider._piModelDoctor;
  if (metadata?.endpointNormalizationPending !== true || metadata.endpointApiExplicit === true || !isPiApi(metadata.endpointApiHint)) return false;
  if (isPendingApiChanged(provider)) return false;
  if (!isPiApi(provider.api) || provider.api !== metadata.endpointApiHint) return false;
  if (model && isPiApi(model.api) && (!hasDoctorMetadata(model) || model._piModelDoctor.managedFields?.includes("api") !== true)) return false;
  return true;
}

function isPendingEndpointChanged(provider: PiProvider): boolean {
  const metadata = provider._piModelDoctor;
  return (metadata?.endpointNormalizationPending === true || metadata?.endpointNormalizationBlocked === true)
    && typeof metadata.endpointValueHint === "string"
    && provider.baseUrl !== metadata.endpointValueHint;
}

function isPendingApiChanged(provider: PiProvider): boolean {
  const metadata = provider._piModelDoctor;
  return (metadata?.endpointNormalizationPending === true || metadata?.endpointApiNormalizationBlocked === true)
    && isPiApi(metadata.endpointApiHint)
    && provider.api !== metadata.endpointApiHint;
}

function isAutoEndpointNormalization(inferred: string | undefined, normalized: string | undefined, api: PiApi | undefined): boolean {
  if (!inferred || !normalized || inferred === normalized) return false;
  if (api !== "openai-completions" && api !== "openai-responses") return false;
  return normalizeEndpointIdentity(withoutOpenAiVersionPath(inferred)) === normalizeEndpointIdentity(withoutOpenAiVersionPath(normalized));
}

function mismatchCode(field: string): FindingCode {
  switch (field) {
    case "api": return "api-mismatch";
    case "name": return "metadata-stale";
    case "input": return "input-mismatch";
    case "cost": return "cost-mismatch";
    case "reasoning":
    case "thinkingLevelMap": return "reasoning-mismatch";
    case "compat": return "cache-mismatch";
    default: return "cache-mismatch";
  }
}

function mergeModel(providerId: string, existing: PiModel, desired: PiModel, changes: Change[], conflicts: Finding[], now: Date, options: { preserveTransport?: boolean } = {}): void {
  const managedFields: string[] = [];
  const removedFields = new Set<string>();
  for (const field of ["name", "api", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"] as const) {
    if (options.preserveTransport && field === "api") continue;
    const value = desired[field];
    if (value === undefined) {
      if (field in existing && canManageField(existing, field)) {
        changes.push({ path: `model.${existing.id}.${field}`, before: existing[field], after: undefined, reason: `Remove stale ${field} from models.dev`, ownership: "managed" });
        delete (existing as Record<string, unknown>)[field];
        removedFields.add(field);
      }
      continue;
    }
    if (canManageField(existing, field)) {
      managedFields.push(field);
      if (!jsonEqual(existing[field], value)) {
        changes.push({ path: `model.${existing.id}.${field}`, before: existing[field], after: value, reason: `Sync ${field} from models.dev`, ownership: "managed" });
        (existing as Record<string, unknown>)[field] = cloneJson(value);
      }
    } else if (!jsonEqual(existing[field], value)) {
      conflicts.push(finding(field === "contextWindow" ? "context-window-mismatch" : field === "maxTokens" ? "max-tokens-mismatch" : mismatchCode(field), "warning", `${providerId}/${existing.id}`, `Preserved user-owned model ${field}`, false, true));
    }
  }
  if (managedFields.length > 0 || removedFields.size > 0 || hasDoctorMetadata(existing)) {
    const previous = hasDoctorMetadata(existing) ? cloneJson(existing._piModelDoctor) : undefined;
    let next = buildMetadata(previous, { source: "models.dev", lastCheck: now.toISOString(), autoRepair: true, providerId, modelId: existing.id }, managedFields, Object.fromEntries(managedFields.map((field) => [field, existing[field]])));
    for (const field of removedFields) {
      next.managedFields = (next.managedFields ?? []).filter((managedField) => managedField !== field);
      if (next.managedValues) delete next.managedValues[field];
    }
    if (options.preserveTransport) next = withoutManagedFields(next, ["api"]);
    if (!jsonEqual(previous, next)) {
      existing._piModelDoctor = next;
      changes.push({ path: `model.${existing.id}._piModelDoctor`, before: previous, after: next, reason: "Record model ownership metadata", ownership: "managed" });
    }
  }
}

function applyRepairPlan(config: PiModelsJson, target: string, catalog: ModelsDevCatalog, findings: Finding[], now: Date, source: string, policy: PolicyCatalog): ChangePlan {
  const selected = parseTarget(target, true);
  const providers = getProviders(config);
  const providerEntry = findConfiguredProviderById(providers, selected.providerId);
  const provider = providerEntry?.provider;
  const providerId = providerEntry?.id ?? selected.providerId;
  if (!provider) return { target, changes: [], conflicts: findings.filter((item) => !item.repairable), warnings: [] };
  const model = getModels(provider).find((item) => item.id === selected.modelId);
  if (!model) return { target, changes: [], conflicts: findings.filter((item) => !item.repairable), warnings: [] };
  const match = findConfiguredMatch(catalog, providerId, provider.baseUrl, model, provider.name);
  if (!match?.model || match.ambiguous) return { target, changes: [], conflicts: findings.filter((item) => !item.repairable), warnings: [] };
  if (findings.some((item) => item.code === "deprecated-model")) {
    return { target, changes: [], conflicts: findings.filter((item) => item.code === "deprecated-model" || !item.repairable), warnings: ["Deprecated models are never automatically repaired."] };
  }
  const metadataOnly = match.metadataOnly === true;
  const pendingEndpointAutoRepair = isPendingEndpointAutoRepair(provider);
  const pendingApiAutoRepair = isPendingApiAutoRepair(provider, model);
  const pendingEndpointChanged = isPendingEndpointChanged(provider);
  const pendingApiChanged = isPendingApiChanged(provider);
  const transportOwned = metadataOnly || model.compat?.transportOwned === true || provider._piModelDoctor?.endpointNormalizationPending === true;
  const catalogEndpoint = inferProviderEndpoint(match.provider);
  const channelEndpoint = model.baseUrl ?? provider.baseUrl;
  const channelApi = transportOwned
    ? detectConfiguredChannelApi(provider, model, channelEndpoint, match.provider)
    : detectPiApi(match.provider, provider.baseUrl ?? catalogEndpoint);
  const endpointApi = endpointApiForModel(match.provider, channelEndpoint, channelApi);
  const desiredEndpoint = transportOwned && pendingEndpointAutoRepair
    ? normalizeEndpointForApi(channelEndpoint, endpointApi)
    : transportOwned
      ? channelEndpoint
      : catalogEndpoint;
  const desired = toPiModel(match.provider, match.model, {
    endpoint: transportOwned ? desiredEndpoint : provider.baseUrl ?? desiredEndpoint,
    api: channelApi,
    providerId,
    adapterProviderId: transportOwned ? adapterIdForPiApi(channelApi) : undefined,
    metadataOnly,
    transportOwned,
    now,
    sourceName: source,
    policy,
  });
  const changes: Change[] = [];
  const conflicts = findings.filter((item) => item.userOwned && !item.repairable);
  const providerMetadataBefore = hasDoctorMetadata(provider) ? cloneJson(provider._piModelDoctor) : undefined;
  const autoEndpointRepair = transportOwned
    && pendingEndpointAutoRepair
    && isAutoEndpointNormalization(channelEndpoint, desiredEndpoint, endpointApi);
  const autoApiRepair = pendingApiAutoRepair && provider.api !== channelApi;
  const modelMetadataBefore = hasDoctorMetadata(model) ? cloneJson(model._piModelDoctor) : undefined;
  const providerChangedFields = new Set<string>();
  const modelChangedFields = new Set<string>();
  const removedModelFields = new Set<string>();
  const desiredProviderName = match.provider.name;
  if (desiredProviderName !== undefined && !transportOwned) {
    if (canManageField(provider, "name")) {
      if (provider.name !== desiredProviderName) {
        changes.push({ path: `providers.${providerId}.name`, before: provider.name, after: desiredProviderName, reason: "Repair provider name", ownership: "managed" });
        provider.name = desiredProviderName;
        providerChangedFields.add("name");
      }
    } else if (provider.name !== desiredProviderName) {
      conflicts.push(finding("metadata-stale", "info", target, "User-owned provider name differs from models.dev; not overwritten", false, true));
    }
  }
  for (const field of ["name", "api", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"] as const) {
    const value = desired[field];
    if (value === undefined) {
      if (field in model && canManageField(model, field)) {
        changes.push({ path: `providers.${providerId}.models[${selected.modelId}].${field}`, before: model[field], after: undefined, reason: `Remove stale ${field} from models.dev`, ownership: "managed" });
        delete (model as Record<string, unknown>)[field];
        modelChangedFields.add(field);
        removedModelFields.add(field);
      }
      continue;
    }
    if (transportOwned && field === "api") continue;
    if (canManageField(model, field)) {
      if (!jsonEqual(model[field], value)) {
        changes.push({ path: `providers.${providerId}.models[${selected.modelId}].${field}`, before: model[field], after: value, reason: `Repair ${field} from models.dev`, ownership: "managed" });
        (model as Record<string, unknown>)[field] = cloneJson(value);
        modelChangedFields.add(field);
      }
    } else if (!jsonEqual(model[field], value)) {
      conflicts.push(finding(field === "contextWindow" ? "context-window-mismatch" : field === "maxTokens" ? "max-tokens-mismatch" : mismatchCode(field), "warning", target, `User-owned ${field} differs from models.dev; not overwritten`, false, true));
    }
  }
  if (transportOwned && pendingEndpointChanged && !conflicts.some((item) => item.code === "endpoint-mismatch" && item.userOwned === true)) {
    conflicts.push(finding("endpoint-mismatch", "warning", target, "Provider-only endpoint was changed after setup; the user-owned endpoint was preserved", false, true));
  }
  if (transportOwned && autoEndpointRepair && provider.baseUrl !== desiredEndpoint) {
    changes.push({ path: `providers.${providerId}.baseUrl`, before: provider.baseUrl, after: desiredEndpoint, reason: "Normalize provider-only endpoint for resolved model API", ownership: "managed" });
    provider.baseUrl = desiredEndpoint;
    providerChangedFields.add("baseUrl");
  } else if (!transportOwned && canManageField(provider, "baseUrl")) {
    if (desiredEndpoint && provider.baseUrl !== desiredEndpoint) {
      changes.push({ path: `providers.${providerId}.baseUrl`, before: provider.baseUrl, after: desiredEndpoint, reason: "Repair provider endpoint", ownership: "managed" });
      provider.baseUrl = desiredEndpoint;
      providerChangedFields.add("baseUrl");
    }
  } else if (!transportOwned && desiredEndpoint && provider.baseUrl !== desiredEndpoint) {
    conflicts.push(finding("endpoint-mismatch", "warning", target, "User-owned endpoint differs from models.dev; not overwritten", false, true));
  }
  if (pendingApiAutoRepair && autoApiRepair) {
    changes.push({ path: `providers.${providerId}.api`, before: provider.api, after: channelApi, reason: "Normalize channel API for resolved model metadata", ownership: "managed" });
    provider.api = channelApi;
    providerChangedFields.add("api");
  } else if (!transportOwned && canManageField(provider, "api")) {
    const expectedApi = detectPiApi(match.provider, provider.baseUrl ?? desiredEndpoint);
    if (provider.api !== expectedApi) {
      changes.push({ path: `providers.${providerId}.api`, before: provider.api, after: expectedApi, reason: "Repair API protocol", ownership: "managed" });
      provider.api = expectedApi;
      providerChangedFields.add("api");
    }
  }
  const providerManagedFields = new Set(providerMetadataBefore?.managedFields ?? []);
  for (const field of providerChangedFields) providerManagedFields.add(field);
  if (transportOwned) {
    for (const field of ["name", "baseUrl", "api"]) providerManagedFields.delete(field);
  }
  const providerMetadataNeedsUpdate = providerChangedFields.size > 0
    || autoEndpointRepair
    || providerMetadataBefore?.endpointNormalizationPending === true
    || transportOwned && ["name", "baseUrl", "api"].some((field) => providerMetadataBefore?.managedFields?.includes(field));
  if (providerMetadataNeedsUpdate) {
    let providerMetadataAfter = buildMetadata(providerMetadataBefore, {
      source,
      lastCheck: now.toISOString(),
      autoRepair: true,
      providerId,
      endpointNormalizationPending: false,
      endpointApiExplicit: providerMetadataBefore?.endpointApiExplicit ?? false,
      endpointValueHint: pendingEndpointChanged || providerMetadataBefore?.endpointNormalizationBlocked === true ? providerMetadataBefore?.endpointValueHint : undefined,
      endpointNormalizationBlocked: pendingEndpointChanged || providerMetadataBefore?.endpointNormalizationBlocked === true,
      endpointApiNormalizationBlocked: pendingApiChanged || providerMetadataBefore?.endpointApiNormalizationBlocked === true,
    }, [...providerManagedFields], managedSnapshotValues(provider, providerManagedFields, providerMetadataBefore, providerChangedFields));
    if (transportOwned) providerMetadataAfter = withoutManagedFields(providerMetadataAfter, ["name", "baseUrl", "api"]);
    if (!jsonEqual(providerMetadataBefore, providerMetadataAfter)) {
      provider._piModelDoctor = providerMetadataAfter;
      changes.push({ path: `providers.${providerId}._piModelDoctor`, before: providerMetadataBefore, after: providerMetadataAfter, reason: "Record provider ownership metadata", ownership: "managed" });
    }
  }
  const managedFields = new Set(modelMetadataBefore?.version === MODEL_DOCTOR_VERSION ? modelMetadataBefore.managedFields ?? [] : []);
  for (const field of modelChangedFields) {
    if (!removedModelFields.has(field)) managedFields.add(field);
  }
  for (const field of removedModelFields) managedFields.delete(field);
  if (transportOwned) managedFields.delete("api");
  const metadataNeedsUpdate = findings.some((item) => item.code === "metadata-missing" || item.code === "metadata-stale" || item.code === "metadata-version")
    || (modelMetadataBefore !== undefined && (
      modelMetadataBefore.version !== MODEL_DOCTOR_VERSION || modelMetadataBefore.source !== source
    ))
    || transportOwned && modelMetadataBefore?.managedFields?.includes("api") === true
    || modelChangedFields.size > 0;
  if (metadataNeedsUpdate) {
    let nextMetadata = buildMetadata(modelMetadataBefore, {
      source,
      lastCheck: now.toISOString(),
      autoRepair: true,
      providerId,
      modelId: selected.modelId,
    }, [...managedFields], managedSnapshotValues(model, managedFields, modelMetadataBefore, modelChangedFields));
    for (const field of removedModelFields) {
      nextMetadata.managedFields = (nextMetadata.managedFields ?? []).filter((managedField) => managedField !== field);
      if (nextMetadata.managedValues) delete nextMetadata.managedValues[field];
    }
    if (transportOwned) nextMetadata = withoutManagedFields(nextMetadata, ["api"]);
    model._piModelDoctor = nextMetadata;
    if (!jsonEqual(modelMetadataBefore, nextMetadata)) changes.push({ path: `providers.${providerId}.models[${selected.modelId}]._piModelDoctor`, before: modelMetadataBefore, after: nextMetadata, reason: "Record model ownership metadata", ownership: "managed" });
  }
  return sanitizePlan({ target, changes, conflicts, warnings: [] });
}

function sanitizePlan(plan: ChangePlan): ChangePlan {
  return {
    target: redactSensitiveText(plan.target),
    changes: plan.changes.map((change) => ({
      ...change,
      before: redactPlanValue(change.before, change.path),
      after: redactPlanValue(change.after, change.path),
      reason: redactSensitiveText(change.reason),
    })),
    conflicts: plan.conflicts,
    warnings: plan.warnings.map((warning) => redactSensitiveText(warning)),
  };
}

function redactPlanValue(value: unknown, field?: string): unknown {
  if (field && isSensitiveFieldName(field)) return "[redacted]";
  if (typeof value === "string") return looksLikeCredentialValue(value) ? "[redacted]" : redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactPlanValue(item));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactPlanValue(child, key)]));
  return value;
}

function checkModel(providerId: string, provider: PiProvider, model: PiModel, sourceProvider: ModelsDevProvider, sourceModel: ModelsDevModel | undefined, policy: PolicyCatalog, metadataOnly = false): Finding[] {
  const target = `${providerId}/${model.id}`;
  const findings: Finding[] = [];
  if (!sourceModel) {
    findings.push(finding("missing-model", "warning", target, `No models.dev metadata found for ${target}`, false));
    return findings;
  }
  const pendingEndpointAutoRepair = isPendingEndpointAutoRepair(provider);
  const pendingApiAutoRepair = isPendingApiAutoRepair(provider, model);
  const pendingEndpointChanged = isPendingEndpointChanged(provider);
  const pendingApiChanged = isPendingApiChanged(provider);
  const transportOwned = metadataOnly || model.compat?.transportOwned === true || provider._piModelDoctor?.endpointNormalizationPending === true;
  const expectedEndpoint = inferProviderEndpoint(sourceProvider);
  const effectiveEndpoint = provider.baseUrl ?? expectedEndpoint;
  const channelEndpoint = model.baseUrl ?? effectiveEndpoint;
  const expectedApi = transportOwned
    ? detectConfiguredChannelApi(provider, model, channelEndpoint, sourceProvider)
    : detectPiApi(sourceProvider, effectiveEndpoint);
  const endpointApi = endpointApiForModel(sourceProvider, channelEndpoint, expectedApi);
  const normalizedChannelEndpoint = transportOwned && pendingEndpointAutoRepair
    ? normalizeEndpointForApi(channelEndpoint, endpointApi)
    : channelEndpoint;
  const endpointNormalizationPending = transportOwned
    && pendingEndpointAutoRepair
    && isAutoEndpointNormalization(channelEndpoint, normalizedChannelEndpoint, endpointApi);
  const expectedModel = toPiModel(sourceProvider, sourceModel, {
    endpoint: transportOwned ? normalizedChannelEndpoint : effectiveEndpoint,
    api: expectedApi,
    adapterProviderId: transportOwned ? adapterIdForPiApi(expectedApi) : undefined,
    metadataOnly,
    transportOwned,
    policy,
  });
  const transportApiMismatch = transportOwned
    && isPiApi(provider.api)
    && isPiApi(expectedApi)
    && provider.api !== expectedApi;
  if ((!transportOwned || transportApiMismatch) && provider.api !== expectedApi) {
    const repairable = pendingApiAutoRepair || !transportOwned && canManageField(provider, "api");
    findings.push(finding("api-mismatch", "warning", target, `Configured provider API is ${provider.api ?? "unset"}; expected ${expectedApi}`, repairable, !repairable));
  }
  if (!transportOwned && expectedEndpoint && provider.baseUrl !== expectedEndpoint) {
    const repairable = canManageField(provider, "baseUrl");
    findings.push(finding("endpoint-mismatch", "warning", target, `Configured endpoint is ${provider.baseUrl ?? "unset"}; models.dev expects ${expectedEndpoint}`, repairable, !repairable));
  } else if (metadataOnly) {
    findings.push(finding("third-party-channel", "info", target, `Using ${sourceProvider.id}/${sourceModel.id} from models.dev as model metadata only; the configured channel endpoint, protocol, headers, and authentication are authoritative`, false));
  }
  if (pendingEndpointChanged) {
    findings.push(finding("endpoint-mismatch", "warning", target, "Provider-only endpoint was changed after setup; the user-owned endpoint was preserved", false, true));
  }
  if (pendingApiChanged || provider._piModelDoctor?.endpointApiNormalizationBlocked === true) {
    findings.push(finding("api-mismatch", "warning", target, "Provider-only API protocol was changed after setup; the user-owned API was preserved", false, true));
  }
  if (endpointNormalizationPending) {
    findings.push(finding("endpoint-mismatch", "warning", target, `Provider-only root endpoint will be normalized to ${normalizedChannelEndpoint} for the resolved ${endpointApi} API`, true));
  }
  if (!transportOwned && model.baseUrl !== undefined && effectiveEndpoint !== undefined && model.baseUrl !== effectiveEndpoint) {
    findings.push(finding("endpoint-mismatch", "warning", target, "Model-specific endpoint override differs from the effective provider endpoint; it was preserved", false, true));
  }
  if (sourceModel.status === "deprecated" || sourceModel.deprecated === true) findings.push(finding("deprecated-model", "warning", target, "models.dev marks this model as deprecated", false));
  if (!transportOwned && sourceProvider.name !== undefined && provider.name !== sourceProvider.name) {
    const repairable = canManageField(provider, "name");
    findings.push(finding("metadata-stale", "info", target, `Provider name is ${provider.name ?? "unset"}; models.dev says ${sourceProvider.name}`, repairable, !repairable, "models.dev", "medium"));
  }
  if (model.id !== sourceModel.id) findings.push(finding("model-id-mismatch", "warning", target, `Configured model id ${model.id} does not match metadata id ${sourceModel.id}`, false, true));
  if (sourceModel.name !== undefined && model.name !== sourceModel.name) {
    findings.push(finding("metadata-stale", "info", target, `Model name is ${model.name ?? "unset"}; models.dev says ${sourceModel.name}`, canManageField(model, "name"), !canManageField(model, "name")));
  }
  if (sourceModel.limit?.context !== undefined && sourceModel.limit.context > 0 && model.contextWindow !== sourceModel.limit.context) findings.push(finding("context-window-mismatch", "warning", target, `Context window is ${model.contextWindow ?? "unset"}; models.dev says ${sourceModel.limit.context}`, canManageField(model, "contextWindow"), !canManageField(model, "contextWindow")));
  if (sourceModel.limit?.output !== undefined && sourceModel.limit.output > 0 && model.maxTokens !== sourceModel.limit.output) findings.push(finding("max-tokens-mismatch", "warning", target, `Max tokens is ${model.maxTokens ?? "unset"}; models.dev says ${sourceModel.limit.output}`, canManageField(model, "maxTokens"), !canManageField(model, "maxTokens")));
  if (hasCostMetadata(sourceModel) && !jsonEqual(model.cost, expectedModel.cost)) {
    findings.push(finding("cost-mismatch", "warning", target, "Model pricing differs from models.dev metadata", canManageField(model, "cost"), !canManageField(model, "cost")));
  }
  const expectedReasoning = resolveReasoning(sourceProvider, sourceModel);
  if (!transportOwned && model.api !== expectedApi) {
    const repairable = canManageField(model, "api");
    findings.push(finding("api-mismatch", "warning", target, `Configured model API is ${model.api ?? "unset"}; expected ${expectedApi}`, repairable, !repairable));
  }
  if (expectedModel.input && !jsonEqual(model.input, expectedModel.input)) {
    const repairable = canManageField(model, "input");
    findings.push(finding("input-mismatch", "warning", target, `Configured input modalities are ${model.input?.join(", ") ?? "unset"}; models.dev expects ${expectedModel.input.join(", ")}`, repairable, !repairable));
  }
  if (model.reasoning !== expectedReasoning.supported) findings.push(finding("reasoning-mismatch", "warning", target, `Reasoning is ${model.reasoning ? "enabled" : "disabled"}; metadata says ${expectedReasoning.supported ? "enabled" : "disabled"}`, canManageField(model, "reasoning"), !canManageField(model, "reasoning")));
  if (!jsonEqual(model.thinkingLevelMap, expectedModel.thinkingLevelMap)) {
    findings.push(finding("reasoning-mismatch", "warning", target, "Thinking level mapping differs from models.dev reasoning policy", canManageField(model, "thinkingLevelMap"), !canManageField(model, "thinkingLevelMap")));
  }
  const expectedCompat = expectedModel.compat;
  if (expectedCompat && !jsonEqual(model.compat, expectedCompat)) {
    const reasoningChanged = compatReasoningDiffers(model.compat, expectedCompat);
    const cacheChanged = compatCacheDiffers(model.compat, expectedCompat);
    if (reasoningChanged) findings.push(finding("reasoning-mismatch", "warning", target, "Reasoning compatibility metadata differs from models.dev policy", canManageField(model, "compat"), !canManageField(model, "compat")));
    if (cacheChanged || !reasoningChanged) findings.push(finding("cache-mismatch", "warning", target, "Cache/reasoning compatibility metadata differs from models.dev policy", canManageField(model, "compat"), !canManageField(model, "compat")));
  }
  if (expectedCompat?.reasoningFallback || (expectedCompat?.reasoningWarnings?.length ?? 0) > 0 || (expectedCompat?.cacheWarnings?.length ?? 0) > 0) {
    findings.push(finding("capability-fallback", "warning", target, "Provider-specific capability behavior is represented as compatibility policy or warning metadata", false));
  }
  checkHeaders(provider, model, transportOwned ? { ...sourceProvider, required_headers: [] } : sourceProvider, transportOwned ? { ...sourceModel, required_headers: [] } : sourceModel, target, findings);
  if (!hasDoctorMetadata(model)) findings.push(finding("metadata-missing", "info", target, "Model has no Pi Model Doctor ownership metadata", true));
  else if (model._piModelDoctor.source !== "models.dev") findings.push(finding("metadata-stale", "info", target, `Metadata source is ${model._piModelDoctor.source}`, true));
  if (hasDoctorMetadata(model) && model._piModelDoctor.version !== MODEL_DOCTOR_VERSION) findings.push(finding("metadata-version", "info", target, `Metadata version ${model._piModelDoctor.version ?? "unknown"} needs refresh`, true));
  if (model.compat?.capabilityPolicyVersion !== policy.schemaVersion) findings.push(finding("policy-stale", "info", target, `Capability policy version ${model.compat?.capabilityPolicyVersion ?? "unknown"} differs from ${policy.schemaVersion}`, true));
  return findings;
}

function checkLocalModel(providerId: string, provider: PiProvider, model: PiModel, policy: PolicyCatalog): Finding[] {
  const target = `${providerId}/${model.id}`;
  const findings: Finding[] = [];
  if (model.compat?.metadataOnly === true) {
    const metadataProvider = typeof model.compat.metadataProviderId === "string" ? model.compat.metadataProviderId : "models.dev";
    findings.push(finding("third-party-channel", "info", target, `Using ${metadataProvider} model metadata only; the configured channel endpoint, protocol, headers, and authentication are authoritative`, false));
  }
  const providerHeaders = provider.headers ?? {};
  const modelHeaders = model.headers ?? {};
  const providerKeys = Object.keys(providerHeaders);
  const modelKeys = Object.keys(modelHeaders);
  const configured = new Set([
    ...providerKeys.filter((key) => hasHeaderValue(providerHeaders, key)),
    ...modelKeys.filter((key) => hasHeaderValue(modelHeaders, key)),
  ].map((key) => key.toLowerCase()));
  if (providerKeys.some((key) => hasHeaderValue(providerHeaders, key))) findings.push(finding("provider-headers-present", "info", target, "Provider headers are configured and will be preserved", false));
  if (modelKeys.some((key) => hasHeaderValue(modelHeaders, key))) findings.push(finding("model-headers-present", "info", target, "Model headers are configured and will be preserved", false));
  for (const providerKey of providerKeys) {
    const modelKey = modelKeys.find((key) => key.toLowerCase() === providerKey.toLowerCase());
    if (modelKey && !sameHeaderValue(providerHeaders, providerKey, modelHeaders, modelKey)) {
      findings.push(finding("header-mismatch", "warning", target, `Provider and model headers differ for ${providerKey.toLowerCase()}; user values were preserved`, false, true));
    }
  }
  if (configured.size > 0) findings.push(finding("headers-preserved", "info", target, "Custom provider/model headers are present and will be preserved", false));
  if (!hasDoctorMetadata(model)) findings.push(finding("metadata-missing", "info", target, "Model has no Pi Model Doctor ownership metadata", true));
  else if (model._piModelDoctor.source !== "models.dev") findings.push(finding("metadata-stale", "info", target, `Metadata source is ${model._piModelDoctor.source}`, true));
  if (hasDoctorMetadata(model) && model._piModelDoctor.version !== MODEL_DOCTOR_VERSION) findings.push(finding("metadata-version", "info", target, `Metadata version ${model._piModelDoctor.version ?? "unknown"} needs refresh`, true));
  if (model.compat?.capabilityPolicyVersion !== policy.schemaVersion) findings.push(finding("policy-stale", "info", target, `Capability policy version ${model.compat?.capabilityPolicyVersion ?? "unknown"} differs from ${policy.schemaVersion}`, true));
  return findings;
}

function checkHeaders(provider: PiProvider, model: PiModel, sourceProvider: ModelsDevProvider, sourceModel: ModelsDevModel, target: string, findings: Finding[]): void {
  const providerHeaders = provider.headers ?? {};
  const modelHeaders = model.headers ?? {};
  const providerKeys = Object.keys(providerHeaders);
  const modelKeys = Object.keys(modelHeaders);
  const configured = new Set([
    ...providerKeys.filter((key) => hasHeaderValue(providerHeaders, key)),
    ...modelKeys.filter((key) => hasHeaderValue(modelHeaders, key)),
  ].map((key) => key.toLowerCase()));
  const required = new Set([...(sourceProvider.required_headers ?? []), ...(sourceModel.required_headers ?? [])].map((key) => key.toLowerCase()));
  if (providerKeys.some((key) => hasHeaderValue(providerHeaders, key))) findings.push(finding("provider-headers-present", "info", target, "Provider headers are configured and will be preserved", false));
  if (modelKeys.some((key) => hasHeaderValue(modelHeaders, key))) findings.push(finding("model-headers-present", "info", target, "Model headers are configured and will be preserved", false));
  for (const header of required) {
    if (!configured.has(header) && !isSatisfiedByProviderAuth(header, provider)) {
      findings.push(finding("header-missing", "warning", target, `Required header ${header} is not configured`, false));
    }
  }
  for (const providerKey of providerKeys) {
    const modelKey = modelKeys.find((key) => key.toLowerCase() === providerKey.toLowerCase());
    if (modelKey && !sameHeaderValue(providerHeaders, providerKey, modelHeaders, modelKey)) {
      findings.push(finding("header-mismatch", "warning", target, `Provider and model headers differ for ${providerKey.toLowerCase()}; user values were preserved`, false, true));
    }
  }
  if (configured.size > 0) findings.push(finding("headers-preserved", "info", target, "Custom provider/model headers are present and will be preserved", false));
}

function finding(
  code: FindingCode,
  severity: Finding["severity"],
  target: string,
  message: string,
  repairable: boolean,
  userOwned = false,
  source?: string,
  confidence?: Finding["confidence"],
): Finding {
  const evidenceSource = source ?? findingSource(code);
  const evidenceConfidence = confidence ?? findingConfidence(code, userOwned);
  return {
    code,
    severity,
    target: redactSensitiveText(target),
    message: redactSensitiveText(message),
    repairable,
    userOwned,
    ...(evidenceSource ? { source: evidenceSource } : {}),
    ...(evidenceConfidence ? { confidence: evidenceConfidence } : {}),
  };
}

function findingSource(code: FindingCode): string | undefined {
  if ([
    "endpoint-mismatch",
    "api-mismatch",
    "model-id-mismatch",
    "deprecated-model",
    "context-window-mismatch",
    "max-tokens-mismatch",
    "input-mismatch",
    "cost-mismatch",
    "cache-mismatch",
    "reasoning-mismatch",
    "capability-fallback",
    "policy-stale",
    "network-unavailable",
    "header-missing",
  ].includes(code)) return "models.dev";
  if (["headers-preserved", "provider-headers-present", "model-headers-present", "header-mismatch", "invalid-config", "metadata-missing", "metadata-version", "third-party-channel"].includes(code)) return "models.json";
  if (["selection-required", "model-selection-required", "authorization-required"].includes(code)) return "command";
  if (code === "migration-conflict") return "migration";
  return undefined;
}

function findingConfidence(code: FindingCode, userOwned: boolean): Finding["confidence"] {
  if (userOwned || code === "capability-fallback" || code === "network-unavailable" || code === "selection-required" || code === "model-selection-required") return "low";
  return "high";
}

function chooseMatch(catalog: ModelsDevCatalog, target: string, modelId?: string, metadataProvider?: string, allowGlobalMetadata = false): ProviderMatch | undefined {
  const providerMatches = ModelsDevClient.match(catalog, target, undefined, { allowPartialProvider: false });
  const providerMatch = providerMatches.find((match) => match.matchedBy.some((value) => value === "provider-id-or-name" || value === "api-url"));
  if (providerMatch && modelId) {
    const modelMatches = ModelsDevClient.match(catalog, target, modelId, { allowPartialProvider: false, allowPartialModel: false });
    const bestScore = modelMatches[0]?.score ?? 0;
    const bestMatches = modelMatches.filter((match) => match.score === bestScore);
    if (bestMatches.length > 1) {
      return {
        provider: bestMatches[0].provider,
        score: bestScore,
        matchedBy: [...new Set(bestMatches.flatMap((match) => match.matchedBy)), "model-ambiguous"],
        ambiguous: true,
      };
    }
    return bestMatches[0] ?? providerMatch;
  }
  const matches = ModelsDevClient.match(catalog, target, modelId, { allowPartialProvider: false, allowPartialModel: false });
  if (matches.length === 0 && allowGlobalMetadata && modelId) {
    return ModelsDevClient.findGlobalModel(catalog, modelId, metadataProvider);
  }
  const bestScore = matches[0]?.score ?? 0;
  const bestMatches = matches.filter((match) => match.score === bestScore);
  if (bestMatches.length > 1) {
    return {
      provider: bestMatches[0].provider,
      score: bestScore,
      matchedBy: [...new Set(bestMatches.flatMap((match) => match.matchedBy)), "model-ambiguous"],
      ambiguous: true,
    };
  }
  return bestMatches[0];
}

function findConfiguredMatch(
  catalog: ModelsDevCatalog,
  providerId: string,
  endpoint: string | undefined,
  model: PiModel,
  providerName?: string,
): ProviderMatch | undefined {
  // A metadata-only model deliberately decouples catalog ownership from the
  // configured channel id. This matters when a custom channel happens to use
  // a provider id such as `openai` or `google`: direct provider lookup would
  // otherwise silently treat the channel as the official catalog provider.
  const metadataOnly = model.compat?.metadataOnly === true;
  const metadataProvider = typeof model.compat?.metadataProviderId === "string"
    ? model.compat.metadataProviderId
    : undefined;
  if (metadataOnly) {
    const globalById = ModelsDevClient.findGlobalModel(catalog, model.id, metadataProvider);
    if (globalById) return globalById;
    if (model.name && model.name !== model.id) {
      const globalByName = ModelsDevClient.findGlobalModel(catalog, model.name, metadataProvider);
      if (globalByName) return globalByName;
    }
    return undefined;
  }
  const allowProviderName = endpoint === undefined;
  const direct = ModelsDevClient.findForConfig(catalog, providerId, endpoint, model.id)
    ?? (allowProviderName && providerName ? ModelsDevClient.findForConfig(catalog, providerName, endpoint, model.id) : undefined);
  if (direct?.ambiguous) return direct;
  if (direct?.model) return direct;
  const providerMatch = ModelsDevClient.findForConfig(catalog, providerId, endpoint)
    ?? (allowProviderName && providerName ? ModelsDevClient.findForConfig(catalog, providerName, endpoint) : undefined);
  if (providerMatch?.ambiguous) return providerMatch;
  const provider = providerMatch?.provider;
  if (provider) {
    const normalizedId = normalizeIdentifier(model.id);
    const exactIds = Object.values(provider.models).filter((candidate) => normalizeIdentifier(candidate.id) === normalizedId);
    if (exactIds.length === 1) return { provider, model: exactIds[0], score: 101, matchedBy: ["provider-id", "configured-model-id"] };
    if (exactIds.length > 1) return { provider, score: 0, matchedBy: ["provider-id", "model-ambiguous"], ambiguous: true };
    if (model.name) {
      const normalizedName = normalizeIdentifier(model.name);
      const exactNames = Object.values(provider.models).filter((candidate) => typeof candidate.name === "string" && normalizeIdentifier(candidate.name) === normalizedName);
      if (exactNames.length === 1) return { provider, model: exactNames[0], score: 100, matchedBy: ["provider-id", "configured-model-name"] };
      if (exactNames.length > 1) return { provider, score: 0, matchedBy: ["provider-id", "model-ambiguous"], ambiguous: true };
    }
    return undefined;
  }
  // An existing catalog provider identity is authoritative. A global model
  // match is reserved for channels whose provider is not represented by the
  // catalog; otherwise an official provider could accidentally borrow a model
  // with the same id from another provider.
  if (providerMatch?.provider) return undefined;
  const endpointMatches = endpoint
    ? ModelsDevClient.match(catalog, endpoint, model.id, { allowPartialProvider: false, allowPartialModel: false })
    : [];
  const endpointModels = endpointMatches.filter((match) => match.model);
  if (endpointMatches.some((match) => match.ambiguous)) {
    const ambiguous = endpointMatches.find((match) => match.ambiguous);
    if (ambiguous) return ambiguous;
  }
  if (endpointModels.length === 1) return endpointModels[0];
  if (endpointModels.length > 1) {
    return { provider: endpointModels[0].provider, score: 0, matchedBy: ["api-url", "model-ambiguous"], ambiguous: true };
  }
  // A third-party channel may have no provider record in models.dev. In that
  // case use an exact, unique model-id/name match only as metadata; transport
  // fields remain owned by the configured channel. An explicit metadata
  // provider recorded by a prior add disambiguates duplicate model ids.
  const globalById = ModelsDevClient.findGlobalModel(catalog, model.id, metadataProvider);
  if (globalById) return globalById;
  if (model.name && model.name !== model.id) {
    const globalByName = ModelsDevClient.findGlobalModel(catalog, model.name, metadataProvider);
    if (globalByName) return globalByName;
  }
  return undefined;
}

function managedSnapshotValues(value: Record<string, unknown>, fields: Set<string>, previous: DoctorMetadata | undefined, changedFields: Set<string>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of fields) {
    if (!(field in value) || value[field] === undefined) continue;
    if (changedFields.has(field) || canManageField(value, field)) snapshot[field] = cloneJson(value[field]);
    else if (previous?.managedValues && field in previous.managedValues) snapshot[field] = cloneJson(previous.managedValues[field]);
  }
  return snapshot;
}

function isPiApi(value: unknown): value is PiApi {
  return value === "openai-completions"
    || value === "openai-responses"
    || value === "anthropic-messages"
    || value === "google-generative-ai";
}

function detectConfiguredChannelApi(provider: PiProvider, model: PiModel, endpoint?: string, metadataProvider?: ModelsDevProvider): PiApi {
  const metadata = provider._piModelDoctor;
  const pendingInference = metadata?.endpointNormalizationPending === true && metadata.endpointApiExplicit !== true;
  const inferredApiWasUserChanged = pendingInference
    && isPiApi(provider.api)
    && metadata?.endpointApiHint !== undefined
    && provider.api !== metadata.endpointApiHint;
  const explicitApi = isPiApi(model.api) ? model.api : (pendingInference && !inferredApiWasUserChanged) ? undefined : isPiApi(provider.api) ? provider.api : undefined;
  return explicitApi ?? endpointApiForModel(metadataProvider, endpoint) ?? detectChannelApi(endpoint);
}

function isSatisfiedByProviderAuth(header: string, provider: PiProvider): boolean {
  const hasApiKey = typeof provider.apiKey === "string" && provider.apiKey.trim().length > 0;
  const hasOAuth = typeof provider.oauth === "string" && provider.oauth.trim().length > 0;
  if (hasOAuth && /^authorization$/i.test(header)) return true;
  if (/^authorization$/i.test(header)) return hasOAuth || provider.authHeader === true && hasApiKey;
  if (!hasApiKey) return false;
  return /^(?:x-)?api[-_]?key$|^x-auth-token$|^api[-_]?token$/i.test(header);
}

function hasHeaderValue(headers: Record<string, string>, key: string): boolean {
  const actual = Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1];
  return typeof actual === "string" && actual.trim().length > 0;
}

function sameHeaderValue(left: Record<string, string>, leftKey: string, right: Record<string, string>, rightKey: string): boolean {
  return left[leftKey] === right[rightKey];
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function hasCostMetadata(model: ModelsDevModel): boolean {
  const cost = model.cost;
  return cost !== undefined && (
    typeof cost.input === "number"
    || typeof cost.output === "number"
    || typeof cost.cache_read === "number"
    || typeof cost.cache_write === "number"
    || (Array.isArray(cost.tiers) && cost.tiers.length > 0)
  );
}

function compatReasoningDiffers(left: PiModel["compat"], right: PiModel["compat"]): boolean {
  const keys = [
    "reasoningControlType",
    "reasoningToggleField",
    "reasoningToggleOnValue",
    "reasoningToggleOffValue",
    "reasoningEffortField",
    "reasoningBudgetField",
    "reasoningAdaptiveField",
    "reasoningBudgetMinTokens",
    "reasoningBudgetTokens",
    "reasoningFallback",
    "reasoningWarnings",
    "reasoningPolicy",
    "forceAdaptiveThinking",
    "canDisable",
    "maxBudgetTokens",
    "minBudgetTokens",
    "maxOutputTokens",
    "fallbackReason",
    "mappingConfidence",
    "thinkingFormat",
    "thinkingConfig",
    "supportsReasoningEffort",
    "supportsReasoningBudget",
  ] as const;
  return keys.some((key) => !jsonEqual(left?.[key], right?.[key]));
}

function compatCacheDiffers(left: PiModel["compat"], right: PiModel["compat"]): boolean {
  const keys = [
    "cacheCapabilities",
    "cacheResolution",
    "cacheControlFormat",
    "supportsLongCacheRetention",
    "supportsPromptCaching",
    "supportsContextCaching",
    "supportsKvCache",
    "cachePromptField",
    "cacheContextField",
    "cacheKvField",
    "cacheWarnings",
    "supportsCacheControlOnTools",
    "supportsLongCacheRetention",
  ] as const;
  return keys.some((key) => !jsonEqual(left?.[key], right?.[key]));
}

function findConfiguredProvider(providers: Record<string, PiProvider>, target: string): { id: string; provider: PiProvider } | undefined {
  const normalized = normalizeIdentifier(target);
  const entry = Object.entries(providers).find(([id, provider]) => [id, provider.name]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeIdentifier(value) === normalized)
    || looksLikeUrl(target) && typeof provider.baseUrl === "string" && sameChannelEndpoint(provider.baseUrl, target, provider.api));
  return entry ? { id: entry[0], provider: entry[1] } : undefined;
}

function findConfiguredProviderById(providers: Record<string, PiProvider>, target: string): { id: string; provider: PiProvider } | undefined {
  const normalized = normalizeIdentifier(target);
  const entries = Object.entries(providers).filter(([id, provider]) => [id, provider.name]
    .filter((value): value is string => typeof value === "string")
    .some((value) => normalizeIdentifier(value) === normalized));
  return entries.length === 1 ? { id: entries[0][0], provider: entries[0][1] } : undefined;
}

function validateExplicitProviderUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new DoctorError(`Provider endpoint is not a valid URL: ${errorMessage(error)}`, "invalid-target", error);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) throw new DoctorError("Provider endpoint must use http:// or https:// with a hostname", "invalid-target");
  if (parsed.username || parsed.password) throw new DoctorError("Provider endpoint must not contain URL credentials", "invalid-target");
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveFieldName(key)) throw new DoctorError("Provider endpoint must not contain credential query parameters", "invalid-target");
  }
}

function providerIdForAddTarget(
  target: string,
  configuredEntry: { id: string; provider: PiProvider } | undefined,
  providers: Record<string, PiProvider>,
  catalogProviderId: string,
  metadataOnly: boolean,
  catalogProviderIds: Iterable<string>,
): string {
  if (configuredEntry) return configuredEntry.id;
  if (!looksLikeUrl(target)) return catalogProviderId;
  if (metadataOnly) return providerIdFromUrl(target, providers, catalogProviderIds);

  const configuredCatalogEntry = findConfiguredProviderById(providers, catalogProviderId);
  if (!configuredCatalogEntry || sameChannelEndpoint(configuredCatalogEntry.provider.baseUrl ?? "", target, configuredCatalogEntry.provider.api)) {
    return catalogProviderId;
  }
  return providerIdFromUrl(target, providers);
}

function validateAddTarget(target: string): void {
  if (!target) throw new DoctorError("Sync target is required", "invalid-target");
  if (target.includes("://") && !looksLikeUrl(target)) throw new DoctorError("Provider URL must use http:// or https://", "invalid-target");
  if (!looksLikeUrl(target) && (isUnsafeIdentifier(target) || /[\\/]/.test(target))) throw new DoctorError("Provider target must be a safe provider identifier", "invalid-target");
  if (looksLikeUrl(target)) validateExplicitProviderUrl(target);
}

function fallbackProvider(
  target: string,
  modelId: string,
  configured?: { id: string; provider: PiProvider },
  providers: Record<string, PiProvider> = {},
  reservedProviderIds: Iterable<string> = [],
): { provider: ModelsDevProvider; model: ModelsDevModel } {
  const endpoint = looksLikeUrl(target) ? target : configured?.provider.baseUrl;
  const id = configured?.id ?? (endpoint ? providerIdFromUrl(endpoint, providers, reservedProviderIds) : target.trim());
  const configuredProvider = configured?.provider;
  const model: ModelsDevModel = {
    id: modelId,
    name: modelId,
    reasoning: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: configuredProvider?.models?.find((item) => item.id === modelId)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, output: configuredProvider?.models?.find((item) => item.id === modelId)?.maxTokens ?? DEFAULT_MAX_TOKENS },
    cost: { ...DEFAULT_COST, cache_read: 0, cache_write: 0 },
  };
  const provider: ModelsDevProvider = {
    id,
    name: configuredProvider?.name ?? id,
    ...(endpoint ? { api: endpoint } : configuredProvider?.api ? { api: configuredProvider.api } : {}),
    models: { [model.id]: model },
  };
  return { provider, model };
}

function mergeMigrationProviderFields(source: PiProvider, target: PiProvider, plan: ChangePlan, targetName: string): void {
  const providerId = targetName.slice(0, targetName.indexOf("/"));
  const managed = new Set(["name", "baseUrl", "api", "models", "_piModelDoctor"]);
  const intentionallyExcluded = new Set(["headers", "apiKey", "oauth", "authHeader", "compat", "modelOverrides", "temperature"]);
  if (source.baseUrl !== undefined && source.baseUrl !== target.baseUrl) {
    plan.warnings.push(`Source provider endpoint was not copied during migration to ${targetName}; destination endpoint was preserved.`);
  }
  if (source.api !== undefined && source.api !== target.api) {
    plan.warnings.push(`Source provider API protocol was not copied during migration to ${targetName}; destination API was preserved.`);
  }
  for (const [field, value] of Object.entries(source)) {
    if (managed.has(field)) continue;
    if (intentionallyExcluded.has(field) || containsSensitiveKey(value) || isSensitiveFieldName(field)) {
      if (value !== undefined) plan.warnings.push(`Source provider field ${field} was not copied during migration to ${targetName}; configure the destination explicitly.`);
      continue;
    }
    if (target[field] === undefined) {
      target[field] = cloneJson(value);
      plan.changes.push({
        path: `providers.${providerId}.${field}`,
        before: undefined,
        after: value,
        reason: "Preserve source provider user-owned field during migration",
        ownership: "user",
      });
    } else if (!jsonEqual(target[field], value)) {
      plan.conflicts.push(finding("migration-conflict", "warning", targetName, `Destination already has a different user-owned provider ${field}; destination value was preserved`, false, true));
    }
  }
}

function mergeMigrationUserFields(source: PiModel, target: PiModel, plan: ChangePlan, targetName: string): void {
  const managed = new Set(["id", "name", "api", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat", "_piModelDoctor"]);
  const sensitive = new Set(["apiKey", "oauth", "authHeader", "authorization", "token", "secret", "password", "credential"]);
  const separator = targetName.indexOf("/");
  const providerId = separator >= 0 ? targetName.slice(0, separator) : targetName;
  const modelId = separator >= 0 ? targetName.slice(separator + 1) : targetName;
  for (const [field, value] of Object.entries(source)) {
    if (field === "id" || field === "_piModelDoctor") continue;
    if (managed.has(field)) {
      if (!canManageField(source, field)) plan.warnings.push(`Source model field ${field} is user-owned and was not copied during migration to ${targetName}; destination metadata was preserved.`);
      continue;
    }
    if (field === "baseUrl") {
      plan.warnings.push(`Source model endpoint override was not copied during migration to ${targetName}; review it explicitly.`);
      continue;
    }
    if (field === "headers") {
      plan.warnings.push(`Source model headers were not copied during migration to ${targetName}; configure destination headers explicitly.`);
      continue;
    }
    if (field === "temperature") {
      plan.warnings.push(`Source model temperature preference was not copied during migration to ${targetName}; configure it explicitly.`);
      continue;
    }
    if (containsSensitiveKey(value) || sensitive.has(field) || isSensitiveFieldName(field)) {
      plan.warnings.push(`Sensitive user-owned field ${field} was not copied during migration to ${targetName}; configure it explicitly.`);
      continue;
    }
    if (target[field] === undefined) {
      target[field] = cloneJson(value);
      plan.changes.push({
        path: `providers.${providerId}.models[${modelId}].${field}`,
        before: undefined,
        after: value,
        reason: "Preserve source user-owned field during migration",
        ownership: "user",
      });
    } else if (!jsonEqual(target[field], value)) {
      plan.conflicts.push(finding("migration-conflict", "warning", targetName, `Destination already has a different user-owned ${field}; destination value was preserved`, false, true));
    }
  }
}

function removeSourceModel(config: PiModelsJson, providerId: string, modelId: string, plan: ChangePlan): void {
  const provider = getProviders(config)[providerId];
  if (!provider) return;
  const models = getModels(provider);
  const index = models.findIndex((model) => model.id === modelId);
  if (index < 0) return;
  const [removed] = models.splice(index, 1);
  plan.changes.push({ path: `providers.${providerId}.models[${modelId}]`, before: removed, after: undefined, reason: "Remove source model after explicit migration request", ownership: "user" });
  if (models.length === 0 && safeToDeleteProvider(provider)) {
    delete getProviders(config)[providerId];
    plan.changes.push({ path: `providers.${providerId}`, before: provider, after: undefined, reason: "Remove empty source provider after migration", ownership: "managed" });
  }
}

function isSensitiveFieldName(field: string): boolean {
  const segments = field.split(/[.[\]]/u).filter(Boolean);
  const key = segments[segments.length - 1] ?? field;
  return /^(?:headers?|api[-_]?key|authorization|auth(?:entication)?|auth[-_]?header|oauth|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|set-cookie)$/i.test(key)
    || /^(?:x[-_]?api[-_]?key|x[-_]?auth[-_]?token)$/i.test(key);
}

function containsSensitiveKey(value: unknown): boolean {
  if (typeof value === "string") return looksLikeCredentialValue(value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => isSensitiveFieldName(key) || containsSensitiveKey(child));
}

function firstEnvironmentKey(provider: ModelsDevProvider): string | undefined {
  const first = provider.env?.find((value) => /^[A-Z][A-Z0-9_]*$/.test(value));
  return first ? `$${first}` : undefined;
}

function isCredentialReference(value: string): boolean {
  return /^\$[A-Z][A-Z0-9_]*$/.test(value)
    || /^\$\{[A-Z][A-Z0-9_]*\}$/.test(value)
    || /^![A-Za-z0-9._:/-]+$/.test(value)
    || /^pi-auth:[A-Za-z0-9._:/-]+$/.test(value);
}

function providerIdFromUrl(target: string, providers: Record<string, PiProvider> = {}, reservedProviderIds: Iterable<string> = []): string {
  try {
    const parsed = new URL(target);
    const hostname = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const base = safeProviderSlug(hostname.split(".")[0] || "custom-provider");
    const existingEndpoint = Object.entries(providers).find(([, provider]) => typeof provider.baseUrl === "string"
      && sameChannelEndpoint(provider.baseUrl, target, provider.api));
    if (existingEndpoint) return existingEndpoint[0];
    const reserved = new Set([...Object.keys(providers), ...reservedProviderIds].map((value) => normalizeIdentifier(value)));
    const existingBase = providers[base];
    if (!reserved.has(base) && (!existingBase || typeof existingBase.baseUrl !== "string" || sameChannelEndpoint(existingBase.baseUrl, target, existingBase.api))) return base;

    const pathSuffix = parsed.pathname.split("/").filter(Boolean).map(safeProviderSlug).filter(Boolean).join("-");
    const hostSuffix = hostname.split(".").slice(1).map(safeProviderSlug).filter(Boolean).join("-");
    const suffix = pathSuffix || hostSuffix || "channel";
    let candidate = safeProviderSlug(`${base}-${suffix}`);
    let sequence = 2;
    while (reserved.has(candidate) || providers[candidate] && (typeof providers[candidate].baseUrl !== "string" || !sameChannelEndpoint(providers[candidate].baseUrl ?? "", target, providers[candidate].api))) {
      candidate = safeProviderSlug(`${base}-${suffix}-${sequence}`);
      sequence += 1;
    }
    return candidate;
  } catch {
    return "custom-provider";
  }
}

function safeProviderSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug && !isUnsafeIdentifier(slug) ? slug : "custom-provider";
}

function normalizeEndpointIdentity(value: string | undefined | URL): string {
  if (!value) return "";
  try {
    const parsed = typeof value === "string" ? new URL(value) : value;
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return typeof value === "string" ? value.trim().toLowerCase().replace(/\/+$/, "") : "";
  }
}

function sameChannelEndpoint(left: string, right: string, api?: string, normalizedApi?: string): boolean {
  const leftIdentity = normalizeEndpointIdentity(left);
  const rightIdentity = normalizeEndpointIdentity(right);
  if (leftIdentity === rightIdentity) return true;
  const apiFamily = api ?? normalizedApi;
  if (apiFamily !== "openai-completions" && apiFamily !== "openai-responses") return false;
  return withoutOpenAiVersionPath(left) === withoutOpenAiVersionPath(right);
}

function withoutOpenAiVersionPath(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.pathname.replace(/\/+$/u, "") === "/v1") parsed.pathname = "/";
    return normalizeEndpointIdentity(parsed);
  } catch {
    return normalizeEndpointIdentity(value);
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isUnsafeIdentifier(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

function parseTarget(target: string, requireModel = false): { providerId: string; modelId?: string } {
  const trimmed = target.trim();
  if (!trimmed) throw new DoctorError("Target is required", "invalid-target");
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    if (requireModel) throw new DoctorError(`Target must be provider/model: ${target}`, "invalid-target");
    if (isUnsafeIdentifier(trimmed)) throw new DoctorError("Target uses an unsafe provider identifier", "invalid-target");
    return { providerId: trimmed };
  }
  const providerId = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!providerId || !modelId || isUnsafeIdentifier(providerId) || isUnsafeIdentifier(modelId)) throw new DoctorError(`Target must be provider/model with safe identifiers`, "invalid-target");
  return { providerId, modelId };
}

function combinePlans(target: string, plans: ChangePlan[]): ChangePlan {
  return {
    target,
    changes: plans.flatMap((plan) => plan.changes),
    conflicts: plans.flatMap((plan) => plan.conflicts),
    warnings: plans.flatMap((plan) => plan.warnings),
  };
}

function safeToDeleteProvider(provider: PiProvider): boolean {
  if (!hasDoctorMetadata(provider)) return false;
  if ("apiKey" in provider || "headers" in provider || "authHeader" in provider || "oauth" in provider) return false;
  const allowed = new Set(["name", "baseUrl", "api", "models", "_piModelDoctor"]);
  if (!Object.keys(provider).every((key) => allowed.has(key))) return false;
  // Metadata-only channels deliberately do not own provider identity fields.
  // Keep an empty provider when any such field is still user-owned so remove
  // cannot discard the user's endpoint/protocol configuration with the model.
  for (const field of ["name", "baseUrl", "api"] as const) {
    if (field in provider && !canManageField(provider, field)) return false;
  }
  return true;
}
