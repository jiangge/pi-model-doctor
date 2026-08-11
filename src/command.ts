import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ModelDoctor, type DoctorListItem } from "./doctor.ts";
import { DoctorError, errorMessage, looksLikeCredentialValue, redactSensitiveText } from "./json.ts";
import type { ChangePlan, CheckResult, ModelCandidate, RefreshResult, RuntimeActivationStatus } from "./types.ts";
import { resolve } from "node:path";

export interface ParsedCommand {
  command: "add" | "list" | "check" | "fix" | "remove" | "refresh" | "sync" | "migrate" | "cleanup-backups" | "rollback" | "help" | "invalid";
  args: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set(["dry-run", "yes", "force", "remove-source", "allow-literal-api-key"]);
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  add: new Set(["api-key", "metadata-provider", "api", "dry-run", "yes", "allow-literal-api-key"]),
  sync: new Set(["models", "api-key", "metadata-provider", "api", "dry-run", "yes", "allow-literal-api-key"]),
  list: new Set(),
  check: new Set(),
  fix: new Set(["dry-run", "yes"]),
  remove: new Set(["dry-run", "yes"]),
  refresh: new Set(["force", "dry-run"]),
  migrate: new Set(["to", "dry-run", "yes", "remove-source"]),
  "cleanup-backups": new Set(["keep", "max-age-ms", "dry-run", "yes"]),
  rollback: new Set(["dry-run", "yes"]),
  help: new Set(),
};

export function parseCommandArgs(input: string): ParsedCommand {
  const tokens = tokenize(input.trim());
  const commandToken = tokens.shift()?.toLowerCase() ?? "help";
  const command = commandToken === "--help" || commandToken === "-h"
    ? "help"
    : isCommand(commandToken) ? commandToken : commandToken ? "invalid" : "help";
  const args: string[] = command === "invalid" ? [commandToken] : [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      args.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      const name = token.slice(2, equals);
      const value = token.slice(equals + 1);
      flags[name] = BOOLEAN_FLAGS.has(name) && (value === "true" || value === "false") ? value === "true" : value;
      continue;
    }
    const name = token.slice(2);
    const next = tokens[index + 1];
    const consumesNext = next && !next.startsWith("--") && (!BOOLEAN_FLAGS.has(name) || next === "true" || next === "false");
    if (consumesNext) {
      flags[name] = BOOLEAN_FLAGS.has(name) ? next === "true" : next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command, args, flags };
}

export function formatPlan(plan: ChangePlan): string {
  const lines = [`Target: ${redactSensitiveText(plan.target)}`, `Changes: ${plan.changes.length}`, `Conflicts: ${plan.conflicts.length}`];
  for (const change of plan.changes.slice(0, 20)) {
    lines.push(`- ${redactSensitiveText(change.path)}: ${formatValue(change.before, change.path)} → ${formatValue(change.after, change.path)} (${redactSensitiveText(change.reason)})`);
  }
  if (plan.changes.length > 20) lines.push(`- … ${plan.changes.length - 20} more changes`);
  for (const conflict of plan.conflicts) lines.push(`! ${redactSensitiveText(conflict.message)}`);
  for (const warning of plan.warnings) lines.push(`⚠ ${redactSensitiveText(warning)}`);
  return lines.join("\n");
}

export function formatFindings(result: CheckResult): string {
  if (result.findings.length === 0) return `${redactSensitiveText(result.target ?? "models.json")}: healthy`;
  const lines = [`${redactSensitiveText(result.target ?? "models.json")}: ${result.findings.length} finding(s)`];
  for (const item of result.findings) lines.push(`${severityIcon(item.severity)} ${item.code}: ${redactSensitiveText(item.message)}`);
  if (result.plan) lines.push(`Repair plan: ${result.plan.changes.length} change(s), ${result.plan.conflicts.length} conflict(s)`);
  return lines.join("\n");
}

export function formatList(items: DoctorListItem[]): string {
  if (items.length === 0) return "No configured models found.";
  return items.map((item) => {
    const capabilities = [item.reasoning ? "reasoning" : undefined, item.contextWindow ? `${item.contextWindow} ctx` : undefined, item.managed ? "managed" : "user-owned"].filter(Boolean).join(", ");
    return redactSensitiveText(`${item.provider}/${item.model}${item.name ? ` (${item.name})` : ""} — ${capabilities || "no metadata"}`);
  }).join("\n");
}

