import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ModelDoctor, type DoctorListItem } from "./doctor.ts";
import { DoctorError, errorMessage } from "./json.ts";
import type { ChangePlan, CheckResult } from "./types.ts";

export interface ParsedCommand {
  command: "add" | "list" | "check" | "fix" | "remove" | "refresh" | "help" | "invalid";
  args: string[];
  flags: Record<string, string | boolean>;
}

export function parseCommandArgs(input: string): ParsedCommand {
  const tokens = tokenize(input.trim());
  const commandToken = tokens.shift()?.toLowerCase() ?? "help";
  const command = isCommand(commandToken) ? commandToken : commandToken ? "invalid" : "help";
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
      flags[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    const next = tokens[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { command, args, flags };
}

export function formatPlan(plan: ChangePlan): string {
  const lines = [`Target: ${plan.target}`, `Changes: ${plan.changes.length}`, `Conflicts: ${plan.conflicts.length}`];
  for (const change of plan.changes.slice(0, 20)) {
    lines.push(`- ${change.path}: ${formatValue(change.before, change.path)} → ${formatValue(change.after, change.path)} (${change.reason})`);
  }
  if (plan.changes.length > 20) lines.push(`- … ${plan.changes.length - 20} more changes`);
  for (const conflict of plan.conflicts) lines.push(`! ${conflict.message}`);
  for (const warning of plan.warnings) lines.push(`⚠ ${warning}`);
  return lines.join("\n");
}

export function formatFindings(result: CheckResult): string {
  if (result.findings.length === 0) return `${result.target ?? "models.json"}: healthy`;
  const lines = [`${result.target ?? "models.json"}: ${result.findings.length} finding(s)`];
  for (const item of result.findings) lines.push(`${severityIcon(item.severity)} ${item.code}: ${item.message}`);
  if (result.plan) lines.push(`Repair plan: ${result.plan.changes.length} change(s), ${result.plan.conflicts.length} conflict(s)`);
  return lines.join("\n");
}

export function formatList(items: DoctorListItem[]): string {
  if (items.length === 0) return "No configured models found.";
  return items.map((item) => {
    const capabilities = [item.reasoning ? "reasoning" : undefined, item.contextWindow ? `${item.contextWindow} ctx` : undefined, item.managed ? "managed" : "user-owned"].filter(Boolean).join(", ");
    return `${item.provider}/${item.model}${item.name ? ` (${item.name})` : ""} — ${capabilities || "no metadata"}`;
  }).join("\n");
}

export function registerModelDoctorCommand(pi: ExtensionAPI, doctor: ModelDoctor): void {
  pi.registerCommand("model-doctor", {
    description: "Discover, check, fix, and manage Pi models.json",
    getArgumentCompletions: (prefix) => {
      const values = ["add", "list", "check", "fix", "remove", "refresh", "help"];
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
    switch (parsed.command) {
      case "add":
        await runAdd(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "list":
        ctx.ui.notify(formatList(await doctor.list(parsed.args[0])), "info");
        return;
      case "check":
        ctx.ui.notify(formatFindings(await doctor.check(parsed.args[0])), "info");
        return;
      case "fix":
        await runFix(parsed.args, parsed.flags, ctx, doctor);
        return;
      case "remove":
        await runRemove(parsed.args, ctx, doctor);
        return;
      case "refresh":
        ctx.ui.notify(formatRefresh(await doctor.refresh(parsed.flags.force === true)), "info");
        return;
      case "invalid":
        ctx.ui.notify(`Unknown model-doctor subcommand: ${parsed.args[0] ?? ""}\n${helpText()}`, "error");
        return;
      default:
        ctx.ui.notify(helpText(), "info");
    }
  } catch (error) {
    const message = error instanceof DoctorError || error instanceof Error ? error.message : errorMessage(error);
    ctx.ui.notify(`model-doctor: ${message}`, "error");
  }
}

async function runAdd(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const target = args[0];
  if (!target) throw new DoctorError("Usage: /model-doctor add <provider-or-url> [model] [--api-key <value>] [--dry-run]", "invalid-target");
  const modelId = args[1];
  const apiKey = typeof flags["api-key"] === "string" ? flags["api-key"] : undefined;
  const proposal = await doctor.proposeAdd({ target, modelId, apiKey, dryRun: flags["dry-run"] === true });
  const preview = [
    `Proposed ${proposal.target}`,
    proposal.warning ? `Warning: ${proposal.warning}` : undefined,
    formatPlan(proposal.plan),
  ].filter(Boolean).join("\n");
  if (flags["dry-run"] === true) {
    ctx.ui.notify(preview, "info");
    return;
  }
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Apply model configuration?", preview);
    if (!confirmed) {
      ctx.ui.notify("Add cancelled; models.json was not changed.", "info");
      return;
    }
  }
  const applied = await doctor.applyAdd(proposal);
  ctx.ui.notify(`${preview}\nApplied. Backup: ${applied.backupPath ?? "none (new file)"}`, "info");
}

async function runFix(args: string[], flags: Record<string, string | boolean>, ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const target = args[0];
  const dryRun = flags["dry-run"] === true;
  const proposal = target
    ? await doctor.proposeFix(target, { persistCache: !dryRun })
    : await doctor.proposeFixAll({ persistCache: !dryRun });
  const preview = formatFindings(proposal.result);
  if (dryRun) {
    ctx.ui.notify(`${preview}\n${proposal.result.plan ? formatPlan(proposal.result.plan) : "No repair plan."}`, "info");
    return;
  }
  if (!proposal.result.plan || proposal.result.plan.changes.length === 0) {
    ctx.ui.notify(`${preview}\nNo changes needed.`, "info");
    return;
  }
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Apply model repairs?", `${preview}\n${formatPlan(proposal.result.plan)}`);
    if (!confirmed) {
      ctx.ui.notify("Fix cancelled; models.json was not changed.", "info");
      return;
    }
  }
  const applied = await doctor.applyFix(proposal);
  ctx.ui.notify(`${preview}\nApplied ${applied.plan?.changes.length ?? 0} repair(s). Backup: ${applied.backupPath ?? "none"}`, "info");
}

async function runRemove(args: string[], ctx: ExtensionCommandContext, doctor: ModelDoctor): Promise<void> {
  const target = args[0];
  if (!target) throw new DoctorError("Usage: /model-doctor remove <provider/model>", "invalid-target");
  const proposal = await doctor.proposeRemove(target);
  if (proposal.plan.conflicts.length > 0) throw new DoctorError(proposal.plan.conflicts.map((item) => item.message).join("; "), "invalid-target");
  const preview = formatPlan(proposal.plan);
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm("Remove model?", preview);
    if (!confirmed) {
      ctx.ui.notify("Remove cancelled; models.json was not changed.", "info");
      return;
    }
  }
  const applied = await doctor.applyRemove(proposal);
  ctx.ui.notify(`${preview}\nRemoved. Backup: ${applied.backupPath ?? "none"}`, "info");
}

function formatRefresh(result: { source: string; stale: boolean; warning?: string; providers: number; models: number }): string {
  return [
    `models.dev refresh: ${result.source}; ${result.providers} providers, ${result.models} models${result.stale ? " (stale)" : ""}`,
    result.warning,
  ].filter(Boolean).join("\n");
}

function helpText(): string {
  return [
    "/model-doctor add <provider-or-url> [model] [--api-key <value>] [--dry-run]",
    "/model-doctor list [provider]",
    "/model-doctor check [provider/model]",
    "/model-doctor fix [provider/model] [--dry-run]",
    "/model-doctor remove <provider/model>",
    "/model-doctor refresh [--force]",
  ].join("\n");
}

function isCommand(value: string): value is Exclude<ParsedCommand["command"], "invalid"> {
  return ["add", "list", "check", "fix", "remove", "refresh", "help"].includes(value);
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
  if (Array.isArray(value)) return value.map((item, index) => redactSecrets(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecrets(child, path ? `${path}.${key}` : key)]));
  }
  return value;
}

function isSensitivePath(path: string): boolean {
  return /(^|[.[])(apiKey|token|secret|authorization|password|credential)([.\]])?/i.test(path);
}

function severityIcon(severity: string): string {
  return severity === "error" ? "✖" : severity === "warning" ? "⚠" : "·";
}
