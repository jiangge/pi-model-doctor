# Independent cache-capability review

## Scope

Reviewed task PRD, full working diff, backend contract and quality guidelines, and resolver → compat/proposal/UI → merge/fix → normalized/provider cache boundaries. All persistence exercised only temporary test directories; no real configuration or credentials were touched. No commit or Mainline lifecycle performed.

## Findings fixed

1. `cacheEvidence` treated any non-empty matched child string, including `"false"`/`"unsupported"`, as support. It now accepts explicit positive/negative labels, leaves arbitrary labels unknown, and gives explicit denial precedence over descriptive string hints, including arrays and nested `supported: false`. Model evidence still overrides provider evidence.
2. Provider summaries changed semantics without a version change. Provider cache schema is now **2**; schema 1 is rejected and regenerated. Full normalized catalog, wrapper and policy schema versions remain unchanged. Empty-model provider summaries resolve provider evidence instead of automatically reporting false.
3. Sync's old no-snapshot ownership fallback could replace compat despite no proof it was generated. Sync and catalog-backed fix now preserve existing compat without an ownership snapshot. Unknown-model fix already requires an exact snapshot and the legacy generated fingerprint. Shared snapshot predicate prevents drift between sync and fix.
4. Chinese documentation was stale. English/Chinese README and backend contract now describe unknown, capability/control separation, zero pricing provenance, safe ownership migration and provider-cache versioning.

## Regression evidence

- Missing/false/true resolve to null/unsupported/support; support without adapter control stays advisory and does not emit a false runtime flag.
- Explicit zero catalog cache prices remain pricing evidence; fallback costs do not, and fallback confidence is low.
- String denials, arbitrary string labels, nested false plus unrelated positive string hints, and array denials are covered by a dedicated test.
- Windhub-like unknown-ID sync produces unknown capabilities and no negative flags; dry-run leaves only original models.json.
- Exact managed legacy fallback snapshot is corrected by sync and fix; ownership snapshots are refreshed.
- Snapshot-free and unmanaged legacy compat are preserved by both sync and fix; edited compat with manual false and true remains untouched.
- Provider schema 1 rejection and schema 2 acceptance/read-back are covered; existing provider-cache security tests still pass.

## Gates

- `npm run typecheck`: PASS, exit 0.
- `npm test`: PASS, **112 tests, 112 pass, 0 fail, 0 skipped, 0 cancelled**.
- `git diff --check`: PASS.

Main session owns final design review and local commit. Conservative conflict rule: contradictory evidence within the same model/provider resolves to denial; descriptive strings cannot cancel explicit denial. Cross-model provider summaries retain any-supported semantics, with unknown dominating all-denied when at least one model lacks evidence.