export function formatCandidates(candidates: ModelCandidate[]): string {
  if (candidates.length === 0) return "No matching models found.";
  return candidates.map((candidate, index) => formatCandidateLabel(candidate, index)).join("\n");
}

export function registerModelDoctorCommand(pi: ExtensionAPI, doctor: ModelDoctor): void {
  pi.registerCommand("model-doctor", {
    description: "Discover, sync, check, fix, migrate, and manage Pi models.json",
    getArgumentCompletions: (prefix) => {
      const values = ["add", "list", "check", "fix", "remove", "refresh", "sync", "migrate", "cleanup-backups", "rollback", "help"];
      return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    handler: async (rawArgs, ctx) => {
      await runCommand(rawArgs, ctx, doctor);
    },
  });
}

export async function runCommand(rawArgs: string, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const parsed = parseCommandArgs(rawArgs);
  try {
    validateCommand(parsed);
    switch (parsed.command) {
      case "add":
        await runAdd(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "list":
        ctx.ui.notify(formatList(await doctor.list(parsed.args[0])), "info");
        return;
      case "check":
        if (parsed.args[0]) validateProviderModelTarget(parsed.args[0], "check");
        ctx.ui.notify(formatFindings(await doctor.check(parsed.args[0])), "info");
        return;
      case "fix":
        await runFix(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "remove":
        await runRemove(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "refresh": {
        const dryRun = parsed.flags["dry-run"] === true;
        ctx.ui.notify(formatRefresh(await doctor.refresh(parsed.flags.force === true, !dryRun)), "info");
        return;
      }
      case "sync":
        await runSync(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "migrate":
        await runMigrate(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "cleanup-backups":
        await runCleanupBackups(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "rollback":
        await runRollback(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "invalid":
        ctx.ui.notify(`Unknown model-doctor subcommand: ${parsed.args[0] ?? ""}\n${helpText()}`, "error");
        return;
      default:
        ctx.ui.notify(helpText(), "info");
    }
  } catch (error) {
    ctx.ui.notify(`model-doctor: ${errorMessage(error)}`, "error");
  }
}

async function runRollback(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  if (args.length !== 1) throw new DoctorError("Usage: /model-doctor rollback <models.json.bak-timestamp> [--dry-run] [--yes]", "invalid-target");
  const backupPath = args[0];
  const dryRun = flags["dry-run"] === true;
  const preview = `Rollback models.json from ${redactSensitiveText(backupPath)}. The current file will be backed up before restore.`;
  await doctor.rollback(backupPath, { dryRun: true });
  if (dryRun) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted (dry-run).`, "info");
    return;
  }
  const beforeRollback = await doctor.list();
  ensureHeadlessAuthorization(ctx, flags, "rollback", false);
  await requireAuthorization(ctx, flags, "rollback", preview);
  const restored = await doctor.rollback(backupPath);
  const afterRollback = await doctor.list();
  const restoredIds = new Set(afterRollback.map((item) => `${normalizeRuntimeId(item.provider)}/${normalizeRuntimeId(item.model)}`));
  const expectations = [
    ...afterRollback.map((item) => ({ provider: item.provider, model: item.model, present: true })),
    ...beforeRollback
      .filter((item) => !restoredIds.has(`${normalizeRuntimeId(item.provider)}/${normalizeRuntimeId(item.model)}`))
      .map((item) => ({ provider: item.provider, model: item.model, present: false })),
  ];
  const status = await activateRuntime(ctx, doctor, expectations);
  ctx.ui.notify(`${preview}\nStatus: ${statusMessage(status)}\nRestored. Safety backup: ${restored.safetyBackupPath ? redactSensitiveText(restored.safetyBackupPath) : "none"}`, status === "activation-failed" ? "warning" : "info");
}

async function runCleanupBackups(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  if (args.length > 0) throw new DoctorError("Usage: /model-doctor cleanup-backups [--keep <count>] [--max-age-ms <milliseconds>] [--dry-run] [--yes]", "invalid-target");
  const keep = parseNonNegativeIntegerFlag(flags.keep, "keep");
  const maxAgeMs = parseNonNegativeNumberFlag(flags["max-age-ms"], "max-age-ms");
  const dryRun = flags["dry-run"] === true;
  const candidates = await doctor.cleanupBackups({ keep, maxAgeMs, dryRun: true });
  const preview = `${dryRun ? "Would remove" : "Remove"} ${candidates.length} backup(s).${candidates.length > 0 ? `\n${candidates.map((path) => redactSensitiveText(path)).join("\n")}` : ""}`;
  if (dryRun) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted (dry-run).`, "info");
    return;
  }
  ensureHeadlessAuthorization(ctx, flags, "cleanup-backups", false);
  await requireAuthorization(ctx, flags, "cleanup-backups", preview);
  const removed = await doctor.cleanupBackups({ keep, maxAgeMs });
  ctx.ui.notify(`Removed ${removed.length} backup(s).\nStatus: persisted.`, "warning");
}

function parsePiApiFlag(value: string): "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai" {
  if (value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages" || value === "google-generative-ai") return value;
  throw new DoctorError(`Flag --api must be one of openai-completions, openai-responses, anthropic-messages, google-generative-ai`, "invalid-target");
}

function parseNonNegativeIntegerFlag(value: string | boolean | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new DoctorError(`Flag --${name} requires a non-negative integer`, "invalid-target");
  return Number(value);
}

function parseNonNegativeNumberFlag(value: string | boolean | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) throw new DoctorError(`Flag --${name} requires a non-negative number`, "invalid-target");
  return Number(value);
}

function parseModelIdsFlag(value: string | boolean | undefined): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new DoctorError("Flag --models requires a comma-separated model id list", "invalid-target");
  const modelIds = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (modelIds.length === 0 || modelIds.some((modelId) => isUnsafeTargetIdentifier(modelId))) {
    throw new DoctorError("Flag --models requires one or more safe model ids", "invalid-target");
  }
  return modelIds;
}

async function runSync(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const target = args[0];
  if (!target) throw new DoctorError("Usage: /model-doctor sync <provider-or-url> [--models <id1,id2>] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]", "invalid-target");
  const dryRun = flags["dry-run"] === true;
  let metadataProvider = typeof flags["metadata-provider"] === "string" ? flags["metadata-provider"] : undefined;
  const explicitModelIds = parseModelIdsFlag(flags.models);
  const selectedApi = typeof flags.api === "string" ? parsePiApiFlag(flags.api) : undefined;
  let modelIds = explicitModelIds;
  if (modelIds.length === 0 && ctx.hasUI) {
    const candidates = await doctor.listCandidates(target, false, undefined, metadataProvider);
    if (candidates.length === 0) throw new DoctorError(`No models.dev models found for ${target}; provide --models <id1,id2>`, "invalid-target");
    const remaining = [...candidates];
    const selected: ModelCandidate[] = [];
    while (remaining.length > 0) {
      const doneLabel = `Done (${selected.length} selected)`;
      const choices = [...remaining.map((candidate, index) => formatCandidateLabel(candidate, index)), doneLabel];
      const choice = await ctx.ui.select(`Select models to sync for ${redactSensitiveText(target)}; choose Done when finished`, choices);
      if (!choice) {
        ctx.ui.notify("Sync cancelled. Status: not-persisted; models.json was not changed.", "info");
        return;
      }
      if (choice === doneLabel) break;
      const selectedIndex = choices.indexOf(choice);
      const candidate = selectedIndex >= 0 ? remaining[selectedIndex] : undefined;
      if (!candidate) throw new DoctorError("The selected model is no longer available; retry model discovery", "invalid-target");
      selected.push(candidate);
      remaining.splice(selectedIndex, 1);
    }
    const metadataProviders = new Set(selected.filter((candidate) => candidate.metadataOnly).map((candidate) => candidate.providerId));
    if (!metadataProvider && metadataProviders.size === 1) {
      // The selected candidate carries the unambiguous models.dev provider
      // identity needed by proposeSync for all subsequent model resolutions.
      metadataProvider = [...metadataProviders][0];
    }
    modelIds = [...new Set(selected.map((candidate) => candidate.id))];
    if (modelIds.length === 0) {
      ctx.ui.notify("Sync cancelled. Status: not-persisted; models.json was not changed.", "info");
      return;
    }
  }
  if (modelIds.length === 0) throw new DoctorError("Model selection is required; use --models <id1,id2> in non-interactive mode", "selection-required");
  ensureHeadlessAuthorization(ctx, flags, "sync", dryRun);
  const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  const proposal = await doctor.proposeSync({
    target,
    modelIds,
    metadataProvider,
    api: selectedApi,
    apiKey,
    allowLiteralApiKey: flags["allow-literal-api-key"] === true,
    dryRun,
    persistCache: !dryRun && !ctx.hasUI,
  });
  const preview = [
    `Sync ${redactSensitiveText(proposal.target)}`,
    `Models: ${proposal.modelIds.map((modelId) => redactSensitiveText(modelId)).join(", ")}`,
    proposal.warnings.length > 0 ? `Warnings:\n${proposal.warnings.map((warning) => `⚠ ${redactSensitiveText(warning)}`).join("\n")}` : undefined,
    formatPlan(proposal.plan),
  ].filter(Boolean).join("\n");
  if (dryRun) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted (dry-run).`, "info");
    return;
  }
  if (proposal.plan.changes.length === 0) {
    ctx.ui.notify(`${preview}\nNo changes needed.\nStatus: not-persisted.`, "info");
    return;
  }
  await requireAuthorization(ctx, flags, "sync", preview);
  const applied = await doctor.applySync(proposal);
  const status = await activateRuntime(ctx, doctor, proposal.modelIds.map((modelId) => ({ provider: proposal.providerId, model: modelId, present: true })));
  ctx.ui.notify(`${preview}\nStatus: ${statusMessage(status)}\nSynced. Backup: ${applied.backupPath ? redactSensitiveText(applied.backupPath) : "none (new file)"}`, status === "activation-failed" ? "warning" : "info");
}

async function runAdd(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const target = args[0];
  if (!target) throw new DoctorError("Usage: /model-doctor add <provider-or-url> [model] | add <provider-id> <endpoint-url> [model] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]", "invalid-target");
  const dryRun = flags["dry-run"] === true;
  const explicitEndpoint = !/^https?:\/\//i.test(target) && /^https?:\/\//i.test(args[1] ?? "") ? args[1] : undefined;
  const explicitProviderId = explicitEndpoint ? target : undefined;
  let modelId = explicitEndpoint ? args[2] : args[1];
  let resolvedTarget = explicitEndpoint ?? target;
  let selectedMetadataProvider = typeof flags["metadata-provider"] === "string" ? flags["metadata-provider"] : undefined;
  if (!modelId && !explicitEndpoint && ctx.hasUI && !/^https?:\/\//i.test(target)) {
    const candidates = await doctor.listCandidates(target, false, undefined, selectedMetadataProvider);
    if (candidates.length === 0) throw new DoctorError(`No models.dev models found for ${target}; provide an explicit model id`, "invalid-target");
    const choices = candidates.map((candidate, index) => formatCandidateLabel(candidate, index));
    const selected = await ctx.ui.select(`Select model for ${redactSensitiveText(target)}`, choices);
    if (!selected) {
      ctx.ui.notify("Add cancelled. Status: not-persisted; models.json was not changed.", "info");
      return;
    }
    const selectedIndex = choices.indexOf(selected);
    const candidate = selectedIndex >= 0 ? candidates[selectedIndex] : undefined;
    if (!candidate) throw new DoctorError("The selected model is no longer available; retry model discovery", "invalid-target");
    // Preserve an explicitly supplied provider URL (including a proxy) while
    // using the selected catalog provider id for ordinary provider/model
    // discovery targets.
    resolvedTarget = /^https?:\/\//i.test(target) ? target : candidate.providerId;
    modelId = candidate.id;
    if (candidate.metadataOnly) selectedMetadataProvider = candidate.providerId;
  }
  const providerOnly = !modelId && /^https?:\/\//i.test(resolvedTarget);
  if (!modelId && !providerOnly) throw new DoctorError("Model selection is required; provide an explicit model id in non-interactive mode", "selection-required");
  const selectedApi = typeof flags.api === "string" ? parsePiApiFlag(flags.api) : undefined;
  ensureHeadlessAuthorization(ctx, flags, "add", dryRun);
  const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  const proposal = await doctor.proposeAdd({
    target: resolvedTarget,
    providerId: explicitProviderId,
    modelId,
    metadataProvider: selectedMetadataProvider,
    api: selectedApi,
    apiKey,
    allowLiteralApiKey: flags["allow-literal-api-key"] === true,
    dryRun,
    persistCache: !dryRun && !ctx.hasUI,
  });
  const preview = [
    `Proposed ${redactSensitiveText(proposal.target)}`,
    `Source: ${proposal.catalogSource}; matched by: ${proposal.matchedBy.join(", ") || "explicit fallback"}`,
    `Adapter: ${proposal.adapter}; confidence: ${proposal.confidence}; reasoning: ${proposal.reasoningControlType}; cache: prompt=${proposal.cacheCapabilities.prompt}, context=${proposal.cacheCapabilities.context}, kv=${proposal.cacheCapabilities.kv}`,
    `Required headers: ${proposal.requiredHeaders.length > 0 ? proposal.requiredHeaders.join(", ") : "none detected"} (values are never displayed)`,
    proposal.warning ? `Warning: ${redactSensitiveText(proposal.warning)}` : undefined,
    formatPlan(proposal.plan),
  ].filter(Boolean).join("\n");
  if (dryRun) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted (dry-run).`, "info");
    return;
  }
  if (proposal.plan.changes.length === 0) {
    ctx.ui.notify(`${preview}\nNo changes needed.\nStatus: not-persisted.`, "info");
    return;
  }
  await requireAuthorization(ctx, flags, "add", preview);
  const applied = await doctor.applyAdd(proposal);
  const status = proposal.modelId
    ? await activateRuntime(ctx, doctor, [{ provider: proposal.providerId, model: proposal.modelId, present: true }])
    : "persisted-reload-required";
  ctx.ui.notify(`${preview}\nStatus: ${statusMessage(status)}\nApplied. Backup: ${applied.backupPath ? redactSensitiveText(applied.backupPath) : "none (new file)"}`, status === "activation-failed" ? "warning" : "info");
}

async function runFix(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const target = args[0];
  if (target) validateProviderModelTarget(target, "fix");
  const dryRun = flags["dry-run"] === true;
  ensureHeadlessAuthorization(ctx, flags, "fix", dryRun);
  const proposal = target
    ? await doctor.proposeFix(target, { persistCache: !dryRun && !ctx.hasUI, dryRun })
    : await doctor.proposeFixAll({ persistCache: !dryRun && !ctx.hasUI, dryRun });
  const preview = formatFindings(proposal.result);
  if (dryRun) {
    ctx.ui.notify(`${preview}\n${proposal.result.plan ? formatPlan(proposal.result.plan) : "No repair plan."}\nStatus: not-persisted (dry-run).`, "info");
    return;
  }
  const blocking = proposal.result.plan?.conflicts.filter((item) => item.severity === "error") ?? [];
  if (blocking.length > 0) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted; repair was not applied.`, "warning");
    return;
  }
  if (!proposal.result.plan || proposal.result.plan.changes.length === 0) {
    ctx.ui.notify(`${preview}\nNo changes needed.\nStatus: not-persisted.`, "info");
    return;
  }
  await requireAuthorization(ctx, flags, "fix", `${preview}\n${formatPlan(proposal.result.plan)}`);
  const applied = await doctor.applyFix(proposal);
  const targets = target
    ? [{ provider: target.slice(0, target.indexOf("/")), model: target.slice(target.indexOf("/") + 1), present: true }]
    : (await doctor.list()).map((item) => ({ provider: item.provider, model: item.model, present: true }));
  const status = await activateRuntime(ctx, doctor, targets);
  ctx.ui.notify(`${preview}\nStatus: ${statusMessage(status)}\nApplied ${applied.plan?.changes.length ?? 0} repair(s). Backup: ${applied.backupPath ? redactSensitiveText(applied.backupPath) : "none"}`, status === "activation-failed" ? "warning" : "info");
}

async function runRemove(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const target = args[0];
  if (!target) throw new DoctorError("Usage: /model-doctor remove <provider/model> [--dry-run] [--yes]", "invalid-target");
  const dryRun = flags["dry-run"] === true;
  validateProviderModelTarget(target, "remove");
  ensureHeadlessAuthorization(ctx, flags, "remove", dryRun);
  const proposal = await doctor.proposeRemove(target, { dryRun });
  if (proposal.plan.conflicts.length > 0) throw new DoctorError(proposal.plan.conflicts.map((item) => item.message).join("; "), "invalid-target");
  const preview = formatPlan(proposal.plan);
  if (flags["dry-run"] === true) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted (dry-run).`, "info");
    return;
  }
  await requireAuthorization(ctx, flags, "remove", preview);
  const applied = await doctor.applyRemove(proposal);
  const [provider, model] = splitProviderModelTarget(target);
  const status = await activateRuntime(ctx, doctor, [{ provider, model, present: false }]);
  ctx.ui.notify(`${preview}\nStatus: ${statusMessage(status)}\nRemoved. Backup: ${applied.backupPath ? redactSensitiveText(applied.backupPath) : "none"}`, status === "activation-failed" ? "warning" : "info");
}

async function runMigrate(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const source = args[0];
  let destination: string | undefined = typeof flags.to === "string" ? flags.to : args[1];
  const dryRun = flags["dry-run"] === true;
  if (!source) throw new DoctorError("Usage: /model-doctor migrate <provider/model> [--to <provider/model>] [--dry-run] [--yes] [--remove-source]", "invalid-target");
  validateProviderModelTarget(source, "migrate source");
  if (destination) validateProviderModelTarget(destination, "migrate destination");
  if (!destination && ctx.hasUI) {
    const candidates = await doctor.listMigrationCandidates(source, false);
    if (candidates.length === 0) throw new DoctorError(`No migration candidates found for ${source}; provide --to <provider/model>`, "invalid-target");
    const choices = candidates.map((candidate, index) => formatCandidateLabel(candidate, index));
    const selected = await ctx.ui.select(`Select migration destination for ${redactSensitiveText(source)}`, choices);
    if (!selected) {
      ctx.ui.notify("Migration cancelled. Status: not-persisted; models.json was not changed.", "info");
      return;
    }
    const selectedIndex = choices.indexOf(selected);
    const candidate = selectedIndex >= 0 ? candidates[selectedIndex] : undefined;
    destination = candidate ? `${candidate.providerId}/${candidate.id}` : undefined;
  }
  if (!destination) throw new DoctorError("Migration destination is required; destination selection is required in UI or --to <provider/model> in headless mode", "selection-required");
  validateProviderModelTarget(destination, "migrate destination");
  ensureHeadlessAuthorization(ctx, flags, "migrate", dryRun);
  const proposal = await doctor.proposeMigrate({ source, destination, dryRun, persistCache: !dryRun && !ctx.hasUI, removeSource: flags["remove-source"] === true });
  const preview = `Migrate ${redactSensitiveText(proposal.source)} -> ${redactSensitiveText(proposal.destination)}\n${formatPlan(proposal.plan)}`;
  if (dryRun) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted (dry-run).`, "info");
    return;
  }
  if (proposal.plan.conflicts.some((item) => item.severity === "error")) {
    ctx.ui.notify(`${preview}\nStatus: not-persisted; migration was not applied.`, "warning");
    return;
  }
  if (proposal.plan.changes.length === 0) {
    ctx.ui.notify(`${preview}\nNo changes needed.\nStatus: not-persisted.`, "info");
    return;
  }
  await requireAuthorization(ctx, flags, "migrate", preview);
  const destinationParts = splitProviderModelTarget(proposal.destination);
  const sourceParts = splitProviderModelTarget(proposal.source);
  const applied = await doctor.applyMigrate(proposal);
  const status = await activateRuntime(ctx, doctor, [
    { provider: destinationParts[0], model: destinationParts[1], present: true },
    ...(flags["remove-source"] === true ? [{ provider: sourceParts[0], model: sourceParts[1], present: false }] : []),
  ]);
  ctx.ui.notify(`${preview}\nStatus: ${statusMessage(status)}\nMigrated. Backup: ${applied.backupPath ? redactSensitiveText(applied.backupPath) : "none"}`, status === "activation-failed" ? "warning" : "info");
}

interface RuntimeExpectation {
  provider: string;
  model: string;
  present: boolean;
}

async function activateRuntime(
  ctx: ExtensionCommandContext,
  doctor: ModelDoctor,
  expectations?: RuntimeExpectation[],
): Promise<RuntimeActivationStatus> {
  if (resolve(doctor.getModelsPath()) !== resolve(getAgentDir(), "models.json")) return "persisted-reload-required";
  const registry = ctx.modelRegistry;
  if (!registry || typeof registry.refresh !== "function" || typeof registry.find !== "function") return "persisted-reload-required";
  try {
    await registry.refresh();
    if (expectations) {
      const configured = await doctor.list();
      for (const expectation of expectations) {
        const existsInConfig = configured.some((item) => normalizeRuntimeId(item.provider) === normalizeRuntimeId(expectation.provider)
          && normalizeRuntimeId(item.model) === normalizeRuntimeId(expectation.model));
        if (existsInConfig !== expectation.present) return "activation-failed";
        const activeModel = registry.find(expectation.provider, expectation.model);
        if (expectation.present ? activeModel === undefined : activeModel !== undefined) return "activation-failed";
      }
    }
    return "persisted-and-active";
  } catch {
    return "activation-failed";
  }
}

function splitProviderModelTarget(target: string): [string, string] {
  const slash = target.indexOf("/");
  return [target.slice(0, slash), target.slice(slash + 1)];
}

function normalizeRuntimeId(value: string): string {
  return value.trim().toLowerCase();
}

function statusMessage(status: RuntimeActivationStatus): string {
  switch (status) {
    case "persisted-and-active": return "persisted-and-active";
    case "activation-failed": return "activation-failed (models.json was persisted; reload Pi or inspect the runtime registry)";
    case "persisted-reload-required": return "persisted-reload-required (reload Pi to activate)";
    default: return "not-persisted";
  }
}

function ensureHeadlessAuthorization(ctx: ExtensionCommandContext, flags: Record<string, string | boolean>, action: string, dryRun: boolean): void {
  if (!dryRun && !ctx.hasUI && flags.yes !== true) {
    throw new DoctorError(`Non-interactive ${action} requires --yes; Status: not-persisted; use --dry-run to preview without writing`, "authorization-required");
  }
}

async function requireAuthorization(ctx: ExtensionCommandContext, flags: Record<string, string | boolean>, action: string, preview: string): Promise<void> {
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(`Apply model-doctor ${action}?`, preview);
    if (!confirmed) throw new DoctorError(`${action} cancelled. Status: not-persisted; models.json was not changed.`, "authorization-required");
    return;
  }
  if (flags.yes !== true) {
    throw new DoctorError(`Non-interactive ${action} requires --yes; Status: not-persisted; use --dry-run to preview without writing`, "authorization-required");
  }
}

function validateProviderModelTarget(target: string, label: string): void {
  const trimmed = target.trim();
  const slash = trimmed.indexOf("/");
  const providerId = slash > 0 ? trimmed.slice(0, slash).trim() : "";
  const modelId = slash >= 0 ? trimmed.slice(slash + 1).trim() : "";
  if (slash <= 0 || !providerId || !modelId || isUnsafeTargetIdentifier(providerId) || isUnsafeTargetIdentifier(modelId)) {
    throw new DoctorError(`${label} target must be provider/model with safe identifiers`, "invalid-target");
  }
}

function isUnsafeTargetIdentifier(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

function validateCommand(parsed: ParsedCommand): void {
  if (parsed.command === "invalid") return;
  const allowed = COMMAND_FLAGS[parsed.command];
  if (allowed) {
    const unknown = Object.keys(parsed.flags).find((name) => !allowed.has(name));
    if (unknown) throw new DoctorError(`Unknown flag --${unknown}; use /model-doctor help for usage`, "invalid-target");
  }
  const maxArgs = parsed.command === "migrate" ? 2
    : parsed.command === "add" ? 3
      : parsed.command === "sync" ? 1
        : parsed.command === "rollback" ? 1
          : ["list", "check", "fix", "remove"].includes(parsed.command) ? 1
            : 0;
  if (parsed.args.length > maxArgs) {
    throw new DoctorError(`Too many arguments for ${parsed.command}; use /model-doctor help for usage`, "invalid-target");
  }
  if (parsed.command === "migrate" && parsed.args[1] && parsed.flags.to !== undefined) {
    throw new DoctorError("Migration destination must be provided either positionally or with --to, not both", "invalid-target");
  }
  if (parsed.command === "add" && parsed.args.length === 3 && (/^https?:\/\//i.test(parsed.args[0] ?? "") || !/^https?:\/\//i.test(parsed.args[1] ?? ""))) {
    throw new DoctorError("Three add arguments require: add <provider-id> <endpoint-url> [model]", "invalid-target");
  }
  for (const [name, value] of Object.entries(parsed.flags)) {
    if (BOOLEAN_FLAGS.has(name) && typeof value !== "boolean") {
      throw new DoctorError(`Flag --${name} expects true or false`, "invalid-target");
    }
  }
  for (const name of ["api-key", "to", "metadata-provider", "api"]) {
    if (parsed.flags[name] === true) throw new DoctorError(`Flag --${name} requires a value`, "invalid-target");
  }
}

function formatRefresh(result: RefreshResult): string {
  const findings = `Configuration: ${result.findings.length} finding(s), ${result.changes} repairable change(s), ${result.conflicts} conflict(s)${result.findings.length === 0 ? " (healthy)" : ""}`;
  return [
    `models.dev refresh: ${result.source}; ${result.providers} providers, ${result.models} models${result.stale ? " (stale)" : ""}`,
    `Policy version: ${result.policyVersion}`,
    findings,
    result.findings.slice(0, 20).map((item) => `${severityIcon(item.severity)} ${item.code}: ${redactSensitiveText(item.message)}`).join("\n"),
    result.warning ? redactSensitiveText(result.warning) : undefined,
  ].filter(Boolean).join("\n");
}

function helpText(): string {
  return [
    "/model-doctor add <provider-or-url> [model] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]",
    "/model-doctor add <provider-id> <endpoint-url> [model] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]",
    "/model-doctor list [provider]",
    "/model-doctor check [provider/model]",
    "/model-doctor fix [provider/model] [--dry-run] [--yes]",
    "/model-doctor remove <provider/model> [--dry-run] [--yes]",
    "/model-doctor refresh [--force] [--dry-run]",
    "/model-doctor sync <provider-or-url> [--models <id1,id2>] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]",
    "/model-doctor migrate <provider/model> [--to <provider/model>] [--dry-run] [--yes] [--remove-source]",
    "/model-doctor cleanup-backups [--keep <count>] [--max-age-ms <milliseconds>] [--dry-run] [--yes]",
    "/model-doctor rollback <models.json.bak-timestamp> [--dry-run] [--yes]",

    "Non-interactive writes require --yes; --dry-run never writes models.json, backups, or caches. Successful writes report persisted-and-active, persisted-reload-required, or activation-failed.",
  ].join("\n");
}

function isCommand(value: string): value is Exclude<ParsedCommand["command"], "invalid"> {
  return ["add", "list", "check", "fix", "remove", "refresh", "sync", "migrate", "cleanup-backups", "rollback", "help"].includes(value);
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of input) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function formatValue(value: unknown, path = ""): string {
  if (value === undefined) return "<missing>";
  if (isSensitivePath(path)) return "[redacted]";
  const redacted = redactSecrets(value, path);
  const serialized = JSON.stringify(redacted);
  return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
}

function redactSecrets(value: unknown, path: string): unknown {
  if (isSensitivePath(path)) return "[redacted]";
  if (typeof value === "string") return looksLikeCredentialValue(value) ? "[redacted]" : redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item, index) => redactSecrets(item, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecrets(child, path ? `${path}.${key}` : key)]));
  return value;
}

function isSensitivePath(path: string): boolean {
  return /(^|[.[])(api[-_]?key|auth(?:orization)?|auth[-_]?header|oauth|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|set-cookie|headers?)([.\]])?/i.test(path);
}

function formatCandidateLabel(candidate: ModelCandidate, index: number): string {
  const details = [
    candidate.name ? `(${candidate.name})` : undefined,
    candidate.deprecated ? "[deprecated]" : undefined,
    candidate.metadataOnly ? "[metadata-only]" : undefined,
    candidate.adapter ? `adapter=${candidate.adapter}` : undefined,
    candidate.reasoningControlType && candidate.reasoningControlType !== "unknown" ? `reasoning=${candidate.reasoningControlType}` : undefined,
    candidate.confidence ? `confidence=${candidate.confidence}` : undefined,
  ].filter(Boolean).join(" ");
  return redactSensitiveText(`${index + 1}. ${candidate.providerId}/${candidate.id}${details ? ` ${details}` : ""}`);
}

function severityIcon(severity: string): string {
  return severity === "error" ? "✖" : severity === "warning" ? "⚠" : "·";
}
