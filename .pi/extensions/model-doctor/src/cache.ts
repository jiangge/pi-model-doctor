import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite, errorMessage, isRecord, pathExists } from "./json.ts";
import type { DoctorPaths, JsonObject, StoredCache } from "./types.ts";

export class CacheStore {
  constructor(
    private readonly paths: Pick<DoctorPaths, "doctorDir" | "modelsCachePath" | "providersCachePath" | "policiesCachePath">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read<T>(path: string): Promise<StoredCache<T> | undefined> {
    if (!(await pathExists(path))) return undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.fetchedAt !== "string" || !("data" in parsed)) {
        return undefined;
      }
      return parsed as unknown as StoredCache<T>;
    } catch {
      return undefined;
    }
  }

  async write<T>(path: string, data: T, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const payload: StoredCache<T> = {
      version: 1,
      fetchedAt: this.now().toISOString(),
      ...(headers?.etag ? { etag: headers.etag } : {}),
      ...(headers?.lastModified ? { lastModified: headers.lastModified } : {}),
      data,
    };
    await atomicWrite(path, `${JSON.stringify(payload, null, 2)}\n`);
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

  async writeProviders<T>(data: T, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    return this.write(this.paths.providersCachePath, data, headers);
  }

  async readPolicies<T>(): Promise<StoredCache<T> | undefined> {
    return this.read<T>(this.paths.policiesCachePath);
  }

  async writePolicies<T>(data: T, headers?: { etag?: string; lastModified?: string }): Promise<void> {
    return this.write(this.paths.policiesCachePath, data, headers);
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
