import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { discoverChannel, modelsEndpoint } from "../src/channel-discovery.ts";

test("header environment templates resolve safely and unsafe live IDs degrade", async () => {
  process.env.DOCTOR_HEADER_TOKEN = "template-secret";
  try {
    assert.equal(modelsEndpoint("https://localhost:1234/path#fragment"), "https://localhost:1234/path/models");
    const result = await discoverChannel({ baseUrl: "http://localhost:1", headers: { Authorization: "Bearer ${DOCTOR_HEADER_TOKEN}" } }, async (_, options) => {
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer template-secret");
      return Response.json({ data: [] });
    });
    assert.deepEqual(result.ids, []);
    let calls = 0;
    for (const value of ["Bearer ${DOCTOR_MISSING_TOKEN}", "Bearer !echo secret", "pi-auth:provider"]) {
      const rejected = await discoverChannel({ baseUrl: "http://localhost:1", headers: { Authorization: value } }, async () => { calls++; return Response.json({ data: [] }); });
      assert.equal(rejected.ids, undefined);
      assert.doesNotMatch(rejected.warnings.join(), /template-secret|echo secret/);
    }
    assert.equal(calls, 0);
    for (const id of ["__proto__", "constructor", "prototype", "bad id", "bad\u0000id"]) {
      assert.equal((await discoverChannel({ baseUrl: "http://localhost:1" }, async () => Response.json({ data: [{ id }] }))).ids, undefined);
    }
  } finally { delete process.env.DOCTOR_HEADER_TOKEN; }
});

test("native fetch local HTTP discovery, persistence and redirect isolation", async () => {
  const requests: { url: string | undefined; auth: string | undefined }[] = [];
  let forwarded = 0;
  const destination = createServer((_, response) => { forwarded++; response.end("unexpected"); });
  const server = createServer((request, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization });
    if (request.url === "/redirect/models") {
      response.writeHead(302, { location: `http://127.0.0.1:${(destination.address() as AddressInfo).port}/stolen` });
      response.end();
    } else if (request.url === "/denied/models") {
      response.writeHead(403); response.end("synthetic-secret-body");
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "NativeLive" }] }));
    }
  });
  await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { paths } = await fixture();
    await writeFile(paths.modelsPath, JSON.stringify({ providers: { channel: { baseUrl: `${base}/v1`, api: "openai-completions", apiKey: "synthetic-native-key", models: [{ id: "Existing", name: "Existing" }] } } }));
    const doctor = new ModelDoctor({ paths, fetcher: { fetchImpl: async () => { throw new Error("metadata offline"); } } });
    const proposal = await doctor.proposeSync({ target: "channel", modelIds: ["NativeLive"] });
    assert.equal(requests[0]?.url, "/v1/models");
    assert.equal(requests[0]?.auth, "Bearer synthetic-native-key");
    assert.ok(proposal.warnings.some((warning) => /source: channel/.test(warning)));
    const applied = await doctor.applySync(proposal);
    assert.ok(applied.backupPath);
    const persisted = JSON.parse(await readFile(paths.modelsPath, "utf8"));
    assert.deepEqual(persisted.providers.channel.models.map((model: { id: string }) => model.id), ["Existing", "NativeLive"]);
    const redirect = await discoverChannel({ baseUrl: `${base}/redirect`, apiKey: "synthetic-native-key" });
    assert.match(redirect.warnings.join(), /redirect rejected/);
    assert.equal(forwarded, 0);
    assert.equal(requests.at(-1)?.auth, "Bearer synthetic-native-key");
    const denied = await discoverChannel({ baseUrl: `${base}/denied`, apiKey: "synthetic-native-key" });
    assert.match(denied.warnings.join(), /403/);
    assert.doesNotMatch(denied.warnings.join(), /synthetic/);
  } finally {
    server.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())), new Promise<void>((resolve, reject) => destination.close((error) => error ? reject(error) : resolve()))]);
  }
  const unavailable = await discoverChannel({ baseUrl: base });
  assert.match(unavailable.warnings.join(), /network request failed/);
  assert.equal(unavailable.ids, undefined);
});

