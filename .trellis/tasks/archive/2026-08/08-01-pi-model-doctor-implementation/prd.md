# Pi Model Doctor Auto Configurator

## Goal

Implement the Pi Model Doctor extension described in `Pi_Model_Doctor_Implementation_Plan_v3.docx`. It is a model lifecycle management layer for Pi: discover provider models, enrich them from models.dev, produce safe `models.json` updates, inspect/fix existing entries, and maintain a local models.dev cache without overwriting user-owned configuration.

## Requirements

1. Ship a project-local Pi extension at `.pi/extensions/model-doctor/` with a default extension factory and a package manifest so it can be loaded by the current `.pi/settings.json`.
2. Register one unified `/model-doctor` command with subcommands:
   - `add <provider-or-url> [model] [--api-key <value>] [--dry-run]`
   - `list [provider]`
   - `check [provider/model]`
   - `fix [provider/model] [--dry-run]`
   - `remove <provider/model>`
   - `refresh [--force]`
   The command must provide useful validation and work in non-interactive modes without blocking on a UI prompt.
3. Manage the default Pi `models.json` (`getModelsPath()` / `~/.pi/agent/models.json`) using read → backup → merge/update → atomic write. Preserve provider/model fields not owned by Doctor and never replace explicit user fields such as headers, endpoint overrides, or special compatibility settings. Backups must be timestamped and written beside the target file before a mutation.
4. Add internal `_piModelDoctor` metadata (`managed`, `source`, `lastCheck`, `autoRepair`, optional `providerId`, `modelId`) to managed providers/models. Metadata is namespaced and must not be sent as a Pi model field if Pi rejects unknown fields; the writer must preserve it in JSON while runtime-facing adapters strip it when needed.
5. Implement a local cache under `~/.pi/model-doctor/` with `models-cache.json`, `providers-cache.json`, and `policies-cache.json`. Reads are local-first, cache writes are atomic, refresh supports manual/forced sync, and stale or unavailable network data does not destroy a usable cache.
6. Integrate models.dev through a configurable fetcher with the default public endpoint, timeout, conditional cache metadata where available, schema-tolerant parsing, provider/model matching, and clear offline errors. Do not require network access for list/check/fix of already configured entries.
7. Implement provider adapters and capability engines:
   - `CacheCapabilityResolver` handles all models.dev metadata, not a fixed provider list, and maps prompt/context/KV cache signals to Pi-compatible compatibility fields when the provider/API supports them.
   - `ThinkingReasoningResolver` handles all models.dev metadata, producing a normalized `{supported, controlType, levels, defaultLevel, maxTokens}` result and converting it into Pi `reasoning`/`thinkingLevelMap` plus provider compatibility fields. Unknown models use a documented fallback policy.
   - Adapter selection is based on API/provider metadata with an extensible generic OpenAI, Anthropic, Google, and unknown-provider fallback.
8. Implement safe discovery for `add`: accept a URL/provider identifier, infer provider and API endpoint/protocol, use the supplied key as an env reference or literal without logging secrets, match an optional model id/name, and generate a complete Pi provider/model proposal with sensible defaults if models.dev is unavailable.
9. Implement `list`, `check`, and `fix` over the actual models.json. Checks must cover endpoint, API protocol, model id, deprecated status, context window, max tokens, cache, reasoning, headers, and metadata version. `fix --dry-run` returns a deterministic change plan and does not write. `fix` only repairs Doctor-managed/repairable fields and reports conflicts rather than overwriting user-owned values.
10. Implement `remove` with an explicit target, preserving unrelated providers/models and deleting empty managed providers only when safe. Removal must be mutation-backed by the same backup/atomic-write path.
11. Add automated tests for parsing/matching, capability resolution, merge ownership rules, backups/atomic writes, dry-run behavior, cache fallback, command argument parsing, and end-to-end add/check/fix/remove flows using temporary directories and mocked fetches.
12. Add user documentation (`README.md`) covering installation/loading, command usage, ownership rules, cache paths, dry-run/backup behavior, supported provider adapters, and offline behavior.

## Acceptance Criteria

