# Independent verification

Reviewed runtime projection, service migration/ownership paths, internal discovery resolution and current regression diff against the active task contract.

## Additional fixes

- Replaced broad prefix-based extension-key exclusion in compat preservation with a generated-field allowlist. Extension keys beginning with `cache` or `supports` are no longer discarded merely because of their names.
- Intermediate null/unknown cleanup now reconstructs evidenced `control` values from existing diagnostics before projection. Previously an evidenced control was lost because reconstruction used fallback false controls.

## Gates

- npm run typecheck: PASS (exit 0).
- npm test: PASS, 112 tests / 112 passed / 0 failed / 0 skipped / 0 cancelled.
- git diff --check: PASS.

Existing tests exercise wholly unevidenced omission, internal tri-state unknown, partial true/false projection, real zero pricing, omitted guessed retention/affinity, exact-snapshot legacy and intermediate cleanup, snapshot-free/unmanaged/edited preservation and repeat fix no-op. Provider/discovery evidence is retained independently of runtime compat.

## Optimizer integration attempt and limit

Attempted direct imports of actual local pi-cache-optimizer exports `isValidModelsConfigForEffectiveCompat`, `describeMissingCacheCompatForModel`, and `decideFixPlacement` with a synthetic unknown model/config. Execution failed before validation with ERR_PACKAGE_PATH_NOT_EXPORTED: local optimizer dependency @earendil-works/pi-coding-agent has no exported main for the import mode chosen. Follow-up succeeded using the optimizer's installed `jiti` createJiti/import path (its own package test convention), from `node --import tsx --input-type=module`, with absolute source paths. Actual exports `isValidModelsConfigForEffectiveCompat`, `describeMissingCacheCompatForModel`, and `decideFixPlacement` executed for three Doctor-produced synthetic models: wholly unknown, partial prompt=true/kv=false, and real zero cache pricing. All three configurations validated true; advice returned []; placement returned provider for the synthetic single-model provider. This verifies exported synthetic validation/advice/placement execution, not fix transactions, live-provider cache behavior or optimization success. No optimizer repository/config was changed.

No real models.json or credentials were accessed or modified. No commit/lifecycle performed. Follow-up inspected every direct compat assignment in capabilityCompat across effort/budget/toggle/adaptive and Google/Anthropic/fallback branches. Replaced probe-generated allowlist with explicit generated-field names covering those branches; cache protocol controls remain intentionally preserved by the separate protocol-control preservation path. Added concrete sync AND fix regression assertions for `cacheOptimizerCustom`, `supportsPromptCacheKey`, `sendSessionAffinityHeaders`, and `cacheControlFormat` on exact-snapshot intermediate cleanup. Re-ran all gates successfully: typecheck exit 0; 112/112 tests; diff check exit 0. Optimizer repo and user configuration unchanged. Integration limitation is now only that no actual optimizer fix transaction or live service behavior was exercised.
