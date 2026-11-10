# Gateway sync improvements

## Goal
Implement the three improvements requested in the fully read external brief, on branch `pi/sync-gateway-improvements` based on v0.4.4 (945434f), without merging, tagging, publishing or pushing.

## Requirements
1. Add `sync --all` for every advertised channel model ID, with one merged proposal, one backup and one atomic write. Preserve dry-run/--yes and existing ownership/conflict semantics. Keep large-list notifications bounded with summaries and counts.
2. Preserve metadata source priority and exact matches. After exact matching fails, strip successive leading ID segments (`a/b/c` → `b/c` → `c`) before conservative defaults. Identify stripped matches and their sources in provenance; retain existing ambiguity handling.
3. Investigate Pi print-mode command execution and output. Add a supported observable noninteractive result channel if doctor is responsible; otherwise document correct headless usage, limits and workable alternatives. Add regression tests for the chosen behavior.

## Acceptance Criteria
- [x] Each issue implemented sequentially with corresponding regression tests.
- [x] Hundreds of advertised models produce bounded notifications and one transactional proposal.
- [x] Nested prefixes, exact-match precedence, ambiguity, defaults and ownership preservation tested.
- [x] Headless success/failure visibility tested and README documents correct invocation and limitations.
- [x] Full test suite and typecheck pass; no lint script currently exists.
- [x] Work log records baseline evidence, decisions, per-issue checks and final results.
- [ ] No real gateway names, domains or credentials in output, fixtures, documentation or commits.

## Scope / decisions
The user's detailed brief is the confirmed scope; no additional feature expansion is needed. Consider empty advertisements, incompatible flags, ambiguous stripped IDs, repeated sync, failures, and output confidentiality. Do not add scheduled sync, overwrite policies, releases or a new standalone CLI unless investigation proves necessary. Prefer existing helpers and host-supported output over ad-hoc stdout that could corrupt JSON/RPC protocols.

## Technical Notes
- Clean original worktree on master 33961c5; fetched origin successfully. master/origin/master remain 0.4.3. v0.4.4 points at 945434f, one commit ahead, also origin/fix/sync-metadata-provider-collision. Created requested branch directly from v0.4.4.
- Package version 0.4.4, Node >=22.19; scripts: npm test, npm run typecheck.
- Use Trellis implementation/check subagents; curate specs and research before activating.

## Open Questions
None blocking: determine supported headless mechanism by inspecting host documentation and implementation, as authorized by the brief.
