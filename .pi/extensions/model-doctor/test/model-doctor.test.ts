import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCommandArgs } from "../src/command.ts";
import { resolveCache, resolveReasoning, toPiModel } from "../src/capabilities.ts";
import { CacheStore } from "../src/cache.ts";
import { ModelDoctor } from "../src/doctor.ts";
import { atomicWrite, canManageField, readModelsJson, stripDoctorMetadata } from "../src/json.ts";
import { resolveProviderAdapter } from "../src/capabilities.ts";
import { ModelsDevClient, normalizeCatalog } from "../src/models-dev.ts";
import type { DoctorPaths, ModelsDevCatalog } from "../src/types.ts";

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

function fetchMock(data: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", etag: "test-etag" },
  })) as typeof fetch;
}

test("parses unified command arguments and quoted values", () => {
  const parsed = parseCommandArgs('add openai gpt-test --api-key "$OPENAI_API_KEY" --dry-run');
  assert.deepEqual(parsed, {
    command: "add",
    args: ["openai", "gpt-test"],
    flags: { "api-key": "$OPENAI_API_KEY", "dry-run": true },
  });
  assert.deepEqual(parseCommandArgs("unknown"), { command: "invalid", args: ["unknown"], flags: {} });
});

test("normalizes reasoning options and universal cache signals", () => {
  const current = catalog().providers.openai;
  const model = current.models["gpt-test"];
  const reasoning = resolveReasoning(current, model);
  assert.deepEqual(reasoning, {
    supported: true,
    controlType: "effort",
    levels: ["low", "medium", "high"],
    defaultLevel: "medium",
    maxTokens: 32000,
  });
  assert.deepEqual(resolveCache(current, model), {
    prompt: true,
    context: false,
    kv: false,
    readPricing: true,
    writePricing: true,
    strategy: "model",
  });
  const piModel = toPiModel(current, model, { now: new Date("2026-08-01T00:00:00.000Z") });
  assert.equal(piModel.reasoning, true);
  assert.equal(piModel.contextWindow, 200000);
  assert.deepEqual(piModel.thinkingLevelMap, { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" });
});

test("matches provider URL and model name", () => {
  const matches = ModelsDevClient.match(catalog(), "https://api.openai.com/v1", "GPT Test");
  assert.equal(matches[0]?.provider.id, "openai");
  assert.equal(matches[0]?.model?.id, "gpt-test");
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

test("cache writes atomically and falls back to valid cached data", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-cache-"));
  const cache = new CacheStore(paths(root));
  await cache.writeModels(catalog());
  const loaded = await cache.readModels<ModelsDevCatalog>();
  assert.equal(Object.keys(loaded?.data.providers ?? {}).length, 1);
  const unavailable = new ModelsDevClient(cache, { fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
  const result = await unavailable.load({ force: true });
  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.match(result.warning ?? "", /cached catalog/);
});

test("add, dry-run fix, fix, and remove preserve unrelated data and create backups", async () => {
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
  const dryRunText = await readFile(targetPaths.modelsPath, "utf8");
  assert.match(dryRunText, /other/);
  const check = await doctor.proposeFix("openai/gpt-test");
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

  const removal = await doctor.proposeRemove("openai/gpt-test");
  assert.equal(removal.plan.conflicts.length, 0);
  await doctor.applyRemove(removal);
  const afterRemove = await readModelsJson(targetPaths.modelsPath);
  assert.equal(afterRemove.data.providers?.openai?.models?.length, 0);
  assert.equal(afterRemove.data.providers?.openai?.headers?.["x-user"], "keep");
  assert.ok(afterRemove.data.providers?.other);
});

test("JSONC input and runtime metadata stripping preserve user fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-jsonc-"));
  const jsonPath = join(root, "models.json");
  await writeFile(jsonPath, '{\n  // keep this comment parseable\n  "providers": { "openai": { "models": [{ "id": "gpt-test", "_piModelDoctor": { "managed": true } }] } }\n}');
  const loaded = await readModelsJson(jsonPath);
  assert.equal(loaded.data.providers?.openai?.models?.[0]?.id, "gpt-test");
  assert.deepEqual(stripDoctorMetadata(loaded.data), { providers: { openai: { models: [{ id: "gpt-test" }] } } });
  assert.equal(resolveProviderAdapter({ id: "deepseek", models: {} }).thinkingFormat, "deepseek");
});

test("dry-run add does not write catalog cache and backups avoid collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-dry-run-"));
  const targetPaths = paths(root);
  const doctor = new ModelDoctor({ paths: targetPaths, fetcher: { fetchImpl: fetchMock(catalog()) }, now: () => new Date("2026-08-01T00:00:00.000Z") });
  await doctor.proposeAdd({ target: "openai", modelId: "gpt-test", dryRun: true });
  await assert.rejects(() => readFile(targetPaths.modelsCachePath));
  await writeFile(targetPaths.modelsPath, "{\"providers\":{}}");
  const first = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test" });
  await doctor.applyAdd(first);
  const second = await doctor.proposeAdd({ target: "openai", modelId: "gpt-test" });
  await doctor.applyAdd(second);
  const backups = (await readdir(root)).filter((file) => file.startsWith("models.json.bak-"));
  assert.equal(backups.length, 2);
  assert.notEqual(backups[0], backups[1]);
});

test("atomic write does not leave temporary files after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-model-doctor-atomic-"));
  const path = join(root, "models.json");
  await atomicWrite(path, "{}\n");
  assert.equal(await readFile(path, "utf8"), "{}\n");
  assert.deepEqual((await readdir(root)).filter((file) => file.endsWith(".tmp")), []);
});