- [x] `npm test` (or the repository's equivalent test command) passes for the new package.
- [x] TypeScript type-check passes with strict settings and no `any` escape hatches in production code except at external JSON boundaries.
- [x] `/model-doctor` command dispatches every planned subcommand and gives actionable errors for malformed targets/unknown subcommands.
- [x] A pre-existing `models.json` with custom headers, endpoint overrides, unknown fields, and unrelated providers survives add/fix/remove unchanged except for intended managed fields.
- [x] Every write creates a backup first, writes atomically, and leaves the original file intact on serialization or write failure.
- [x] `fix --dry-run` makes no filesystem mutation; a real fix updates only allowed fields and records Doctor metadata.
- [x] Cache refresh is local-first and failure-safe; list/check/fix continue to work when models.dev is unreachable and a cache or local config exists.
- [x] Universal cache and reasoning resolvers are metadata-driven and have generic fallback behavior for unknown providers/models.
- [x] Documentation and code-spec contracts are updated.

## Definition of Done

- Implementation, tests, type-check, and focused runtime smoke checks are green.
- All commands are wired into `.pi/settings.json` for this project.
- No secrets are printed or persisted in logs/tests.
- A Mainline intent is appended for meaningful implementation milestones, then local changes are committed and sealed at the handoff boundary.

## Technical Approach

Use a dependency-light TypeScript package under `.pi/extensions/model-doctor/` with pure domain modules and a thin Pi command adapter:

- `types.ts`: normalized models.dev, Pi JSON, Doctor metadata, findings, change plans, and command results.
- `json.ts`: tolerant JSON read/write, deep merge helpers, ownership classification, backup + atomic write.
- `cache.ts`: local cache store and stale/fresh metadata.
- `models-dev.ts`: HTTP fetch, schema normalization, provider/model matching.
- `capabilities.ts`: universal cache and thinking/reasoning resolvers plus provider adapter mapping.
- `doctor.ts`: add/list/check/fix/remove domain services.
- `command.ts`: slash command parsing, prompts/notifications, and formatting.
- `index.ts`: default Pi extension factory.

The implementation uses Pi's public `getModelsPath()` and `CONFIG_DIR_NAME` APIs; it does not reach into Pi internals. Pi's models.json schema is treated as a compatibility target, while `_piModelDoctor` remains an extension-owned namespace. The default models.dev endpoint is configurable by `PI_MODEL_DOCTOR_MODELS_DEV_URL`, and cache location by `PI_MODEL_DOCTOR_DIR`.

## Decision (ADR-lite)

**Context**: The repository is a new Pi extension and has no existing application code or test runner. The plan requires lifecycle management, safe config persistence, and universal metadata handling rather than a one-off generator.

**Decision**: Build a self-contained TypeScript extension with pure functions around a filesystem/network adapter. Use Pi's single unified slash command and register it in project settings. Use a tolerant normalized models.dev adapter and generic fallbacks instead of hard-coding a finite model/provider table.

**Consequences**: The package is testable without Pi UI or network access and can preserve unknown JSON fields. A future release can add official Pi config API integration or provider-specific adapters without changing command semantics. The first version intentionally does not infer or validate live provider credentials by making model API calls.

## Out of Scope

- Sending test inference requests to provider APIs.
- Managing `auth.json`, OAuth login flows, or rotating credentials.
- Replacing Pi's built-in model registry or modifying Pi source code.
- Automatically changing user-owned headers, endpoint overrides, temperature, or arbitrary compatibility settings.
- Supporting undocumented provider-specific fields as first-class owned fields; they remain preserved JSON.

## Technical Notes

- Source plan: `Pi_Model_Doctor_Implementation_Plan_v3.docx`.
- Pi runtime inspected: `@earendil-works/pi-coding-agent@0.82.1`.
- Public Pi APIs used: `getModelsPath`, `CONFIG_DIR_NAME`, `ExtensionAPI`, `ExtensionCommandContext`.
- Relevant references: Pi docs `docs/extensions.md`, `docs/models.md`, `docs/providers.md`, `docs/packages.md`, and `.trellis/spec/backend/*` / `.trellis/spec/frontend/*`.
