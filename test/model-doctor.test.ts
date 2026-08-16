import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { formatFindings, parseCommandArgs, runCommand } from "../src/command.ts";
import {
  capabilityCompat,
  defaultPolicyCatalog,
  endpointApiForModel,
  normalizeEndpointForApi,
  resolveCache,
  resolveReasoning,
  resolveProviderAdapter,
  toPiModel,
} from "../src/capabilities.ts";
import { CacheStore } from "../src/cache.ts";
import { ModelDoctor } from "../src/doctor.ts";
import modelDoctorExtension, { getModelDoctorRefreshIntervalMs } from "../index.ts";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { atomicWrite, canManageField, cleanupBackups, DoctorError, fileFingerprint, readModelsJson, redactSensitiveText, stripDoctorMetadata, writeModelsJson } from "../src/json.ts";
import { ModelsDevClient, ModelsDevError, normalizeCatalog } from "../src/models-dev.ts";
import type { DoctorPaths, ModelsDevCatalog, PiModelsJson } from "../src/types.ts";

function catalog(): ModelsDevCatalog {
  return normalizeCatalog({
    openai: {
      id: "openai",
      name: "OpenAI",
      env: ["OPENAI_API_KEY"],
      api: "https://api.openai.com/v1",
      models: {
        "gpt-test": {
          id: "gpt-test",
          name: "GPT Test",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
          modalities: { input: ["text", "image"], output: ["text"] },
          limit: { context: 200000, output: 32000 },
          cost: { input: 1, output: 3, cache_read: 0.2, cache_write: 0.4 },
        },
      },
    },
  });
}

function richCatalog(): ModelsDevCatalog {
  return normalizeCatalog({
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      api: "https://api.anthropic.com",
      required_headers: ["x-api-key"],
      models: {
        "claude-budget": {
          id: "claude-budget",
          reasoning: true,
          reasoning_options: [{ type: "budget", min: 1024, max: 16000 }],
          required_headers: ["anthropic-version"],
          limit: { context: 100000, output: 16000 },
          interleaved: { context_cache: true, kv_cache: true },
        },
      },
    },
    google: {
      id: "google",
      name: "Google",
      api: "https://generativelanguage.googleapis.com/v1beta",
      models: {
        "gemini-budget": {
          id: "gemini-budget",
          reasoning: true,
          reasoning_options: [{ type: "budget", min: 512, max: 8192 }],
          limit: { context: 500000, output: 8192 },
        },
      },
    },
    unknown: {
      id: "unknown",
      name: "Unknown",
      api: "https://unknown.example/v1",
      models: {
        "unknown-thinking": {
          id: "unknown-thinking",
          reasoning: true,
          reasoning_options: [{ type: "mystery", values: ["strange"] }],
          limit: { context: 10000, output: 1000 },
        },
      },
    },
  });
}

function paths(root: string): DoctorPaths {
  const doctorDir = join(root, "doctor");
  return {
    modelsPath: join(root, "models.json"),
    doctorDir,
    modelsCachePath: join(doctorDir, "models-cache.json"),
    providersCachePath: join(doctorDir, "providers-cache.json"),
    policiesCachePath: join(doctorDir, "policies-cache.json"),
  };
}

function fetchMock(data: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json", etag: "test-etag" }): typeof fetch {
  return (async () => new Response(status === 304 ? null : JSON.stringify(data), { status, headers })) as typeof fetch;
}

function baseConfig(): PiModelsJson {
  return { providers: { openai: { baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-test" }] } } };
}

test("parses unified command arguments, migration flags, help, and unknown paths", () => {
  assert.deepEqual(parseCommandArgs('add openai gpt-test --api-key "$OPENAI_API_KEY" --dry-run'), {
    command: "add",
    args: ["openai", "gpt-test"],
    flags: { "api-key": "$OPENAI_API_KEY", "dry-run": true },
  });
  assert.deepEqual(parseCommandArgs("cleanup-backups --keep 2 --dry-run"), {
    command: "cleanup-backups",
    args: [],
    flags: { keep: "2", "dry-run": true },
  });
  assert.deepEqual(parseCommandArgs("rollback models.json.bak-2026 --yes"), {
    command: "rollback",
    args: ["models.json.bak-2026"],
    flags: { yes: true },
  });
  assert.deepEqual(parseCommandArgs("migrate openai/gpt-test --to anthropic/claude"), {
    command: "migrate",
    args: ["openai/gpt-test"],
    flags: { to: "anthropic/claude" },
  });
  assert.deepEqual(parseCommandArgs("add openai gpt-test --allow-literal-api-key --yes"), {
    command: "add",
    args: ["openai", "gpt-test"],
    flags: { "allow-literal-api-key": true, yes: true },
  });
  assert.deepEqual(parseCommandArgs("add https://gateway.example/v1 model --metadata-provider anthropic --api anthropic-messages --dry-run"), {
    command: "add",
    args: ["https://gateway.example/v1", "model"],
    flags: { "metadata-provider": "anthropic", api: "anthropic-messages", "dry-run": true },
  });
  assert.deepEqual(parseCommandArgs("add providerA https://gateway.example/v1 model --yes"), {
    command: "add",
    args: ["providerA", "https://gateway.example/v1", "model"],
    flags: { yes: true },
  });
  assert.deepEqual(parseCommandArgs("sync openai --models gpt-one,gpt-two --yes"), {
    command: "sync",
    args: ["openai"],
    flags: { models: "gpt-one,gpt-two", yes: true },
  });
  assert.deepEqual(parseCommandArgs("unknown"), { command: "invalid", args: ["unknown"], flags: {} });
  assert.equal(parseCommandArgs("").command, "help");
});

test("normalizes effort, budget, toggle, and unknown reasoning plus cache signals", () => {
  const current = catalog().providers.openai;
  const model = current.models["gpt-test"];
  const normalizedReasoning = resolveReasoning(current, model);
  assert.equal(normalizedReasoning.supported, true);
  assert.equal(normalizedReasoning.controlType, "effort");
  assert.deepEqual(normalizedReasoning.levels, ["low", "medium", "high"]);
  assert.equal(normalizedReasoning.defaultLevel, "medium");
  assert.equal(normalizedReasoning.maxTokens, 32000);
  assert.equal(normalizedReasoning.maxOutputTokens, 32000);
  assert.equal(normalizedReasoning.mappingConfidence, "high");
  assert.equal(normalizedReasoning.canDisable, true);
  const normalizedCache = resolveCache(current, model);
  assert.equal(normalizedCache.prompt, false);
  assert.equal(normalizedCache.context, false);
  assert.equal(normalizedCache.kv, false);
  assert.equal(normalizedCache.readPricing, true);
  assert.equal(normalizedCache.writePricing, true);
  assert.equal(normalizedCache.strategy, "model");
  assert.deepEqual(normalizedCache.capability, { prompt: false, context: false, kv: false });
  assert.deepEqual(normalizedCache.pricing, { read: true, write: true });
  assert.equal(normalizedCache.source, "models.dev");
  assert.equal(normalizedCache.confidence, "medium");
  const budget = richCatalog().providers.anthropic.models["claude-budget"];
  const budgetReasoning = resolveReasoning(richCatalog().providers.anthropic, budget);
  assert.equal(budgetReasoning.controlType, "budget");
  assert.equal(budgetReasoning.budgetTokens, 16000);
  assert.equal(budgetReasoning.minBudgetTokens, 1024);
  const budgetModel = toPiModel(richCatalog().providers.anthropic, budget);
  assert.deepEqual(budgetModel.compat?.thinkingConfig, { type: "enabled", budget_tokens: 16000 });
  assert.equal(budgetModel.compat?.supportsReasoningBudget, true);
  assert.equal(budgetModel.thinkingLevelMap?.high, "12256");
  assert.equal(budgetModel.thinkingLevelMap?.xhigh, undefined);
  assert.equal(budgetModel.thinkingLevelMap?.max, undefined);
  const google = richCatalog().providers.google;
  const googleModel = toPiModel(google, google.models["gemini-budget"]);
  assert.deepEqual(googleModel.compat?.thinkingConfig, { includeThoughts: true, thinkingBudget: 8192 });
  const toggle = resolveReasoning(undefined, { id: "toggle", reasoning: true });
  assert.equal(toggle.controlType, "toggle");
  const explicitToggle = resolveReasoning(undefined, { id: "explicit-toggle", reasoning: true, reasoning_options: [{ type: "toggle", values: ["disabled", "enabled"] }] });
  assert.equal(explicitToggle.toggleOnValue, "enabled");
  assert.equal(explicitToggle.toggleOffValue, "disabled");
  assert.deepEqual(toPiModel({ id: "custom", models: {} }, { id: "explicit-toggle", reasoning: true, reasoning_options: [{ type: "toggle", values: ["disabled", "enabled"] }] }).thinkingLevelMap, { off: "disabled", minimal: "enabled", low: "enabled", medium: "enabled", high: "enabled" });
  const adaptive = resolveReasoning(richCatalog().providers.anthropic, { id: "adaptive", reasoning: true, reasoning_options: [{ type: "adaptive" }] });
  assert.equal(adaptive.controlType, "adaptive");
  const adaptiveModel = toPiModel(richCatalog().providers.anthropic, { id: "adaptive", reasoning: true, reasoning_options: [{ type: "adaptive" }] });
  assert.deepEqual(adaptiveModel.compat?.thinkingConfig, { type: "adaptive" });
  assert.equal(adaptiveModel.compat?.forceAdaptiveThinking, true);
  const unknown = resolveReasoning(undefined, { id: "unknown", reasoning: true, reasoning_options: [{ type: "mystery" }] });
  assert.equal(unknown.fallback, true);
  const openAiBudget = toPiModel(
    { id: "openai-compatible", api: "https://proxy.example/v1", models: {} },
    { id: "openai-budget", reasoning: true, reasoning_options: [{ type: "budget", min: 256, max: 4096 }] },
  );
  assert.deepEqual(openAiBudget.compat?.thinkingConfig, {
    reasoning_effort: "medium",
    reasoning_budget_tokens: 4096,
  });
  const unknownModel = toPiModel(richCatalog().providers.unknown, richCatalog().providers.unknown.models["unknown-thinking"]);
  assert.equal(unknownModel.compat?.reasoningFallback, true);
  assert.match((unknownModel.compat?.reasoningWarnings ?? []).join(" "), /unknown/i);
  const piModel = toPiModel(current, model, { now: new Date("2026-08-01T00:00:00.000Z") });
  assert.equal(piModel.reasoning, true);
  assert.equal(piModel.contextWindow, 200000);
  assert.deepEqual(piModel.thinkingLevelMap, { minimal: null, low: "low", medium: "medium", high: "high" });
});

test("resolves provider adapters and independent cache capabilities", () => {
  const rich = richCatalog();
  const anthropicProvider = rich.providers.anthropic;
  const anthropicModel = anthropicProvider.models["claude-budget"];
  const cache = resolveCache(anthropicProvider, anthropicModel);
  assert.equal(cache.context, true);
  assert.equal(cache.kv, true);
  const compat = capabilityCompat("anthropic-messages", cache, resolveReasoning(anthropicProvider, anthropicModel), anthropicModel, "anthropic");
  assert.equal(compat?.supportsPromptCaching, false);
  assert.equal(compat?.supportsContextCaching, false);
  assert.equal(compat?.supportsKvCache, false);
  assert.equal(compat?.cacheControlFormat, undefined);
  assert.equal(compat?.cacheResolution?.context, "advisory");
  assert.equal(compat?.cacheResolution?.kv, "advisory");
  assert.ok((compat?.cacheWarnings?.length ?? 0) > 0);
  assert.equal(resolveProviderAdapter({ id: "deepseek", models: {} }).thinkingFormat, "deepseek");
  assert.equal(resolveProviderAdapter({ id: "google", models: {} }).id, "google");
  assert.equal(defaultPolicyCatalog().schemaVersion, 1);
  assert.equal(compat?.cacheCapabilities?.prompt, false);
  assert.equal(compat?.cacheCapabilities?.context, true);
  assert.equal(compat?.cacheCapabilities?.readPricing, false);
  assert.equal(compat?.cacheCapabilities?.kv, true);
  assert.deepEqual(compat?.cacheResolution?.pricing, { read: false, write: false });
  assert.equal(compat?.cacheResolution?.source, "models.dev");
});

test("matches provider URL/model name and lists explicit candidates", () => {
  const matches = ModelsDevClient.match(catalog(), "https://api.openai.com/v1", "GPT Test");
  assert.equal(matches[0]?.provider.id, "openai");
  assert.equal(matches[0]?.model?.id, "gpt-test");
  const rootMatches = ModelsDevClient.match(catalog(), "https://api.openai.com", "gpt-test");
  assert.equal(rootMatches[0]?.provider.id, "openai");
  assert.equal(rootMatches[0]?.model?.id, "gpt-test");
  const reverseCatalog = normalizeCatalog({
    openai: { id: "openai", api: "https://api.openai.com", models: { "gpt-test": { id: "gpt-test" } } },
  });
  const reverseMatches = ModelsDevClient.match(reverseCatalog, "https://api.openai.com/v1", "gpt-test", { allowPartialProvider: false, allowPartialModel: false });
  assert.equal(reverseMatches[0]?.provider.id, "openai");
  assert.equal(reverseMatches[0]?.model?.id, "gpt-test");
  assert.deepEqual(ModelsDevClient.listCandidates(catalog(), "openai").map((item) => item.id), ["gpt-test"]);
  assert.equal(ModelsDevClient.listCandidates(catalog(), "openai")[0]?.confidence, "high");
  assert.equal(ModelsDevClient.find(catalog(), "openai", "gpt")?.model, undefined);
});

test("normalizes custom channel endpoints from resolved API type", async () => {
  assert.equal(normalizeEndpointForApi("https://gateway.example", "openai-completions"), "https://gateway.example/v1");
  assert.equal(normalizeEndpointForApi("https://gateway.example/", "openai-responses"), "https://gateway.example/v1");
  assert.equal(normalizeEndpointForApi("https://gateway.example/v1", "openai-completions"), "https://gateway.example/v1");
  assert.equal(normalizeEndpointForApi("https://gateway.example/custom", "openai-completions"), "https://gateway.example/custom");
  assert.equal(normalizeEndpointForApi("https://gateway.example?route=chat", "openai-completions"), "https://gateway.example/v1?route=chat");
  assert.equal(normalizeEndpointForApi("https://gateway.example#chat", "openai-completions"), "https://gateway.example/v1#chat");
  assert.equal(normalizeEndpointForApi("https://gateway.example", "anthropic-messages"), "https://gateway.example");
  assert.equal(normalizeEndpointForApi("https://gateway.example", "google-generative-ai"), "https://gateway.example");
  assert.equal(endpointApiForModel(catalog().providers.openai, "https://gateway.example"), "openai-completions");
  assert.equal(endpointApiForModel(richCatalog().providers.anthropic, "https://gateway.example"), "anthropic-messages");
  assert.equal(endpointApiForModel(richCatalog().providers.google, "https://gateway.example"), "google-generative-ai");
  assert.equal(endpointApiForModel(richCatalog().providers.anthropic, "https://gateway.example", "openai-completions"), "openai-completions");
  assert.equal(endpointApiForModel(undefined, "https://gateway.example"), undefined);
});

test("adds or preserves channel URL versions from the resolved model API", async () => {
  const openAiRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-endpoint-openai-root-"));
  const openAiDoctor = new ModelDoctor({ paths: paths(openAiRoot), fetcher: { fetchImpl: fetchMock(catalog()) } });
  const openAi = await openAiDoctor.proposeAdd({ target: "https://gateway.example", modelId: "gpt-test", persistCache: false });
  assert.equal(openAi.config.providers?.gateway?.baseUrl, "https://gateway.example/v1");
  await openAiDoctor.applyAdd(openAi);
  assert.equal((await readModelsJson(paths(openAiRoot).modelsPath)).data.providers?.gateway?.baseUrl, "https://gateway.example/v1");

  const anthropicRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-endpoint-anthropic-root-"));
  const anthropicDoctor = new ModelDoctor({ paths: paths(anthropicRoot), fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const anthropic = await anthropicDoctor.proposeAdd({ target: "https://custom-anthropic-gateway.example", modelId: "claude-budget", persistCache: false });
  assert.equal(anthropic.config.providers?.[anthropic.providerId]?.baseUrl, "https://custom-anthropic-gateway.example");
  assert.equal(anthropic.config.providers?.[anthropic.providerId]?.api, "anthropic-messages");
  const genericAnthropic = await anthropicDoctor.proposeAdd({ target: "https://custom-gateway.example", modelId: "claude-budget", persistCache: false });
  assert.equal(genericAnthropic.config.providers?.[genericAnthropic.providerId]?.baseUrl, "https://custom-gateway.example");
  assert.equal(genericAnthropic.config.providers?.[genericAnthropic.providerId]?.api, "openai-completions");
  const google = await anthropicDoctor.proposeAdd({ target: "https://custom-google-gateway.example", modelId: "gemini-budget", persistCache: false });
  assert.equal(google.config.providers?.[google.providerId]?.baseUrl, "https://custom-google-gateway.example");

  const explicitOpenAi = await anthropicDoctor.proposeAdd({ target: "https://custom-gateway.example", modelId: "claude-budget", api: "openai-completions", persistCache: false });
  assert.equal(explicitOpenAi.config.providers?.[explicitOpenAi.providerId]?.baseUrl, "https://custom-gateway.example/v1");
  assert.equal(explicitOpenAi.config.providers?.[explicitOpenAi.providerId]?.api, "openai-completions");

  const explicitPath = await openAiDoctor.proposeAdd({ target: "https://gateway.example/custom/", modelId: "gpt-test", persistCache: false });
  assert.equal(explicitPath.config.providers?.[explicitPath.providerId]?.baseUrl, "https://gateway.example/custom/");
  const queryPath = await openAiDoctor.proposeAdd({ target: "https://gateway.example?route=chat", modelId: "gpt-test", persistCache: false });
  assert.equal(queryPath.config.providers?.[queryPath.providerId]?.baseUrl, "https://gateway.example/v1?route=chat");
  const fragmentRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-endpoint-fragment-root-"));
  const fragmentDoctor = new ModelDoctor({ paths: paths(fragmentRoot), fetcher: { fetchImpl: fetchMock(catalog()) } });
  const fragmentPath = await fragmentDoctor.proposeAdd({ target: "https://fragment-gateway.example#chat", modelId: "gpt-test", persistCache: false });
  assert.equal(fragmentPath.config.providers?.[fragmentPath.providerId]?.baseUrl, "https://fragment-gateway.example/v1#chat");

  const providerOnly = await fragmentDoctor.proposeAdd({ target: "https://provider-only.example", persistCache: false });
  assert.equal(providerOnly.config.providers?.[providerOnly.providerId]?.baseUrl, "https://provider-only.example");
});

test("supports direct provider-id endpoint model setup with URL versioning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-endpoint-provider-id-"));
  const doctor = new ModelDoctor({ paths: paths(root), fetcher: { fetchImpl: fetchMock(catalog()) } });
  const proposal = await doctor.proposeAdd({ target: "https://provider-id.example/", providerId: "providerA", modelId: "gpt-test", persistCache: false });
  assert.equal(proposal.providerId, "providerA");
  assert.equal(proposal.config.providers?.providerA?.baseUrl, "https://provider-id.example/v1");
  assert.equal(proposal.config.providers?.providerA?.models?.[0]?.id, "gpt-test");

  const alreadyVersioned = await doctor.proposeAdd({ target: "https://already-versioned.example/v1/", providerId: "providerB", modelId: "gpt-test", persistCache: false });
  assert.equal(alreadyVersioned.config.providers?.providerB?.baseUrl, "https://already-versioned.example/v1/");

  const existingRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-endpoint-existing-root-"));
  const existingPaths = paths(existingRoot);
  await writeFile(existingPaths.modelsPath, JSON.stringify({ providers: { providerD: { baseUrl: "https://existing.example/v1", api: "openai-completions", models: [] } } }));
  const existingDoctor = new ModelDoctor({ paths: existingPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const existing = await existingDoctor.proposeAdd({ target: "https://existing.example", providerId: "providerD", modelId: "gpt-test", persistCache: false });
  assert.equal(existing.config.providers?.providerD?.baseUrl, "https://existing.example/v1");
  assert.equal(existing.config.providers?.providerD?.models?.[0]?.id, "gpt-test");

  const responses = await doctor.proposeAdd({ target: "https://responses.example", providerId: "providerC", modelId: "gpt-test", api: "openai-responses", persistCache: false });
  assert.equal(responses.config.providers?.providerC?.baseUrl, "https://responses.example/v1");
  assert.equal(responses.config.providers?.providerC?.api, "openai-responses");
});

test("rejects ambiguous model discovery instead of selecting a catalog entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-ambiguous-"));
  const targetPaths = paths(root);
  const ambiguous = normalizeCatalog({
    openai: { id: "openai", models: { shared: { id: "shared", name: "Shared" } } },
    anthropic: { id: "anthropic", models: { shared: { id: "shared", name: "Shared" } } },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(ambiguous) } });
  await assert.rejects(() => doctor.proposeAdd({ target: "shared", persistCache: false }), (error: unknown) => error instanceof DoctorError && error.code === "selection-required");
});

