# Quality Guidelines

## Required Patterns

- Keep domain logic independent from Pi UI so it can run against temporary directories and mocked `fetch`.
- Use strict TypeScript (`tsconfig.json`) and treat external JSON as `unknown` until normalized with guards.
- Use `readModelsJson` → proposal/plan → `writeModelsJson`; never mutate the target file in a command parser.
- Preserve unknown JSON fields and user-owned values. Track managed fields and snapshots in `_piModelDoctor` so later explicit edits become conflicts.
- Add a behavior test for every new command/persistence rule and rerun both typecheck and tests after fixes.

## Forbidden Patterns

- `any` in production modules to bypass type safety.
- Direct writes to `models.json` without a timestamped backup and atomic rename.
- Network calls as the only source of truth for local `list`, `check`, or `fix`.
- Hard-coded finite model/provider rules in place of metadata-driven resolvers.
- Logging or displaying credentials.
- Overwriting `headers`, endpoint overrides, temperature, or arbitrary compatibility fields just because models.dev differs.

## Test Commands

```bash
npm run typecheck
npm test
```

Tests use Node's built-in test runner with `tsx`, temporary directories, and mocked `fetch`. Assertions target public domain behavior: command parsing, resolver output, ownership decisions, cache fallback, backups, dry-run behavior, package loading, and end-to-end mutations.

## Review Checklist

- [ ] Required command paths and malformed-target errors are covered.
- [ ] Dry-run has no `models.json`, backup, or cache mutation.
- [ ] Existing custom headers, endpoint overrides, unknown fields, and unrelated providers survive.
- [ ] Metadata is versioned, namespaced, and has managed-field snapshots.
- [ ] Network failures retain valid cache and report staleness.
- [ ] Typecheck, tests, and `git diff --check` pass.
