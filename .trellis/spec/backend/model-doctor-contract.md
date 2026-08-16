# Pi Model Doctor Contract

## 1. Scope / Trigger

This contract applies to the root `pi-model-doctor` package because the extension changes a user configuration file, introduces a slash-command API, integrates a remote catalog/cache, and owns a cross-boundary repair policy.

## 2. Signatures

```ts
/model-doctor add <provider-or-url> [model] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]
/model-doctor add <provider-id> <endpoint-url> [model] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]
/model-doctor list [provider]
/model-doctor check [provider/model]
/model-doctor fix [provider/model] [--dry-run] [--yes]
/model-doctor remove <provider/model> [--dry-run] [--yes]
/model-doctor refresh [--force] [--dry-run]
/model-doctor sync <provider-or-url> [--models <id1,id2>] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]
/model-doctor migrate <provider/model> [--to <provider/model>] [--dry-run] [--yes] [--remove-source]
/model-doctor cleanup-backups [--keep <count>] [--max-age-ms <milliseconds>] [--dry-run] [--yes]
/model-doctor rollback <models.json.bak-timestamp> [--dry-run] [--yes]
```

Core service signatures:

```ts
ModelDoctor.proposeAdd(input: AddInput): Promise<AddProposal>
ModelDoctor.proposeSync(input: SyncInput): Promise<SyncProposal>
ModelDoctor.applySync(proposal: SyncProposal): Promise<{ backupPath?: string; plan: ChangePlan }>
ModelDoctor.proposeFix(target: string, options?: { persistCache?: boolean }): Promise<FixProposal>
ModelDoctor.proposeFixAll(options?: { persistCache?: boolean }): Promise<FixProposal>
ModelDoctor.applyFix(proposal: FixProposal): Promise<{ backupPath?: string; plan?: ChangePlan }>
ModelDoctor.proposeMigrate(input: MigrateInput): Promise<MigrateProposal>
ModelDoctor.applyMigrate(proposal: MigrateProposal): Promise<{ backupPath?: string; plan: ChangePlan }>
ModelDoctor.rollback(backupPath: string, options?: { dryRun?: boolean }): Promise<{ sourcePath: string; safetyBackupPath?: string }>
```

`AddInput` supports `providerId?: string` for explicit channel setup (`add providerA https://gateway.example/v1` or `add providerA https://gateway.example/v1 <model>`), `metadataProvider?: string` to disambiguate global models.dev metadata, and `api?: PiApi` to explicitly select a third-party channel transport protocol. `SyncInput` uses `modelIds: string[]` for headless selection and shares the same metadata-provider/API/credential safety rules as `AddInput`.

## 3. Contracts