test("uses official model metadata for an unlisted third-party channel without replacing transport fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-third-party-channel-"));
  const targetPaths = paths(root);
  const officialCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      name: "OpenAI",
      api: "https://api.openai.com/v1",
      models: { "gpt-test": { id: "gpt-test", reasoning: true, limit: { context: 200000, output: 32000 } } },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(officialCatalog) } });
  const proposal = await doctor.proposeAdd({ target: "https://third-party.example/v1", modelId: "gpt-test", persistCache: false });
  assert.equal(proposal.metadataOnly, true);
  assert.equal(proposal.metadataProviderId, "openai");
  assert.equal(proposal.providerId, "third-party");
  assert.equal(proposal.config.providers?.[proposal.providerId]?.baseUrl, "https://third-party.example/v1");
  assert.equal(proposal.config.providers?.[proposal.providerId]?.api, "openai-completions");
  assert.equal(proposal.config.providers?.[proposal.providerId]?.models?.[0]?.contextWindow, 200000);
  assert.equal(proposal.config.providers?.[proposal.providerId]?.models?.[0]?.compat?.metadataOnly, true);
  assert.equal(proposal.config.providers?.[proposal.providerId]?.models?.[0]?.compat?.metadataProviderId, "openai");
  assert.equal(proposal.config.providers?.[proposal.providerId]?.apiKey, undefined);
  await doctor.applyAdd(proposal);
  const checked = await doctor.check(`${proposal.providerId}/${proposal.modelId}`);
  assert.equal(checked.findings.some((item) => item.code === "third-party-channel"), true);
  assert.equal(checked.findings.some((item) => item.code === "endpoint-mismatch"), false);
  assert.equal((await readModelsJson(targetPaths.modelsPath)).data.providers?.[proposal.providerId]?.baseUrl, "https://third-party.example/v1");
});

test("automatically uses the official metadata provider for an unlisted channel", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-third-party-official-metadata-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      wong: {
        baseUrl: "https://wong.example/v1",
        api: "openai-completions",
        apiKey: "$WONG_API_KEY",
        headers: { "user-agent": "keep" },
        models: [],
      },
    },
  }));
  const duplicateCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      models: { "gpt-official": { id: "gpt-official", limit: { context: 200000 } } },
    },
    gateway: {
      id: "gateway",
      npm: "@ai-sdk/openai-compatible",
      api: "https://gateway.example/v1",
      models: {
        "gpt-official": {
          id: "gpt-official",
          provider: { npm: "@ai-sdk/openai" },
          limit: { context: 100000 },
        },
      },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(duplicateCatalog) } });
  const proposal = await doctor.proposeAdd({ target: "wong", modelId: "gpt-official", persistCache: false });
  assert.equal(proposal.metadataProviderId, "openai");
  assert.equal(proposal.matchedBy.includes("official-metadata-provider"), true);
  assert.equal(proposal.config.providers?.wong?.models?.[0]?.contextWindow, 200000);
  assert.equal(proposal.config.providers?.wong?.baseUrl, "https://wong.example/v1");
  assert.equal(proposal.config.providers?.wong?.apiKey, "$WONG_API_KEY");
  assert.deepEqual(proposal.config.providers?.wong?.headers, { "user-agent": "keep" });

  const implicitCatalog = normalizeCatalog({
    anthropic: {
      id: "anthropic",
      npm: "@ai-sdk/anthropic",
      api: "https://api.anthropic.com",
      models: { "claude-official": { id: "claude-official", limit: { context: 300000 } } },
    },
    gateway: {
      id: "gateway",
      npm: "@ai-sdk/openai-compatible",
      api: "https://gateway.example/v1",
      models: { "claude-official": { id: "claude-official", limit: { context: 100000 } } },
    },
  });
  const implicitDoctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(implicitCatalog) } });
  const implicit = await implicitDoctor.proposeAdd({ target: "wong", modelId: "claude-official", persistCache: false });
  assert.equal(implicit.metadataProviderId, "anthropic");
  assert.equal(implicit.config.providers?.wong?.models?.[0]?.contextWindow, 300000);
});

