# Pi Model Doctor

Pi Model Doctor is a project-local Pi extension that manages the model lifecycle in `models.json`. It discovers provider metadata from [models.dev](https://models.dev), fills in model capabilities, checks existing entries, and applies safe repairs without replacing user-owned settings.

## Load it

This repository's `.pi/settings.json` loads the extension automatically:

```json
{
  "extensions": ["./extensions/model-doctor/index.ts"]
}
```

For another Pi project, copy `.pi/extensions/model-doctor/` and add its `index.ts` to that project's `.pi/settings.json`.

## Commands

```text
/model-doctor add <provider-or-url> [model] [--api-key <value>] [--dry-run]
/model-doctor list [provider]
/model-doctor check [provider/model]
/model-doctor fix [provider/model] [--dry-run]
/model-doctor remove <provider/model>
/model-doctor refresh [--force]
```

`add` accepts a models.dev provider id/name, a provider API URL, or a model id. When available, the provider's environment variable is used as an API-key reference (for example `$OPENAI_API_KEY`); secrets are never printed by the extension. Use `--dry-run` to inspect a proposal without writing.

`check` works offline for the local file and uses the local models.dev cache when the network is unavailable. `fix` only changes fields owned by Pi Model Doctor. If a user explicitly changed an endpoint, header, compatibility object, or model capability, the change is reported as a conflict and is not overwritten. `remove` requires an exact `provider/model` target.

## Safe writes and ownership

The default file is Pi's `getModelsPath()` (`~/.pi/agent/models.json`). Mutating commands:

1. Read the existing file.
2. Create a timestamped `models.json.bak-<timestamp>` backup when the file exists.
3. Merge only the requested provider/model.
4. Write through a temporary file and atomic rename.

Managed entries carry `_piModelDoctor` metadata with the source, last check, repair policy, managed fields, and the last managed values. Unknown JSON fields and user-owned headers/endpoint overrides remain intact.

## Cache and offline behavior

The local cache defaults to:

```text
~/.pi/model-doctor/models-cache.json
~/.pi/model-doctor/providers-cache.json
~/.pi/model-doctor/policies-cache.json
```

Override the location with `PI_MODEL_DOCTOR_DIR`; override the configuration target with `PI_MODEL_DOCTOR_MODELS_PATH`; override the models.dev endpoint with `PI_MODEL_DOCTOR_MODELS_DEV_URL`. Refresh is local-first and failure-safe: a failed network refresh keeps a valid prior cache and reports that it is stale.

## Provider capabilities

The cache and reasoning engines are metadata-driven rather than a finite model table. They normalize prompt/context/KV-cache signals and reasoning toggle/effort/budget options for OpenAI-compatible, OpenAI Responses, Anthropic Messages, Google, and unknown-provider fallback adapters. New models.dev providers can therefore be discovered without changing the extension.

## Development

From the repository root:

```bash
npm install --prefix .pi/extensions/model-doctor
npm run typecheck --prefix .pi/extensions/model-doctor
npm test --prefix .pi/extensions/model-doctor
```

The domain modules are intentionally dependency-light and can be tested with temporary directories and mocked `fetch` implementations.