test("models endpoint preserves explicit paths and rejects unsafe origins", () => {
  assert.equal(modelsEndpoint("http://localhost:1234"), "http://localhost:1234/v1/models");
  assert.equal(modelsEndpoint("https://example.com/v1/"), "https://example.com/v1/models");
  assert.equal(modelsEndpoint("https://example.com/custom?x=1"), "https://example.com/custom/models?x=1");
  assert.throws(() => modelsEndpoint("https://10.0.0.1/v1"));
  assert.throws(() => modelsEndpoint("https://example.com?api_key=secret"));
});
test("channel discovery exact IDs, auth references and redirect isolation", async () => {
  process.env.DOCTOR_TEST_TOKEN = "test-only-token";
  try {
    const result = await discoverChannel({ baseUrl: "http://localhost:1234/v1", api: "openai-responses", apiKey: "$DOCTOR_TEST_TOKEN", headers: { "x-test": "hello" } }, async (url, options) => {
      assert.equal(String(url), "http://localhost:1234/v1/models");
      assert.equal(options?.redirect, "manual");
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-only-token");
      assert.equal(new Headers(options?.headers).get("x-test"), "hello");
      return Response.json({ data: [{ id: "Unknown" }, { id: "unknown" }, { id: "Unknown" }] });
    });
    assert.deepEqual(result.ids, ["Unknown", "unknown"]);
  } finally { delete process.env.DOCTOR_TEST_TOKEN; }
});
test("commands, unsupported APIs, HTTP failure, malformed and oversized data degrade safely", async () => {
  let called = false;
  const fetcher: typeof fetch = async () => { called = true; return Response.json({ data: [] }); };
  const command = await discoverChannel({ baseUrl: "http://localhost:1", apiKey: "!echo secret" }, fetcher);
  assert.equal(called, false); assert.equal(command.ids, undefined);
  await discoverChannel({ baseUrl: "http://localhost:1", api: "anthropic-messages" }, fetcher);
  assert.equal(called, false);
  const denied = await discoverChannel({ baseUrl: "http://localhost:1" }, async () => new Response("secret", { status: 401 }));
  assert.match(denied.warnings.join(), /401/); assert.doesNotMatch(denied.warnings.join(), /secret/);
  for (const body of [{ data: [{ id: 1 }] }, { data: Array.from({ length: 10001 }, () => ({ id: "x" })) }]) {
    assert.equal((await discoverChannel({ baseUrl: "http://localhost:1" }, async () => Response.json(body))).ids, undefined);
  }
});

import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelDoctor } from "../src/doctor.ts";
test("sync live unknown case variants survive metadata outage and dry-run is read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-channel-"));
  const paths = { modelsPath: join(root, "models.json"), doctorDir: join(root, "cache"), modelsCachePath: join(root, "cache/models.json"), providersCachePath: join(root, "cache/providers.json"), policiesCachePath: join(root, "cache/policies.json") };
  const original = JSON.stringify({ providers: { channel: { baseUrl: "http://localhost:1234/v1", api: "openai-completions", custom: "keep", models: [{ id: "old", name: "Old" }] } } });
  await writeFile(paths.modelsPath, original);
  let requests = 0;
  const doctor = new ModelDoctor({ paths, channelFetch: async () => { requests++; return Response.json({ data: [{ id: "New" }, { id: "new" }] }); }, fetcher: { fetchImpl: async () => { throw new Error("mock outage"); } } });
  const discovery = await doctor.discoverSync({ target: "channel", modelIds: [] });
  assert.equal(discovery.source, "channel");
  const proposal = await doctor.proposeSync({ target: "channel", modelIds: ["New", "new"], discovery, dryRun: true });
  assert.equal(requests, 1);
  assert.deepEqual(proposal.modelIds, ["New", "new"]);
  assert.deepEqual(proposal.config.providers?.channel.models?.map((model) => model.id), ["old", "New", "new"]);
  await assert.rejects(doctor.proposeSync({ target: "channel", modelIds: ["absent"], discovery, dryRun: true }), /absent/);
  assert.equal(await readFile(paths.modelsPath, "utf8"), original);
  assert.deepEqual(await readdir(root), ["models.json"]);
  proposal.dryRun = false;
  const applied = await doctor.applySync(proposal);
  assert.ok(applied.backupPath);
  assert.equal(await readFile(applied.backupPath!, "utf8"), original);
  const persisted = JSON.parse(await readFile(paths.modelsPath, "utf8"));
  assert.deepEqual(persisted.providers.channel.models.map((model: { id: string }) => model.id), ["old", "New", "new"]);
  assert.equal(persisted.providers.channel.custom, "keep");
  assert.equal((await readdir(root)).filter((name) => name.startsWith("models.json.bak-")).length, 1);
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

