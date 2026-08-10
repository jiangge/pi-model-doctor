# Pi Model Doctor

> **English** | [简体中文](docs/README.zh-CN.md)

Pi Model Doctor is a Pi extension that manages the model lifecycle in `models.json`. A normal `pi install npm:pi-model-doctor` installs it to the current user's global Pi settings; use `-l` only when you explicitly want a project-local installation. It discovers provider metadata from [models.dev](https://models.dev), fills in model capabilities, checks existing entries, and applies safe repairs without replacing user-owned settings.

## Table of contents

- [Install, update, and uninstall](#install-update-and-uninstall)
- [Global installation and project-local override](#global-installation-and-project-local-override)
- [Commands](#commands)
- [Safe writes and ownership](#safe-writes-and-ownership)
- [Cache and offline behavior](#cache-and-offline-behavior)
- [Provider capabilities](#provider-capabilities)
- [Development](#development)

## Install, update, and uninstall

Install from npm into the current user's global Pi installation (the default and recommended mode):

```bash
pi install npm:pi-model-doctor
```

This writes the package source to the user's Pi package directory and adds it to `~/.pi/agent/settings.json`, so it is available in other projects for the same user. Install into the current project's `.pi/settings.json` only when you explicitly need a project-local pin:


```bash
pi install npm:pi-model-doctor -l
```

Update the installed package later with:

```bash
pi update npm:pi-model-doctor
```

Remove it from the same scope in which it was installed:

```bash
# Global/user installation
pi remove npm:pi-model-doctor
# Equivalent alias
pi uninstall npm:pi-model-doctor

# Project-local installation
pi remove npm:pi-model-doctor -l
```

After installing or removing a package, restart Pi or start a new session so the extension registration is rebuilt. Removing the package does not remove models already written to `models.json`; use `/model-doctor remove <provider/model>` for configuration entries, and keep the timestamped backup if you may need to roll back.

## Global installation and project-local override

The repository's `.pi/settings.json` contains only this project's development tooling. It does not need a `../index.ts` Model Doctor entry when the package is globally installed. Pi's global settings load the npm package through its package-root manifest:

```json
{
  "packages": ["npm:pi-model-doctor"]
}
```

Use `pi install npm:pi-model-doctor -l` only for a project-local override; in that case Pi writes the package reference to `.pi/settings.json` for that project. Do not add both the global package and a local `../index.ts` entry, or the extension may be loaded twice.

## Development checkout

For this repository's development smoke test, the relevant entry in `.pi/settings.json` is:

```json
{
  "extensions": ["../index.ts"]
}
```

Pi resolves relative paths in a project `.pi/settings.json` from the `.pi/` directory. A `../index.ts` entry would therefore point to this repository's root source, but it is not needed for normal global npm installation. For another Pi project, install the published package with `pi install npm:pi-model-doctor`, or add the package directory to that project's Pi settings. Installed npm/Git packages do **not** use `../index.ts`; Pi reads the package-root manifest `pi.extensions: ["./index.ts"]` instead.

### Why the implementation is now at the repository root

`.pi/` is Pi's project-local runtime/configuration namespace, but a package intended for GitHub/npm/pi.dev should have its own package root. The implementation lives at the repository root so `package.json`, `README.md`, `LICENSE`, `src/`, tests, and the Pi manifest are packaged together. The project-local `.pi/settings.json` points to `../index.ts` only for this repository's development smoke test; when installed from npm or Git, Pi resolves `./index.ts` from the package's own `pi.extensions` manifest.

## Commands

```text
/model-doctor add <provider-or-url> [model-or-endpoint-url] [--metadata-provider <models.dev-provider>] [--api <protocol>] [--api-key <reference>] [--allow-literal-api-key] [--dry-run] [--yes]
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

`sync` discovers all models for a provider/channel from models.dev and lets the interactive UI select multiple models for this run. In non-interactive mode, pass `--models model-a,model-b`; there is no implicit catalog-first-model selection. Sync writes one combined proposal with one backup and one atomic write, so the selected models are applied together. `sync --dry-run` never writes models.json, backups, or caches.

`add` accepts a models.dev provider id/name, a provider API URL, or a model id. When a model is omitted in the interactive UI, the extension presents candidates for selection; non-interactive mode requires an explicit model id. A third-party channel may not have a provider record in models.dev: in that case, pass its channel URL and model id, and Model Doctor can use an exact model record from another catalog provider as metadata only. To set up a channel before adding any model, either pass only the channel URL (`add https://gateway.example/v1`, deriving a provider id) or explicitly name it (`add providerA https://gateway.example/v1`). Both forms create an empty provider entry with endpoint and inferred protocol; models can then be attached with `add providerA <model>`, `add https://gateway.example/v1 <model>`, or `sync providerA`. The channel endpoint, API protocol, headers, authentication, and other transport fields remain user-owned and are not replaced. If the model exists under multiple catalog providers, pass `--metadata-provider <models.dev-provider>`; pass `--api <openai-completions|openai-responses|anthropic-messages|google-generative-ai>` when protocol inference is insufficient. Provider website metadata can be reviewed and supplied separately, but is not fetched automatically or treated as a models.dev provider record. API credentials should be references such as `$OPENAI_API_KEY`, `${OPENAI_API_KEY}`, `!command`, or `pi-auth:provider`; literal API keys are not persisted unless `--allow-literal-api-key` is explicitly supplied. Secrets are never printed by the extension. Use `--dry-run` to inspect a proposal without writing. Non-interactive writes require `--yes`; `--dry-run` takes precedence over `--yes`. `migrate` accepts an explicit `--to provider/model`, or presents destination candidates in UI mode; non-interactive mode requires `--to`.

`check` works offline for the local file and uses the local models.dev cache when the network is unavailable; even without a catalog it reports local ownership, metadata, and header findings. The slash-command `refresh` forces a catalog read and reports full configuration findings without applying repairs; it never writes `models.json`, while the normal form may update catalog/policy caches. `refresh --dry-run` is fully read-only and also leaves catalog/policy caches unchanged. `fix` only changes fields owned by Pi Model Doctor. If a user explicitly changed an endpoint, header, compatibility object, or model capability, the change is reported as a conflict and is not overwritten. `remove` requires an exact `provider/model` target. `migrate` creates a destination model from current metadata, preserves safe user fields, reports endpoint/API/header conflicts without copying secrets, keeps the source by default, and requires `--remove-source` for explicit source removal; deprecated destinations are advisory and cannot be auto-applied. A no-op migration reports no changes and does not create a backup. Every mutation verifies that `models.json` did not change after proposal creation, then uses a backup, atomic write, persisted read-back verification, and automatic restoration if persistence verification fails. When the active Pi runtime uses the default agent models path, the command refreshes and verifies the model registry, reporting `persisted-and-active`, `activation-failed`, or `persisted-reload-required`; dry-run and cancellation report `not-persisted`. Backup cleanup is explicit only: `/model-doctor cleanup-backups --keep <count>` or `--max-age-ms <milliseconds>` previews/removes old timestamped backups after authorization; it never runs automatically.

## Safe writes and ownership

The default file is `join(getAgentDir(), "models.json")` (normally `~/.pi/agent/models.json`). Mutating commands:

1. Read the existing file.
2. Create a timestamped `models.json.bak-<timestamp>` backup when the file exists.
3. Merge only the requested provider/model.
4. Write through a temporary file and atomic rename.

Managed entries carry `_piModelDoctor` metadata with the source, last check, repair policy, managed fields, and the last managed values. Unknown JSON fields and user-owned headers/endpoint overrides remain intact.

Migration keeps the source model unless `--remove-source` is supplied. It does not copy API keys, OAuth, authorization/secret headers, endpoint overrides, or user-owned capability overrides; destination values win on conflicts. To roll back a persisted mutation, use `/model-doctor rollback <models.json.bak-<timestamp>> [--dry-run] [--yes]`. The command validates the backup as a regular, parseable models file, creates a separate safety backup of the current file, atomically restores the validated backup, and refreshes/verifies the active model registry when supported. If activation cannot be verified, reload Pi and run `/model-doctor check`; backups contain the original credentials and must be protected like `models.json`.

## Cache and offline behavior

The local cache defaults to:

```text
~/.pi/model-doctor/models-cache.json
~/.pi/model-doctor/providers-cache.json
~/.pi/model-doctor/policies-cache.json
```

`policies-cache.json` contains a versioned capability policy catalog used by the reasoning/cache resolvers. Its baseline records the Pi runtime version (`0.82.1`), models.dev schema label (`api.json`), normalized schema version (`1`), observation date, PolicyCatalog schema version, and `_piModelDoctor` metadata version. Invalid, incompatible, sensitive, or insecurely-permissioned cache data is ignored and regenerated. `models-cache.json` stores the normalized complete catalog, while `providers-cache.json` stores provider summaries, environment-variable names, selected adapters, reasoning controls, and independent prompt/context/KV capability signals. Cache writes reject sensitive fields; the cache directory is mode `0700` and cache files are mode `0600`. Capability results include resolved, partial, advisory, or unsupported status; pricing metadata is not treated as permission to enable runtime caching. Each result retains source and confidence so provider facts are not mistaken for verified Pi runtime behavior.

Override the location with `PI_MODEL_DOCTOR_DIR`; override the configuration target with `PI_MODEL_DOCTOR_MODELS_PATH`; override the models.dev endpoint with `PI_MODEL_DOCTOR_MODELS_DEV_URL`. A custom endpoint must pass the same HTTPS/private-host policy; explicitly trusted private test infrastructure requires `PI_MODEL_DOCTOR_TRUSTED_ENDPOINT=1`. Refresh is local-first and failure-safe: a failed network refresh keeps a valid prior cache and reports that it is stale. A session-scoped background refresh runs every 24 hours by default with bounded random jitter to reduce multi-session refresh bursts; set `PI_MODEL_DOCTOR_REFRESH_INTERVAL_MS=0` to disable it. `PI_MODEL_DOCTOR_REFRESH_JITTER_MS` can override the jitter bound. Background refresh only updates catalog caches and reports warnings; it never edits `models.json`.

## Provider capabilities

The cache and reasoning engines are metadata-driven rather than a finite model table. They normalize prompt/context/KV-cache signals and reasoning toggle/effort/budget/adaptive options for OpenAI-compatible, OpenAI Responses, Anthropic Messages, Google, and unknown-provider fallback adapters. Provider-specific compatibility metadata records fields for reasoning budgets, thinking config, independent cache capabilities, and unsupported runtime behavior. Budget values are kept distinct from output-token limits, and unknown/advisory capabilities are never silently presented as enabled. New models.dev providers can therefore be discovered without changing the extension. For third-party channels, these are model facts and advisory capability data only; they do not prove that the third-party transport implements the same runtime behavior.

## Development

From the repository root:

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The package can be installed into another Pi project with:

```bash
pi install npm:pi-model-doctor
```

Or tested from a local checkout with `pi install /absolute/path/to/pi-model-doctor`.

The domain modules are intentionally dependency-light and can be tested with temporary directories and mocked `fetch` implementations.
