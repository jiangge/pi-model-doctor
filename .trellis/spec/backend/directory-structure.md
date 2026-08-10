# Directory Structure

## Scope

This repository is a publishable Pi package. The production Model Doctor code lives at the repository root so npm/Git/package consumers receive one self-contained package. Other users install it globally with `pi install npm:pi-model-doctor`; `.pi/settings.json` is reserved for this repository's local development tooling and does not need to register Model Doctor when the global package is installed.

## Layout

```text
index.ts                                   # Pi ExtensionAPI entry point
package.json                               # publishable Pi package manifest
tsconfig.json                              # strict TypeScript settings
src/
├── types.ts                               # JSON, models.dev, capability contracts
├── json.ts                                # config parsing, ownership, atomic writes
├── cache.ts                               # local cache persistence
├── models-dev.ts                          # remote catalog client and matching
├── capabilities.ts                        # cache/reasoning engines and adapters
├── doctor.ts                              # add/list/check/fix/remove domain service
└── command.ts                             # unified /model-doctor command adapter
test/model-doctor.test.ts                  # public behavior tests
.pi/settings.json                          # local project tooling; Model Doctor is globally installed
```

Pure domain code belongs in `src/`; Pi UI/command registration belongs in `command.ts` and `index.ts`. Do not read Pi's private `dist/core` modules when a public ExtensionAPI or config API exists.

## Naming

Use kebab-free lowercase filenames, PascalCase classes, and verb-oriented exported functions (`readModelsJson`, `resolveReasoning`, `proposeFix`). Types describe serialized contracts (`PiModel`, `ModelsDevProvider`, `ChangePlan`).

## Examples

- `src/json.ts` is the persistence boundary.
- `src/doctor.ts` is the orchestration/service boundary.
- `src/command.ts` is the thin Pi command/UI boundary.
- `package.json` is the publishable package boundary; its `pi.extensions` manifest points to `./index.ts`. A normal `pi install npm:pi-model-doctor` writes the package to the user's global Pi settings; `-l` is an explicit project-local override.
