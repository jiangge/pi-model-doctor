# Sync endpoint-first model discovery

## Goal
Make sync discover the configured channel's actual advertised model IDs before using models.dev metadata. Main agent designs/reviews; same-model Pi agents develop/test through Herdr.

## Requirements
- Interactive sync candidate listing and headless sync use channel model discovery first. Preserve add/migration listing semantics (introduce sync-specific API if necessary).
- For supported OpenAI-compatible protocols request the configured base URL's models endpoint without duplicating /v1 or destroying explicit paths. Unsupported protocols explicitly degrade, not fabricated endpoint assumptions.
- Use configured provider credentials/headers with supported safe reference resolution; never execute credential commands implicitly, leak secrets, or forward credentials to redirects/different origins. Bound timeout/body/model count, validate external unknown JSON and URLs including private-host safety with intentional local loopback support.
- Channel IDs are authoritative and exact case-sensitive strings, including catalog-unknown models. Metadata enrichment is best effort and must not globally block successfully discovered channel IDs when models.dev is unavailable. Metadata stays separate from channel transport.
- API failures (401/403, missing discovery endpoint, timeout/malformed responses) emit safe specific warnings and clearly labelled fallback source. Fallback models.dev then local models/explicit --models; never claim fallback is live channel support. An explicit model absent from a successful channel list must not be presented as verified supported.
- No default related-page crawling. Documents are not automatically fetched and credentials are never sent to documentation.
- Dry-run no config/backups/cache writes; discovery is read-only. Normal sync retains selected-only one atomic write/backup, no removal of existing models.
- Exact-case deduplication/matching across sync. UI uses existing paged searchable picker. Source/warnings surfaced even when listing is empty or catalog unavailable.
- Tests cover endpoint construction, auth isolation/redirection, safe secret reference behavior, timeout/body validation, actual channel list priority, unknown metadata IDs, catalog outage, explicit/headless and UI paths, fallback, case variants, dry-run, preservation and no deletion.
- Update README/help/spec contract for observable behavior. npm run typecheck, npm test, git diff --check green.

## Design
Add a bounded channel discovery boundary independent of models.dev. Expose sync discovery result with candidates, source and warnings, shared by UI and proposeSync. Channel list determines available IDs; use metadata only to enrich selected IDs and preserve user-owned transport. Avoid repeat discovery per selected model. Reuse existing URL/credential guards where appropriate without weakening models.dev policy.
