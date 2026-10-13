# Final verification: endpoint-first sync

## Checks

- `npm run typecheck`: passed.
- `npm test`: 107 tests passed; 0 failed, cancelled, skipped or todo; runner reports 0 suites.
- `git diff --check`: passed.
- No commit or Mainline seal performed by reviewer.

## PRD evidence

| Requirement | Implementation and verification evidence |
| --- | --- |
| Sync-specific channel-first discovery; unchanged add/migration discovery | `ModelDoctor.discoverSync` feeds command UI and `proposeSync`; `listCandidates` retains catalog semantics. Existing add/migration tests pass. |
| Correct OpenAI-compatible endpoint | `modelsEndpoint`: root `/v1/models`, explicit path append, no duplicated `/v1`, trailing slash normalization, query preservation and fragment removal tested. Native HTTP test observes `/v1/models`. |
| Unsupported protocols explicitly degrade | Discovery supports only openai-completions/openai-responses. Anthropic configured missing-API and URL catalog inference tests verify unsupported warning and no discovery request. |
| Credentials/headers safe references | Tests verify environment API-key refs, header templates, CLI literal opt-in, unresolved refs and command/auth-store rejection. No credential commands are executed. |
| Auth isolation and redirect rejection | Manual redirects tested with mocks and two real local Node HTTP servers. Native fetch sends synthetic auth only to configured server; redirect destination receives zero requests. |
| URL/private-host safety | URL guards reject credential queries and non-loopback private addresses; intentional HTTP/HTTPS loopback accepted. Native HTTP test exercises default fetch. DNS preflight limitation below. |
| Timeout/body/count/external JSON bounds | Shared 5s timeout, 1 MiB streamed body bound, 10,000-model bound; tests cover stalled stream, oversize body/count, malformed IDs/JSON shapes and unsafe prototype identifiers. |
| Exact channel IDs and unknown IDs | Exact-case duplicates removed while case variants remain; live unknown IDs survive catalog outage and dry-run/apply. Advertised unknown IDs use conservative metadata. |
| Metadata best effort, separate transport | Live sync bypasses catalog admission, tolerates metadata ambiguity/outage including invalid-catalog catch path, and treats official-provider metadata as metadata-only. Regression verifies explicit API, base URL and API-key reference preservation. |
| Safe warnings and labelled fallback | 401/403/404, redirects, timeout, malformed/body errors, unsupported protocol and network failure tested. Native 403 response body and synthetic key never appear in warnings. Source/warnings surfaced before UI selection. Fallback is models.dev, then local/explicit, explicitly unverified. |
| Successful empty list and explicit absent IDs | Empty result remains channel source without fallback; explicit absent exact ID is rejected. |
| No documentation crawling | No documentation/page fetching implemented or automatically invoked; discovery credentials used only for configured channel endpoint. Webpage scraping is not supported or claimed. |
| Read-only discovery/dry-run | Discovery has no write path; dry-run fixture asserts unchanged config and no backup/cache directory. |
| One atomic apply, backup, preservation/no deletion | Proposal combines selected models; existing regression and native persisted flow verify old model retained, new live model added and backup present. Existing writer tests cover atomic/temp handling. |
| Exact identity across sync/UI | Exact dedup and matching; live case variants tests pass. Existing paged/searchable picker retained; UI live-selection regression passes. |
| Headless ordering and cancellation | Missing --models rejected before discovery; regression asserts no additional network. Authorization precedes discovery; existing headless --yes and cancellation tests remain green. |
| Reused result integrity | Same-instance WeakMap binds discovery object to target/config/transport overrides and payload. Fabricated/cross-target results rejected; changed payload/config invalidates binding by comparison. |
| README/help/spec | README/help describe channel-first discovery and unverified fallback; backend contract records endpoints, supported APIs, result binding, metadata-only behavior and DNS limitation. |

## Accepted boundaries and limitations

- Unsupported APIs do not assume a models endpoint. They explicitly fall back to catalog/local/explicit sources; fallback is not proof of channel support.
- Commands (`!command`) and implicit auth-store (`pi-auth:`) resolution are deliberately unavailable to discovery; unresolved credentials degrade safely instead of executing or guessing.
- DNS validation is preflight, not address-pinned transport. Native fetch may resolve again, leaving lookup/connect TOCTOU; this implementation is **not rebinding-proof**. Injected fetch implementations bypass native DNS preflight for controlled testing.
- Native integration uses local loopback servers, synthetic credentials and temporary files. It is not a live-provider or public-DNS integration test.
- No default webpage/documentation scraping is supported.
- Exhaustive DNS-rebinding, every possible header encoding, and live provider compatibility are outside this verification. Existing picker tests plus new live-selection tests are not exhaustive terminal rendering coverage.