test("requires an explicit metadata provider when a third-party model id is ambiguous", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-third-party-ambiguous-"));
  const targetPaths = paths(root);
  const ambiguousCatalog = normalizeCatalog({
    openai: { id: "openai", api: "https://api.openai.com/v1", models: { shared: { id: "shared", limit: { context: 1000 } } } },
    anthropic: { id: "anthropic", api: "https://api.anthropic.com", models: { shared: { id: "shared", limit: { context: 2000 } } } },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(ambiguousCatalog) } });
  await assert.rejects(
    () => doctor.proposeAdd({ target: "https://third-party.example/v1", modelId: "shared", persistCache: false }),
    (error: unknown) => error instanceof DoctorError && error.code === "selection-required",
  );
  const selected = await doctor.proposeAdd({ target: "https://third-party.example/v1", modelId: "shared", metadataProvider: "anthropic", persistCache: false });
  assert.equal(selected.metadataProviderId, "anthropic");
  assert.equal(selected.config.providers?.[selected.providerId]?.models?.[0]?.contextWindow, 2000);
});

test("preserves third-party headers and credentials while adding metadata-only models", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-third-party-owned-transport-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      gateway: {
        baseUrl: "https://gateway.example/v1",
        api: "openai-completions",
        apiKey: "$GATEWAY_API_KEY",
        headers: { "x-gateway-mode": "keep" },
        models: [],
      },
    },
  }, null, 2));
  const officialCatalog = normalizeCatalog({
    anthropic: {
      id: "anthropic",
      api: "https://api.anthropic.com",
      models: { "claude-test": { id: "claude-test", reasoning: true, limit: { context: 120000, output: 16000 } } },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(officialCatalog) } });
  const proposal = await doctor.proposeAdd({ target: "https://gateway.example/v1", modelId: "claude-test", api: "openai-completions", persistCache: false });
  assert.equal(proposal.providerId, "gateway");
  await doctor.applyAdd(proposal);
  const persisted = await readModelsJson(targetPaths.modelsPath);
  const provider = persisted.data.providers?.gateway;
  assert.equal(provider?.apiKey, "$GATEWAY_API_KEY");
  assert.deepEqual(provider?.headers, { "x-gateway-mode": "keep" });
  assert.equal(provider?.baseUrl, "https://gateway.example/v1");
  assert.equal(provider?.api, "openai-completions");
  assert.equal(provider?.models?.[0]?.compat?.metadataProviderId, "anthropic");
});

test("third-party API overrides survive metadata-only check and fix", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-third-party-api-"));
  const targetPaths = paths(root);
  const officialCatalog = normalizeCatalog({
    anthropic: {
      id: "anthropic",
      api: "https://api.anthropic.com",
      models: { "claude-test": { id: "claude-test", reasoning: true, limit: { context: 120000, output: 16000 } } },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(officialCatalog) } });
  const added = await doctor.proposeAdd({
    target: "https://gateway.example/v1",
    modelId: "claude-test",
    api: "openai-completions",
    persistCache: false,
  });
  assert.equal(added.config.providers?.[added.providerId]?.api, "openai-completions");
  assert.equal(added.config.providers?.[added.providerId]?.models?.[0]?.api, "openai-completions");
  await doctor.applyAdd(added);
  const checked = await doctor.check(`${added.providerId}/${added.modelId}`);
  assert.equal(checked.findings.some((item) => item.code === "third-party-channel"), true);
  assert.equal(checked.findings.some((item) => item.code === "api-mismatch"), false);
  const fixed = await doctor.proposeFix(`${added.providerId}/${added.modelId}`, { persistCache: false });
  assert.equal(fixed.result.findings.some((item) => item.code === "api-mismatch"), false);
  assert.equal(fixed.result.plan?.changes.some((change) => /\.api$/.test(change.path)), false);
  const persisted = await readModelsJson(targetPaths.modelsPath);
  const provider = persisted.data.providers?.[added.providerId];
  assert.equal(provider?.api, "openai-completions");
  assert.equal(provider?.models?.[0]?.api, "openai-completions");
  assert.ok(provider?.headers === undefined);
});

test("sync prepares and applies multiple selected models with one backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-sync-service-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: { other: { models: [{ id: "keep", custom: true }] } },
    customTopLevel: { keep: true },
  }, null, 2));
  const multiCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      name: "OpenAI",
      api: "https://api.openai.com/v1",
      models: {
        "gpt-one": { id: "gpt-one", limit: { context: 100000, output: 8000 } },
        "gpt-two": { id: "gpt-two", limit: { context: 200000, output: 16000 } },
      },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(multiCatalog) } });
  const proposal = await doctor.proposeSync({ target: "openai", modelIds: ["gpt-one", "gpt-two"], persistCache: false });
  assert.deepEqual(proposal.modelIds, ["gpt-one", "gpt-two"]);
  assert.equal(proposal.config.providers?.openai?.models?.length, 2);
  assert.equal(proposal.config.providers?.other?.models?.[0]?.id, "keep");
  assert.equal((proposal.config.customTopLevel as { keep?: boolean }).keep, true);
  assert.equal(proposal.plan.changes.length > 0, true);
  const applied = await doctor.applySync(proposal);
  assert.ok(applied.backupPath);
  const saved = await readModelsJson(targetPaths.modelsPath);
  assert.deepEqual(saved.data.providers?.openai?.models?.map((model) => model.id), ["gpt-one", "gpt-two"]);
  assert.equal(saved.data.providers?.other?.models?.[0]?.id, "keep");
  assert.equal((await readdir(root)).filter((file) => file.startsWith("models.json.bak-")).length, 1);
});

test("sync dry-run and headless authorization are side-effect safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-sync-command-"));
  const targetPaths = paths(root);
  const multiCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      api: "https://api.openai.com/v1",
      models: {
        "gpt-one": { id: "gpt-one" },
        "gpt-two": { id: "gpt-two" },
      },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(multiCatalog) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("sync openai --models gpt-one", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /requires --yes/);
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
  await runCommand("sync openai --models gpt-one,gpt-two --yes --dry-run", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /not-persisted \(dry-run\)/);
  await assert.rejects(() => readFile(targetPaths.modelsCachePath));
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("interactive sync selects several models and supports Done", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-sync-ui-"));
  const targetPaths = paths(root);
  const multiCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      api: "https://api.openai.com/v1",
      models: {
        "gpt-one": { id: "gpt-one" },
        "gpt-two": { id: "gpt-two" },
      },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(multiCatalog) } });
  const notifications: string[] = [];
  let selections = 0;
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (_prompt: string, choices: string[]) => {
        selections += 1;
        return selections <= 2 ? choices[0] : choices.at(-1);
      },
      confirm: async () => true,
    },
  } as never;
  await runCommand("sync openai", ctx, doctor);
  const saved = await readModelsJson(targetPaths.modelsPath);
  assert.deepEqual(saved.data.providers?.openai?.models?.map((model) => model.id), ["gpt-one", "gpt-two"]);
  assert.match(notifications.at(-1) ?? "", /Synced/);
});

