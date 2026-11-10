import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ModelDoctor } from "../src/doctor.ts";
import { runCommand } from "../src/command.ts";
import { normalizeCatalog } from "../src/models-dev.ts";
import { readModelsJson } from "../src/json.ts";
import type { DoctorPaths } from "../src/types.ts";

const fixtureRoots = new Set<string>();
test.afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  fixtureRoots.clear();
});

async function setup(sources: Record<string, string[]>, ids = ["a/b/c"], channel = "channel", live = true) {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-prefix-"));
  fixtureRoots.add(root);
  const paths: DoctorPaths = { modelsPath: join(root, "models.json"), doctorDir: join(root, "doctor"),
    modelsCachePath: join(root, "doctor", "models-cache.json"), providersCachePath: join(root, "doctor", "providers-cache.json"),
    policiesCachePath: join(root, "doctor", "policies-cache.json") };
  await writeFile(paths.modelsPath, JSON.stringify({ providers: { [channel]: {
    baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions", apiKey: "$SAMPLE_KEY", headers: { "x-custom": "keep" }, models: [],
  } } }));
  const raw = Object.fromEntries(Object.entries(sources).map(([provider, models], i) => [provider, {
    id: provider, api: `https://${provider}.example/v1`, models: Object.fromEntries(models.map((id, j) => [id, {
      id, name: `Source ${i}-${j}`, limit: { context: 100000 + i * 1000 + j, output: 12000 },
    }])),
  }]));
  const doctor = new ModelDoctor({ paths, channelFetch: async () => Response.json({ data: ids.map((id) => ({ id })) }, { status: live ? 200 : 404 }),
    fetcher: { fetchImpl: async () => Response.json(raw) } });
  return { root, paths, doctor, channel, catalog: normalizeCatalog(raw),
    propose: (metadataProvider?: string) => doctor.proposeSync({ target: channel, modelIds: ids, metadataProvider, persistCache: false }) };
}

test("sync strips prefixes in order, retains channel identity and provenance, and repeats without backup", async () => {
  for (const sourceIds of [["b/c", "c"], ["c"]]) {
    const s = await setup({ source: sourceIds });
    const proposal = await s.propose();
    const model = proposal.config.providers!.channel.models![0];
    assert.equal(model.id, "a/b/c");
    assert.equal(model.contextWindow, 100000);
    assert.deepEqual(model._piModelDoctor?.metadataProvenance, { providerId: "source", modelId: sourceIds[0],
      requestedModelId: "a/b/c", matchKind: "prefix-stripped", reason: "catalog-reference", evidence: [] });
    assert.equal(proposal.metadataSources[0].modelId, sourceIds[0]);
    await s.doctor.applySync(proposal);
    const checked = await s.doctor.check("channel/a/b/c");
    assert.ok(!checked.findings.some((f) => ["model-id-mismatch", "missing-model"].includes(f.code)));
    const fix = await s.doctor.proposeFix("channel/a/b/c", { persistCache: false });
    assert.equal(fix.result.plan?.changes.length ?? 0, 0);
    const repeat = await s.propose();
    assert.equal(repeat.plan.changes.length, 0);
    assert.equal((await s.doctor.applySync(repeat)).backupPath, undefined);
    assert.equal((await readdir(s.root)).filter((file) => file.startsWith("models.json.bak-")).length, 1);
  }
});

test("full exact global match precedes shorter direct metadata; intermediate suffix precedes terminal global match", async () => {
  const full = await setup({ channel: ["c"], source: ["a/b/c"] });
  const a = await full.propose();
  assert.equal(a.metadataSources[0].providerId, "source");
  assert.equal(a.metadataSources[0].modelId, "a/b/c");
  assert.equal(a.metadataSources[0].matchKind, undefined);
  const intermediate = await setup({ channel: ["c"], source: ["b/c"] });
  assert.equal((await intermediate.propose()).metadataSources[0].modelId, "b/c");
});

test("direct display-name ambiguity does not hide an exact global ID before stripping", async () => {
  // Both direct-provider names tie with the request. This is not an ID tie:
  // the existing exact global-ID tier must run before conservative defaults.
  const s = await setup({ channel: ["named-one", "named-two", "c"], source: ["a/b/c"] });
  const catalog = structuredClone(s.catalog);
  catalog.providers.channel.models["named-one"].name = "a/b/c";
  catalog.providers.channel.models["named-two"].name = "a/b/c";
  const doctor = new ModelDoctor({ paths: s.paths,
    channelFetch: async () => Response.json({ data: [{ id: "a/b/c" }] }),
    fetcher: { fetchImpl: async () => Response.json(catalog.providers) },
  });
  const proposal = await doctor.proposeSync({ target: "channel", modelIds: ["a/b/c"], persistCache: false });
  assert.equal(proposal.metadataSources[0].providerId, "source");
  assert.equal(proposal.metadataSources[0].modelId, "a/b/c");
  assert.equal(proposal.metadataSources[0].matchKind, undefined);
});