- Default target: `join(getAgentDir(), "models.json")`; override with `PI_MODEL_DOCTOR_MODELS_PATH`.
- The published package does not bundle or pin the Pi host in `devDependencies`; `@earendil-works/pi-coding-agent` and `typebox` remain optional peer dependencies supplied by Pi. Repository development checks resolve the installed Pi host, optionally overridden with `PI_HOST_PACKAGE`.
- Cache directory: `PI_MODEL_DOCTOR_DIR` or `~/.pi/model-doctor/`.
- Cache files: `models-cache.json`, `providers-cache.json`, `policies-cache.json`; cache directories are created with mode `0700` and cache files with mode `0600`.
- models.dev endpoint: `PI_MODEL_DOCTOR_MODELS_DEV_URL` or `https://models.dev/api.json`. Custom endpoints use the same HTTPS/private-host policy; explicitly trusted private test infrastructure requires `PI_MODEL_DOCTOR_TRUSTED_ENDPOINT=1`.
- Mutating commands read JSON, create `models.json.bak-<timestamp>[-n]`, verify the proposal base fingerprint before writing, and atomically rename a temp file into place.
- `_piModelDoctor` is extension-owned metadata with `managed`, `source`, `lastCheck`, `autoRepair`, `version`, `managedFields`, and `managedValues`. Pending provider-only entries may additionally record `endpointNormalizationPending`, `endpointApiExplicit`, `endpointApiHint`, `endpointValueHint`, `endpointNormalizationBlocked`, and `endpointApiNormalizationBlocked`; these fields distinguish inferred transport values from later user edits.
- Managed fields are model metadata/capabilities (`name`, reasoning, thinking map, input, cost, context window, max tokens, compat) and provider identity fields (`name`, base URL, API). API keys and headers are user-owned.
- Pi runtime configuration accepts ordinary Pi fields; `_piModelDoctor` is an unknown-field namespace preserved by the writer and omitted by `stripDoctorMetadata` when creating a runtime-facing object.
- `models-cache.json` stores the complete normalized catalog; `providers-cache.json` stores schema-versioned provider summaries, adapter ids, environment-variable names, and independent capability signals. `policies-cache.json` stores a versioned `PolicyCatalog` used by capability resolution, including the Pi `0.82.1`/models.dev `api.json` normalized schema-version `1` compatibility baseline and observation date; invalid, old, sensitive, or insecurely-permissioned cache data is ignored and regenerated. Network normalization and normalized-cache validation share the same metadata shape rules. Model-level `interleaved` accepts the models.dev object form or a boolean, while unsupported primitives remain invalid; a boolean is preserved as catalog metadata and does not itself enable prompt/context/KV runtime capabilities. Cache writers reject sensitive object keys/values rather than persisting credentials. Cache capability output keeps prompt/context/KV control, pricing, usage, retention, and session-affinity semantics separate; unsupported runtime behavior is advisory rather than enabled. Capability results record confidence/source and cache adapters expose resolved, partial, advisory, or unsupported status independently for prompt/context/KV.
- `refresh` is read-only for `models.json`: it performs a forced catalog refresh and reports full configuration findings and a repair summary without applying changes. `refresh --dry-run` leaves catalog/policy caches unchanged; the normal slash command may update catalog/policy caches, while the domain API controls persistence explicitly. Cache writers serialize writes with a short-lived lock and stale-lock timeout so concurrent Pi sessions cannot corrupt validator/data pairs.
- A session-scoped background refresh runs every 24 hours by default with bounded random jitter; `PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS=0` disables it and `PI_MODEL_DOCTOR_REFRESH_JITTER_MS` overrides the jitter bound. Background refresh is stopped on session shutdown, may update catalog/policy caches, and never writes `models.json`.
- Non-interactive mutating commands require `--yes`; `--dry-run` never writes config, backups, or caches. Successful writes include persisted read-back verification and report `persisted-and-active` when the default Pi model registry refreshes and verifies the target, `activation-failed` when refresh or verification fails, or `persisted-reload-required` when a custom models path or unavailable registry prevents activation verification; cancellation and dry-run report `not-persisted`. A no-op migration does not create a backup. Backup retention is explicit only through `cleanup-backups`, never an automatic write-path side effect. `rollback` validates a timestamped backup, backs up the current file, atomically restores the backup, and uses the same runtime activation status.
- `migrate` preserves safe user fields, reports destination conflicts, keeps the source by default, and only removes it with explicit `--remove-source`. UI mode may select a discovered destination; non-interactive mode requires explicit `--to`. Deprecated destinations remain advisory and are not auto-applied. Endpoint overrides, API keys, OAuth, authorization/secret headers, and user-owned capability fields are not copied across providers. Rollback is performed by validating the timestamped backup, backing up the current file, atomically restoring the backup, and reloading/verifying Pi.
- `sync` discovers the catalog models for a provider/channel and applies the user-selected subset as one combined proposal and one atomic write. UI mode supports repeated selection with an explicit Done choice; cancellation at any selection step is `not-persisted` and performs no proposal/write; non-interactive mode requires `--models <id1,id2>`. Conditional catalog refresh preserves prior `ETag`/`Last-Modified` validators when the server omits replacements, while credential-like or newline-bearing response validators invalidate the response before cache writes.
- `add` accepts an unlisted third-party channel URL. When the URL has no models.dev provider match, an exact model id/name may be resolved globally from models.dev as metadata-only. `add <url> <model>` adds a channel model in one proposal; `add <provider-id> <endpoint-url> <model>` does the same with an explicit storage id. A URL given without a model id creates a provider-only entry (endpoint and inferred protocol, no model); `add <provider-id> <endpoint-url>` provides an explicit storage id for the same provider-only setup. Provider-only metadata records `endpointNormalizationPending` and the initial inferred `endpointApiHint`; once a model resolves the channel API, only an inferred root endpoint/API is normalized, while an explicit `--api`, explicit non-root path, or later user edit remains authoritative. Models are also attachable later with `add <provider-id-or-url> <model>` or `sync`. `--metadata-provider` is required to disambiguate duplicate catalog model ids; `--api` explicitly selects the Pi transport protocol when URL inference is insufficient. For direct channel/model adds, a root URL receives `/v1` only for `openai-completions` or `openai-responses`; Anthropic and Google families do not receive that suffix. Existing `/v1` and other explicit paths are preserved; query strings and fragments remain attached after an inserted `/v1`. URL-only provider setup does not append a suffix because no model type is available. An explicit `--api` controls the suffix decision, and an already configured channel endpoint remains authoritative. In metadata-only mode the channel's endpoint, API, headers, authentication, and unknown transport fields remain authoritative; models.dev provider identity is never copied into those fields. Official provider website metadata is not fetched implicitly, and any separately reviewed provider facts remain advisory until supplied through a supported metadata source.