test("interactive sync cancellation after selection does not write", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-sync-ui-cancel-"));
  const targetPaths = paths(root);
  const multiCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      api: "https://api.openai.com/v1",
      models: {
        "gpt-one": { id: "gpt-one" },
        "gpt-two": { id: "gpt-two" },
      },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(multiCatalog) } });
  const notifications: string[] = [];
  let selections = 0;
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (_prompt: string, choices: string[]) => {
        selections += 1;
        return selections === 1 ? choices[0] : undefined;
      },
      confirm: async () => true,
    },
  } as never;
  await runCommand("sync openai", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /Sync cancelled.*not-persisted/s);
  await assert.rejects(() => readFile(targetPaths.modelsPath));
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("adds a provider-only entry when a URL is given without a model id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const proposal = await doctor.proposeAdd({ target: "https://gateway.example/v1", persistCache: false });
  assert.equal(proposal.modelId, "");
  assert.equal(proposal.providerId, "gateway");
  assert.equal(proposal.config.providers?.gateway?.baseUrl, "https://gateway.example/v1");
  assert.equal(proposal.config.providers?.gateway?.models?.length, 0);
  assert.equal(proposal.config.providers?.gateway?.api, "openai-completions");
  await doctor.applyAdd(proposal);
  const saved = await readModelsJson(targetPaths.modelsPath);
  assert.equal(saved.data.providers?.gateway?.models?.length, 0);
  assert.equal(saved.data.providers?.gateway?.baseUrl, "https://gateway.example/v1");

  // A provider-only root endpoint is intentionally left unversioned until the
  // first model is resolved; adding that model then normalizes it.
  const pendingRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-pending-root-"));
  const pendingPaths = paths(pendingRoot);
  const pendingDoctor = new ModelDoctor({ paths: pendingPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const pending = await pendingDoctor.proposeAdd({ target: "https://pending.example", persistCache: false });
  assert.equal(pending.config.providers?.pending?.baseUrl, "https://pending.example");
  await pendingDoctor.applyAdd(pending);
  const resolved = await pendingDoctor.proposeAdd({ target: "pending", modelId: "gpt-test", persistCache: false });
  assert.equal(resolved.config.providers?.pending?.baseUrl, "https://pending.example/v1");
  assert.equal(resolved.plan.changes.some((change) => change.path === "providers.pending.baseUrl"), true);
  await pendingDoctor.applyAdd(resolved);
  const pendingSaved = (await readModelsJson(pendingPaths.modelsPath)).data;
  assert.equal(pendingSaved.providers?.pending?.baseUrl, "https://pending.example/v1");
  assert.equal(pendingSaved.providers?.pending?._piModelDoctor?.endpointNormalizationPending, false);
  assert.equal(pendingSaved.providers?.pending?._piModelDoctor?.endpointApiHint, undefined);
  const pendingCheck = await pendingDoctor.check("pending/gpt-test");
  assert.equal(pendingCheck.findings.some((finding) => finding.code === "endpoint-mismatch"), false);

  const pendingSyncRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-pending-sync-"));
  const pendingSyncDoctor = new ModelDoctor({ paths: paths(pendingSyncRoot), fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const pendingSync = await pendingSyncDoctor.proposeAdd({ target: "https://pending-sync.example", persistCache: false });
  await pendingSyncDoctor.applyAdd(pendingSync);
  const pendingSyncProposal = await pendingSyncDoctor.proposeSync({ target: "pending-sync", modelIds: ["claude-budget"], persistCache: false });
  assert.equal(pendingSyncProposal.config.providers?.["pending-sync"]?.api, "anthropic-messages");
  assert.equal(pendingSyncProposal.config.providers?.["pending-sync"]?.baseUrl, "https://pending-sync.example");
  assert.equal(pendingSyncProposal.config.providers?.["pending-sync"]?._piModelDoctor?.endpointNormalizationPending, false);
  await pendingSyncDoctor.applySync(pendingSyncProposal);
  const pendingSyncCheck = await pendingSyncDoctor.check("pending-sync/claude-budget");
  assert.equal(pendingSyncCheck.findings.some((finding) => finding.code === "api-mismatch" || finding.code === "endpoint-mismatch"), false);

  const pendingAnthropicRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-pending-anthropic-"));
  const pendingAnthropicDoctor = new ModelDoctor({ paths: paths(pendingAnthropicRoot), fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const pendingAnthropic = await pendingAnthropicDoctor.proposeAdd({ target: "https://pending-anthropic.example", persistCache: false });
  await pendingAnthropicDoctor.applyAdd(pendingAnthropic);
  const resolvedAnthropic = await pendingAnthropicDoctor.proposeAdd({ target: "pending-anthropic", modelId: "claude-budget", persistCache: false });
  assert.equal(resolvedAnthropic.config.providers?.[resolvedAnthropic.providerId]?.api, "anthropic-messages");
  assert.equal(resolvedAnthropic.config.providers?.[resolvedAnthropic.providerId]?.baseUrl, "https://pending-anthropic.example");
  assert.equal(resolvedAnthropic.plan.changes.some((change) => change.path.endsWith(".baseUrl")), false);

  const explicitTransportRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-explicit-api-"));
  const explicitTransportDoctor = new ModelDoctor({ paths: paths(explicitTransportRoot), fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const explicitTransport = await explicitTransportDoctor.proposeAdd({ target: "https://explicit-transport.example", api: "anthropic-messages", persistCache: false });
  await explicitTransportDoctor.applyAdd(explicitTransport);
  const resolvedExplicitTransport = await explicitTransportDoctor.proposeAdd({ target: "explicit-transport", modelId: "gpt-test", persistCache: false });
  assert.equal(resolvedExplicitTransport.config.providers?.[resolvedExplicitTransport.providerId]?.api, "anthropic-messages");
  assert.equal(resolvedExplicitTransport.config.providers?.[resolvedExplicitTransport.providerId]?.baseUrl, "https://explicit-transport.example");
  assert.equal(resolvedExplicitTransport.plan.changes.some((change) => change.path.endsWith(".baseUrl")), false);

  const userChangedApiRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-user-api-"));
  const userChangedApiPaths = paths(userChangedApiRoot);
  const userChangedApiDoctor = new ModelDoctor({ paths: userChangedApiPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const userChangedApi = await userChangedApiDoctor.proposeAdd({ target: "https://user-api.example", persistCache: false });
  await userChangedApiDoctor.applyAdd(userChangedApi);
  const userChangedApiConfig = await readModelsJson(userChangedApiPaths.modelsPath);
  userChangedApiConfig.data.providers?.["user-api"] && (userChangedApiConfig.data.providers["user-api"].api = "google-generative-ai");
  await writeFile(userChangedApiPaths.modelsPath, JSON.stringify(userChangedApiConfig.data));
  const resolvedUserChangedApi = await userChangedApiDoctor.proposeAdd({ target: "user-api", modelId: "gpt-test", persistCache: false });
  assert.equal(resolvedUserChangedApi.config.providers?.["user-api"]?.api, "google-generative-ai");
  assert.equal(resolvedUserChangedApi.config.providers?.["user-api"]?.baseUrl, "https://user-api.example");
  assert.equal(resolvedUserChangedApi.plan.changes.some((change) => change.path.endsWith(".api") || change.path.endsWith(".baseUrl")), false);
  assert.equal(resolvedUserChangedApi.plan.conflicts.some((finding) => finding.code === "api-mismatch"), true);
  assert.equal(resolvedUserChangedApi.config.providers?.["user-api"]?._piModelDoctor?.endpointApiNormalizationBlocked, true);
  await userChangedApiDoctor.applyAdd(resolvedUserChangedApi);
  const userChangedApiCheck = await userChangedApiDoctor.check("user-api/gpt-test");
  assert.equal(userChangedApiCheck.findings.some((finding) => finding.code === "api-mismatch" && finding.userOwned === true), true);
  const userChangedApiFix = await userChangedApiDoctor.proposeFix("user-api/gpt-test", { persistCache: false, dryRun: true });
  assert.equal(userChangedApiFix.result.plan?.changes.some((change) => change.path.endsWith(".api")), false);

  const userChangedEndpointRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-user-endpoint-"));
  const userChangedEndpointPaths = paths(userChangedEndpointRoot);
  const userChangedEndpointDoctor = new ModelDoctor({ paths: userChangedEndpointPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const userChangedEndpoint = await userChangedEndpointDoctor.proposeAdd({ target: "https://original-endpoint.example", persistCache: false });
  await userChangedEndpointDoctor.applyAdd(userChangedEndpoint);
  const userChangedEndpointConfig = await readModelsJson(userChangedEndpointPaths.modelsPath);
  userChangedEndpointConfig.data.providers?.["original-endpoint"] && (userChangedEndpointConfig.data.providers["original-endpoint"].baseUrl = "https://user-proxy.example");
  await writeFile(userChangedEndpointPaths.modelsPath, JSON.stringify(userChangedEndpointConfig.data));
  const resolvedUserChangedEndpoint = await userChangedEndpointDoctor.proposeAdd({ target: "original-endpoint", modelId: "gpt-test", persistCache: false });
  assert.equal(resolvedUserChangedEndpoint.config.providers?.["original-endpoint"]?.baseUrl, "https://user-proxy.example");
  assert.equal(resolvedUserChangedEndpoint.plan.changes.some((change) => change.path.endsWith(".baseUrl")), false);
  assert.equal(resolvedUserChangedEndpoint.plan.conflicts.some((finding) => finding.code === "endpoint-mismatch"), true);
  await userChangedEndpointDoctor.applyAdd(resolvedUserChangedEndpoint);
  const userChangedEndpointCheck = await userChangedEndpointDoctor.check("original-endpoint/gpt-test");
  assert.equal(userChangedEndpointCheck.findings.some((finding) => finding.code === "endpoint-mismatch" && finding.userOwned === true), true);

  // Adding the same URL again without a model must not duplicate the provider.
  await assert.rejects(
    () => doctor.proposeAdd({ target: "https://gateway.example/v1", persistCache: false }),
    (error: unknown) => error instanceof DoctorError && /already configured/.test(error.message),
  );
  // Models can then be attached via add with an explicit model id.
  const withModel = await doctor.proposeAdd({ target: "https://gateway.example/v1", modelId: "gpt-test", persistCache: false });
  assert.equal(withModel.providerId, "gateway");
  assert.deepEqual(withModel.config.providers?.gateway?.models?.map((model) => model.id), ["gpt-test"]);
  await doctor.applyAdd(withModel);
  const updated = await readModelsJson(targetPaths.modelsPath);
  assert.equal(updated.data.providers?.gateway?.models?.length, 1);
  assert.equal(updated.data.providers?.gateway?.models?.[0]?.id, "gpt-test");
});

test("sync preserves pending channel transport conflicts and rejects mixed API protocols", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-sync-pending-transport-"));
  const targetPaths = paths(root);
  const syncCatalog = normalizeCatalog({
    openai: { id: "openai", api: "https://api.openai.com/v1", models: { "gpt-test": { id: "gpt-test" } } },
    anthropic: { id: "anthropic", api: "https://api.anthropic.com", models: { "claude-budget": { id: "claude-budget" } } },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(syncCatalog) } });
  await doctor.applyAdd(await doctor.proposeAdd({ target: "https://pending-sync.example", persistCache: false }));
  const changed = await readModelsJson(targetPaths.modelsPath);
  changed.data.providers?.["pending-sync"] && (changed.data.providers["pending-sync"].baseUrl = "https://user-sync-proxy.example");
  changed.data.providers?.["pending-sync"] && (changed.data.providers["pending-sync"].api = "google-generative-ai");
  await writeFile(targetPaths.modelsPath, JSON.stringify(changed.data));
  const proposal = await doctor.proposeSync({ target: "pending-sync", modelIds: ["gpt-test"], persistCache: false });
  assert.equal(proposal.config.providers?.["pending-sync"]?.baseUrl, "https://user-sync-proxy.example");
  assert.equal(proposal.config.providers?.["pending-sync"]?.api, "google-generative-ai");
  assert.equal(proposal.plan.changes.some((change) => change.path.endsWith(".baseUrl") || change.path.endsWith(".api")), false);
  assert.equal(proposal.plan.conflicts.some((finding) => finding.code === "endpoint-mismatch"), true);
  assert.equal(proposal.plan.conflicts.some((finding) => finding.code === "api-mismatch"), true);
  await doctor.applySync(proposal);
  const checked = await doctor.check("pending-sync/gpt-test");
  assert.equal(checked.findings.some((finding) => finding.code === "endpoint-mismatch" && finding.userOwned === true), true);
  assert.equal(checked.findings.some((finding) => finding.code === "api-mismatch" && finding.userOwned === true), true);
  const mixedRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-sync-pending-mixed-"));
  const mixedDoctor = new ModelDoctor({ paths: paths(mixedRoot), fetcher: { fetchImpl: fetchMock(syncCatalog) } });
  await mixedDoctor.applyAdd(await mixedDoctor.proposeAdd({ target: "https://pending-mixed.example", persistCache: false }));
  await assert.rejects(
    () => mixedDoctor.proposeSync({ target: "pending-mixed", modelIds: ["gpt-test", "claude-budget"], persistCache: false }),
    (error: unknown) => error instanceof DoctorError && /different channel API protocols/.test(error.message),
  );
});

test("explicit provider id plus endpoint creates a provider-only channel and supports later model add", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-explicit-provider-endpoint-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });

  const proposal = await doctor.proposeAdd({
    target: "https://test.example/v1",
    providerId: "providerA",
    apiKey: "$PROVIDER_A_KEY",
    persistCache: false,
  });
  assert.equal(proposal.providerId, "providerA");
  assert.equal(proposal.modelId, "");
  assert.equal(proposal.metadataOnly, true);
  assert.equal(proposal.config.providers?.providerA?.name, "providerA");
  assert.equal(proposal.config.providers?.providerA?.baseUrl, "https://test.example/v1");
  assert.equal(proposal.config.providers?.providerA?.apiKey, "$PROVIDER_A_KEY");
  assert.deepEqual(proposal.config.providers?.providerA?.models, []);
  await doctor.applyAdd(proposal);

  await assert.rejects(
    () => doctor.proposeAdd({ target: "https://different.example/v1", providerId: "providerA", persistCache: false }),
    (error: unknown) => error instanceof DoctorError && /already configured/.test(error.message),
  );
  await assert.rejects(
    () => doctor.proposeAdd({ target: "https://test.example/v1", providerId: "providerB", persistCache: false }),
    (error: unknown) => error instanceof DoctorError && /already configured/.test(error.message),
  );

  const withModel = await doctor.proposeAdd({ target: "providerA", modelId: "gpt-test", persistCache: false });
  assert.equal(withModel.providerId, "providerA");
  assert.equal(withModel.config.providers?.providerA?.baseUrl, "https://test.example/v1");
  assert.equal(withModel.plan.changes.some((change) => change.path === "providers.providerA.baseUrl"), false);
  assert.equal(withModel.config.providers?.providerA?.apiKey, "$PROVIDER_A_KEY");
  assert.equal(withModel.config.providers?.providerA?.models?.[0]?.id, "gpt-test");
  assert.equal(withModel.config.providers?.providerA?._piModelDoctor?.endpointApiHint, undefined);

  const direct = await doctor.proposeAdd({ target: "https://test.example/v1", providerId: "providerA", modelId: "gpt-test", persistCache: false });
  assert.equal(direct.providerId, "providerA");
  assert.equal(direct.modelId, "gpt-test");
  assert.equal(direct.metadataOnly, true);
  assert.equal(direct.config.providers?.providerA?.baseUrl, "https://test.example/v1");
  assert.equal(direct.config.providers?.providerA?.apiKey, "$PROVIDER_A_KEY");
  assert.equal(direct.config.providers?.providerA?.models?.[0]?.id, "gpt-test");

  const commandRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-explicit-provider-command-"));
  const commandDoctor = new ModelDoctor({ paths: paths(commandRoot), fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("add providerA https://test.example/v1 --yes --api-key $PROVIDER_A_KEY", ctx, commandDoctor);
  const commandSaved = await readModelsJson(paths(commandRoot).modelsPath);
  assert.equal(commandSaved.data.providers?.providerA?.baseUrl, "https://test.example/v1");
  assert.equal(commandSaved.data.providers?.providerA?.apiKey, "$PROVIDER_A_KEY");
  assert.match(notifications.at(-1) ?? "", /Applied/);

  const directCommandRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-direct-channel-command-"));
  const directCommandDoctor = new ModelDoctor({ paths: paths(directCommandRoot), fetcher: { fetchImpl: fetchMock(catalog()) } });
  const directNotifications: string[] = [];
  const directContext = { hasUI: false, ui: { notify: (message: string) => directNotifications.push(message) } } as never;
  await runCommand("add providerA https://test.example/v1 gpt-test --yes --api-key $PROVIDER_A_KEY", directContext, directCommandDoctor);
  const directSaved = await readModelsJson(paths(directCommandRoot).modelsPath);
  assert.equal(directSaved.data.providers?.providerA?.baseUrl, "https://test.example/v1");
  assert.equal(directSaved.data.providers?.providerA?.apiKey, "$PROVIDER_A_KEY");
  assert.equal(directSaved.data.providers?.providerA?.models?.[0]?.id, "gpt-test");
  assert.equal(directSaved.data.providers?.providerA?.models?.[0]?.compat?.metadataOnly, true);
  assert.match(directNotifications.at(-1) ?? "", /Applied/);
});

test("provider-only URL add accepts an API key reference and keeps official catalog identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-only-key-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const proposal = await doctor.proposeAdd({ target: "https://gateway.example/v1", apiKey: "$GATEWAY_API_KEY", persistCache: false });
  assert.equal(proposal.config.providers?.gateway?.apiKey, "$GATEWAY_API_KEY");
  const literal = await doctor.proposeAdd({ target: "https://gateway.example/v1", apiKey: "literal-secret", persistCache: false });
  assert.equal(literal.config.providers?.gateway?.apiKey, undefined);
  assert.match(literal.warning ?? "", /not persisted/);

  // An official models.dev endpoint URL keeps the catalog provider id.
  const official = await doctor.proposeAdd({ target: "https://api.openai.com/v1", persistCache: false });
  assert.equal(official.providerId, "openai");
  assert.equal(official.metadataOnly, false);
  assert.equal(official.config.providers?.openai?.baseUrl, "https://api.openai.com/v1");
});

test("preserves user-owned fields after managed metadata snapshot changes", () => {
  const model = {
    id: "gpt-test",
    contextWindow: 1000,
    _piModelDoctor: {
      managed: true as const,
      source: "models.dev",
      lastCheck: "2026-08-01",
      autoRepair: true,
      managedFields: ["contextWindow"],
      managedValues: { contextWindow: 2000 },
    },
  };
  assert.equal(canManageField(model, "contextWindow"), false);
  assert.equal(canManageField(model, "maxTokens"), true);
});

test("cache writes atomically, stores policy schema, and falls back to valid cached data", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-cache-"));
  const cache = new CacheStore(paths(root));
  await cache.writeModels(catalog());
  const loaded = await cache.readModels<ModelsDevCatalog>();
  assert.equal(Object.keys(loaded?.data.providers ?? {}).length, 1);
  await cache.writePolicyCatalog(defaultPolicyCatalog(new Date("2026-08-01T00:00:00.000Z")));
  assert.equal((await cache.readPolicyCatalog())?.schemaVersion, 1);
  assert.equal((await cache.readPolicyCatalog())?.baseline.piVersion, "0.82.1");
  assert.equal((await cache.readPolicyCatalog())?.baseline.modelsDevSchemaVersion, 1);
  const unavailable = new ModelsDevClient(cache, { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
  const result = await unavailable.load({ force: true });
  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.match(result.warning ?? "", /cached catalog/);
});

test("current models.dev metadata does not block unrelated model discovery and remains valid in cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-current-metadata-"));
  const targetPaths = paths(root);
  const rawCatalog = {
    wong: {
      id: "wong",
      models: {
        "gpt-5.6-sol": { id: "gpt-5.6-sol" },
      },
    },
    "cloudflare-workers-ai": {
      id: "cloudflare-workers-ai",
      models: {
        "@cf/nvidia/nemotron-3-120b-a12b": {
          id: "@cf/nvidia/nemotron-3-120b-a12b",
          interleaved: true,
        },
      },
    },
    nvidia: {
      id: "nvidia",
      models: {
        "nvidia/active-speaker-detection": {
          id: "nvidia/active-speaker-detection",
          limit: { context: 0, output: 4096 },
        },
        "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
          id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 32768 }],
        },
      },
    },
    "google-vertex": {
      id: "google-vertex",
      models: {
        "gemini-2.5-flash": {
          id: "gemini-2.5-flash",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", min: 0, max: 24576 }],
        },
      },
    },
    lynkr: {
      id: "lynkr",
      api: "http://127.0.0.1:8081/v1",
      models: { "lynkr-auto": { id: "lynkr-auto" } },
    },
    sarvam: {
      id: "sarvam",
      models: {
        "sarvam-105b": {
          id: "sarvam-105b",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: [null, "low", "medium", "high"] }],
        },
      },
    },
    "302ai": {
      id: "302ai",
      env: ["302AI_API_KEY"],
      models: { "gpt-test": { id: "gpt-test" } },
    },
    edenai: {
      id: "edenai",
      models: {
        "flexai/DeepSeek-V4-Flash-0731": { id: "flexai/DeepSeek-V4-Flash-0731" },
        "flexai/deepseek-v4-flash-0731": { id: "flexai/deepseek-v4-flash-0731" },
      },
    },
  };
  const online = new ModelsDevClient(new CacheStore(targetPaths), { fetchImpl: fetchMock(rawCatalog) });
  const loaded = await online.load({ force: true });
  assert.equal(loaded.source, "network");
  assert.equal(ModelsDevClient.find(loaded.catalog, "wong", "gpt-5.6-sol")?.model?.id, "gpt-5.6-sol");
  assert.equal(loaded.catalog.providers["cloudflare-workers-ai"].models["@cf/nvidia/nemotron-3-120b-a12b"].interleaved, true);
  assert.deepEqual(loaded.catalog.providers.nvidia.models["nvidia/active-speaker-detection"].limit, { context: 0, output: 4096 });
  assert.deepEqual(loaded.catalog.providers.nvidia.models["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"].reasoning_options, [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 32768 }]);
  assert.deepEqual(loaded.catalog.providers["google-vertex"].models["gemini-2.5-flash"].reasoning_options, [{ type: "toggle" }, { type: "budget_tokens", min: 0, max: 24576 }]);
  assert.equal(loaded.catalog.providers.lynkr.api, "http://127.0.0.1:8081/v1");
  assert.deepEqual(loaded.catalog.providers.sarvam.models["sarvam-105b"].reasoning_options, [{ type: "effort", values: [null, "low", "medium", "high"] }]);
  assert.deepEqual(loaded.catalog.providers["302ai"].env, ["302AI_API_KEY"]);
  assert.equal(Object.keys(loaded.catalog.providers.edenai.models).length, 2);
  assert.equal(ModelsDevClient.find(loaded.catalog, "edenai", "flexai/deepseek-v4-flash-0731")?.ambiguous, true);

  const cached = new ModelsDevClient(new CacheStore(targetPaths), { fetchImpl: (async () => { throw new Error("cache should be used"); }) as typeof fetch });
  const cachedResult = await cached.load();
  assert.equal(cachedResult.source, "cache");
  assert.equal(ModelsDevClient.find(cachedResult.catalog, "wong", "gpt-5.6-sol")?.model?.id, "gpt-5.6-sol");
  assert.equal(cachedResult.catalog.providers["cloudflare-workers-ai"].models["@cf/nvidia/nemotron-3-120b-a12b"].interleaved, true);
  assert.deepEqual(cachedResult.catalog.providers.nvidia.models["nvidia/active-speaker-detection"].limit, { context: 0, output: 4096 });
  assert.deepEqual(cachedResult.catalog.providers.nvidia.models["nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"].reasoning_options, [{ type: "toggle" }, { type: "budget_tokens", min: -1, max: 32768 }]);
  assert.deepEqual(cachedResult.catalog.providers["google-vertex"].models["gemini-2.5-flash"].reasoning_options, [{ type: "toggle" }, { type: "budget_tokens", min: 0, max: 24576 }]);
  assert.equal(cachedResult.catalog.providers.lynkr.api, "http://127.0.0.1:8081/v1");
  assert.deepEqual(cachedResult.catalog.providers.sarvam.models["sarvam-105b"].reasoning_options, [{ type: "effort", values: [null, "low", "medium", "high"] }]);
  assert.deepEqual(cachedResult.catalog.providers["302ai"].env, ["302AI_API_KEY"]);
  assert.equal(Object.keys(cachedResult.catalog.providers.edenai.models).length, 2);
  assert.equal(ModelsDevClient.find(cachedResult.catalog, "edenai", "flexai/deepseek-v4-flash-0731")?.ambiguous, true);
});

