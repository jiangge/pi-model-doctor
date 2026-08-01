# Directory Structure

## Scope

This repository is a Pi extension project. The production Model Doctor code lives in `.pi/extensions/model-doctor/` so Pi can discover it from project settings without coupling the extension to Pi internals.

## Layout

```text
.pi/
├── settings.json                         # project resource registration
└── extensions/model-doctor/
    ├── index.ts                          # Pi ExtensionAPI entry point
    ├── package.json                      # local test/package metadata
    ├── tsconfig.json                     # strict TypeScript settings
    ├── src/
    │   ├── types.ts                      # JSON, models.dev, capability contracts
    │   ├── json.ts                       # config parsing, ownership, atomic writes
    │   ├── cache.ts                      # local cache persistence
    │   ├── models-dev.ts                 # remote catalog client and matching
    │   ├── capabilities.ts               # cache/reasoning engines and adapters
    │   ├── doctor.ts                     # add/list/check/fix/remove domain service
    │   └── command.ts                    # unified /model-doctor command adapter
    └── test/model-doctor.test.ts         # public behavior tests
```

Pure domain code belongs in `src/`; Pi UI/command registration belongs in `command.ts` and `index.ts`. Do not read Pi's private `dist/core` modules when a public ExtensionAPI or config API exists.

## Naming

Use kebab-free lowercase filenames, PascalCase classes, and verb-oriented exported functions (`readModelsJson`, `resolveReasoning`, `proposeFix`). Types describe serialized contracts (`PiModel`, `ModelsDevProvider`, `ChangePlan`).

## Examples

- `.pi/extensions/model-doctor/src/json.ts` is the persistence boundary.
- `.pi/extensions/model-doctor/src/doctor.ts` is the orchestration/service boundary.
- `.pi/extensions/model-doctor/src/command.ts` is the thin Pi command/UI boundary.
