import { chmod, lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { atomicWrite, DoctorError, errorMessage, isRecord, isSafeHeaderName, looksLikeCredentialValue } from "./json.ts";
import { isSafeProviderApiUrl } from "./catalog-url.ts";
import { isPolicyCatalog } from "./capabilities.ts";
import type { DoctorPaths, JsonObject, PolicyCatalog, ProviderCacheData, StoredCache } from "./types.ts";

// The stale bound is shorter than the acquisition timeout, so a crashed
// writer can be reclaimed by the next process instead of causing every later
// refresh to time out forever. Active writers refresh the lock heartbeat.
const CACHE_LOCK_TIMEOUT_MS = 15_000;
const CACHE_LOCK_STALE_MS = 5_000;

export class CacheStore {
  constructor(
    private readonly paths: Pick<DoctorPaths, "doctorDir" | "modelsCachePath" | "providersCachePath" | "policiesCachePath">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read<T>(path: string): Promise<StoredCache<T> | undefined> {
    try {
      const directory = await lstat(this.paths.doctorDir);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) return undefined;
      const file = await lstat(path);
      // A read must remain side-effect free (especially for --dry-run). An
      // overly permissive cache is invalid rather than silently repaired.
      if (!file.isFile() || (file.mode & 0o077) !== 0) return undefined;
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        !isRecord(parsed)
        || parsed.version !== 1
        || typeof parsed.fetchedAt !== "string"
        || !Number.isFinite(Date.parse(parsed.fetchedAt))
        || parsed.etag !== undefined && !isSafeCacheHeader(parsed.etag)
        || parsed.lastModified !== undefined && !isSafeCacheHeader(parsed.lastModified)
        || !("data" in parsed)
        || hasSensitiveCacheKey(parsed.data)
      ) {
        return undefined;
      }
      return parsed as unknown as StoredCache<T>;
    } catch {
      return undefined;
    }
  }

  async write<T>(path: string, data: T, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    if (hasSensitiveCacheKey(data)) throw new DoctorError(`Refusing to cache sensitive fields in ${path}`, "invalid-config");
    try {
      await mkdir(this.paths.doctorDir, { recursive: true, mode: 0o700 });
      const directory = await lstat(this.paths.doctorDir);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("cache directory is not a regular directory");
      await chmod(this.paths.doctorDir, 0o700);
    } catch (error) {
      throw new DoctorError(`Unable to secure cache directory ${this.paths.doctorDir}: ${errorMessage(error)}`, "write-error", error);
    }
    if (headers?.etag !== undefined && !isSafeCacheHeader(headers.etag)) throw new DoctorError(`Refusing unsafe cache ETag in ${path}`, "invalid-config");
    if (headers?.lastModified !== undefined && !isSafeCacheHeader(headers.lastModified)) throw new DoctorError(`Refusing unsafe cache Last-Modified value in ${path}`, "invalid-config");
    const payload: StoredCache<T> = {
      version: 1,
      fetchedAt: this.now().toISOString(),
      ...(headers?.etag ? { etag: headers.etag } : {}),
      ...(headers?.lastModified ? { lastModified: headers.lastModified } : {}),
      data,
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(payload, null, 2);
      if (serialized === undefined) throw new Error("cache payload is not JSON serializable");
    } catch (error) {
      throw new DoctorError(`Unable to serialize cache file ${path}: ${errorMessage(error)}`, "write-error", error);
    }
    // atomicWrite applies 0600 to the temporary file before rename. Serialize
    // writers across Pi sessions so concurrent refreshes cannot overwrite each
    // other's validator/data pair. Avoid a post-rename chmod on the
    // caller-controlled path, which could follow a raced symlink.
    await withCacheLock(this.paths.doctorDir, () => atomicWrite(path, `${serialized}\n`, 0o600));
  }

  async readModels<T>(): Promise<StoredCache<T> | undefined> {
    return this.read<T>(this.paths.modelsCachePath);
  }

  async writeModels<T>(data: T, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    return this.write(this.paths.modelsCachePath, data, headers);
  }

  async readProviders<T>(): Promise<StoredCache<T> | undefined> {
    return this.read<T>(this.paths.providersCachePath);
  }

  async readProviderCache(): Promise<ProviderCacheData | undefined> {
    const cached = await this.read<ProviderCacheData>(this.paths.providersCachePath);
    return cached && isProviderCacheData(cached.data) ? cached.data : undefined;
  }

  async writeProviders<T>(data: T, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    return this.write(this.paths.providersCachePath, data, headers);
  }

  async writeProviderCache(data: ProviderCacheData, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    if (!isProviderCacheData(data)) throw new DoctorError("Cannot write an invalid provider cache", "invalid-config");
    return this.writeProviders(data, headers);
  }

  async readPolicies<T>(): Promise<StoredCache<T> | undefined> {
    return this.read<T>(this.paths.policiesCachePath);
  }

  async readPolicyCatalog(): Promise<PolicyCatalog | undefined> {
    const cached = await this.read<PolicyCatalog>(this.paths.policiesCachePath);
    return cached && isPolicyCatalog(cached.data) ? cached.data : undefined;
  }

  async writePolicies<T>(data: T, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    return this.write(this.paths.policiesCachePath, data, headers);
  }

  async writePolicyCatalog(data: PolicyCatalog): Promise<void> {
    if (!isPolicyCatalog(data)) throw new DoctorError("Cannot write an invalid policy catalog", "invalid-config");
    return this.writePolicies(data);
  }

  describe(): JsonObject {
    return {
      directory: this.paths.doctorDir,
      models: this.paths.modelsCachePath,
      providers: this.paths.providersCachePath,
      policies: this.paths.policiesCachePath,
    };
  }

  static errorMessage(error: unknown): string {
    return errorMessage(error);
  }
}

