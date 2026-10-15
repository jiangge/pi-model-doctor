# Official provider attribution for third-party sync

## Findings

- Initial analysis (before the approved implementation): sync's `proposeSync` channel path only selected an automatic metadata source for a unique exact ID; duplicate IDs omitted metadata and fell back to 128,000 context.
- The initial global resolver used native-looking `@ai-sdk/<provider>` evidence as an authorship hint. That assumption is deliberately removed: SDK package names describe adapters, not publishers.
- At initial research time, `https://models.dev/api.json` had no `windhub` provider and listed exact `glm-5.3` IDs under 33 providers. `zai/glm-5.3` had `limit.context = 1,000,000`, but used generic `@ai-sdk/openai-compatible` and lacked a model `provider` origin field. Therefore official attribution required independent publisher evidence.

## Approaches

1. **Strict catalog evidence**: automatically use only a unique source explicitly attributable through catalog/native-provider metadata; otherwise notify that the official source is unknown and require `--metadata-provider` or retain a clearly labeled conservative fallback. Safest, but does not automatically resolve the observed GLM-5.3 case.
2. **Curated official-source mapping**: maintain a narrow, reviewed model-family/provider mapping (for example, GLM-5.3 → `zai`) and prefer it when target channel is absent; notify users of the selected provider and retain explicit `--metadata-provider` precedence. Solves known cases, but requires ongoing review as models/providers change.
3. **Heuristics**: infer official provider from model names/IDs or provider display names. Broad coverage, but can silently select a reseller or incompatible provider-specific limit; not recommended without strong evidence.

## Approved implementation and official evidence (verified 2026-10-15)

The approved compromise is a small exact-ID publisher attribution registry. It selects a metadata provider but contains no model limits or other parameter values; all context/output/model metadata remains dynamic models.dev data. SDK package metadata is not publisher evidence. No prefix, case-folded alias, or variant/suffix matching is used for registry attribution.

- Z.AI's official [GLM-5.3 model documentation](https://docs.z.ai/guides/llm/glm-5.3) explicitly calls GLM-5.3 Z.ai's flagship model.
- Z.AI's official [API reference](https://docs.z.ai/api-reference/introduction) documents the standard base endpoint `https://api.z.ai/api/paas/v4` and includes a request example with model `glm-5.3`. It distinguishes Coding Plan dedicated endpoints, so no endpoint is copied to a third-party channel.
- The reviewed exact attribution is `glm-5.3` → models.dev provider `zai`. The live catalog supplies the actual limits (observed during task research: context 1,000,000; catalog entry values can change). Official docs establish publisher identity, not the actual ceiling of a Windhub or other channel.
- Additional families require comparable direct official evidence before they are added.

Resolution order: explicit `--metadata-provider` > direct target catalog metadata > exact reviewed publisher attribution > unique catalog-only match (never label as official) > conservative defaults with an explicit warning. Invalid explicit providers fail instead of degrading. Per-model provenance persists source provider/model, reason, evidence URLs, and verification date. Third-party transport and user-owned pricing/cache behavior remain authoritative.

## Historical alternatives considered

The earlier strict-catalog-only approach did not resolve the observed GLM-5.3 case because the catalog identifies Z.AI's adapter generically and duplicates the model across providers. Curated exact publisher attribution resolves only reviewed cases without broad alias heuristics. Model-name/provider-name heuristics remain rejected.