import { runCommand } from "../src/command.ts";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doctor-discovery-test-"));
  const paths = { modelsPath: join(root, "models.json"), doctorDir: join(root, "cache"), modelsCachePath: join(root, "cache/models.json"), providersCachePath: join(root, "cache/providers.json"), policiesCachePath: join(root, "cache/policies.json") };
  await writeFile(paths.modelsPath, JSON.stringify({ providers: { channel: { baseUrl: "http://localhost:1", api: "openai-completions", models: [] } } }));
  return { root, paths };
}
test("redirects never forward auth and body/time limits are bounded", async () => {
  let calls = 0;
  const redirect = await discoverChannel({ baseUrl: "http://localhost:1", apiKey: "literal-secret" }, async (_, options) => {
    calls++; assert.equal(options?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "https://other.example" } });
  });
  assert.equal(calls, 1); assert.match(redirect.warnings.join(), /redirect rejected/); assert.doesNotMatch(redirect.warnings.join(), /literal-secret/);
  const oversized = await discoverChannel({ baseUrl: "http://localhost:1" }, async () => new Response("x".repeat(1048577)));
  assert.match(oversized.warnings.join(), /body validation/);
  const start = Date.now();
  const timed = await discoverChannel({ baseUrl: "http://localhost:1" }, async () => new Response(new ReadableStream({ start() {} })));
  assert.match(timed.warnings.join(), /timed out/);
  assert.ok(Date.now() - start < 6500);
});
test("CLI literal opt-in, early validation, fallback and UI live selection", async () => {
  const { root, paths } = await fixture();
  const auth: (string | null)[] = [];
  const doctor = new ModelDoctor({ paths, channelFetch: async (_, options) => {
    auth.push(new Headers(options?.headers).get("authorization"));
    return Response.json({ data: [{ id: "Live" }, { id: "live" }] });
  }, fetcher: { fetchImpl: async () => { throw new Error("mock outage"); } } });
  await doctor.discoverSync({ target: "channel", modelIds: [], apiKey: "literal-secret" });
  assert.equal(auth[0], null);
  await doctor.discoverSync({ target: "channel", modelIds: [], apiKey: "literal-secret", allowLiteralApiKey: true });
  assert.equal(auth[1], "Bearer literal-secret");
  await assert.rejects(doctor.discoverSync({ target: "channel", modelIds: ["\n"] }));
  assert.equal(auth.length, 2);
  const notifications: string[] = [];
  let selections = 0;
  await runCommand("sync channel --dry-run", { hasUI: true, ui: {
    notify: (text: string) => notifications.push(text),
    select: async (_: string, choices: string[]) => { selections++; return choices.find((choice) => selections === 1 ? choice.includes("Live") : choice.includes("Done")); },
    confirm: async () => true,
  } } as never, doctor);
  assert.ok(notifications.some((text) => /source: channel/.test(text)));
  assert.ok(notifications.some((text) => /Live/.test(text)));
  assert.deepEqual(await readdir(root), ["models.json"]);
  const fallback = new ModelDoctor({ paths, channelFetch: async () => new Response(null, { status: 404 }), fetcher: { fetchImpl: async () => { throw new Error("mock outage"); } } });
  const result = await fallback.discoverSync({ target: "channel", modelIds: ["explicit"] });
  assert.equal(result.source, "local-explicit"); assert.deepEqual(result.candidates.map((model) => model.id), ["explicit"]);
  assert.match(result.warnings.join(), /404/);
});

