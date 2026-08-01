import { CacheStore } from "./cache.ts";
import {
  buildMetadata,
  canManageField,
  cloneJson,
  DoctorError,
  getModels,
  getProviders,
  hasDoctorMetadata,
  jsonEqual,
  readModelsJson,
  writeModelsJson,
} from "./json.ts";
import { ModelsDevClient, ModelsDevError } from "./models-dev.ts";
import {
  capabilityCompat,
  detectPiApi,
  inferProviderEndpoint,
  resolveCache,
  resolveCapabilities,
  resolveReasoning,
  toPiModel,
  toThinkingLevelMap,
} from "./capabilities.ts";
import type {
  AddInput,
  Change,
  ChangePlan,
  CheckResult,
  CommandResult,
  DoctorMetadata,
  DoctorOptions,
  DoctorPaths,
  Finding,
  FindingCode,
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevProvider,
  PiModel,
  PiModelsJson,
  PiProvider,
  ProviderMatch,
} from "./types.ts";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COST,
  DEFAULT_MAX_TOKENS,
  MODEL_DOCTOR_VERSION,
} from "./types.ts";

export interface AddProposal {
  target: string;
  providerId: string;
  modelId: string;
  config: PiModelsJson;
  plan: ChangePlan;
  catalogSource: "network" | "cache" | "fallback";
  warning?: string;
}

export interface FixProposal {
  config: PiModelsJson;
  result: CheckResult;
}

