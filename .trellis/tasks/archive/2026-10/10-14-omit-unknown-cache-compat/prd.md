# Unknown cache diagnostics omitted from runtime compat

User accepted design: internal unknown is correct, runtime models.json should omit unknown cache items. Same-model Herdr implementation/testing; main reviews.

## Requirements
- Keep normalized caches/proposals/reports internal tri-state unknown and source confidence.
- Runtime compat no null/unknown cache diagnostic values; wholly unevidenced fallback omits cacheCapabilities/cacheResolution and guessed negative runtime controls/retention/affinity. Partial evidence omit unknown subitems and unknown derived negatives, preserving evidenced support/denial/real pricing.
- Actual Pi protocol controls written only with evidence and adapter support; preserve user/other extension controls.
- Do not let omission corrupt internal proposal cache capabilities (derive from normalizedCache not emitted compat) or provider cache summaries.
- Safely cleanup prior model-doctor legacy false fallback and newly introduced null/unknown metadata in sync/fix only exact managed ownership snapshot, no blanket cache deletion. Preserve edited compat, snapshot-free, unmanaged, other fields/extension fields; no direct live windhub config modifications.
- Fix/check diagnostics account new omission rather than perpetual mismatch; snapshots accurately reflect cleaned config, repeat sync/fix idempotent.
- Test fallback omission, partial true/false omission, real zero prices, internal unknown retained, managed legacy/current cleanup sync/fix, manual true/false+extension controls and unowned preserved, dry-run no writes, no unrelated capability regressions.
- Verify pi-cache-optimizer compatibility with synthetic config through its actual local exported validation/advice/fix planning paths where practical; do not assert live-provider/cache optimization success. No dependency on optimizer at runtime and no modifications to its repo.
- Update README English/Chinese/backend specs, verification evidence. npm run typecheck/npm test/git diff --check all pass.
- Local commit only, no push/npm release.
