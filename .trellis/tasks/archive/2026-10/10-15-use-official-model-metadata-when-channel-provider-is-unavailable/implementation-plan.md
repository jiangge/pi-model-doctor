# Approved implementation plan

User approved implementation via Herdr same-model agent, with lead responsible for design and code review. Do not commit/push or alter unrelated Mainline intent lifecycle.

## Architecture and acceptance

1. Introduce a reviewed publisher/official-provider registry (not hardcoded numeric limits). Include source URLs and verification date. Verify GLM -> zai standard API; optionally other families only with evidence. Rules must be constrained and full-model matches: never strip fine-tune, variant, date, thinking or quantization suffixes to manufacture an official match. Unknown names remain unknown. SDK package alone is not authorship proof; remove that assumption from shared official selection.
2. Resolver order: explicit metadata-provider > direct target catalog metadata where available > evidenced publisher origin/registry official provider with exact model > existing unique metadata-only match (do not label reseller official) > explicit unknown/conservative warning. Channel live IDs remain case sensitive; source model identity must not overwrite channel identity. No network search at runtime.
3. Share resolution across add/sync/check/fix where applicable. Persist selected source provider/model, reason/evidence in Doctor namespace with backward-compatible optional fields. Repeated sync/check/fix must retain the same source semantics. User edits remain authoritative.
4. For absent target channel, adopt official context/output defaults and model facts, not official endpoint/API/headers/auth or reseller pricing/cache execution claims. Clearly distinguish official reference limits from verified channel limits. Never overwrite manual pricing with official pricing. Unknown official source must produce explicit uncertainty and describe numeric conservative defaults if still needed for Pi, never claim official accuracy.
5. Notifications on dry-run/write/no-op show per-model metadata source, fallback reason and existing persistence status. Mixed-family sync resolves each model independently. Explicit source wins and invalid explicit source must not silently fall back.
6. Regression tests: Windhub glm-5.3 -> 1M, transport preservation, explicit override, unknown official source, registry provider/model absent, fake native SDK reseller, multiple official regions/plans deterministic standard choice, misleading custom model IDs, variants/case collisions, mixed-model sync, ownership, source persistence/check/fix consistency, idempotence and dry-run no config/backup/cache writes. Update English/Chinese docs and backend executable contract.
7. Run focused tests then full npm test and npm run typecheck. Keep implementation proportionate; do not build web scraping, broad alias guessing, or new UI/settings systems.

## Scope decisions

Unknown source may keep existing conservative fallback for availability, but must explicitly warn which limits are defaults. No automatic max-over-providers. Official pricing is not channel pricing. Existing explicit metadata-provider behavior must stay supported with accurate labels. Lead reviews source-selection correctness, ownership and attribution tests before completion.