export interface RemoveProposal {
  config: PiModelsJson;
  plan: ChangePlan;
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
    this.modelsDev = new ModelsDevClient(this.cache, options.fetcher);
  }

  async list(providerId?: string): Promise<DoctorListItem[]> {
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const providers = getProviders(data);
    const result: DoctorListItem[] = [];
    for (const [id, provider] of Object.entries(providers)) {
      if (providerId && id !== providerId) continue;
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

  async refresh(force = false): Promise<{ source: "network" | "cache"; stale: boolean; warning?: string; providers: number; models: number }> {
    const result = await this.modelsDev.refresh(force);
    const models = Object.values(result.catalog.providers).reduce((count, provider) => count + Object.keys(provider.models).length, 0);
    await this.cache.writePolicies("model-doctor-v1");
    return {
      source: result.source,
      stale: result.stale,
      warning: result.warning,
      providers: Object.keys(result.catalog.providers).length,
      models,
    };
  }

  async proposeAdd(input: AddInput): Promise<AddProposal> {
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    let catalog: ModelsDevCatalog | undefined;
    let catalogSource: AddProposal["catalogSource"] = "fallback";
    let warning: string | undefined;
    try {
      const loaded = await this.modelsDev.load({ persist: !input.dryRun });
      catalog = loaded.catalog;
      catalogSource = loaded.source;
      warning = loaded.warning;
    } catch (error) {
      if (!(error instanceof ModelsDevError)) throw error;
      warning = error.message;
    }

    const match = catalog ? chooseMatch(catalog, input.target, input.modelId) : undefined;
    const fallback = fallbackProvider(input.target, input.modelId);
    const provider = match?.provider ?? fallback.provider;
    const sourceModel = match?.model ?? fallback.model;
    const providerId = provider.id;
    const modelId = sourceModel.id;
    const endpoint = inferProviderEndpoint(provider, looksLikeUrl(input.target) ? input.target : undefined);
    if (!endpoint && !getProviders(data)[providerId]) {
      throw new DoctorError(`Unable to infer an API endpoint for provider ${providerId}; pass a provider URL to add`, "invalid-target");
    }
    const generatedModel = toPiModel(provider, sourceModel, {
      endpoint,
      now: this.now(),
      sourceName: this.source,
    });
    const configuredProvider: PiProvider = {
      name: provider.name ?? provider.id,
      ...(endpoint ? { baseUrl: endpoint } : {}),
      api: detectPiApi(provider, endpoint),
      ...(input.apiKey ? { apiKey: input.apiKey } : firstEnvironmentKey(provider) ? { apiKey: firstEnvironmentKey(provider) } : {}),
      models: [generatedModel],
    };
    const next = cloneJson(data);
    const plan = mergeProvider(next, providerId, configuredProvider, this.now());
    return {
      target: `${providerId}/${modelId}`,
      providerId,
      modelId,
      config: next,
      plan,
      catalogSource,
      warning,
    };
  }

  async applyAdd(proposal: AddProposal): Promise<{ backupPath?: string; target: string; plan: ChangePlan }> {
    const blocking = proposal.plan.conflicts.filter((item) => item.severity === "error");
    if (blocking.length > 0) {
      throw new DoctorError(`Cannot add ${proposal.target}: ${blocking.map((item) => item.message).join("; ")}`, "invalid-config");
    }
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, target: proposal.target, plan: proposal.plan };
  }

  async check(target?: string): Promise<CheckResult> {
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const checkedAt = this.now().toISOString();
    let catalog: ModelsDevCatalog;
    let networkFinding: Finding | undefined;
    try {
      const loaded = await this.modelsDev.load();
      catalog = loaded.catalog;
      if (loaded.warning) {
        networkFinding = finding("network-unavailable", "warning", target ?? "models.json", loaded.warning, false);
      }
    } catch (error) {
      if (!(error instanceof ModelsDevError)) throw error;
      const noCatalogResult: CheckResult = {
        target,
        checkedAt,
        findings: [finding("network-unavailable", "warning", target ?? "models.json", error.message, false)],
      };
      return noCatalogResult;
    }
    const findings = networkFinding ? [networkFinding] : [];
    const providers = getProviders(data);
    const selected = target ? parseTarget(target) : undefined;
    for (const [providerId, provider] of Object.entries(providers)) {
      if (selected && selected.providerId !== providerId) continue;
      const match = ModelsDevClient.findForConfig(catalog, providerId, provider.baseUrl, selected?.modelId);
      if (!match) {
        findings.push(finding("missing-provider", "warning", providerId, `No models.dev metadata found for provider ${providerId}`, false));
        continue;
      }
      if (selected?.modelId) {
        const model = getModels(provider).find((item) => item.id === selected.modelId);
        if (!model) {
          findings.push(finding("missing-model", "error", target ?? providerId, `Model ${selected.modelId} is not configured`, false));
          continue;
        }
        findings.push(...checkModel(providerId, provider, model, match.provider, match.model));
      } else {
        for (const model of getModels(provider)) {
          const source = match.provider.models[model.id] ?? Object.values(match.provider.models).find((item) => item.name === model.name);
          findings.push(...checkModel(providerId, provider, model, match.provider, source));
        }
      }
    }
    const plan = target ? await this.buildFixPlan(data, catalog, target, findings) : undefined;
    return { target, checkedAt, findings, plan };
  }

  async proposeFix(target: string, options: { persistCache?: boolean } = {}): Promise<FixProposal> {
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    let catalog: ModelsDevCatalog;
    let networkFinding: Finding | undefined;
    try {
      const loaded = await this.modelsDev.load({ persist: options.persistCache !== false });
      catalog = loaded.catalog;
      if (loaded.warning) networkFinding = finding("network-unavailable", "warning", target, loaded.warning, false);
    } catch (error) {
      if (error instanceof ModelsDevError) {
        return { config: data, result: { target, checkedAt: this.now().toISOString(), findings: [finding("network-unavailable", "warning", target, error.message, false)] } };
      }
      throw error;
    }
    const result = await this.checkWithCatalog(data, catalog, target, networkFinding);
    const config = cloneJson(data);
    const plan = applyRepairPlan(config, target, catalog, result.findings, this.now(), this.source);
    result.plan = plan;
    return { config, result };
  }

  async proposeFixAll(options: { persistCache?: boolean } = {}): Promise<FixProposal> {
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    let catalog: ModelsDevCatalog;
    let networkFinding: Finding | undefined;
    try {
      const loaded = await this.modelsDev.load({ persist: options.persistCache !== false });
      catalog = loaded.catalog;
      if (loaded.warning) networkFinding = finding("network-unavailable", "warning", "models.json", loaded.warning, false);
    } catch (error) {
      if (error instanceof ModelsDevError) {
        return { config: data, result: { checkedAt: this.now().toISOString(), findings: [finding("network-unavailable", "warning", "models.json", error.message, false)] } };
      }
      throw error;
    }
    const config = cloneJson(data);
    const findings = networkFinding ? [networkFinding] : [];
    const plans: ChangePlan[] = [];
    for (const [providerId, provider] of Object.entries(getProviders(data))) {
      for (const model of getModels(provider)) {
        const target = `${providerId}/${model.id}`;
        const result = await this.checkWithCatalog(data, catalog, target);
        findings.push(...result.findings);
        plans.push(applyRepairPlan(config, target, catalog, result.findings, this.now(), this.source));
      }
    }
    const plan = combinePlans("models.json", plans);
    return { config, result: { checkedAt: this.now().toISOString(), findings, plan } };
  }

  async applyFix(proposal: FixProposal): Promise<{ backupPath?: string; plan?: ChangePlan }> {
    if (!proposal.result.plan || proposal.result.plan.changes.length === 0) return {};
    const blocking = proposal.result.plan.conflicts.filter((item) => item.severity === "error");
    if (blocking.length > 0) {
      throw new DoctorError(`Cannot fix ${proposal.result.target ?? "models.json"}: ${blocking.map((item) => item.message).join("; ")}`, "invalid-config");
    }
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, plan: proposal.result.plan };
  }

  async proposeRemove(target: string): Promise<RemoveProposal> {
    const selected = parseTarget(target, true);
    const { data } = await readModelsJson(this.options.paths.modelsPath);
    const next = cloneJson(data);
    const providers = getProviders(next);
    const provider = providers[selected.providerId];
    if (!provider) {
      return { config: next, plan: { target, changes: [], conflicts: [finding("missing-provider", "error", target, `Provider ${selected.providerId} is not configured`, false)], warnings: [] } };
    }
    const models = getModels(provider);
    const index = models.findIndex((model) => model.id === selected.modelId);
    if (index < 0) {
      return { config: next, plan: { target, changes: [], conflicts: [finding("missing-model", "error", target, `Model ${selected.modelId} is not configured`, false)], warnings: [] } };
    }
    const model = models[index];
    models.splice(index, 1);
    const changes: Change[] = [{ path: `providers.${selected.providerId}.models[${selected.modelId}]`, before: model, after: undefined, reason: "Remove explicitly requested model", ownership: "user" }];
    if (models.length === 0 && safeToDeleteProvider(provider)) {
      delete providers[selected.providerId];
      changes.push({ path: `providers.${selected.providerId}`, before: provider, after: undefined, reason: "Remove empty Doctor-managed provider", ownership: "managed" });
    }
    return { config: next, plan: { target, changes, conflicts: [], warnings: [] } };
  }

  async applyRemove(proposal: RemoveProposal): Promise<{ backupPath?: string; plan: ChangePlan }> {
    if (proposal.plan.conflicts.length > 0) {
      throw new DoctorError(proposal.plan.conflicts.map((item) => item.message).join("; "), "invalid-config");
    }
    const result = await writeModelsJson(this.options.paths.modelsPath, proposal.config, this.now());
    return { backupPath: result.backupPath, plan: proposal.plan };
  }

  private async checkWithCatalog(data: PiModelsJson, catalog: ModelsDevCatalog, target: string, networkFinding?: Finding): Promise<CheckResult> {
    const selected = parseTarget(target, true);
    const providers = getProviders(data);
    const provider = providers[selected.providerId];
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
    const match = ModelsDevClient.findForConfig(catalog, selected.providerId, provider.baseUrl, selected.modelId);
    if (!match) {
      findings.push(finding("missing-model", "warning", target, `No models.dev metadata found for ${target}`, false));
      return { target, checkedAt: this.now().toISOString(), findings };
    }
    findings.push(...checkModel(selected.providerId, provider, model, match.provider, match.model));
    return { target, checkedAt: this.now().toISOString(), findings };
  }

  private async buildFixPlan(data: PiModelsJson, catalog: ModelsDevCatalog, target: string, _findings: Finding[]): Promise<ChangePlan> {
    const result = await this.checkWithCatalog(data, catalog, target);
    const config = cloneJson(data);
    return applyRepairPlan(config, target, catalog, result.findings, this.now(), this.source);
  }
}

