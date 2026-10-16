# Preserve resolved sync metadata across channel ID collisions

## Goal
Fix sync rejecting a valid exact catalog source when a configured third-party channel ID collides with another catalog provider.

## Requirements
- Honor the metadata provider already resolved by sync, without marking automatic selection as user-explicit provenance.
- Preserve channel transport, authentication, and user-owned pricing.
- Keep explicit metadata selection authoritative and retain conservative/ambiguous behavior.
- No subagents, release, or push.

## Acceptance Criteria
- [x] Regression fails before fix and passes afterward for channel ID `openai` and model `glm-5.3` owned by `zai`.
- [x] Automatic provenance remains official-reference; explicit provenance remains explicit-provider.
- [x] Channel transport and pricing survive.
- [x] Typecheck, full tests, and diff whitespace checks pass.

## Technical Approach
Treat a metadataProvider supplied to chooseMatch as a selection constraint regardless of whether selected by the user or sync. Keep metadataProviderExplicit exclusively for provenance. Reuse existing exact-source resolution and add public proposeSync coverage.

## Out of Scope
Publisher registry expansion, protocol changes, packaging/release, and unrelated catalog schema work.
