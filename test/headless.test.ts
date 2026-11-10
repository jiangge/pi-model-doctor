import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerModelDoctorCommand, runCommand, type CommandResult } from "../src/command.ts";
import { ModelDoctor } from "../src/doctor.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "doctor-headless-"));
  const doctorDir = join(root, "cache");
  const modelsPath = join(root, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: { channel: { baseUrl: "http://127.0.0.1:12345/v1", api: "openai-completions", models: [] } } }));
  const doctor = new ModelDoctor({ paths: { modelsPath, doctorDir, modelsCachePath: join(doctorDir, "models-cache.json"), providersCachePath: join(doctorDir, "providers-cache.json"), policiesCachePath: join(doctorDir, "policies-cache.json") },
    channelFetch: async () => Response.json({ data: [{ id: "unknown" }] }),
    fetcher: { fetchImpl: async () => { throw new Error("offline"); } },
  });
  const notices: string[] = [];
  const ctx = { hasUI: false, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionCommandContext;
  return { root, doctor, ctx, notices };
}

test("registered headless results use supported custom messages, while TUI/RPC keep notify", async () => {
  const s = await fixture();
  try {
    let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    const messages: unknown[] = [];
    const api = { registerCommand: (_name: string, command: { handler: typeof handler }) => { handler = command.handler; }, sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }) } as unknown as ExtensionAPI;
    registerModelDoctorCommand(api, s.doctor);
    await handler("help", s.ctx);
    assert.equal(messages.length, 1);
    assert.deepEqual((messages[0] as { options: unknown }).options, { triggerTurn: false });
    assert.equal((messages[0] as { message: { customType: string } }).message.customType, "model-doctor-result");
    await handler("help", { ...s.ctx, hasUI: true });
    assert.equal(messages.length, 1);
    assert.equal(s.notices.length, 2);
  } finally { await rm(s.root, { recursive: true, force: true }); }
});

test("final results cover validation, authorization, operation failure, dry-run, persistence and no-op", async () => {
  const s = await fixture();
  try {
    for (const [command, status, success] of [
      ["help", "completed", true], ["unknown", "failed", false],
      ["sync channel --all --models x --dry-run", "failed", false],
      ["remove", "failed", false], ["sync channel --all", "failed", false],
      ["rollback missing --yes", "failed", false],
      ["sync channel --all --dry-run", "dry-run", true],
      ["sync channel --all --yes", "persisted-reload-required", true],
      ["sync channel --all --yes", "no-op", true],
    ] as const) {
      const results: CommandResult[] = [];
      await runCommand(command, s.ctx, s.doctor, (result) => results.push(result));
      assert.equal(results.length, 1, command);
      assert.equal(results[0].details.status, status, command);
      assert.equal(results[0].details.success, success, command);
      assert.equal(results[0].details.final, true);
      assert.ok(results[0].content.length <= 12000);
      assert.deepEqual(Object.keys(results[0].details).sort(), ["command", "final", "severity", "status", "success"]);
    }
    // Only activation's path comparison is mocked; all actual I/O stays in root.
    s.doctor.getModelsPath = () => join(getAgentDir(), "models.json");
    const failedActivation: CommandResult[] = [];
    await runCommand("configure channel --api anthropic-messages --yes", {
      ...s.ctx, modelRegistry: { refresh: async () => { throw new Error("registry unavailable"); }, find: () => undefined },
    } as unknown as ExtensionCommandContext, s.doctor, (result) => failedActivation.push(result));
    assert.equal(failedActivation[0].details.status, "activation-failed");
    assert.equal(failedActivation[0].details.success, false);
    s.doctor.list = async () => { throw new Error(`Authorization: Bearer test-secret-value ${"x".repeat(15000)}`); };
    const results: CommandResult[] = [];
    await runCommand("list", s.ctx, s.doctor, (result) => results.push(result));
    assert.equal(results[0].details.success, false);
    assert.ok(results[0].content.length <= 12000);
    assert.doesNotMatch(results[0].content, /test-secret-value/);
  } finally { await rm(s.root, { recursive: true, force: true }); }
});

test("installed Pi JSON dispatch emits final results without model work; plain print stays silent", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-pi-json-"));
  try {
    const agent = join(root, "agent");
    await mkdir(agent);
    const hostEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const cli = join(dirname(hostEntry), "cli.js");
    const env = {
      PATH: process.env.PATH, HOME: root, TMPDIR: root,
      PI_CODING_AGENT_DIR: agent, PI_MODEL_DOCTOR_DIR: join(root, "cache"),
      PI_MODEL_DOCTOR_MODELS_PATH: join(agent, "models.json"),
      PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS: "0", PI_SKIP_VERSION_CHECK: "1",
    };
    const runHost = (args: string[]) => {
      const pending = promisify(execFile)(process.execPath, args, { cwd: root, env, timeout: 20000, maxBuffer: 1024 * 1024 });
      // Print mode reads piped stdin before dispatch; execFile leaves it open.
      pending.child.stdin?.end();
      return pending;
    };
    const base = [cli, "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "-e", resolve("index.ts")];
    for (const [command, success] of [["help", true], ["sync --bad-flag", false]] as const) {
      const { stdout } = await runHost([...base, "--mode", "json", `/model-doctor ${command}`]);
      const records = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const results = records.filter((record) => record.type === "message_end" && record.message?.role === "custom" && record.message.customType === "model-doctor-result");
      assert.equal(results.length, 1, stdout);
      assert.equal(results[0].message.details.success, success);
      assert.equal(results[0].message.details.final, true);
      assert.ok(!records.some((record) => record.type === "agent_start" || record.message?.role === "assistant" || record.type === "tool_execution_start"), "command must not start model work");
    }
    const plain = await runHost([...base, "-p", "/model-doctor help"]);
    assert.equal(plain.stdout.trim(), "");
    assert.ok(!(await readdir(root)).includes("cache"));
    // The host initializes an empty auth store in its isolated agent directory.
    assert.deepEqual(JSON.parse(await readFile(join(agent, "auth.json"), "utf8")), {});
    assert.ok(!(await readdir(agent)).includes("models.json"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
