# Error Handling

## Scope

The extension crosses three failure-prone boundaries: user command input, local JSON/filesystem operations, and the models.dev network/cache. Errors must remain actionable without exposing credentials.

## Error Types

`DoctorError` in `src/json.ts` carries a stable code (`invalid-config`, `invalid-target`, `selection-required`, `authorization-required`, `concurrent-modification`, `backup-error`, `write-error`, or `io-error`) and an optional cause. `ModelsDevError` in `src/models-dev.ts` distinguishes `network-unavailable` from `invalid-catalog`.

## Boundary Rules

- Parse and validate `models.json` before mutating it. A non-object root or malformed JSON fails with `invalid-config`.
- A models.dev request and response-body read have bounded timeouts, reject unsafe endpoints/headers and oversized bodies, check the HTTP status, and normalize the response before caching it.
- A valid cache is used when the network is unavailable; the result is marked stale and includes a warning.
- `--dry-run` never calls `writeModelsJson`; add/fix/sync/migrate and refresh dry-run catalog/policy loads also use `persist: false`.
- Mutations back up the existing file before atomic replacement. Backup names use an exclusive create operation to avoid concurrent collision; backup or write failure is reported and does not claim success. Persisted read-back failures attempt an automatic atomic restoration from the new backup. `rollback` validates a regular, parseable timestamped backup, backs up the current file, atomically restores it, and verifies the restored data.
- Background catalog refresh failures are warnings only; they never mutate `models.json` and do not claim a configuration repair. Normal slash-command refresh may persist catalog/policy caches, while `--dry-run` and any lifecycle dry-run path must not persist them.
- Slash-command handlers catch errors at the boundary and show `model-doctor: <message>` through `ctx.ui.notify`; domain modules throw typed errors instead of printing. Error messages, findings, plans, and warnings pass through secret redaction before user output. `sync` is a single combined proposal: UI selection ends with an explicit Done choice, headless mode requires `--models`, and all selected models share one authorization, backup, and atomic write. The package does not install a Pi host as a project development dependency; Pi supplies the optional peer at extension load time, while repository checks must resolve an installed host or fail with an actionable `PI_HOST_PACKAGE` message.
- Mutating commands in non-interactive modes require explicit `--yes`; `--dry-run` takes precedence and never persists config, backups, or caches. `add --api-key` accepts references (`$ENV_VAR`, `${ENV_VAR}`, `!command`, or `pi-auth:`); literal keys are omitted unless explicit literal-key opt-in is supplied. Cache writes reject sensitive keys and use restrictive directory/file permissions. Successful default-path mutations refresh the Pi model registry and report `persisted-and-active`, `activation-failed`, or `persisted-reload-required`; custom model paths remain persistence-only until Pi reloads the matching runtime. An unlisted third-party URL can use an exact models.dev model match as metadata-only; its endpoint, API protocol, headers, authentication, and other transport fields remain channel-owned. For a direct channel/model add, a root URL receives `/v1` only for the resolved `openai-completions` or `openai-responses` family; explicit paths, query strings, fragments, Anthropic, and Google endpoints are preserved. URL-only provider setup does not append `/v1` because no model type is available. `--metadata-provider` resolves duplicate model ids and `--api` is an explicit transport override that also controls root-URL normalization; no provider credentials are sent to or inferred for a third-party endpoint.

## Validation Matrix

| Condition | Result |
|---|---|
| Unknown/malformed `provider/model` target | `DoctorError("invalid-target")` |
| Ambiguous model discovery | selection-required finding or `DoctorError("selection-required")`; never silently select a catalog entry |
| Non-interactive migration without destination | `DoctorError("selection-required")`; no discovery fallback or write |
| UI cancellation or headless authorization rejection | `authorization-required` with `Status: not-persisted`; no config/cache write |
| `models.json` invalid JSON/root/providers/models shape | `DoctorError("invalid-config")` |
| models.dev HTTP/network failure with valid cache | stale cache + warning |
| models.dev failure without cache for add/check/fix | warning finding or fallback proposal (add) |
| unlisted third-party URL with unique exact model metadata | metadata-only model proposal; preserve endpoint/API/headers/authentication |
| `add <provider-id> <endpoint-url>` | provider-only setup under the explicit safe id; reject duplicate id/endpoint collisions without mutation |
| `add <provider-id> <endpoint-url> <model>` | one-step channel/model setup; preserve channel-owned endpoint/API/headers/auth and use unique models.dev metadata only |
| unlisted third-party URL with ambiguous model metadata | `selection-required`; require `--metadata-provider` |
| third-party `--api` override | use explicit channel API; do not copy catalog provider API; use it for root-URL `/v1` normalization |
| user-owned endpoint/header/capability differs | warning conflict; do not overwrite |
| backup copy fails | `DoctorError("backup-error")`; no write |
| atomic rename fails | `DoctorError("write-error")`; temp file cleanup is best effort and the pre-write configuration remains available through the backup/restore path |
| non-interactive mutation without `--yes` | `DoctorError("authorization-required")`; no config/cache mutation |
| headless sync without `--models` | `DoctorError("selection-required")`; no config/cache mutation |
| sync UI cancellation or empty selection | `authorization-required`/selection cancellation; no config/cache mutation |
| migration destination user field differs | warning `migration-conflict`; destination value is preserved |
| invalid policy/catalog cache | ignore and regenerate policy, or fail without cache; never treat it as valid |
| malformed cached provider/model ids, limits, costs, reasoning options, or sensitive fields | invalidate the catalog cache and use the network or typed no-cache failure path |
| secret-like error/header text | redact values while retaining safe field names and status |
| models.dev endpoint with URL credentials/credential query/private host, unsafe response headers, body timeout, or unsafe response size | typed `invalid-catalog`/`network-unavailable`; do not fetch or cache the response |
| proposal applied after models.json changed | `DoctorError("concurrent-modification")`; regenerate the plan |
| sensitive cache payload or cache directory/file security failure | typed `invalid-config`/`write-error`; do not claim a valid cache or expose the value |
| rollback path is not a sibling timestamped backup or contains invalid JSON/schema | `DoctorError("invalid-target"/"backup-error")`; no current-file mutation |
| runtime registry refresh or target verification fails after persistence | report `activation-failed`; config remains persisted and user is told to reload/inspect Pi |

## Common Mistakes

- Do not append `/v1` before resolving the channel/model API family. For direct URL/model adds, normalize only a root URL; preserve explicit endpoint paths and keep query strings/fragments after the inserted `/v1`. Provider-only URL setup has no model type and must remain unchanged. Pending provider-only metadata records the inferred API and endpoint hints; after model resolution, only still-inferred endpoint/API fields may be repaired. A changed endpoint/API is user-owned, is marked as blocked normalization state, and must remain untouched. Catalog root and `/v1` are equivalent only in both directions for OpenAI-compatible API families.

Do not catch and ignore a failed backup, do not silently turn a user-owned conflict into a repair, and do not include raw `error` objects or request headers in user output. Use `errorMessage()` for safe short messages.

> **Warning**: A stale cache is a valid degraded source only for network failures. Malformed catalog data must not replace a valid cache silently; invalid policy data is ignored and regenerated.