function mergeProvider(config: PiModelsJson, providerId: string, desired: PiProvider, now: Date): ChangePlan {
  const providers = getProviders(config);
  const existing = providers[providerId];
  const changes: Change[] = [];
  const conflicts: Finding[] = [];
  if (!existing) {
    const providerManagedFields = ["name", "baseUrl", "api"];
    const providerMetadata = buildMetadata(undefined, {
      source: "models.dev",
      lastCheck: now.toISOString(),
      autoRepair: true,
      providerId,
    }, providerManagedFields, Object.fromEntries(providerManagedFields.map((field) => [field, desired[field]]).filter(([, value]) => value !== undefined)));
    desired._piModelDoctor = providerMetadata;
    providers[providerId] = desired;
    changes.push({ path: `providers.${providerId}`, before: undefined, after: desired, reason: "Add provider from models.dev", ownership: "managed" });
    return { target: providerId, changes, conflicts, warnings: [] };
  }
  const provider = existing;
  const providerManagedFields: string[] = [];
  for (const field of ["name", "baseUrl", "api"] as const) {
    const value = desired[field];
    if (value === undefined) continue;
    if (provider[field] === undefined || canManageField(provider, field)) {
      providerManagedFields.push(field);
      if (!jsonEqual(provider[field], value)) {
        changes.push({ path: `providers.${providerId}.${field}`, before: provider[field], after: value, reason: `Sync ${field} from models.dev`, ownership: "managed" });
        provider[field] = value;
      }
    } else if (!jsonEqual(provider[field], value)) {
      conflicts.push(finding(field === "baseUrl" ? "endpoint-mismatch" : "api-mismatch", "warning", providerId, `Preserved user-owned provider ${field}`, false, true));
    }
  }
  if (desired.apiKey !== undefined && provider.apiKey === undefined) {
    provider.apiKey = desired.apiKey;
    changes.push({ path: `providers.${providerId}.apiKey`, before: undefined, after: "[redacted]", reason: "Configure provider authentication reference", ownership: "user" });
  }
  const desiredModel = getModels(desired)[0];
  const models = getModels(provider);
  const existingModel = models.find((model) => model.id === desiredModel.id);
  if (!existingModel) {
    models.push(desiredModel);
    changes.push({ path: `providers.${providerId}.models[${desiredModel.id}]`, before: undefined, after: desiredModel, reason: "Add model metadata from models.dev", ownership: "managed" });
  } else {
    mergeModel(providerId, existingModel, desiredModel, changes, conflicts, now);
  }
  const previousProviderMetadata = hasDoctorMetadata(provider) ? provider._piModelDoctor : undefined;
  provider._piModelDoctor = buildMetadata(previousProviderMetadata, { source: "models.dev", lastCheck: now.toISOString(), autoRepair: true, providerId }, providerManagedFields, Object.fromEntries(providerManagedFields.map((field) => [field, provider[field]]).filter(([, value]) => value !== undefined)));
  return { target: `${providerId}/${desiredModel.id}`, changes, conflicts, warnings: [] };
}

