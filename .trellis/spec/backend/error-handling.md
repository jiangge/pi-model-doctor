# Error Handling

## Scope

The extension crosses three failure-prone boundaries: user command input, local JSON/filesystem operations, and the models.dev network/cache. Errors must remain actionable without exposing credentials.

## Error Types

`DoctorError` in `.pi/extensions/model-doctor/src/json.ts` carries a stable code (`invalid-config`, `invalid-target`, `backup-error`, `write-error`, or `io-error`) and an optional cause. `ModelsDevError` in `src/models-dev.ts` distinguishes `network-unavailable` from `invalid-catalog`.

## Boundary Rules

- Parse and validate `models.json` before mutating it. A non-object root or malformed JSON fails with `invalid-config`.
- A models.dev request has a timeout, checks the HTTP status, and normalizes the response before caching it.
- A valid cache is used when the network is unavailable; the result is marked stale and includes a warning.
- `--dry-run` never calls `writeModelsJson`; its catalog load also uses `persist: false`.
- Mutations back up the existing file before atomic replacement. Backup or write failure is reported and does not claim success.
- Slash-command handlers catch errors at the boundary and show `model-doctor: <message>` through `ctx.ui.notify`; domain modules throw typed errors instead of printing.

## Validation Matrix

| Condition | Result |
|---|---|
| Unknown/malformed `provider/model` target | `DoctorError("invalid-target")` |
| `models.json` invalid JSON/root/providers/models shape | `DoctorError("invalid-config")` |
| models.dev HTTP/network failure with valid cache | stale cache + warning |
| models.dev failure without cache for add/check/fix | warning finding or fallback proposal (add) |
| user-owned endpoint/header/capability differs | warning conflict; do not overwrite |
| backup copy fails | `DoctorError("backup-error")`; no write |
| atomic rename fails | `DoctorError("write-error")`; temp file cleanup is best effort |

## Common Mistakes

Do not catch and ignore a failed backup, do not silently turn a user-owned conflict into a repair, and do not include raw `error` objects or request headers in user output. Use `errorMessage()` for safe short messages.
