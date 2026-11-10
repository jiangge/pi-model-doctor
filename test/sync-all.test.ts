import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCommandArgs, runCommand } from "../src/command.ts";
import { ModelDoctor } from "../src/doctor.ts";
import { normalizeCatalog } from "../src/models-dev.ts";
import { readModelsJson } from "../src/json.ts";
import type { DoctorPaths } from "../src/types.ts";

const fixtureRoots = new Set<string>();
test.afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { recursive: true, force: true })));
  fixtureRoots.clear();
});

async function setup(ids: string[], status = 200) {
  const root = await mkdtemp(join(tmpdir(), "pi-sync-all-"));
  fixtureRoots.add(root);
  const paths: DoctorPaths = {
    modelsPath: join(root, "models.json"), doctorDir: join(root, "doctor"),
    modelsCachePath: join(root, "doctor", "models-cache.json"),
    providersCachePath: join(root, "doctor", "providers-cache.json"),
    policiesCachePath: join(root, "doctor", "policies-cache.json"),
  };
  const initial = JSON.stringify({ custom: true, providers: {
    channel: { baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions", headers: { "x-custom": "keep" }, models: [] },
    unrelated: { models: [{ id: "keep" }] },
  } });
  await writeFile(paths.modelsPath, initial);
  let requests = 0;
  const doctor = new ModelDoctor({ paths,
    channelFetch: async () => { requests += 1; return Response.json({ data: ids.map((id) => ({ id })) }, { status }); },
    fetcher: { fetchImpl: async () => Response.json(normalizeCatalog({ source: { id: "source", api: "https://source.example/v1", models: { known: { id: "known" } } } })) },
  });
  const notifications: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notifications.push(message) } } as never;
  return { root, paths, initial, doctor, notifications, ctx, requests: () => requests };
}

test("sync --all flags reject conflicts and unauthorized discovery", async () => {
  assert.equal(parseCommandArgs("sync --all channel").flags.all, true);
  const s = await setup(["known"]);
  for (const [command, expected] of [
    ["sync channel --all --models known --dry-run", /cannot be combined/],
    ["sync channel --all=invalid --dry-run", /expects true or false/],
    ["list --all", /Unknown flag/],
    ["sync channel --all", /requires --yes/],
    ["sync channel --all=false --yes", /Model selection is required/],
  ] as const) {
    await runCommand(command, s.ctx, s.doctor);
    assert.match(s.notifications.at(-1)!, expected);
  }
  assert.equal(s.requests(), 0);
  assert.equal(await readFile(s.paths.modelsPath, "utf8"), s.initial);
  assert.deepEqual(await readdir(s.root), ["models.json"]);
});

test("sync --all requires live advertisement and treats empty success as no write", async () => {
  for (const status of [200, 404]) {
    const s = await setup([], status);
    await runCommand("sync channel --all --yes", s.ctx, s.doctor);
    assert.match(s.notifications.at(-1)!, status === 200 ? /advertised 0 models.*not-persisted/ : /requires a successful channel advertisement.*not-persisted/);
    assert.equal(s.requests(), 1);
    assert.equal(await readFile(s.paths.modelsPath, "utf8"), s.initial);
    assert.deepEqual(await readdir(s.root), ["models.json"]);
  }
});

test("sync --all hundreds of exact IDs use one proposal/apply and backup with bounded output", async () => {
  const ids = ["known", "Case", "case", ...Array.from({ length: 300 }, (_, i) => `unknown-${i}`)];
  const s = await setup([...ids, "known"]);
  let proposals = 0;
  let applies = 0;
  const propose = s.doctor.proposeSync.bind(s.doctor);
  const apply = s.doctor.applySync.bind(s.doctor);
  s.doctor.proposeSync = async (input) => { proposals += 1; return propose(input); };
  s.doctor.applySync = async (proposal) => { applies += 1; return apply(proposal); };
  await runCommand("sync channel --all --yes --dry-run", s.ctx, s.doctor);
  assert.match(s.notifications.at(-1)!, /not-persisted \(dry-run\)/);
  assert.equal(await readFile(s.paths.modelsPath, "utf8"), s.initial);
  assert.deepEqual(await readdir(s.root), ["models.json"]);
  assert.equal(applies, 0);
  proposals = 0;
  await runCommand("sync channel --all --yes", s.ctx, s.doctor);
  assert.equal(proposals, 1);
  assert.equal(applies, 1);
  const saved = (await readModelsJson(s.paths.modelsPath)).data;
  assert.deepEqual(saved.providers?.channel?.models?.map((model) => model.id).sort(), [...ids].sort());
  assert.deepEqual(saved.providers?.channel?.headers, { "x-custom": "keep" });
  assert.equal(saved.custom, true);
  assert.equal(saved.providers?.unrelated?.models?.[0]?.id, "keep");
  const backups = (await readdir(s.root)).filter((file) => file.startsWith("models.json.bak-"));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(join(s.root, backups[0]), "utf8"), s.initial);
  assert.match(s.notifications.at(-1)!, /Models: 303/);
  assert.match(s.notifications.at(-1)!, /Conservative defaults: 302/);
  assert.match(s.notifications.at(-1)!, /more warnings/);
  assert.match(s.notifications.at(-1)!, /Synced. Backup:/);
  assert.ok(s.notifications.every((message) => message.length < 20000));
  await runCommand("sync channel --all --yes", s.ctx, s.doctor);
  assert.match(s.notifications.at(-1)!, /already-persisted/);
  assert.equal((await readdir(s.root)).filter((file) => file.startsWith("models.json.bak-")).length, 1);
});

test("sync --all bounds failed-apply notifications as well as successful previews", async () => {
  const s = await setup(["known"]);
  s.doctor.applySync = async () => {
    throw new Error(`Apply failed: Authorization: Bearer synthetic-secret-value ${"conflict ".repeat(10000)}`);
  };
  await runCommand("sync channel --all --yes", s.ctx, s.doctor);
  assert.match(s.notifications.at(-1)!, /Apply failed/);
  assert.ok(s.notifications.at(-1)!.length < 2100);
  assert.doesNotMatch(s.notifications.at(-1)!, /synthetic-secret-value/);
  assert.equal(await readFile(s.paths.modelsPath, "utf8"), s.initial);
  // Normal authorized proposals may persist catalog caches before apply.
  assert.ok(!(await readdir(s.root)).some((file) => file.startsWith("models.json.bak-")));
});

test("sync --all bounds conflict/value previews and shares them with interactive authorization", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `custom-${i}-${"x".repeat(200)}`);
  const s = await setup(ids);
  const config = JSON.parse(s.initial);
  config.providers.channel.models = ids.map((id) => ({ id, name: "user-name", contextWindow: 42, maxTokens: 10, compat: { custom: "y".repeat(1000) } }));
  await writeFile(s.paths.modelsPath, JSON.stringify(config));
  let preview = "";
  const ctx = { hasUI: true, ui: {
    notify: (message: string) => s.notifications.push(message),
    select: async () => { throw new Error("--all must bypass picker"); },
    confirm: async (_title: string, message: string) => { preview = message; return true; },
  } } as never;
  await runCommand("sync channel --all", ctx, s.doctor);
  assert.ok(preview.length > 0 && preview.length < 20000);
  assert.ok(s.notifications.at(-1)!.startsWith(preview));
  assert.match(preview, /more conflicts/);
  assert.ok(s.notifications.every((message) => message.length < 20000));
  const saved = (await readModelsJson(s.paths.modelsPath)).data;
  assert.ok(saved.providers?.channel?.models?.every((model) => model.contextWindow === 42 && model.name === "user-name"));
});