test("refresh uses conditional headers and reports configuration findings without writing models.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-refresh-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify(baseConfig(), null, 2));
  const initial = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog(), 200, { "content-type": "application/json", etag: "test-etag", "last-modified": "Wed, 01 Aug 2026 00:00:00 GMT" }) }, now: () => new Date("2026-08-01T00:00:00.000Z") });
  await initial.modelsDev.load({ force: true });
  const seen: RequestInit[] = [];
  const refreshDoctor = new ModelDoctor({
    paths: targetPaths,
    fetcher: {
      fetchImpl: (async (_url, init) => {
        seen.push(init ?? {});
        return new Response(null, { status: 304, headers: { etag: "test-etag" } });
      }) as typeof fetch,
    },
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  const before = await readFile(targetPaths.modelsPath, "utf8");
  const result = await refreshDoctor.refresh(true);
  assert.equal(result.source, "cache");
  assert.ok(result.findings.some((item) => item.code === "context-window-mismatch"));
  assert.equal(seen.length, 1);
  const headers = seen[0]?.headers as Record<string, string>;
  assert.equal(headers["if-none-match"], "test-etag");
  assert.equal(headers["if-modified-since"], "Wed, 01 Aug 2026 00:00:00 GMT");
  assert.equal(await readFile(targetPaths.modelsPath, "utf8"), before);
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("invalid cached catalogs are discarded and timeout remains typed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-invalid-cached-catalog-"));
  const targetPaths = paths(root);
  const cache = new CacheStore(targetPaths);
  await mkdir(targetPaths.doctorDir, { recursive: true });
  await writeFile(targetPaths.modelsCachePath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), data: { providers: { bad: { id: "bad", models: { model: { id: "model", limit: { output: -1 } } } } } } }));
  const client = new ModelsDevClient(cache, { timeoutMs: 1, fetchImpl: (async (_url, init) => await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  })) as typeof fetch });
  await assert.rejects(() => client.load({ force: true }), (error: unknown) => error instanceof ModelsDevError && error.code === "network-unavailable");
});

test("models.dev fails with typed errors when no valid cache exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-no-cache-"));
  const client = new ModelsDevClient(new CacheStore(paths(root)), { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
  await assert.rejects(() => client.load({ force: true }), (error: unknown) => error instanceof ModelsDevError && error.code === "network-unavailable");
  const invalidJson = new ModelsDevClient(new CacheStore(paths(await mkdtemp(join(tmpdir(), "pi-model-doctor-invalid-json-")))), { fetchImpl: (async () => new Response("not-json", { status: 200 })) as typeof fetch });
  await assert.rejects(() => invalidJson.load({ force: true }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  assert.throws(() => new ModelsDevClient(new CacheStore(paths(join(tmpdir(), "pi-model-doctor-private-endpoint"))), { endpoint: "http://0.0.0.0:8080/api.json" }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  assert.doesNotThrow(() => new ModelsDevClient(new CacheStore(paths(join(tmpdir(), "pi-model-doctor-trusted-endpoint"))), { endpoint: "https://10.0.0.1:8443/api.json", trustedEndpoint: true }));
});

test("forced refresh preserves stale cache when network is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-stale-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  await doctor.modelsDev.load({ force: true });
  const offline = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch } });
  const result = await offline.refresh(true);
  assert.equal(result.stale, true);
  assert.match(result.warning ?? "", /using cached catalog/);
});

test("network refresh preserves prior validators when a 200 response omits them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-cache-validator-preserve-"));
  const targetPaths = paths(root);
  const cache = new CacheStore(targetPaths);
  const first = new ModelsDevClient(cache, {
    fetchImpl: fetchMock(catalog(), 200, { "content-type": "application/json", etag: "old-etag", "last-modified": "Wed, 01 Aug 2026 00:00:00 GMT" }),
  });
  await first.load({ force: true });
  const seen: RequestInit[] = [];
  const second = new ModelsDevClient(cache, {
    fetchImpl: (async (_url, init) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify(catalog()), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  await second.load({ force: true });
  const headers = seen[0]?.headers as Record<string, string>;
  assert.equal(headers["if-none-match"], "old-etag");
  assert.equal(headers["if-modified-since"], "Wed, 01 Aug 2026 00:00:00 GMT");
  const stored = JSON.parse(await readFile(targetPaths.modelsCachePath, "utf8")) as { etag?: string; lastModified?: string };
  assert.equal(stored.etag, "old-etag");
  assert.equal(stored.lastModified, "Wed, 01 Aug 2026 00:00:00 GMT");
});

test("unsafe response validators are rejected without caching", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-unsafe-response-validator-"));
  const targetPaths = paths(root);
  const client = new ModelsDevClient(new CacheStore(targetPaths), {
    fetchImpl: (async () => new Response(JSON.stringify(catalog()), {
      status: 200,
      headers: { "content-type": "application/json", etag: "Bearer SECRET_TOKEN" },
    })) as typeof fetch,
  });
  await assert.rejects(
    () => client.load({ force: true }),
    (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog",
  );
  await assert.rejects(() => readFile(targetPaths.modelsCachePath));
  await assert.rejects(() => readFile(targetPaths.providersCachePath));
});

test("policy cache is read and used by capability fallback resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-policy-runtime-"));
  const targetPaths = paths(root);
  const policy = defaultPolicyCatalog();
  policy.fallback.reasoning.fallbackField = "customFallbackPolicy";
  const cache = new CacheStore(targetPaths);
  await cache.writePolicyCatalog(policy);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const proposal = await doctor.proposeAdd({ target: "unknown", modelId: "unknown-thinking", persistCache: false });
  assert.match((proposal.config.providers?.unknown?.models?.[0]?.compat?.reasoningWarnings ?? []).join(" "), /customFallbackPolicy/);
});