function mergeModel(providerId: string, existing: PiModel, desired: PiModel, changes: Change[], conflicts: Finding[], now: Date): void {
  const managedFields: string[] = [];
  for (const field of ["name", "api", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"] as const) {
    const value = desired[field];
    if (value === undefined) continue;
    if (existing[field] === undefined || canManageField(existing, field)) {
      managedFields.push(field);
      if (!jsonEqual(existing[field], value)) {
        changes.push({ path: `model.${existing.id}.${field}`, before: existing[field], after: value, reason: `Sync ${field} from models.dev`, ownership: "managed" });
        (existing as Record<string, unknown>)[field] = cloneJson(value);
      }
    } else if (!jsonEqual(existing[field], value)) {
      conflicts.push(finding(field === "contextWindow" ? "context-window-mismatch" : field === "maxTokens" ? "max-tokens-mismatch" : field === "reasoning" || field === "thinkingLevelMap" ? "reasoning-mismatch" : "cache-mismatch", "warning", `${providerId}/${existing.id}`, `Preserved user-owned model ${field}`, false, true));
    }
  }
  if (managedFields.length > 0 || hasDoctorMetadata(existing)) {
    const previous = hasDoctorMetadata(existing) ? existing._piModelDoctor : undefined;
    const metadata = buildMetadata(previous, { source: "models.dev", lastCheck: now.toISOString(), autoRepair: true, providerId, modelId: existing.id }, managedFields, Object.fromEntries(managedFields.map((field) => [field, existing[field]])));
    existing._piModelDoctor = metadata;
  }
}

function applyRepairPlan(config: PiModelsJson, target: string, catalog: ModelsDevCatalog, findings: Finding[], now: Date, source: string): ChangePlan {
  const selected = parseTarget(target, true);
  const providers = getProviders(config);
  const provider = providers[selected.providerId];
  if (!provider) return { target, changes: [], conflicts: findings.filter((item) => !item.repairable), warnings: [] };
  const model = getModels(provider).find((item) => item.id === selected.modelId);
  if (!model) return { target, changes: [], conflicts: findings.filter((item) => !item.repairable), warnings: [] };
  const match = ModelsDevClient.find(catalog, selected.providerId, selected.modelId);
  if (!match?.model) return { target, changes: [], conflicts: findings.filter((item) => !item.repairable), warnings: [] };
  const desiredEndpoint = inferProviderEndpoint(match.provider);
  const desired = toPiModel(match.provider, match.model, { endpoint: provider.baseUrl ?? desiredEndpoint, now, sourceName: source });
  const changes: Change[] = [];
  const conflicts = findings.filter((item) => item.userOwned && !item.repairable);
  for (const field of ["api", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"] as const) {
    const value = desired[field];
    if (value === undefined) continue;
    if (canManageField(model, field) || model[field] === undefined) {
      if (!jsonEqual(model[field], value)) {
        changes.push({ path: `providers.${selected.providerId}.models[${selected.modelId}].${field}`, before: model[field], after: value, reason: `Repair ${field} from models.dev`, ownership: "managed" });
        (model as Record<string, unknown>)[field] = cloneJson(value);
      }
    } else if (!jsonEqual(model[field], value)) {
      conflicts.push(finding(field === "contextWindow" ? "context-window-mismatch" : field === "maxTokens" ? "max-tokens-mismatch" : field === "reasoning" || field === "thinkingLevelMap" ? "reasoning-mismatch" : "cache-mismatch", "warning", target, `User-owned ${field} differs from models.dev; not overwritten`, false, true));
    }
  }
  if (provider.baseUrl === undefined || canManageField(provider, "baseUrl")) {
    const expectedEndpoint = desiredEndpoint;
    if (expectedEndpoint && provider.baseUrl !== expectedEndpoint) {
      changes.push({ path: `providers.${selected.providerId}.baseUrl`, before: provider.baseUrl, after: expectedEndpoint, reason: "Repair provider endpoint", ownership: "managed" });
      provider.baseUrl = expectedEndpoint;
    }
  } else if (desiredEndpoint && provider.baseUrl !== desiredEndpoint) {
    conflicts.push(finding("endpoint-mismatch", "warning", target, "User-owned endpoint differs from models.dev; not overwritten", false, true));
  }
  if (provider.api === undefined || canManageField(provider, "api")) {
    const expectedApi = detectPiApi(match.provider, provider.baseUrl ?? desiredEndpoint);
    if (provider.api !== expectedApi) {
      changes.push({ path: `providers.${selected.providerId}.api`, before: provider.api, after: expectedApi, reason: "Repair API protocol", ownership: "managed" });
      provider.api = expectedApi;
    }
  }
  const previous = hasDoctorMetadata(model) ? cloneJson(model._piModelDoctor) : undefined;
  const nextMetadata = buildMetadata(previous, { source, lastCheck: now.toISOString(), autoRepair: true, providerId: selected.providerId, modelId: selected.modelId }, ["api", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"], Object.fromEntries(["api", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens", "compat"].map((field) => [field, model[field]]).filter(([, value]) => value !== undefined)));
  model._piModelDoctor = nextMetadata;
  if (!jsonEqual(previous, nextMetadata)) {
    changes.push({ path: `providers.${selected.providerId}.models[${selected.modelId}]._piModelDoctor`, before: previous, after: nextMetadata, reason: "Record model ownership metadata", ownership: "managed" });
  }
  return { target, changes, conflicts, warnings: [] };
}

function checkModel(providerId: string, provider: PiProvider, model: PiModel, sourceProvider: ModelsDevProvider, sourceModel?: ModelsDevModel): Finding[] {
  const target = `${providerId}/${model.id}`;
  const findings: Finding[] = [];
  if (!sourceModel) {
    findings.push(finding("missing-model", "warning", target, `No models.dev metadata found for ${target}`, false));
    return findings;
  }
  const expectedEndpoint = inferProviderEndpoint(sourceProvider);
  const expectedApi = detectPiApi(sourceProvider, provider.baseUrl ?? expectedEndpoint);
  if (provider.api && provider.api !== expectedApi) findings.push(finding("api-mismatch", "warning", target, `Configured API ${provider.api} differs from expected ${expectedApi}`, canManageField(provider, "api"), !canManageField(provider, "api")));
  if (expectedEndpoint && provider.baseUrl !== expectedEndpoint) findings.push(finding("endpoint-mismatch", "warning", target, `Configured endpoint is ${provider.baseUrl ?? "unset"}; models.dev expects ${expectedEndpoint}`, provider.baseUrl === undefined || canManageField(provider, "baseUrl"), provider.baseUrl !== undefined && !canManageField(provider, "baseUrl")));
  if (sourceModel.status === "deprecated" || sourceModel.deprecated === true) findings.push(finding("deprecated-model", "warning", target, "models.dev marks this model as deprecated", false));
  if (model.id !== sourceModel.id) findings.push(finding("model-id-mismatch", "warning", target, `Configured model id ${model.id} does not match metadata id ${sourceModel.id}`, false, true));
  if (sourceModel.limit?.context !== undefined && sourceModel.limit.context > 0 && model.contextWindow !== sourceModel.limit.context) findings.push(finding("context-window-mismatch", "warning", target, `Context window is ${model.contextWindow ?? "unset"}; models.dev says ${sourceModel.limit.context}`, canManageField(model, "contextWindow"), !canManageField(model, "contextWindow")));
  if (sourceModel.limit?.output !== undefined && sourceModel.limit.output > 0 && model.maxTokens !== sourceModel.limit.output) findings.push(finding("max-tokens-mismatch", "warning", target, `Max tokens is ${model.maxTokens ?? "unset"}; models.dev says ${sourceModel.limit.output}`, canManageField(model, "maxTokens"), !canManageField(model, "maxTokens")));
  const expectedReasoning = resolveReasoning(sourceProvider, sourceModel);
  if (model.reasoning !== expectedReasoning.supported) findings.push(finding("reasoning-mismatch", "warning", target, `Reasoning is ${model.reasoning ? "enabled" : "disabled"}; metadata says ${expectedReasoning.supported ? "enabled" : "disabled"}`, canManageField(model, "reasoning"), !canManageField(model, "reasoning")));
  const expectedCompat = capabilityCompat(expectedApi, resolveCache(sourceProvider, sourceModel), expectedReasoning, sourceModel, sourceProvider.id);
  if (expectedCompat && !jsonEqual(model.compat, expectedCompat)) findings.push(finding("cache-mismatch", "warning", target, "Cache/reasoning compatibility metadata differs from models.dev", canManageField(model, "compat"), !canManageField(model, "compat")));
  if (model.headers && Object.keys(model.headers).length > 0) findings.push(finding("headers-preserved", "info", target, "Custom model headers are present and will be preserved", false, true));
  if (!hasDoctorMetadata(model)) findings.push(finding("metadata-missing", "info", target, "Model has no Pi Model Doctor ownership metadata", true));
  else if (model._piModelDoctor.source !== "models.dev") findings.push(finding("metadata-stale", "info", target, `Metadata source is ${model._piModelDoctor.source}`, true));
  if (hasDoctorMetadata(model) && model._piModelDoctor.version !== MODEL_DOCTOR_VERSION) findings.push(finding("metadata-version", "info", target, `Metadata version ${model._piModelDoctor.version ?? "unknown"} needs refresh`, true));
  return findings;
}

function finding(code: FindingCode, severity: Finding["severity"], target: string, message: string, repairable: boolean, userOwned = false): Finding {
  return { code, severity, target, message, repairable, userOwned };
}

function chooseMatch(catalog: ModelsDevCatalog, target: string, modelId?: string): ProviderMatch | undefined {
  return ModelsDevClient.match(catalog, target, modelId)[0];
}

function fallbackProvider(target: string, modelId?: string): { provider: ModelsDevProvider; model: ModelsDevModel } {
  const endpoint = looksLikeUrl(target) ? target : undefined;
  const id = endpoint ? providerIdFromUrl(endpoint) : target.trim();
  const model: ModelsDevModel = {
    id: modelId ?? "default-model",
    name: modelId ?? "Default model",
    reasoning: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: DEFAULT_CONTEXT_WINDOW, output: DEFAULT_MAX_TOKENS },
    cost: { ...DEFAULT_COST, cache_read: 0, cache_write: 0 },
  };
  const provider: ModelsDevProvider = { id, name: id, api: endpoint, models: { [model.id]: model } };
  return { provider, model };
}

function firstEnvironmentKey(provider: ModelsDevProvider): string | undefined {
  const first = provider.env?.find((value) => /^[A-Z][A-Z0-9_]+$/.test(value));
  return first ? `$${first}` : undefined;
}

function providerIdFromUrl(target: string): string {
  try {
    const hostname = new URL(target).hostname.replace(/^www\./, "").split(".")[0];
    return hostname || "custom-provider";
  } catch {
    return "custom-provider";
  }
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function parseTarget(target: string, requireModel = false): { providerId: string; modelId?: string } {
  const trimmed = target.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    if (requireModel) throw new DoctorError(`Target must be provider/model: ${target}`, "invalid-target");
    return { providerId: trimmed };
  }
  return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
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
  if (provider.apiKey || provider.headers || provider.authHeader || provider.oauth) return false;
  const allowed = new Set(["name", "baseUrl", "api", "models", "_piModelDoctor"]);
  return Object.keys(provider).every((key) => allowed.has(key));
}