test("discovery binding, empty live list and headless missing selection are enforced", async () => {
  const { paths } = await fixture();
  let calls = 0;
  const doctor = new ModelDoctor({ paths, channelFetch: async () => { calls++; return Response.json({ data: [] }); }, fetcher: { fetchImpl: async () => { throw new Error("outage"); } } });
  const discovery = await doctor.discoverSync({ target: "channel", modelIds: [] });
  assert.equal(discovery.source, "channel");
  assert.deepEqual(discovery.candidates, []);
  await assert.rejects(doctor.proposeSync({ target: "channel", modelIds: ["absent"], discovery, dryRun: true }), /absent/);
  await assert.rejects(doctor.proposeSync({ target: "https://other.example", modelIds: ["x"], discovery, dryRun: true }), /does not match/);
  await assert.rejects(doctor.proposeSync({ target: "channel", modelIds: ["x"], discovery: { source: "channel", candidates: [{ id: "x", providerId: "channel", deprecated: false, matchedBy: [] }], warnings: [] }, dryRun: true }), /does not match/);
  const notifications: string[] = [];
  await runCommand("sync channel --dry-run", { hasUI: false, ui: { notify: (text: string) => notifications.push(text) } } as never, doctor);
  assert.equal(calls, 1);
  assert.ok(notifications.some((text) => /selection|--models/i.test(text)));
});

test("missing configured protocol infers Anthropic and official URL sync keeps transport", async () => {
  const { paths } = await fixture();
  await writeFile(paths.modelsPath, JSON.stringify({ providers: { channel: { baseUrl: "https://api.anthropic.com", models: [] } } }));
  let calls = 0;
  const unsupported = new ModelDoctor({ paths, channelFetch: async () => { calls++; return Response.json({ data: [] }); }, fetcher: { fetchImpl: async () => { throw new Error("outage"); } } });
  const result = await unsupported.discoverSync({ target: "channel", modelIds: ["claude"] });
  assert.equal(calls, 0);
  assert.match(result.warnings.join(), /unsupported/);
  const catalog = { official: { id: "official", api: "https://official.example/v1", models: { Live: { id: "Live", name: "Enriched" } } } };
  const doctor = new ModelDoctor({ paths, channelFetch: async () => Response.json({ data: [{ id: "Live" }] }), fetcher: { fetchImpl: async () => Response.json(catalog) } });
  const proposal = await doctor.proposeSync({ target: "https://official.example/v1", modelIds: ["Live"], api: "openai-responses", apiKey: "$CHANNEL_TOKEN", dryRun: true });
  const provider = proposal.config.providers?.[proposal.providerId];
  assert.equal(provider?.baseUrl, "https://official.example/v1");
  assert.equal(provider?.api, "openai-responses");
  assert.equal(provider?.apiKey, "$CHANNEL_TOKEN");
});

test("live IDs override catalog ambiguity/case variants and catalog fallback stays labelled", async () => {
  const { paths } = await fixture();
  const catalog = { a: { id: "a", api: "https://a.example/v1", models: { Shared: { id: "Shared" }, shared: { id: "shared" } } }, b: { id: "b", api: "https://b.example/v1", models: { Shared: { id: "Shared" } } } };
  const doctor = new ModelDoctor({ paths, channelFetch: async () => Response.json({ data: [{ id: "Shared" }, { id: "shared" }] }), fetcher: { fetchImpl: async () => Response.json(catalog) } });
  const proposal = await doctor.proposeSync({ target: "channel", modelIds: ["Shared", "shared"], dryRun: true });
  assert.deepEqual(proposal.modelIds, ["Shared", "shared"]);
  assert.deepEqual(proposal.config.providers?.channel.models?.map((model) => model.id), ["Shared", "shared"]);
  assert.ok(proposal.warnings.some((warning) => /Official metadata source unknown.*conservative defaults/.test(warning)));
  const urlDoctor = new ModelDoctor({ paths, channelFetch: async () => { throw new Error("must not call Anthropic discovery"); }, fetcher: { fetchImpl: async () => Response.json({ anthropic: { id: "anthropic", api: "https://api.anthropic.com", npm: "@ai-sdk/anthropic", models: { claude: { id: "claude" } } } }) } });
  const result = await urlDoctor.discoverSync({ target: "https://api.anthropic.com", modelIds: [] });
  assert.equal(result.source, "models.dev");
  assert.match(result.warnings.join(), /unsupported/);
});