test("refresh dry-run does not persist catalog or policy caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-refresh-dry-run-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify(baseConfig(), null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const result = await doctor.refresh(true, false);
  assert.equal(result.source, "network");
  await assert.rejects(() => readFile(targetPaths.modelsCachePath));
  await assert.rejects(() => readFile(targetPaths.providersCachePath));
  await assert.rejects(() => readFile(targetPaths.policiesCachePath));
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("invalid policy and malformed models.dev cache are ignored safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-invalid-cache-"));
  const targetPaths = paths(root);
  const cache = new CacheStore(targetPaths);
  await mkdir(targetPaths.doctorDir, { recursive: true });
  await writeFile(targetPaths.policiesCachePath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), data: { schemaVersion: 99 } }));
  assert.equal(await cache.readPolicyCatalog(), undefined);
  const secretPolicy = defaultPolicyCatalog();
  (secretPolicy.fallback.cache as Record<string, unknown>).secret = "DO_NOT_CACHE";
  await writeFile(targetPaths.policiesCachePath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), data: secretPolicy }));
  assert.equal(await cache.readPolicyCatalog(), undefined);
  await writeFile(targetPaths.modelsCachePath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), data: { providers: { broken: { id: "broken", models: "not-an-object" } } } }));
  const client = new ModelsDevClient(cache, { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
  await assert.rejects(() => client.load({ force: true }), /offline/);
});

test("add, dry-run fix, fix-all, fix, and remove preserve unrelated data and create backups", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-e2e-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      other: { baseUrl: "https://other.example/v1", models: [{ id: "keep", custom: true }] },
      openai: {
        baseUrl: "https://proxy.example/v1",
        headers: { "x-user": "keep" },
        models: [{ id: "gpt-test", contextWindow: 1000, headers: { "x-model": "keep" } }],
      },
    },
    customTopLevel: { keep: true },
  }, null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) }, now: () => new Date("2026-08-01T00:00:00.000Z") });
  const add = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", apiKey: "$OPENAI_API_KEY" });
  assert.equal(add.plan.conflicts.some((item) => item.code === "endpoint-mismatch"), true);
  const check = await doctor.proposeFix("openai/gpt-test", { persistCache: false });
  assert.equal(check.result.plan?.conflicts.some((item) => item.userOwned), true);
  assert.equal(check.config.providers?.openai?.headers?.["x-user"], "keep");
  assert.equal(check.config.providers?.openai?.models?.[0]?.headers?.["x-model"], "keep");
  assert.equal((check.config.customTopLevel as { keep?: boolean } | undefined)?.keep, true);
  const applied = await doctor.applyFix(check);
  assert.ok(applied.backupPath);
  const files = await readdir(root);
  assert.equal(files.some((file) => file.startsWith("models.json.bak-")), true);
  const saved = await readModelsJson(targetPaths.modelsPath);
  assert.equal(saved.data.providers?.other?.models?.[0]?.id, "keep");
  assert.equal(saved.data.providers?.openai?.models?.[0]?.contextWindow, 1000);
  assert.equal(saved.data.providers?.openai?.models?.[0]?._piModelDoctor?.managed, true);
  const all = await doctor.proposeFixAll({ persistCache: false });
  assert.ok(all.result.plan);
  const removal = await doctor.proposeRemove("openai/gpt-test");
  assert.equal(removal.plan.conflicts.length, 0);
  await doctor.applyRemove(removal);
  const afterRemove = await readModelsJson(targetPaths.modelsPath);
  assert.equal(afterRemove.data.providers?.openai?.models?.length, 0);
  assert.equal(afterRemove.data.providers?.openai?.headers?.["x-user"], "keep");
  assert.ok(afterRemove.data.providers?.other);
});

test("check validates deprecated metadata and missing headers without exposing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-deprecated-"));
  const targetPaths = paths(root);
  const deprecated = catalog();
  deprecated.providers.openai.models["gpt-test"].deprecated = true;
  deprecated.providers.openai.models["gpt-test"].status = "deprecated";
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test", _piModelDoctor: { managed: true, source: "models.dev", lastCheck: "2026-08-01", autoRepair: true, version: 0, managedFields: [], managedValues: {} } }] } } }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(deprecated) } });
  const result = await doctor.check("openai/gpt-test");
  assert.equal(result.findings.some((item) => item.code === "deprecated-model"), true);
  assert.equal(result.findings.some((item) => item.code === "metadata-version"), true);
  assert.equal(result.findings.some((item) => item.code === "header-missing"), false);

  const missingHeaderRoot = await mkdtemp(join(tmpdir(), "pi-model-doctor-missing-header-"));
  const missingHeaderPaths = paths(missingHeaderRoot);
  const rich = richCatalog();
  await writeFile(missingHeaderPaths.modelsPath, JSON.stringify({ providers: { anthropic: { models: [{ id: "claude-budget" }] } } }));
  const missingHeaderDoctor = new ModelDoctor({ paths: missingHeaderPaths, fetcher: { fetchImpl: fetchMock(rich) } });
  const missingHeaderResult = await missingHeaderDoctor.check("anthropic/claude-budget");
  assert.equal(missingHeaderResult.findings.some((item) => item.code === "header-missing"), true);
});

test("check validates required and conflicting headers without exposing values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-headers-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { anthropic: { headers: { "x-api-key": "SECRET" }, models: [{ id: "claude-budget", headers: { "x-api-key": "OTHER" } }] } } }));
  const rich = richCatalog();
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(rich) } });
  const result = await doctor.check("anthropic/claude-budget");
  assert.equal(result.findings.some((item) => item.code === "header-mismatch"), true);
  assert.equal(result.findings.some((item) => item.code === "headers-preserved"), true);
  assert.equal(formatFindings(result).includes("SECRET"), false);
  assert.equal(formatFindings(result).includes("OTHER"), false);
});

test("user-deleted managed provider identity fields remain non-repairable", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-deleted-fields-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      openai: {
        models: [{ id: "gpt-test" }],
        _piModelDoctor: {
          managed: true,
          source: "models.dev",
          lastCheck: "2026-08-01T00:00:00.000Z",
          autoRepair: true,
          version: 1,
          managedFields: ["name", "baseUrl", "api"],
          managedValues: {
            name: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            api: "openai-completions",
          },
        },
      },
    },
  }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const result = await doctor.check("openai/gpt-test");
  const identityFindings = result.findings.filter((item) => (
    item.code === "api-mismatch" && item.message.startsWith("Configured provider API")
  ) || (
    item.code === "endpoint-mismatch" && item.message.startsWith("Configured endpoint")
  ) || (
    item.code === "metadata-stale" && item.message.startsWith("Provider name")
  ));
  assert.equal(identityFindings.length, 3);
  assert.ok(identityFindings.every((item) => item.repairable === false && item.userOwned === true));
});

test("user-deleted managed model API and input fields remain user-owned", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-model-deleted-fields-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      openai: {
        name: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        models: [{
          id: "gpt-test",
          _piModelDoctor: {
            managed: true,
            source: "models.dev",
            lastCheck: "2026-08-01T00:00:00.000Z",
            autoRepair: true,
            version: 1,
            managedFields: ["api", "input"],
            managedValues: {
              api: "openai-completions",
              input: ["text"],
            },
          },
        }],
      },
    },
  }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const result = await doctor.check("openai/gpt-test");
  const deletedFieldFindings = result.findings.filter((item) => (
    item.code === "api-mismatch" && item.message.startsWith("Configured model API")
  ) || item.code === "input-mismatch");
  assert.equal(deletedFieldFindings.length, 2);
  assert.ok(deletedFieldFindings.every((item) => item.repairable === false && item.userOwned === true));
});

test("migrate creates a destination, preserves user fields, and can remove the source explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-migrate-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test", headers: { "x-user": "keep" }, custom: { keep: true } }] } } }, null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const proposal = await doctor.proposeMigrate({ source: "openai/gpt-test", destination: "anthropic/claude-budget", removeSource: true, dryRun: true, persistCache: false });
  assert.equal(proposal.plan.target, "openai/gpt-test -> anthropic/claude-budget");
  assert.equal(proposal.config.providers?.anthropic?.models?.[0]?.headers, undefined);
  assert.ok(proposal.plan.warnings.some((warning) => /headers/.test(warning)));
  assert.deepEqual((proposal.config.providers?.anthropic?.models?.[0]?.custom as { keep?: boolean } | undefined), { keep: true });
  assert.equal(proposal.config.providers?.openai?.models?.length, 0);
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
  const applied = await doctor.applyMigrate(proposal);
  assert.equal(applied.backupPath, undefined);
  assert.ok(applied.plan.changes.length > 0);
  const persisted = await readModelsJson(targetPaths.modelsPath);
  assert.equal(persisted.data.providers?.openai?.models?.[0]?.id, "gpt-test");
  const writeProposal = await doctor.proposeMigrate({ source: "openai/gpt-test", destination: "anthropic/claude-budget", removeSource: true, persistCache: false });
  const written = await doctor.applyMigrate(writeProposal);
  assert.ok(written.backupPath);
});

test("migration keeps the source by default and reports destination conflicts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-migrate-default-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      openai: { models: [{ id: "gpt-test", custom: "source" }] },
      anthropic: { models: [{ id: "claude-budget", custom: "destination" }] },
    },
  }, null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const proposal = await doctor.proposeMigrate({ source: "openai/gpt-test", destination: "anthropic/claude-budget", dryRun: true, persistCache: false });
  assert.equal(proposal.config.providers?.openai?.models?.length, 1);
  assert.equal(proposal.config.providers?.anthropic?.models?.[0]?.custom, "destination");
  assert.ok(proposal.plan.conflicts.some((item) => item.code === "migration-conflict"));
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("migration treats metadata-only destination churn as a no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-migrate-no-op-"));
  const targetPaths = paths(root);
  const rich = richCatalog();
  const destinationProvider = rich.providers.anthropic;
  const destinationSource = destinationProvider.models["claude-budget"];
  const destinationModel = toPiModel(destinationProvider, destinationSource, {
    endpoint: destinationProvider.api,
    sourceName: "models.dev",
    now: new Date("2026-08-01T00:00:00.000Z"),
  });
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      openai: { models: [{ id: "gpt-test" }] },
      anthropic: { name: "Anthropic", baseUrl: destinationProvider.api, api: "anthropic-messages", models: [destinationModel] },
    },
  }, null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(rich) }, now: () => new Date("2026-08-02T00:00:00.000Z") });
  const proposal = await doctor.proposeMigrate({ source: "openai/gpt-test", destination: "anthropic/claude-budget", persistCache: false });
  assert.equal(proposal.plan.changes.length, 0);
  assert.ok(proposal.plan.warnings.some((warning) => /no runtime|no backup/i.test(warning)));
  const applied = await doctor.applyMigrate(proposal);
  assert.equal(applied.backupPath, undefined);
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("add treats metadata-only provider/model churn as a no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-add-no-op-"));
  const targetPaths = paths(root);
  const sourceCatalog = catalog();
  const sourceProvider = sourceCatalog.providers.openai;
  const sourceModel = sourceProvider.models["gpt-test"];
  const existingModel = toPiModel(sourceProvider, sourceModel, {
    endpoint: sourceProvider.api,
    sourceName: "models.dev",
    now: new Date("2026-08-01T00:00:00.000Z"),
  });
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: { openai: { name: "OpenAI", baseUrl: sourceProvider.api, api: "openai-completions", apiKey: "$OPENAI_API_KEY", models: [existingModel] } },
  }, null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(sourceCatalog) }, now: () => new Date("2026-08-02T00:00:00.000Z") });
  const proposal = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", persistCache: false });
  assert.equal(proposal.plan.changes.length, 0);
  const applied = await doctor.applyAdd(proposal);
  assert.equal(applied.backupPath, undefined);
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("backup cleanup supports age retention and rejects unsafe models paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-backup-safety-"));
  const targetPaths = paths(root);
  const oldBackup = join(root, "models.json.bak-2020-01-01T00-00-00-000Z");
  await writeFile(oldBackup, "{}");
  await utimes(oldBackup, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  const preview = await cleanupBackups(targetPaths.modelsPath, { maxAgeMs: 1000, now: new Date("2026-08-01T00:00:00.000Z"), dryRun: true });
  assert.deepEqual(preview, [oldBackup]);
  assert.equal(await readFile(oldBackup, "utf8"), "{}");
  const realPath = join(root, "real-models.json");
  const linkPath = join(root, "models.json");
  await writeFile(realPath, JSON.stringify({ providers: {} }));
  await symlink(realPath, linkPath);
  await assert.rejects(() => writeModelsJson(linkPath, { providers: { openai: { models: [] } } }), (error: unknown) => error instanceof DoctorError && error.code === "backup-error");
  assert.equal(await readFile(realPath, "utf8"), JSON.stringify({ providers: {} }));
});