async function withCacheLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${directory}/.cache-write.lock`;
  const started = Date.now();
  while (true) {
    let handle: FileHandle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
        try {
          const lockStat = await lstat(lockPath);
          if (Date.now() - lockStat.mtimeMs > CACHE_LOCK_STALE_MS) await unlink(lockPath);
        } catch { /* another writer may have released it */ }
        if (Date.now() - started >= CACHE_LOCK_TIMEOUT_MS) throw new DoctorError(`Timed out waiting for cache write lock ${lockPath}`, "write-error");
        await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
        continue;
      }
      throw error instanceof DoctorError
        ? error
        : new DoctorError(`Unable to acquire cache write lock ${lockPath}: ${errorMessage(error)}`, "write-error", error);
    }
    let identity: { dev: number; ino: number } | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    try {
      const lockStat = await handle.stat();
      identity = { dev: lockStat.dev, ino: lockStat.ino };
      await handle.writeFile(`${process.pid}\n`, "utf8");
      heartbeat = setInterval(() => {
        void handle.utimes(new Date(), new Date()).catch(() => undefined);
      }, Math.max(500, Math.floor(CACHE_LOCK_STALE_MS / 3)));
      const heartbeatHandle = heartbeat as unknown as { unref?: () => void };
      heartbeatHandle.unref?.();
      return await operation();
    } catch (error) {
      throw error instanceof DoctorError
        ? error
        : new DoctorError(`Unable to write cache under lock ${lockPath}: ${errorMessage(error)}`, "write-error", error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      try { await handle.close(); } catch { /* best effort */ }
      if (identity) {
        try {
          const current = await lstat(lockPath);
          if (current.dev === identity.dev && current.ino === identity.ino) await unlink(lockPath);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
            // Another writer may have replaced the lock. Do not remove it.
          }
        }
      }
    }
  }
}

export function isProviderCacheData(value: unknown): value is ProviderCacheData {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.providers) || hasSensitiveCacheKey(value)) return false;
  return Object.entries(value.providers).every(([providerKey, summary]) => {
    if (isUnsafeCacheKey(providerKey) || !isRecord(summary) || typeof summary.id !== "string" || summary.id.trim() === "" || isUnsafeCacheKey(summary.id)
      || normalizeCacheIdentifier(providerKey) !== normalizeCacheIdentifier(summary.id)
      || typeof summary.adapter !== "string" || summary.adapter.trim() === "" || !isRecord(summary.capabilities)
      || !isProviderCapabilitySummary(summary.capabilities)) return false;
    if (summary.name !== undefined && typeof summary.name !== "string") return false;
    if (summary.api !== undefined && (typeof summary.api !== "string" || !isSafeProviderApiUrl(summary.api, isSensitiveCacheField))) return false;
    if (summary.doc !== undefined && typeof summary.doc !== "string") return false;
    if (summary.env !== undefined && (!Array.isArray(summary.env) || !summary.env.every((item) => typeof item === "string" && /^[A-Z0-9][A-Z0-9_]*$/.test(item)))) return false;
    if (summary.required_headers !== undefined && (!Array.isArray(summary.required_headers) || !summary.required_headers.every((item) => isSafeHeaderName(item)))) return false;
    return true;
  });
}

function isProviderCapabilitySummary(value: JsonObject): boolean {
  for (const key of ["prompt", "context", "kv", "reasoning"] as const) {
    if (typeof value[key] !== "boolean") return false;
  }
  const reasoningControls = value.reasoningControls;
  const cacheSources = value.cacheSources;
  const cacheConfidences = value.cacheConfidences;
  const cacheSignals = value.cacheSignals;
  if (!Array.isArray(reasoningControls) || !Array.isArray(cacheSources) || !Array.isArray(cacheConfidences) || !Array.isArray(cacheSignals)) return false;
  if (!reasoningControls.every((item) => typeof item === "string" && item.trim() !== "")) return false;
  if (!cacheSources.every((item) => typeof item === "string" && item.trim() !== "")) return false;
  if (!cacheConfidences.every((item) => typeof item === "string" && ["high", "medium", "low"].includes(item))) return false;
  if (!cacheSignals.every(isProviderCacheSignal)) return false;
  return true;
}

function isProviderCacheSignal(value: unknown): boolean {
  if (!isRecord(value) || typeof value.modelId !== "string" || value.modelId.trim() === "" || isUnsafeCacheKey(value.modelId)) return false;
  for (const key of ["capability", "control", "pricing", "usageReporting", "retention", "sessionAffinity"] as const) {
    if (!isRecord(value[key])) return false;
  }
  if (hasInvalidBooleanFields(value.capability, ["prompt", "context", "kv"])) return false;
  if (hasInvalidBooleanFields(value.control, ["prompt", "context", "kv"])) return false;
  if (hasInvalidBooleanFields(value.pricing, ["read", "write"])) return false;
  if (hasInvalidBooleanFields(value.usageReporting, ["readTokens", "writeTokens"])) return false;
  if (!isRecord(value.retention) || typeof value.retention.supported !== "boolean" || !Array.isArray(value.retention.values) || !value.retention.values.every((item) => typeof item === "string")) return false;
  if (!isRecord(value.sessionAffinity) || typeof value.sessionAffinity.supported !== "boolean") return false;
  if (value.sessionAffinity.format !== undefined && typeof value.sessionAffinity.format !== "string") return false;
  if (typeof value.confidence !== "string" || !["high", "medium", "low"].includes(value.confidence)) return false;
  if (typeof value.source !== "string" || !["pi", "provider", "models.dev", "fallback"].includes(value.source)) return false;
  return true;
}

function hasInvalidBooleanFields(value: unknown, keys: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  return keys.some((key) => typeof value[key] !== "boolean");
}

function normalizeCacheIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function isUnsafeCacheKey(value: string): boolean {
  return value === "__proto__" || value === "constructor" || value === "prototype";
}

function hasSensitiveCacheKey(value: unknown): boolean {
  if (typeof value === "string") return looksLikeCredentialValue(value);
  if (Array.isArray(value)) return value.some((item) => hasSensitiveCacheKey(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => {
    if (isUnsafeCacheKey(key) || isSensitiveCacheField(key)) return true;
    if (isCacheMapKey(key) && isRecord(child)) {
      // Provider/model/adapter ids are data keys, not field names. Inspect the
      // mapped values with normal field-name rules so secrets nested inside a
      // summary cannot bypass cache validation.
      return Object.entries(child).some(([entryKey, entryValue]) => isUnsafeCacheKey(entryKey) || hasSensitiveCacheKey(entryValue));
    }
    return hasSensitiveCacheKey(child);
  });
}

function isSafeCacheHeader(value: unknown): value is string {
  return typeof value === "string" && !/[\r\n]/.test(value) && !looksLikeCredentialValue(value);
}

function isSensitiveCacheField(key: string): boolean {
  return /^(?:headers?|authentication|auth|credentials?|api[-_]?key|authorization(?:[-_]?header)?|auth[-_]?header|oauth|access[-_]?token|refresh[-_]?token|token|secret|password|credential|cookie|set-cookie)$/i.test(key)
    || /^(?:x[-_]?api[-_]?key|x[-_]?auth[-_]?token)$/i.test(key);
}

function isCacheMapKey(key: string): boolean {
  return key === "providers" || key === "models" || key === "adapters";
}