## 4. Validation & Error Matrix

| Input/state | Behavior |
|---|---|
| Missing add target | usage error / `invalid-target` |
| URL add without model id | provider-only entry (endpoint + protocol, no model); model attach via `add <url> <model>` or `sync` |
| Provider id + endpoint URL | provider-only entry stored under the explicit provider id; endpoint/API/auth remain channel-owned |
| Provider id + endpoint URL + model | add the selected model in one proposal; use models.dev only for metadata and preserve channel-owned transport fields |
| Missing fix/remove model target | `provider/model` validation error |
| User-edited managed field | warning conflict; preserve user value |
| Provider/model deprecated in models.dev | warning finding; never auto-delete |
| Cache fresh | local-first, no network request |
| Cache stale + network unavailable | stale cache with warning |
| No cache + network unavailable during add | fallback proposal only when endpoint/model input is sufficient |
| Dry-run | no config write, backup, or cache write |
| Invalid policy/catalog cache | ignored safely; regenerate policy or use no-cache failure path |
| Model `interleaved` is an object or boolean | normalize and preserve it; boolean alone does not enable runtime cache capabilities |
| Model `interleaved` is another primitive | typed `ModelsDevError("invalid-catalog")`; do not cache the response |
| Literal `--api-key` without `--allow-literal-api-key` | omit the literal from the proposal/config and emit a safe warning; references such as `$ENV_VAR`, `${ENV_VAR}`, `!command`, and `pi-auth:` are allowed |
| Proposal base file changed before apply | concurrent-modification error; no backup or write |
| Refresh dry-run | catalog/config findings only; no cache persistence |
| Non-interactive mutation without `--yes` | authorization error; no config/cache mutation |
| Migration destination user field differs | warning conflict; destination value wins |
| Migration without `--remove-source` | destination is added/updated; source remains |
| Backup/atomic write failure | typed error and failure status |
| Sensitive cache payload or incompatible cache schema | cache write/read is rejected safely; network/fallback path is used without exposing the value |
| Rollback path is not a sibling timestamped backup or contains invalid JSON/schema | `DoctorError("invalid-target"/"backup-error")`; no current-file mutation |
| Unlisted third-party URL with an exact unique model id | metadata-only proposal using models.dev model facts; preserve channel transport fields |
| Unlisted third-party URL with duplicate model id | `selection-required` until `--metadata-provider` selects the catalog provider |
| Third-party `--api` override | use the explicit Pi protocol for the channel; never infer or copy the catalog provider API; use it for root-URL `/v1` normalization |
| Third-party check/fix | report `third-party-channel`; repair model metadata/capability fields only; pending provider-only channels may normalize only inferred root endpoint/API fields, never explicit endpoint/API/headers/authentication; later endpoint/API edits produce non-repairable conflicts |

## 5. Good / Base / Bad Cases

- **Good**: `fix openai/gpt-test --dry-run` prints a deterministic plan, leaves both models.json and cache unchanged, and reports preserved custom headers.
- **Base**: `add openai gpt-test` merges the model into an existing provider and preserves unknown top-level/provider/model keys.
- **Bad**: a user changes the proxy `baseUrl`; `fix` reports an endpoint conflict and does not replace the proxy endpoint.

## 6. Tests Required

Endpoint normalization additions must cover root URLs for OpenAI-compatible completions/responses, idempotent `/v1`, trailing slashes, explicit non-root paths, query/fragment preservation, Anthropic/Google no-suffix behavior, explicit `--api` overrides, direct URL/model and provider-id/endpoint/model forms, and URL-only provider setup without model-based inference.

- `parseCommandArgs`: quoted values, flags, unknown/help path, refresh dry-run flag, optional migrate destination.
- Capability engines: toggle/effort/budget/adaptive reasoning, unknown fallback, distinct cache capability/control/pricing/usage/retention signals, provider adapters.
- JSON boundary: JSONC comments and minimal source-format preservation, ownership snapshots, backup collision suffix, atomic temp cleanup, metadata stripping, rollback validation.
- Cache: local read, stale fallback, forced refresh, conditional headers, HTTP 304, policy schema validation, dry-run non-persistence, and identical network/cache acceptance of boolean or object `interleaved` metadata while rejecting other primitives.
- Service: add/list/check/fix/fix-all/remove/refresh/migrate with temporary files; assert backup exists, unrelated data survives, user fields survive, source retention/removal, metadata/deprecated/header findings, and dry-run has no mutation.
- Headers: required and conflicting header findings are reported without values.
- Discovery: ambiguous model matches return a selection-required result; UI migration/add/sync flows present candidates, while headless flows require explicit targets/model lists.
- Authorization: interactive cancellation, headless rejection without `--yes`, explicit `--yes` success.
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
