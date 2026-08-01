# Pi Model Doctor Contract

## 1. Scope / Trigger

This contract applies to `.pi/extensions/model-doctor/` because the extension changes a user configuration file, introduces a slash-command API, integrates a remote catalog/cache, and owns a cross-boundary repair policy.

## 2. Signatures

```ts
/model-doctor add <provider-or-url> [model] [--api-key <value>] [--dry-run]
/model-doctor list [provider]
/model-doctor check [provider/model]
/model-doctor fix [provider/model] [--dry-run]
/model-doctor remove <provider/model>
/model-doctor refresh [--force]
```

Core service signatures:

```ts
ModelDoctor.proposeAdd(input: AddInput): Promise<AddProposal>
ModelDoctor.proposeFix(target: string, options?: { persistCache?: boolean }): Promise<FixProposal>
ModelDoctor.proposeFixAll(options?: { persistCache?: boolean }): Promise<FixProposal>
ModelDoctor.applyFix(proposal: FixProposal): Promise<{ backupPath?: string; plan?: ChangePlan }>
```

## 3. Contracts

- Default target: `join(getAgentDir(), "models.json")`; override with `PI_MODEL_DOCTOR_MODELS_PATH`.
- Cache directory: `PI_MODEL_DOCTOR_DIR` or `~/.pi/model-doctor/`.
- Cache files: `models-cache.json`, `providers-cache.json`, `policies-cache.json`.
- models.dev endpoint: `PI_MODEL_DOCTOR_MODELS_DEV_URL` or `https://models.dev/api.json`.
- Mutating commands read JSON, create `models.json.bak-<timestamp>[-n]`, and atomically rename a temp file into place.
- `_piModelDoctor` is extension-owned metadata with `managed`, `source`, `lastCheck`, `autoRepair`, `version`, `managedFields`, and `managedValues`.
- Managed fields are model metadata/capabilities (`name`, reasoning, thinking map, input, cost, context window, max tokens, compat) and provider identity fields (`name`, base URL, API). API keys and headers are user-owned.
- Pi runtime configuration accepts ordinary Pi fields; `_piModelDoctor` is an unknown-field namespace preserved by the writer and omitted by `stripDoctorMetadata` when creating a runtime-facing object.

## 4. Validation & Error Matrix

| Input/state | Behavior |
|---|---|
| Missing add target | usage error / `invalid-target` |
| Missing fix/remove model target | `provider/model` validation error |
| User-edited managed field | warning conflict; preserve user value |
| Provider/model deprecated in models.dev | warning finding; never auto-delete |
| Cache fresh | local-first, no network request |
| Cache stale + network unavailable | stale cache with warning |
| No cache + network unavailable during add | fallback proposal only when endpoint/model input is sufficient |
| Dry-run | no config write, backup, or cache write |
| Backup/atomic write failure | typed error and failure status |

## 5. Good / Base / Bad Cases

- **Good**: `fix openai/gpt-test --dry-run` prints a deterministic plan, leaves both models.json and cache unchanged, and reports preserved custom headers.
- **Base**: `add openai gpt-test` merges the model into an existing provider and preserves unknown top-level/provider/model keys.
- **Bad**: a user changes the proxy `baseUrl`; `fix` reports an endpoint conflict and does not replace the proxy endpoint.

## 6. Tests Required

- `parseCommandArgs`: quoted values, flags, unknown/help path.
- Capability engines: toggle/effort/budget reasoning, unknown fallback, cache pricing/signals, provider adapters.
- JSON boundary: JSONC comments, ownership snapshots, backup collision suffix, atomic temp cleanup, metadata stripping.
- Cache: local read, stale fallback, forced refresh, conditional headers, dry-run non-persistence.
- Service: add/list/check/fix/fix-all/remove with temporary files; assert backup exists, unrelated data survives, user fields survive, and dry-run has no mutation.
- Integration: load extension through Pi with `.pi/settings.json` and assert `/model-doctor` registration without network or secret output.

## 7. Wrong vs Correct

### Wrong

```ts
await writeFile(modelsPath, JSON.stringify(next));
```

### Correct

```ts
const backupPath = await backupFile(modelsPath, now);
await atomicWrite(modelsPath, `${JSON.stringify(next, null, 2)}\n`);
```

The correct path retains rollback evidence, preserves file permissions where possible, and prevents readers from observing a partially written JSON file.