test("stripped reviewed publisher selection retains evidence and preview mapping", async () => {
  const s = await setup({ reseller: ["glm-5.3"], zai: ["glm-5.3"] }, ["route/team/glm-5.3"]);
  const proposal = await s.propose();
  const source = proposal.metadataSources[0];
  assert.equal(source.providerId, "zai");
  assert.equal(source.modelId, "glm-5.3");
  assert.equal(source.reason, "official-reference");
  assert.equal(source.matchKind, "prefix-stripped");
  assert.ok(source.evidence.length > 0);
  const messages: string[] = [];
  await runCommand("sync channel --models route/team/glm-5.3 --dry-run", {
    hasUI: false, ui: { notify: (message: string) => messages.push(message) },
  } as never, s.doctor);
  assert.match(messages.at(-1)!, /route\/team\/glm-5\.3 → zai\/glm-5\.3 \(official-reference; prefix-stripped\)/);
});

test("explicit metadata source remains scoped, including invalid/missing source and exact precedence", async () => {
  const s = await setup({ source: ["b/c", "a/b/c"], other: ["a/b/c", "c"] });
  assert.equal((await s.propose("source")).metadataSources[0].modelId, "a/b/c");
  const stripped = await setup({ source: ["c"], other: ["a/b/c"] });
  const selected = (await stripped.propose("source")).metadataSources[0];
  assert.equal(selected.modelId, "c");
  assert.equal(selected.reason, "explicit-provider");
  for (const provider of ["absent", "other"]) {
    const missing = await setup({ source: ["c"], other: ["unrelated"] });
    await assert.rejects(missing.propose(provider), (error: unknown) => (error as { code: string }).code === "invalid-target");
  }
});

test("ambiguous exact or stripped IDs never skip to a shorter unique source; case variants remain conservative", async () => {
  for (const ambiguousId of ["a/b/c", "b/c"]) {
    const s = await setup({ first: [ambiguousId], second: [ambiguousId], shorter: ["c"] });
    assert.equal((await s.propose()).metadataSources[0].reason, "conservative-defaults");
  }
  const variants = await setup({ source: ["b/C", "B/c", "c"] });
  assert.equal((await variants.propose()).metadataSources[0].reason, "conservative-defaults");
  await assert.rejects(variants.propose("source"), (error: unknown) => (error as { code: string }).code === "invalid-target");
  const missing = await setup({ source: ["unrelated"] });
  assert.equal((await missing.propose()).metadataSources[0].reason, "conservative-defaults");
});

test("managed stripped facts update through fix without renaming the runtime model", async () => {
  const s = await setup({ source: ["c"] });
  await s.doctor.applySync(await s.propose());
  const changed = structuredClone(s.catalog);
  changed.providers.source.models.c.limit = { context: 222222, output: 33333 };
  const doctor = new ModelDoctor({ paths: s.paths, fetcher: { fetchImpl: async () => Response.json(changed.providers) } });
  const fix = await doctor.proposeFix("channel/a/b/c", { persistCache: false });
  const model = fix.config.providers!.channel.models![0];
  assert.equal(model.id, "a/b/c");
  assert.equal(model.contextWindow, 222222);
  assert.equal(model.maxTokens, 33333);
  assert.equal(model._piModelDoctor?.metadataProvenance?.modelId, "c");
  await doctor.applyFix(fix);
  assert.equal((await doctor.proposeFix("channel/a/b/c", { persistCache: false })).result.plan?.changes.length ?? 0, 0);
});

test("stripped metadata survives provider-id collision, degraded discovery, and owned-field updates", async () => {
  const s = await setup({ channel: ["unrelated"], source: ["c"] }, ["a/b/c"], "channel", false);
  await s.doctor.applySync(await s.propose());
  const saved = (await readModelsJson(s.paths.modelsPath)).data;
  const provider = saved.providers!.channel;
  const model = provider.models![0];
  model.name = "User name";
  model.cost = { input: 7, output: 8, cacheRead: 9, cacheWrite: 10 };
  model.compat = { ...model.compat, userControl: true };
  model.contextWindow = 777; // user edit to an owned field must still win
  await writeFile(s.paths.modelsPath, JSON.stringify(saved));
  const repeat = await s.propose();
  const updated = repeat.config.providers!.channel;
  assert.equal(updated.models![0].name, "User name");
  assert.equal(updated.models![0].contextWindow, 777);
  assert.deepEqual(updated.models![0].cost, model.cost);
  assert.deepEqual(updated.models![0].compat, model.compat);
  assert.equal(updated.baseUrl, provider.baseUrl);
  assert.equal(updated.apiKey, "$SAMPLE_KEY");
  assert.deepEqual(updated.headers, { "x-custom": "keep" });
  assert.equal(repeat.metadataSources[0].providerId, "source");
  const fix = await s.doctor.proposeFix("channel/a/b/c", { persistCache: false });
  const repaired = fix.config.providers!.channel.models![0];
  assert.equal(repaired.id, "a/b/c");
  assert.equal(repaired.name, "User name");
  assert.equal(repaired.contextWindow, 777);
  assert.equal(repaired._piModelDoctor?.metadataProvenance?.matchKind, "prefix-stripped");
  assert.ok((await readFile(s.paths.modelsPath, "utf8")).includes("User name"));
});