test("backup cleanup is explicit, dry-run safe, and retains the newest backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-backup-cleanup-"));
  const targetPaths = paths(root);
  const backupNames = [
    "models.json.bak-2026-08-01T00-00-00-000Z-2",
    "models.json.bak-2026-08-01T00-00-00-000Z-1",
    "models.json.bak-2026-08-01T00-00-00-000Z",
  ];
  for (const name of backupNames) await writeFile(join(root, name), name);
  const preview = await cleanupBackups(targetPaths.modelsPath, { keep: 1, dryRun: true });
  assert.equal(preview.length, 2);
  assert.equal((await readdir(root)).filter((file) => file.startsWith("models.json.bak-")).length, 3);
  const removed = await cleanupBackups(targetPaths.modelsPath, { keep: 1 });
  assert.equal(removed.length, 2);
  assert.equal((await readdir(root)).filter((file) => file.startsWith("models.json.bak-")).length, 1);
});

test("JSONC input and runtime metadata stripping preserve user fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-jsonc-"));
  const jsonPath = join(root, "models.json");
  await writeFile(jsonPath, '{\n  // keep this comment parseable\n  "providers": { "openai": { "models": [{ "id": "gpt-test", "_piModelDoctor": { "managed": true }, }] } },\n}');
  const loaded = await readModelsJson(jsonPath);
  assert.equal(loaded.data.providers?.openai?.models?.[0]?.id, "gpt-test");
  assert.deepEqual(stripDoctorMetadata(loaded.data), { providers: { openai: { models: [{ id: "gpt-test" }] } } });
  loaded.data.providers!.openai!.models![0]!.name = "Updated name";
  await writeModelsJson(jsonPath, loaded.data);
  const updatedText = await readFile(jsonPath, "utf8");
  assert.match(updatedText, /keep this comment parseable/);
  assert.match(updatedText, /"name": "Updated name"/);
});

test("config validation and error output remain typed and secret-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-invalid-config-"));
  const jsonPath = join(root, "models.json");
  await writeFile(jsonPath, JSON.stringify({ providers: { openai: { models: [{ id: "" }] } } }));
  await assert.rejects(() => readModelsJson(jsonPath), (error: unknown) => error instanceof DoctorError && error.code === "invalid-config");
  await writeFile(jsonPath, '{"providers":{"openai":{"models":[{"id":"gpt-test","custom":{"__proto__":{"polluted":true}}}]}}}');
  await assert.rejects(() => readModelsJson(jsonPath), (error: unknown) => error instanceof DoctorError && error.code === "invalid-config");
  assert.equal(redactSensitiveText("request failed?api_key=SECRET authorization: Bearer TOKEN" ).includes("SECRET"), false);
  assert.equal(redactSensitiveText("request failed?api_key=SECRET authorization: Bearer TOKEN" ).includes("TOKEN"), false);
});

test("dry-run add/remove does not write catalog cache or backups and backup names avoid collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-dry-run-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) }, now: () => new Date("2026-08-01T00:00:00.000Z") });
  await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", dryRun: true, persistCache: false });
  await assert.rejects(() => readFile(targetPaths.modelsCachePath));
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }] } } }));
  const removal = await doctor.proposeRemove("openai/gpt-test");
  const before = await readFile(targetPaths.modelsPath, "utf8");
  assert.equal(before.includes("gpt-test"), true);
  await writeFile(join(root, "models.json.bak-2026-08-01T00-00-00-000Z"), "existing");
  await doctor.applyRemove(removal);
  assert.equal((await readdir(root)).filter((file) => file.startsWith("models.json.bak-")).length, 2);
});

test("extension registers the unified command and lifecycle hooks from project settings", async () => {
  const registered: string[] = [];
  const hooks: string[] = [];
  modelDoctorExtension({ registerCommand: (name: string) => registered.push(name), on: (event: string) => hooks.push(event) } as never);
  assert.deepEqual(registered, ["model-doctor"]);
  assert.deepEqual(hooks, ["session_start", "session_shutdown"]);
  const settingsPath = join(process.cwd(), ".pi", "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { extensions?: string[] };
  assert.equal(settings.extensions?.includes("../index.ts"), false);
  assert.equal(resolve(dirname(settingsPath), "../index.ts"), join(process.cwd(), "index.ts"));
});

test("Pi extension loader registers model-doctor without network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-loader-"));
  const loaded = await discoverAndLoadExtensions([join(process.cwd(), "index.ts")], root, join(root, "agent"));
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.equal(loaded.extensions[0]?.commands.has("model-doctor"), true);
  assert.equal(loaded.extensions[0]?.handlers.has("session_start"), true);
  assert.equal(loaded.extensions[0]?.handlers.has("session_shutdown"), true);
});

test("periodic refresh interval is configurable and disables with zero", () => {
  const previous = process.env.PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS;
  try {
    process.env.PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS = "0";
    assert.equal(getModelDoctorRefreshIntervalMs(), 0);
    process.env.PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS = "not-a-number";
    assert.equal(getModelDoctorRefreshIntervalMs(), 24 * 60 * 60 * 1000);
  } finally {
    if (previous === undefined) delete process.env.PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS;
    else process.env.PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS = previous;
  }
});

test("interactive cancellation leaves models.json unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-cancel-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }] } } }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message), confirm: async () => false },
  } as never;
  await runCommand("remove openai/gpt-test", ctx, doctor);
  assert.equal((await readModelsJson(targetPaths.modelsPath)).data.providers?.openai?.models?.length, 1);
  assert.match(notifications.at(-1) ?? "", /cancelled/);
});

test("atomic write reports blocked parent and cleans up temporary files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-atomic-failure-"));
  const blocked = join(root, "blocked");
  await writeFile(blocked, "not a directory");
  await assert.rejects(() => atomicWrite(join(blocked, "models.json"), "{}\n"), (error: unknown) => error instanceof DoctorError && error.code === "write-error");
});

test("atomic rename failures are typed and preserve the original file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-rename-failure-"));
  const path = join(root, "models.json");
  await writeFile(path, "original\n");
  await assert.rejects(
    () => atomicWrite(path, "replacement\n", undefined, { renameImpl: async () => { throw new Error("rename failed"); } }),
    (error: unknown) => error instanceof DoctorError && error.code === "write-error",
  );
  assert.equal(await readFile(path, "utf8"), "original\n");
  assert.deepEqual((await readdir(root)).filter((file) => file.endsWith(".tmp")), []);
});

test("atomic write does not leave temporary files after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-atomic-"));
  const path = join(root, "models.json");
  await atomicWrite(path, "{}\n");
  assert.equal(await readFile(path, "utf8"), "{}\n");
  assert.deepEqual((await readdir(root)).filter((file) => file.endsWith(".tmp")), []);
});

test("interactive migration selects a destination when --to is omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-migrate-select-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }] } } }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (_prompt: string, choices: string[]) => choices[0],
      confirm: async () => false,
    },
  } as never;
  await runCommand("migrate openai/gpt-test", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /cancelled|migration candidates|destination/i);
  assert.equal((await readModelsJson(targetPaths.modelsPath)).data.providers?.openai?.models?.length, 1);
});

test("interactive add selects a candidate instead of silently taking the first model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-select-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      select: async (_prompt: string, choices: string[]) => choices[0],
      confirm: async () => true,
    },
  } as never;
  await runCommand("add openai", ctx, doctor);
  assert.equal((await readModelsJson(targetPaths.modelsPath)).data.providers?.openai?.models?.[0]?.id, "gpt-test");
  assert.equal(notifications.some((message) => /Applied/.test(message)), true);
});

test("add command reports successful dry-runs and metadata-provider selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-add-success-notice-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: { wong: { baseUrl: "https://wong.example/v1", api: "openai-completions", models: [] } },
  }));
  const duplicateCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      npm: "@ai-sdk/openai",
      api: "https://api.openai.com/v1",
      models: { "gpt-official": { id: "gpt-official" } },
    },
    gateway: {
      id: "gateway",
      npm: "@ai-sdk/openai-compatible",
      api: "https://gateway.example/v1",
      models: { "gpt-official": { id: "gpt-official", provider: { npm: "@ai-sdk/openai" } } },
    },
  });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(duplicateCatalog) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("add wong gpt-official --dry-run", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /Dry-run succeeded for wong\/gpt-official/);
  assert.match(notifications.at(-1) ?? "", /Metadata provider: openai/);
  assert.match(notifications.at(-1) ?? "", /not-persisted \(dry-run\)/);
});

test("successful default-path mutations refresh and verify the active model registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-runtime-active-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const targetPaths = paths(root);
    const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
    const notifications: string[] = [];
    let refreshed = 0;
    const ctx = {
      hasUI: false,
      modelRegistry: {
        refresh: async () => { refreshed += 1; },
        find: (provider: string, model: string) => provider === "openai" && model === "gpt-test" ? { provider, id: model } : undefined,
      },
      ui: { notify: (message: string) => notifications.push(message) },
    } as never;
    await runCommand("add openai gpt-test --yes", ctx, doctor);
    assert.equal(refreshed, 1);
    assert.match(notifications.at(-1) ?? "", /persisted-and-active/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("runtime verification failures are reported after persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-runtime-failure-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const targetPaths = paths(root);
    const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
    const notifications: string[] = [];
    const ctx = {
      hasUI: false,
      modelRegistry: { refresh: async () => undefined, find: () => undefined },
      ui: { notify: (message: string) => notifications.push(message) },
    } as never;
    await runCommand("add openai gpt-test --yes", ctx, doctor);
    assert.match(notifications.at(-1) ?? "", /activation-failed/);
    assert.equal((await readModelsJson(targetPaths.modelsPath)).data.providers?.openai?.models?.[0]?.id, "gpt-test");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("headless direct channel model add supports URL targets and explicit provider ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-direct-channel-url-command-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("add https://gateway.example/v1 gpt-test --yes", ctx, doctor);
  const saved = await readModelsJson(targetPaths.modelsPath);
  assert.equal(saved.data.providers?.gateway?.baseUrl, "https://gateway.example/v1");
  assert.equal(saved.data.providers?.gateway?.models?.[0]?.id, "gpt-test");
  assert.equal(saved.data.providers?.gateway?.models?.[0]?.compat?.metadataOnly, true);
  assert.match(notifications.at(-1) ?? "", /Applied/);
});

test("headless direct channel model add requires --yes and writes with explicit authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-direct-channel-auth-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("add providerA https://gateway.example/v1 gpt-test", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /requires --yes/);
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
  await runCommand("add providerA https://gateway.example/v1 gpt-test --yes", ctx, doctor);
  const saved = await readModelsJson(targetPaths.modelsPath);
  assert.equal(saved.data.providers?.providerA?.models?.[0]?.id, "gpt-test");
});

test("extension command rejects headless writes without --yes and accepts explicit --yes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-command-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = {
    hasUI: false,
    ui: { notify: (message: string) => notifications.push(message) },
  } as never;
  await runCommand("add openai gpt-test", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /requires --yes/);
  await runCommand("add openai gpt-test --yes", ctx, doctor);
  assert.equal((await readModelsJson(targetPaths.modelsPath)).data.providers?.openai?.models?.[0]?.id, "gpt-test");
});

test("headless migrate requires an explicit destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-migrate-headless-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }] } } }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(richCatalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("migrate openai/gpt-test --yes", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /destination is required/i);
});

test("headless refresh dry-run does not write caches", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-refresh-command-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("refresh --force --dry-run", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /models.dev refresh/);
  await assert.rejects(() => readFile(targetPaths.modelsCachePath));
});

test("normal refresh may persist catalog and policy caches but never writes models.json", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-refresh-command-normal-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify(baseConfig(), null, 2));
  const before = await readFile(targetPaths.modelsPath, "utf8");
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("refresh --force", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /Configuration:/);
  assert.equal(await readFile(targetPaths.modelsPath, "utf8"), before);
  assert.ok((await readFile(targetPaths.modelsCachePath, "utf8")).includes('"version": 1'));
  assert.ok((await readFile(targetPaths.policiesCachePath, "utf8")).includes('"schemaVersion": 1'));
  assert.equal((await readdir(root)).some((file) => file.startsWith("models.json.bak-")), false);
});

test("proposal apply rejects concurrent models.json changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-concurrent-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }] } } }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const proposal = await doctor.proposeRemove("openai/gpt-test");
  const originalFingerprint = await fileFingerprint(targetPaths.modelsPath);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test", changed: true }] } } }));
  assert.notEqual(await fileFingerprint(targetPaths.modelsPath), originalFingerprint);
  await assert.rejects(() => doctor.applyRemove(proposal), (error: unknown) => error instanceof DoctorError && error.code === "concurrent-modification");
});

test("offline check retains local ownership findings without a cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-offline-check-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }] } } }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch } });
  const result = await doctor.check("openai/gpt-test");
  assert.equal(result.findings.some((item) => item.code === "network-unavailable"), true);
  assert.equal(result.findings.some((item) => item.code === "metadata-missing"), true);
});

test("malformed mutating targets are rejected before headless authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-target-validation-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("remove openai", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /provider\/model/);
});

