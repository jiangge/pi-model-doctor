import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import type { DoctorMetadata, JsonObject, PiModel, PiModelsJson, PiProvider } from "./types.ts";

export class DoctorError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid-config" | "io-error" | "backup-error" | "write-error" | "invalid-target" = "io-error",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DoctorError";
  }
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readModelsJson(path: string): Promise<{ data: PiModelsJson; existed: boolean }> {
  try {
    const text = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonComments(text));
    } catch (error) {
      throw new DoctorError(`Invalid JSON in ${path}`, "invalid-config", error);
    }
    if (!isRecord(parsed)) {
      throw new DoctorError(`${path} must contain a JSON object`, "invalid-config");
    }
    return { data: parsed as PiModelsJson, existed: true };
  } catch (error) {
    if (error instanceof DoctorError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return { data: { providers: {} }, existed: false };
    throw new DoctorError(`Unable to read ${path}: ${errorMessage(error)}`, "io-error", error);
  }
}

export function getProviders(config: PiModelsJson): Record<string, PiProvider> {
  if (!config.providers) config.providers = {};
  if (!isRecord(config.providers)) {
    throw new DoctorError("models.json providers must be an object", "invalid-config");
  }
  return config.providers as Record<string, PiProvider>;
}

export function getModels(provider: PiProvider): PiModel[] {
  if (!provider.models) provider.models = [];
  if (!Array.isArray(provider.models)) {
    throw new DoctorError("models.json provider models must be an array", "invalid-config");
  }
  return provider.models as PiModel[];
}

export const MANAGED_MODEL_FIELDS = [
  "name",
  "api",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "compat",
] as const;

export type ManagedModelField = (typeof MANAGED_MODEL_FIELDS)[number];

export function hasDoctorMetadata(value: unknown): value is JsonObject & { _piModelDoctor: DoctorMetadata } {
  return isRecord(value) && isRecord(value._piModelDoctor) && value._piModelDoctor.managed === true;
}

export function canManageField(value: JsonObject, field: string): boolean {
  if (!(field in value) || value[field] === undefined) return true;
  const metadata = value._piModelDoctor;
  if (!isRecord(metadata) || metadata.managed !== true) return false;
  const fields = Array.isArray(metadata.managedFields) ? metadata.managedFields : [];
  if (!fields.includes(field)) return false;
  const snapshots = isRecord(metadata.managedValues) ? metadata.managedValues : undefined;
  return snapshots ? jsonEqual(snapshots[field], value[field]) : true;
}

export function buildMetadata(
  previous: DoctorMetadata | undefined,
  details: Omit<DoctorMetadata, "managed" | "version" | "lastCheck"> & { lastCheck: string },
  managedFields: string[],
  managedValues: JsonObject,
): DoctorMetadata {
  const previousFields = previous?.managedFields ?? [];
  const previousValues = previous?.managedValues ?? {};
  return {
    ...(previous ?? {}),
    managed: true,
    source: details.source,
    lastCheck: details.lastCheck,
    autoRepair: details.autoRepair,
    providerId: details.providerId,
    modelId: details.modelId,
    version: 1,
    managedFields: [...new Set([...previousFields, ...managedFields])],
    managedValues: cloneJson({ ...previousValues, ...managedValues }),
  } as DoctorMetadata;
}

export function updateManagedMetadata(
  value: JsonObject,
  metadata: DoctorMetadata,
  fields: string[],
): void {
  const managedValues: JsonObject = {};
  for (const field of fields) {
    if (field in value) managedValues[field] = cloneJson(value[field]);
  }
  value._piModelDoctor = buildMetadata(metadata, metadata, fields, managedValues);
}

export async function backupFile(path: string, now = new Date()): Promise<string | undefined> {
  if (!(await pathExists(path))) return undefined;
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let backupPath = `${path}.bak-${stamp}`;
  let suffix = 0;
  while (await pathExists(backupPath)) {
    suffix += 1;
    backupPath = `${path}.bak-${stamp}-${suffix}`;
  }
  try {
    await copyFile(path, backupPath);
    return backupPath;
  } catch (error) {
    throw new DoctorError(`Unable to back up ${path}: ${errorMessage(error)}`, "backup-error", error);
  }
}

export async function atomicWrite(path: string, serialized: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let mode: number | undefined;
  try {
    try {
      mode = (await stat(path)).mode & 0o777;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const handle = await open(temporary, "wx", mode ?? 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Best-effort cleanup; preserve the original error.
    }
    throw new DoctorError(`Unable to atomically write ${path}: ${errorMessage(error)}`, "write-error", error);
  }
}

export async function writeModelsJson(
  path: string,
  value: PiModelsJson,
  now = new Date(),
): Promise<{ backupPath?: string }> {
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`;
  } catch (error) {
    throw new DoctorError(`Unable to serialize ${path}: ${errorMessage(error)}`, "write-error", error);
  }
  const backupPath = await backupFile(path, now);
  await atomicWrite(path, serialized);
  return { backupPath };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function stripDoctorMetadata<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripDoctorMetadata(item)) as T;
  if (!isRecord(value)) return value;
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "_piModelDoctor") continue;
    result[key] = stripDoctorMetadata(child);
  }
  return result as T;
}

function stripJsonComments(text: string): string {
  let output = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (character === "\n") {
        output += character;
      }
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (quote) {
      output += character;
      if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else {
      output += character;
    }
  }
  return output;
}
