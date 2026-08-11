import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, unlink, lstat } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { MODEL_DOCTOR_VERSION } from "./types.ts";
import type { DoctorMetadata, JsonObject, PiModel, PiModelsJson, PiProvider } from "./types.ts";

export class DoctorError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid-config" | "io-error" | "backup-error" | "write-error" | "invalid-target" | "selection-required" | "authorization-required" | "concurrent-modification" = "io-error",
    public readonly cause?: unknown,
  ) {
    super(redactSensitiveText(message));
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
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((item) => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`);
  return `{${entries.join(",")}}`;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readModelsJson(path: string): Promise<{ data: PiModelsJson; existed: boolean; fingerprint?: string }> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new DoctorError(`${path} must be a regular file`, "invalid-config");
    const text = await readFile(path, "utf8");
    const fingerprint = createHash("sha256").update(text).digest("hex");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(text));
    } catch (error) {
      throw new DoctorError(`Invalid JSON in ${path}`, "invalid-config", error);
    }
    if (!isRecord(parsed)) {
      throw new DoctorError(`${path} must contain a JSON object`, "invalid-config");
    }
    validateModelsConfig(parsed, path);
    return { data: parsed as PiModelsJson, existed: true, fingerprint };
  } catch (error) {
    if (error instanceof DoctorError) throw error;
    if (isNodeError(error) && error.code === "ENOENT") return { data: { providers: {} }, existed: false, fingerprint: undefined };
    throw new DoctorError(`Unable to read ${path}: ${errorMessage(error)}`, "io-error", error);
  }
}

export function getProviders(config: PiModelsJson): Record<string, PiProvider> {
  if (!config.providers) config.providers = {};
  if (!isRecord(config.providers)) {
    throw new DoctorError("models.json providers must be an object", "invalid-config");
  }
  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (!isRecord(provider)) throw new DoctorError(`models.json provider ${providerId} must be an object`, "invalid-config");
  }
  return config.providers as Record<string, PiProvider>;
}

export function getModels(provider: PiProvider): PiModel[] {
  if (!provider.models) provider.models = [];
  if (!Array.isArray(provider.models)) {
    throw new DoctorError("models.json provider models must be an array", "invalid-config");
  }
  for (const [index, model] of provider.models.entries()) {
    if (!isRecord(model) || typeof model.id !== "string" || model.id.trim() === "") {
      throw new DoctorError(`models.json provider model at index ${index} must have a string id`, "invalid-config");
    }
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
  const hasValue = field in value && value[field] !== undefined;
  const metadata = value._piModelDoctor;
  if (!isRecord(metadata) || metadata.managed !== true || metadata.version !== MODEL_DOCTOR_VERSION) return !hasValue;
  const fields = Array.isArray(metadata.managedFields) ? metadata.managedFields : [];
  if (!fields.includes(field)) return !hasValue;
  const snapshots = isRecord(metadata.managedValues) ? metadata.managedValues : undefined;
  if (!hasValue) {
    // A field that was managed before but was removed by the user is still a
    // user-owned deletion until the repair policy explicitly reclaims it.
    return !snapshots || !(field in snapshots);
  }
  return snapshots ? jsonEqual(snapshots[field], value[field]) : true;
}

export function buildMetadata(
  previous: DoctorMetadata | undefined,
  details: Omit<DoctorMetadata, "managed" | "version" | "lastCheck"> & { lastCheck: string },
  managedFields: string[],
  managedValues: JsonObject,
): DoctorMetadata {
  const compatiblePrevious = previous?.version === MODEL_DOCTOR_VERSION ? previous : undefined;
  const previousFields = compatiblePrevious?.managedFields ?? [];
  const previousValues = compatiblePrevious?.managedValues ?? {};
  const metadata: DoctorMetadata = {
    ...(compatiblePrevious ?? {}),
    managed: true,
    source: details.source,
    lastCheck: details.lastCheck,
    autoRepair: details.autoRepair,
    version: MODEL_DOCTOR_VERSION,
  };
  if (details.providerId !== undefined) metadata.providerId = details.providerId;
  else delete metadata.providerId;
  if (details.modelId !== undefined) metadata.modelId = details.modelId;
  else delete metadata.modelId;
  if (details.endpointNormalizationPending !== undefined) metadata.endpointNormalizationPending = details.endpointNormalizationPending;
  else delete metadata.endpointNormalizationPending;
  if (details.endpointApiExplicit !== undefined) metadata.endpointApiExplicit = details.endpointApiExplicit;
  else delete metadata.endpointApiExplicit;
  if (details.endpointApiHint !== undefined) metadata.endpointApiHint = details.endpointApiHint;
  else delete metadata.endpointApiHint;
  if (details.endpointValueHint !== undefined) metadata.endpointValueHint = details.endpointValueHint;
  else delete metadata.endpointValueHint;
  if (details.endpointNormalizationBlocked !== undefined) metadata.endpointNormalizationBlocked = details.endpointNormalizationBlocked;
  else delete metadata.endpointNormalizationBlocked;
  if (details.endpointApiNormalizationBlocked !== undefined) metadata.endpointApiNormalizationBlocked = details.endpointApiNormalizationBlocked;
  else delete metadata.endpointApiNormalizationBlocked;
  return {
    ...metadata,
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

export async function listBackups(path: string): Promise<string[]> {
  const directory = dirname(path);
  const prefix = `${basename(path)}.bak-`;
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw new DoctorError(`Unable to list backups for ${path}: ${errorMessage(error)}`, "io-error", error);
  }
  const backups: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !isTimestampedBackupName(entry, basename(path))) continue;
    const backupPath = join(directory, entry);
    try {
      const info = await lstat(backupPath);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      backups.push({ path: backupPath, mtimeMs: info.mtimeMs });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw new DoctorError(`Unable to inspect backup ${backupPath}: ${errorMessage(error)}`, "io-error", error);
    }
  }
  return backups.sort((left, right) => right.mtimeMs - left.mtimeMs || left.path.localeCompare(right.path)).map((item) => item.path);
}

export async function cleanupBackups(path: string, options: { keep?: number; maxAgeMs?: number; now?: Date; dryRun?: boolean } = {}): Promise<string[]> {
  if (options.keep === undefined && options.maxAgeMs === undefined) {
    throw new DoctorError("Backup cleanup requires --keep or --max-age-ms", "invalid-target");
  }
  if (options.keep !== undefined && (!Number.isInteger(options.keep) || options.keep < 0)) {
    throw new DoctorError("Backup retention keep count must be a non-negative integer", "invalid-target");
  }
  if (options.maxAgeMs !== undefined && (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0)) {
    throw new DoctorError("Backup retention max age must be a non-negative number", "invalid-target");
  }
  const backups = await listBackups(path);
  const keep = options.keep ?? 0;
  const nowMs = (options.now ?? new Date()).getTime();
  const removed: string[] = [];
  for (const [index, backupPath] of backups.entries()) {
    if (index < keep) continue;
    if (options.maxAgeMs !== undefined) {
      const age = nowMs - (await lstat(backupPath)).mtimeMs;
      if (age <= options.maxAgeMs) continue;
    }
    try {
      if (!options.dryRun) await unlink(backupPath);
      removed.push(backupPath);
    } catch (error) {
      throw new DoctorError(`Unable to remove backup ${backupPath}: ${errorMessage(error)}`, "backup-error", error);
    }
  }
  return removed;
}

export async function backupFile(path: string, now = new Date()): Promise<string | undefined> {
  let sourceMode: number;
  try {
    const sourceInfo = await lstat(path);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("models.json must be a regular file");
    sourceMode = sourceInfo.mode & 0o777;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new DoctorError(`Unable to inspect ${path} before backup: ${errorMessage(error)}`, "backup-error", error);
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  let suffix = 0;
  while (true) {
    const backupPath = `${path}.bak-${stamp}${suffix === 0 ? "" : `-${suffix}`}`;
    try {
      await copyFile(path, backupPath, constants.COPYFILE_EXCL);
      await chmod(backupPath, sourceMode);
      return backupPath;
    } catch (error) {
      if (isNodeError(error) && error.code === "EEXIST") {
        suffix += 1;
        continue;
      }
      try { await unlink(backupPath); } catch { /* best effort cleanup */ }
      throw new DoctorError(`Unable to back up ${path}: ${errorMessage(error)}`, "backup-error", error);
    }
  }
}

export async function restoreBackup(
  modelsPath: string,
  backupPath: string,
  now = new Date(),
  dryRun = false,
): Promise<{ sourcePath: string; safetyBackupPath?: string }> {
  const sourcePath = resolveBackupPath(modelsPath, backupPath);
  let sourceText: string;
  let sourceData: PiModelsJson;
  try {
    const sourceInfo = await lstat(sourcePath);
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error("backup must be a regular file");
    sourceText = await readFile(sourcePath, "utf8");
    const validated = await readModelsJson(sourcePath);
    if (!validated.existed) throw new Error("backup does not exist");
    sourceData = validated.data;
  } catch (error) {
    throw new DoctorError(`Unable to validate backup ${sourcePath}: ${errorMessage(error)}`, "backup-error", error);
  }
  if (dryRun) return { sourcePath };
  const safetyBackupPath = await backupFile(modelsPath, now);
  try {
    await atomicWrite(modelsPath, sourceText);
    const restored = await readModelsJson(modelsPath);
    if (!jsonEqual(restored.data, sourceData)) throw new Error("restored JSON did not match the validated backup");
  } catch (error) {
    try {
      if (safetyBackupPath) await atomicWrite(modelsPath, await readFile(safetyBackupPath, "utf8"));
      else await unlinkIfExists(modelsPath);
    } catch (rollbackError) {
      throw new DoctorError(`Unable to restore backup ${sourcePath}: ${errorMessage(error)}; safety rollback failed: ${errorMessage(rollbackError)}`, "write-error", error);
    }
    throw new DoctorError(`Unable to restore backup ${sourcePath}: ${errorMessage(error)}; current configuration was restored`, "write-error", error);
  }
  return { sourcePath, safetyBackupPath };
}

export interface AtomicWriteOptions {
  renameImpl?: typeof rename;
}

export async function atomicWrite(path: string, serialized: string, modeOverride?: number, options: AtomicWriteOptions = {}): Promise<void> {
  const parent = dirname(path);
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let mode: number | undefined;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    try {
      const destinationInfo = await lstat(path);
      if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink()) throw new Error("atomic write target must be a regular file");
      mode = destinationInfo.mode & 0o777;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
    const handle = await open(temporary, "wx", modeOverride ?? mode ?? 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (modeOverride !== undefined) await chmod(temporary, modeOverride);
    else if (mode !== undefined) await chmod(temporary, mode);
    await (options.renameImpl ?? rename)(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Best-effort cleanup; preserve the original error.
    }
    throw new DoctorError(`Unable to atomically write ${path}: ${errorMessage(error)}`, "write-error", error);
  }
}

export async function fileFingerprint(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("models.json must be a regular file");
    const text = await readFile(path, "utf8");
    return createHash("sha256").update(text).digest("hex");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new DoctorError(`Unable to inspect ${path}: ${errorMessage(error)}`, "io-error", error);
  }
}

export async function writeModelsJson(
  path: string,
  value: PiModelsJson,
  now = new Date(),
): Promise<{ backupPath?: string }> {
  let originalText: string | undefined;
  let originalData: PiModelsJson | undefined;
  try {
    originalText = await readFile(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(originalText));
    } catch (error) {
      throw new DoctorError(`Invalid JSON in ${path}`, "invalid-config", error);
    }
    if (!isRecord(parsed)) throw new DoctorError(`${path} must contain a JSON object`, "invalid-config");
    validateModelsConfig(parsed, path);
    originalData = parsed as PiModelsJson;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      originalText = undefined;
    } else if (error instanceof DoctorError) {
      throw error;
    } else {
      throw new DoctorError(`Unable to read ${path} before writing: ${errorMessage(error)}`, "io-error", error);
    }
  }
  let serialized: string;
  try {
    const body = JSON.stringify(value, null, 2);
    serialized = originalText === undefined || originalData === undefined
      ? `${body}\n`
      : preserveJsoncFormatting(originalText, originalData, value);
  } catch (error) {
    throw new DoctorError(`Unable to serialize ${path}: ${errorMessage(error)}`, "write-error", error);
  }
  validateModelsConfig(value, path);
  const backupPath = await backupFile(path, now);
  try {
    await atomicWrite(path, serialized);
    const verified = await readModelsJson(path);
    if (!jsonEqual(verified.data, value)) throw new Error("persisted JSON did not match the requested configuration");
  } catch (error) {
    let restoreError: unknown;
    try {
      if (backupPath) await atomicWrite(path, await readFile(backupPath, "utf8"));
      else await unlinkIfExists(path);
    } catch (rollbackError) {
      restoreError = rollbackError;
    }
    const suffix = restoreError ? `; automatic rollback failed: ${errorMessage(restoreError)}` : "; original configuration was restored";
    throw new DoctorError(`Unable to persist ${path}: ${errorMessage(error)}${suffix}`, "write-error", error);
  }
  return { backupPath };
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("refusing to remove a non-regular rollback target");
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message);
}

export function isSafeHeaderName(value: unknown): value is string {
  return typeof value === "string" && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value) && value.trim() === value;
}

export function looksLikeCredentialValue(value: string): boolean {
  return /[?&](?:x[-_]?api[-_]?key|api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|token|secret|password)=[^&\s]+/i.test(value)
    || /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\b(?:sk|rk|pk|ak)-[A-Za-z0-9_-]{16,}\b/.test(value)
    || /\b(?:gh[pousr]|xox[bprs])_[A-Za-z0-9_-]{20,}\b/.test(value)
    || /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(value);
}

export function redactSensitiveText(message: string): string {
  const sensitiveKey = "(?:x[-_]?api[-_]?key|x[-_]?auth[-_]?token|api[-_]?key|authorization|auth(?:entication)?|auth[-_]?header|oauth|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|set-cookie)";
  const queryPattern = new RegExp(`([?&]${sensitiveKey}=)[^&\\s]+`, "gi");
  const fieldPattern = new RegExp(`(?<![A-Za-z0-9_-])(["']?${sensitiveKey}["']?\\s*[:=]\\s*["']?)[^"'\\s,;}]+`, "gi");
  return message
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@")
    .replace(queryPattern, "$1[redacted]")
    .replace(/(\b(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(fieldPattern, "$1[redacted]");
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

function validateModelsConfig(value: JsonObject, path: string): void {
  validateSafeJsonKeys(value, path);
  if (value.providers !== undefined && !isRecord(value.providers)) {
    throw new DoctorError(`${path} providers must be an object`, "invalid-config");
  }
  if (!isRecord(value.providers)) return;
  for (const [providerId, provider] of Object.entries(value.providers)) {
    if (isUnsafeJsonKey(providerId)) throw new DoctorError(`${path} provider ${providerId} uses an unsafe identifier`, "invalid-config");
    if (!isRecord(provider)) throw new DoctorError(`${path} provider ${providerId} must be an object`, "invalid-config");
    if (provider.headers !== undefined) validateHeaders(provider.headers, `${path} provider ${providerId} headers`);
    if (provider.models !== undefined && !Array.isArray(provider.models)) {
      throw new DoctorError(`${path} provider ${providerId} models must be an array`, "invalid-config");
    }
    if (Array.isArray(provider.models)) {
      for (const [index, model] of provider.models.entries()) {
        if (!isRecord(model) || typeof model.id !== "string" || model.id.trim() === "" || isUnsafeJsonKey(model.id)) {
          throw new DoctorError(`${path} provider ${providerId} model at index ${index} must have a safe string id`, "invalid-config");
        }
        if (model.headers !== undefined) validateHeaders(model.headers, `${path} provider ${providerId} model ${model.id} headers`);
      }
    }
  }
}

function validateHeaders(value: unknown, path: string): void {
  if (!isRecord(value) || Object.entries(value).some(([key, header]) => isUnsafeJsonKey(key) || !isSafeHeaderName(key) || typeof header !== "string" || /[\r\n]/.test(header))) {
    throw new DoctorError(`${path} must be an object of safe single-line string values`, "invalid-config");
  }
}

function validateSafeJsonKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => validateSafeJsonKeys(child, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (isUnsafeJsonKey(key)) throw new DoctorError(`${path} contains unsafe key ${key}`, "invalid-config");
    validateSafeJsonKeys(child, `${path}.${key}`);
  }
}

function isUnsafeJsonKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

interface JsonComment {
  text: string;
  key?: string;
}

interface JsonSourceNode {
  start: number;
  end: number;
  value: unknown;
  object?: Map<string, JsonSourceNode>;
  array?: JsonSourceNode[];
}

interface JsonSourcePatch {
  start: number;
  end: number;
  replacement: string;
}

function preserveJsoncFormatting(original: string, before: PiModelsJson, after: PiModelsJson): string {
  try {
    const source = parseJsonSource(original);
    const patches: JsonSourcePatch[] = [];
    collectJsonSourcePatches(source, before, after, original, patches);
    if (patches.length === 0) return original;
    let result = original;
    for (const patch of patches.sort((left, right) => right.start - left.start)) {
      result = `${result.slice(0, patch.start)}${patch.replacement}${result.slice(patch.end)}`;
    }
    return result;
  } catch {
    const body = JSON.stringify(after, null, 2) ?? "null";
    return preserveJsoncComments(original, body);
  }
}

function parseJsonSource(text: string): JsonSourceNode {
  const cursor = { index: 0 };
  const root = parseJsonSourceNode(text, cursor);
  cursor.index = skipJsoncTrivia(text, cursor.index);
  if (cursor.index !== text.length) throw new Error("Unexpected content after JSON root");
  return root;
}

function parseJsonSourceNode(text: string, cursor: { index: number }): JsonSourceNode {
  cursor.index = skipJsoncTrivia(text, cursor.index);
  const start = cursor.index;
  const character = text[cursor.index];
  if (character === "{") return parseJsonSourceObject(text, cursor, start);
  if (character === "[") return parseJsonSourceArray(text, cursor, start);
  if (character === '"') {
    const end = scanJsonString(text, cursor.index);
    const value = JSON.parse(text.slice(cursor.index, end)) as unknown;
    cursor.index = end;
    return { start, end, value };
  }
  const primitive = text.slice(cursor.index).match(/^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/u)?.[0];
  if (!primitive) throw new Error("Invalid JSON value");
  cursor.index += primitive.length;
  return { start, end: cursor.index, value: JSON.parse(primitive) as unknown };
}

function parseJsonSourceObject(text: string, cursor: { index: number }, start: number): JsonSourceNode {
  cursor.index += 1;
  const object = new Map<string, JsonSourceNode>();
  cursor.index = skipJsoncTrivia(text, cursor.index);
  while (text[cursor.index] !== "}") {
    if (text[cursor.index] !== '"') throw new Error("Object key must be a string");
    const keyEnd = scanJsonString(text, cursor.index);
    const key = JSON.parse(text.slice(cursor.index, keyEnd)) as string;
    cursor.index = skipJsoncTrivia(text, keyEnd);
    if (text[cursor.index] !== ":") throw new Error("Object key must be followed by a colon");
    cursor.index += 1;
    const child = parseJsonSourceNode(text, cursor);
    object.set(key, child);
    cursor.index = skipJsoncTrivia(text, cursor.index);
    if (text[cursor.index] === ",") {
      cursor.index += 1;
      cursor.index = skipJsoncTrivia(text, cursor.index);
      if (text[cursor.index] === "}") break;
      continue;
    }
    if (text[cursor.index] !== "}") throw new Error("Object entry must be separated by a comma");
  }
  cursor.index += 1;
  return { start, end: cursor.index, value: Object.fromEntries([...object].map(([key, child]) => [key, child.value])), object };
}

function parseJsonSourceArray(text: string, cursor: { index: number }, start: number): JsonSourceNode {
  cursor.index += 1;
  const array: JsonSourceNode[] = [];
  cursor.index = skipJsoncTrivia(text, cursor.index);
  while (text[cursor.index] !== "]") {
    array.push(parseJsonSourceNode(text, cursor));
    cursor.index = skipJsoncTrivia(text, cursor.index);
    if (text[cursor.index] === ",") {
      cursor.index += 1;
      cursor.index = skipJsoncTrivia(text, cursor.index);
      if (text[cursor.index] === "]") break;
      continue;
    }
    if (text[cursor.index] !== "]") throw new Error("Array entry must be separated by a comma");
  }
  cursor.index += 1;
  return { start, end: cursor.index, value: array.map((child) => child.value), array };
}

function scanJsonString(text: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
  }
  throw new Error("Unterminated JSON string");
}

function skipJsoncTrivia(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (/\s/u.test(text[index] ?? "")) {
      index += 1;
      continue;
    }
    if (text[index] === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (text[index] === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Unterminated JSON comment");
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function collectJsonSourcePatches(
  node: JsonSourceNode,
  before: unknown,
  after: unknown,
  text: string,
  patches: JsonSourcePatch[],
): void {
  if (jsonEqual(before, after)) return;
  if (isRecord(before) && isRecord(after) && node.object) {
    const beforeKeys = Object.keys(before).sort();
    const afterKeys = Object.keys(after).sort();
    if (jsonEqual(beforeKeys, afterKeys)) {
      for (const key of afterKeys) {
        const child = node.object.get(key);
        if (!child) {
          patches.push({ start: node.start, end: node.end, replacement: formatJsonReplacement(after, text, node.start, node.end) });
          return;
        }
        collectJsonSourcePatches(child, before[key], after[key], text, patches);
      }
      return;
    }
  }
  if (Array.isArray(before) && Array.isArray(after) && node.array && before.length === after.length) {
    for (let index = 0; index < after.length; index += 1) {
      const child = node.array[index];
      if (!child) {
        patches.push({ start: node.start, end: node.end, replacement: formatJsonReplacement(after, text, node.start, node.end) });
        return;
      }
      collectJsonSourcePatches(child, before[index], after[index], text, patches);
    }
    return;
  }
  patches.push({ start: node.start, end: node.end, replacement: formatJsonReplacement(after, text, node.start, node.end) });
}

function formatJsonReplacement(value: unknown, source: string, start: number, end?: number): string {
  let serialized = JSON.stringify(value, null, 2) ?? "null";
  if (end !== undefined && (isRecord(value) || Array.isArray(value))) {
    const oldFragment = source.slice(start, end);
    serialized = preserveJsoncComments(oldFragment, serialized).replace(/\n$/u, "");
  }
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const indent = source.slice(lineStart, start).match(/^[ \t]*/u)?.[0] ?? "";
  return serialized.replace(/\n/g, `\n${indent}`);
}

function preserveJsoncComments(original: string, body: string): string {
  const comments = extractJsonComments(original);
  if (comments.length === 0) return `${body}\n`;
  const lines = body.split("\n");
  let searchFrom = 0;
  const suffix: string[] = [];
  for (const comment of comments) {
    const commentLines = comment.text.split("\n");
    let target = -1;
    if (comment.key !== undefined) {
      const keyText = JSON.stringify(comment.key);
      target = lines.findIndex((line, index) => index >= searchFrom && line.trimStart().startsWith(`${keyText}:`));
    }
    if (target < 0) {
      suffix.push(comment.text);
      continue;
    }
    const indent = lines[target]?.match(/^\s*/u)?.[0] ?? "";
    lines.splice(target, 0, ...commentLines.map((line) => `${indent}${line}`));
    searchFrom = target + commentLines.length + 1;
  }
  const trailing = suffix.length > 0 ? `\n${suffix.join("\n")}` : "";
  return `${lines.join("\n").replace(/\n?$/u, "")}${trailing}\n`;
}

function extractJsonComments(text: string): JsonComment[] {
  const comments: Array<JsonComment & { end: number }> = [];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character !== "/" || (next !== "/" && next !== "*")) continue;
    const start = index;
    let end = index + 2;
    if (next === "/") {
      while (end < text.length && text[end] !== "\n") end += 1;
    } else {
      while (end < text.length && !(text[end] === "*" && text[end + 1] === "/")) end += 1;
      if (end < text.length) end += 2;
    }
    const commentText = text.slice(start, end).trim();
    comments.push({ text: commentText, key: findNextJsonPropertyKey(text, end), end });
    index = Math.max(index, end - 1);
  }
  return comments.map(({ text: commentText, key }) => ({ text: commentText, key }));
}

function findNextJsonPropertyKey(text: string, from: number): string | undefined {
  let quoteStart = -1;
  let escaped = false;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (quoteStart >= 0) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') {
        const raw = text.slice(quoteStart, index + 1);
        let next = index + 1;
        while (next < text.length && /\s/u.test(text[next] ?? "")) next += 1;
        if (text[next] === ":") {
          try { return JSON.parse(raw) as string; } catch { return undefined; }
        }
        quoteStart = -1;
      }
      continue;
    }
    if (character === '"') quoteStart = index;
  }
  return undefined;
}

function resolveBackupPath(modelsPath: string, requestedPath: string): string {
  const directory = resolve(dirname(modelsPath));
  const candidate = resolve(directory, requestedPath);
  if (dirname(candidate) !== directory || !isTimestampedBackupName(basename(candidate), basename(modelsPath))) {
    throw new DoctorError(`Backup path must refer to a timestamped backup beside ${modelsPath}`, "invalid-target");
  }
  return candidate;
}

function isTimestampedBackupName(entry: string, modelsName: string): boolean {
  const prefix = `${modelsName}.bak-`;
  return entry.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?$/u.test(entry.slice(prefix.length));
}

function stripJsonCommentsAndTrailingCommas(text: string): string {
  return removeTrailingCommas(stripJsonComments(text));
}

function removeTrailingCommas(text: string): string {
  let output = "";
  let quote: '"' | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
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
    if (character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    output += character;
  }
  return output;
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