test("unknown flags and missing flag values are rejected without mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-flags-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("add openai gpt-test --unknown", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /Unknown flag/);
  await runCommand("add openai gpt-test --api-key --yes", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /requires a value/);
  await assert.rejects(() => readFile(targetPaths.modelsPath));
});

test("catalog normalization preserves non-secret token metadata and strips credentials", () => {
  const normalized = normalizeCatalog({
    test: {
      id: "test",
      models: {
        model: { id: "model", tokenizer: "cl100k", api_key: "SECRET", max_tokens: 4096 },
      },
    },
  });
  const model = normalized.providers.test.models.model;
  assert.equal(model.tokenizer, "cl100k");
  assert.equal(model.max_tokens, 4096);
  assert.equal("api_key" in model, false);
  assert.throws(() => normalizeCatalog({ test: { id: "test", api: "https://example.test/v1?api_key=secret", models: {} } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  assert.throws(() => normalizeCatalog({ test: { id: "test", api: "https://user:pass@example.test/v1", models: {} } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  assert.throws(() => normalizeCatalog({ test: { id: "test", api: "https://[::1]/v1", models: {} } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  assert.throws(() => normalizeCatalog({ test: { id: "test", api: "http://10.0.0.1/v1", models: {} } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  assert.throws(() => normalizeCatalog({ test: { id: "test", api: "http://public.example/v1", models: {} } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  for (const env of [["lowercase_key"], ["INVALID-KEY"], [""], ["WITH SPACE"]]) {
    assert.throws(() => normalizeCatalog({ test: { id: "test", env, models: {} } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  }
  assert.throws(() => normalizeCatalog({ test: { id: "test", models: { model: { id: "MODEL" } } } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  assert.throws(() => normalizeCatalog({ test: { id: "test", models: { model: { id: "model", reasoning_options: [{ type: "budget", min: 10, max: 5 }] } } } }), (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog");
  for (const option of [
    { type: "budget", min: -1, max: 32768 },
    { type: "budget_tokens", min: -2, max: 32768 },
    { type: "budget_tokens", min: -1, max: 0 },
    { type: "effort", values: [false, "low"] },
  ]) {
    assert.throws(
      () => normalizeCatalog({ test: { id: "test", models: { model: { id: "model", reasoning_options: [option] } } } }),
      (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog",
    );
  }
  for (const interleaved of [1, "enabled"]) {
    assert.throws(
      () => normalizeCatalog({ test: { id: "test", models: { model: { id: "model", interleaved } } } }),
      (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog",
    );
  }
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "4096"]) {
    assert.throws(
      () => normalizeCatalog({ test: { id: "test", models: { model: { id: "model", limit: { context: limit } } } } }),
      (error: unknown) => error instanceof ModelsDevError && error.code === "invalid-catalog",
    );
  }
});

test("secret redaction covers auth headers, OAuth, and nested headers", () => {
  const redacted = redactSensitiveText('authHeader: "AUTH_SECRET" oauth: OAUTH_SECRET headers: {"x-api-key":"HEADER_SECRET"} url=https://user:pass@example.test?token=QUERY_SECRET');
  assert.equal(redacted.includes("AUTH_SECRET"), false);
  assert.equal(redacted.includes("OAUTH_SECRET"), false);
  assert.equal(redacted.includes("HEADER_SECRET"), false);
  assert.equal(redacted.includes("QUERY_SECRET"), false);
  assert.equal(redacted.includes("user:pass"), false);
});

test("literal API keys require explicit opt-in and safe references are retained", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-api-key-policy-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const omitted = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", apiKey: "literal-secret", persistCache: false });
  assert.equal(omitted.config.providers?.openai?.apiKey, undefined);
  assert.match(omitted.warning ?? "", /not persisted/i);
  const referenced = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", apiKey: "$OPENAI_API_KEY", persistCache: false });
  assert.equal(referenced.config.providers?.openai?.apiKey, "$OPENAI_API_KEY");
  const allowed = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", apiKey: "literal-secret", allowLiteralApiKey: true, persistCache: false });
  assert.equal(allowed.config.providers?.openai?.apiKey, "literal-secret");
  assert.match(allowed.warning ?? "", /literal API key/i);
  assert.equal(JSON.stringify(allowed.plan).includes("literal-secret"), false);
  assert.equal(JSON.stringify(omitted.plan).includes("literal-secret"), false);
});

test("deprecated migration destination is advisory and cannot be applied", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-deprecated-migrate-"));
  const targetPaths = paths(root);
  const rich = richCatalog();
  rich.providers.anthropic.models["claude-budget"].deprecated = true;
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }] } } }));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(rich) } });
  const proposal = await doctor.proposeMigrate({ source: "openai/gpt-test", destination: "anthropic/claude-budget", persistCache: false });
  assert.equal(proposal.plan.conflicts.some((item) => item.code === "deprecated-model" && item.severity === "error"), true);
  await assert.rejects(() => doctor.applyMigrate(proposal), (error: unknown) => error instanceof DoctorError && error.code === "invalid-config");
});

test("fix-all applies safe repairs to every configured model and preserves the source file on dry-run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-fix-all-apply-"));
  const targetPaths = paths(root);
  const twoModelCatalog = normalizeCatalog({
    openai: {
      id: "openai",
      api: "https://api.openai.com/v1",
      models: {
        "gpt-test": { id: "gpt-test", reasoning: false, limit: { context: 200000, output: 32000 } },
        "gpt-second": { id: "gpt-second", reasoning: false, limit: { context: 100000, output: 16000 } },
      },
    },
  });
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }, { id: "gpt-second" }] } } }, null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(twoModelCatalog) } });
  const proposal = await doctor.proposeFixAll({ persistCache: false, dryRun: true });
  assert.equal(proposal.result.plan?.changes.some((change) => /gpt-test/.test(change.path)), true);
  assert.equal(proposal.result.plan?.changes.some((change) => /gpt-second/.test(change.path)), true);
  assert.equal(await readFile(targetPaths.modelsPath, "utf8"), JSON.stringify({ providers: { openai: { models: [{ id: "gpt-test" }, { id: "gpt-second" }] } } }, null, 2));
  const applied = await doctor.applyFix({ ...proposal, dryRun: false });
  assert.ok(applied.plan?.changes.length);
  const saved = await readModelsJson(targetPaths.modelsPath);
  assert.equal(saved.data.providers?.openai?.models?.[0]?.contextWindow, 200000);
  assert.equal(saved.data.providers?.openai?.models?.[1]?.contextWindow, 100000);
});

test("repair removes stale doctor-managed capability fields but preserves user-owned fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-stale-managed-field-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({
    providers: {
      openai: {
        models: [{
          id: "gpt-test",
          thinkingLevelMap: { low: "low" },
          custom: "keep",
          _piModelDoctor: {
            managed: true,
            source: "models.dev",
            lastCheck: "2026-08-01T00:00:00.000Z",
            autoRepair: true,
            version: 1,
            managedFields: ["thinkingLevelMap"],
            managedValues: { thinkingLevelMap: { low: "low" } },
          },
        }],
      },
    },
  }, null, 2));
  const noReasoning = normalizeCatalog({ openai: { id: "openai", api: "https://api.openai.com/v1", models: { "gpt-test": { id: "gpt-test", reasoning: false } } } });
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(noReasoning) } });
  const proposal = await doctor.proposeFix("openai/gpt-test", { persistCache: false, dryRun: true });
  assert.equal(proposal.config.providers?.openai?.models?.[0]?.thinkingLevelMap, undefined);
  assert.equal(proposal.config.providers?.openai?.models?.[0]?.custom, "keep");
  assert.equal(proposal.config.providers?.openai?.models?.[0]?._piModelDoctor?.managedFields?.includes("thinkingLevelMap"), false);
  assert.equal(proposal.result.plan?.changes.some((change) => change.after === undefined && /thinkingLevelMap/.test(change.path)), true);
});

test("provider cache is versioned, complete, and rejects secret-bearing summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-provider-cache-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  await doctor.modelsDev.load({ force: true });
  const providerCache = await doctor.cache.readProviderCache();
  assert.equal(providerCache?.schemaVersion, 1);
  assert.equal(providerCache?.providers.openai?.env?.[0], "OPENAI_API_KEY");
  assert.equal(providerCache?.providers.openai?.required_headers, undefined);
  await writeFile(targetPaths.providersCachePath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), data: { schemaVersion: 1, providers: { openai: { id: "openai", adapter: "openai-compatible", capabilities: {}, headers: { authorization: "SECRET" } } } } }));
  assert.equal(await doctor.cache.readProviderCache(), undefined);
  await writeFile(targetPaths.providersCachePath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), data: { schemaVersion: 1, providers: { openai: { id: "other", adapter: "openai-compatible", capabilities: { prompt: false, context: false, kv: false, reasoning: false, reasoningControls: [], cacheSources: [], cacheConfidences: [], cacheSignals: [] } } } } }));
  assert.deepEqual(await doctor.cache.readProviderCache(), undefined);
  await writeFile(targetPaths.providersCachePath, JSON.stringify({ version: 1, fetchedAt: new Date().toISOString(), data: { schemaVersion: 1, providers: { openai: { id: "openai", adapter: "openai-compatible", capabilities: { prompt: false, context: false, kv: false, reasoning: false, reasoningControls: [], cacheSources: [], cacheConfidences: [], cacheSignals: [] }, nested: { x_api_key: "SECRET" } } } } }));
  assert.deepEqual(await doctor.cache.readProviderCache(), undefined);
});

test("stale cache write locks are reclaimed safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-cache-stale-lock-"));
  const targetPaths = paths(root);
  await mkdir(targetPaths.doctorDir, { recursive: true });
  const lockPath = join(targetPaths.doctorDir, ".cache-write.lock");
  await writeFile(lockPath, "crashed-process\n");
  await utimes(lockPath, new Date("2020-01-01T00:00:00.000Z"), new Date("2020-01-01T00:00:00.000Z"));
  await new CacheStore(targetPaths).writeModels(catalog());
  assert.equal((await readdir(targetPaths.doctorDir)).includes(".cache-write.lock"), false);
});

test("concurrent cache writes leave a valid single cache payload and release the lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-cache-concurrent-"));
  const targetPaths = paths(root);
  const cache = new CacheStore(targetPaths);
  await Promise.all([
    cache.writeModels(catalog()),
    cache.writeModels(catalog()),
    cache.writeModels(catalog()),
  ]);
  const loaded = await cache.readModels<ModelsDevCatalog>();
  assert.equal(loaded?.version, 1);
  assert.equal(Object.keys(loaded?.data.providers ?? {}).length, 1);
  assert.equal((await readdir(targetPaths.doctorDir)).includes(".cache-write.lock"), false);
});

test("cache files and directories use restrictive permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-cache-permissions-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  await doctor.modelsDev.load({ force: true });
  const directoryMode = (await (await import("node:fs/promises")).stat(targetPaths.doctorDir)).mode & 0o777;
  const fileMode = (await (await import("node:fs/promises")).stat(targetPaths.modelsCachePath)).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(fileMode, 0o600);
  await (await import("node:fs/promises")).chmod(targetPaths.modelsCachePath, 0o644);
  assert.equal(await doctor.cache.readModels<ModelsDevCatalog>(), undefined);
  await (await import("node:fs/promises")).chmod(targetPaths.doctorDir, 0o755);
  assert.equal(await doctor.cache.readModels<ModelsDevCatalog>(), undefined);
});

test("rollback validates and atomically restores a backup with headless authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-rollback-"));
  const targetPaths = paths(root);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "old-model" }] } } }, null, 2));
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) }, now: () => new Date("2026-08-01T00:00:00.000Z") });
  const proposal = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", persistCache: false });
  const applied = await doctor.applyAdd(proposal);
  assert.ok(applied.backupPath);
  await writeFile(targetPaths.modelsPath, JSON.stringify({ providers: { openai: { models: [{ id: "changed-after-write" }] } } }, null, 2));
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand(`rollback ${applied.backupPath} --yes`, ctx, doctor);
  assert.equal((await readModelsJson(targetPaths.modelsPath)).data.providers?.openai?.models?.[0]?.id, "old-model");
  assert.match(notifications.at(-1) ?? "", /persisted-reload-required|persisted-and-active/);
  assert.ok((await readdir(root)).some((file) => file.startsWith("models.json.bak-")));
});

test("headless dry-run takes precedence over --yes for mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-dry-run-precedence-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) } });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  await runCommand("add openai gpt-test --yes --dry-run", ctx, doctor);
  assert.match(notifications.at(-1) ?? "", /not-persisted.*dry-run/i);
  await assert.rejects(() => readFile(targetPaths.modelsPath));
  await assert.rejects(() => readFile(targetPaths.modelsCachePath));
});
