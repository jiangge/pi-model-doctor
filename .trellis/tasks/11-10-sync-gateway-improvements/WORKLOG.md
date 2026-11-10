# Gateway sync improvements work log

## Issue 1 — sync --all

### Baseline / scope
- Active task resolved via `python3 ./.trellis/scripts/task.py current --source`.
- Read PRD, curated backend specs, shared reuse guide and `research/sync-design.md`.
- Initial tracked tree was clean on `pi/sync-gateway-improvements`; task/workspace records were untracked.
- Existing `proposeSync` combines models in memory; `applySync` invokes the shared backup/atomic writer once. No writer/service changes needed.
- This dispatch implements issue 1 only; prefix matching and noninteractive result reporting remain for later sequential dispatches.

### Decisions / changes
- Sync-only boolean `--all` rejects `--models`, bypasses picker, and selects exact deduplicated IDs only after successful live channel discovery. Catalog/local fallback is never silently treated as advertisement.
- Empty successful advertisement reports zero models and not-persisted without proposal/write/backup.
- Existing pre-discovery headless authorization and dry-run precedence remain intact.
- Sync presentation uses sampled, counted sections, bounded individual lines, and bounded caught errors. Full proposal data is untouched. Authorization and final output reuse the same preview; status/backup remain outside sampled sections.
- English and Chinese README document invocation, live-only behavior, empty lists and bounded presentation.
- Added `test/sync-all.test.ts` for flag/auth/no-request behavior, empty/fallback behavior, 303 exact IDs (including case variants), dry-run non-persistence, one proposal/apply/backup, repeat no-op, ownership conflicts and bounded authorization/output.

### Verification
- Initial `npm run typecheck`: infrastructure failure (`spawnSync tsc ENOENT`); repository development dependencies were absent (`node_modules/.bin` missing). Installing locked dependencies with `npm ci --ignore-scripts` before rerunning checks.
- Active LSP probe of changed TypeScript paths: no TypeScript findings; auxiliary repository heuristics report existing warnings/hints and the unchanged `redactSecrets(...): unknown` return rule. No unrelated refactoring performed.
- Main session subsequently verified issue 1: `npm test` 121/121 pass, `npm run typecheck` pass, `git diff --check` exit 0 (dispatch evidence).

## Issue 2 — prefix-stripped sync metadata

### Decisions / changes
- This dispatch implements issue 2 only, preserving issue 1; issue 3 headless reporting remains pending.
- Added ordered exact metadata lookup (`a/b/c`, `b/c`, `c`) with the existing explicit-source/direct-target/publisher/unique-catalog source ordering within each candidate. Full exact matches finish before any suffix lookup. Explicit sources remain scoped and invalid/missing sources fail.
- Ambiguity/case-variant protection is terminal rather than permission to try shorter IDs. Unresolved channel metadata retains sync's existing conservative fallback; pre-existing catalog candidate ties still raise selection errors. No fuzzy/substring matches are admitted as suffix metadata.
- Separated internal metadata source model ID from persisted runtime model ID when sync reuses proposeAdd. Input guards constrain that source identity to the channel ID or its slash-delimited suffix and the selected provider; downstream source changes cannot silently reselect a different model.
- Optional provenance fields `requestedModelId` and `matchKind: prefix-stripped` retain the actual catalog provider/model, underlying reason, publisher evidence and date. Older provenance remains valid; no separate provenance schema validator exists to extend.
- Check/fix honors a recorded, validated metadata-only suffix identity and preserves it during managed updates; intentional channel/source ID differences do not emit spurious model-id-mismatch findings. Model capability generation still uses the actual source model before restoring the channel runtime ID.
- Bounded sync previews display original channel ID → actual source provider/model and prefix-stripped marker. English and Chinese README explain lookup ordering, provenance, ambiguity, explicit scoping and check/fix behavior.
- Added `test/sync-prefix.test.ts`: nested/intermediate/terminal suffixes, full global exact precedence over shorter direct metadata, reviewed publisher evidence, preview mapping, explicit scope and invalid sources, terminal exact/stripped ambiguity and case variants, conservative defaults, provider-ID collisions, degraded discovery, owned/user-edited fields, managed fact updates, repeat sync/fix and no extra backup. Existing suite retains catalog-outage/default and ownership regressions.
- Removed the unused `checkedAt` local from check while touching its metadata path; no behavior change.

### Terminal verification
- Focused initial prefix tests: 5/5 passed; additional managed-update and publisher/preview cases included in final suite.
- Final `npm run typecheck`: exit 0.
- Final `npm test`: 128/128 passed, 0 failed, 0 skipped; includes all issue 1 regressions and seven new prefix tests. Runtime approximately 10.3 seconds.
- `git diff --check`: exit 0.
- Active LSP probe of `src/doctor.ts`, `src/types.ts`, `src/command.ts`, `test/sync-prefix.test.ts`: no TypeScript errors reported; one push-only clean recheck was inconclusive. Auxiliary ast-grep reports two pre-existing no-unknown-returns findings on unchanged redaction helpers. Compiler verification above is definitive for TypeScript.
- All configuration/network fixtures are synthetic and temporary, with mocked catalog/channel responses. No real gateway configuration or credentials read; no commit, merge, tag, publish or push performed.

## Issue 3 — observable headless results

### Investigation / decisions
- Installed host docs and implementation confirm registered extension commands execute in print mode, but default UI notifications are no-ops. Plain print renders assistant text, not custom messages. JSON streams supported custom message events. RPC exposes notifications with hasUI true; dispatch acceptance is not operation success.
- Injected a result sink at command registration using `pi.sendMessage` with customType `model-doctor-result` and explicit `triggerTurn: false`. No stdout printing, standalone CLI, or model invocation was added.
- Per-invocation context captures the final notification once; discovery progress is superseded by the final operation notification/error. Explicit outcome state (not parsed human text) supplies machine success/status for dry-run, no-op, persistence, blocked repairs and activation failure. Validation and operation errors are caught inside the same boundary. Context UI getter support is retained without mutating host context.
- Result details contain only known command, boolean success, status, severity and final=true. Human content is redacted and capped at 12,000 characters. Interactive/RPC notifications remain unchanged and do not duplicate custom messages.
- English/Chinese README document JSON invocation/filter, details contract, print silence, exit-code caveat and RPC alternative.

### Regression / verification
- Added unit tests for registered sink/no-trigger-turn behavior, TUI/RPC notification preservation, validation/authorization/operation failures, dry-run, persisted/reload, no-op, activation failure, bounded redaction and one final result despite discovery progress.
- Added installed-host subprocess coverage using isolated temporary HOME/cwd/agent/config/cache paths, an allowlisted environment without credentials, disabled auto resources/background refresh, and deadlines. Help/invalid commands avoid gateway/catalog work; event assertions reject model/tool runs.
- Initial focused run: two unit tests passed; integration failed before launching host because the host package exposes ESM imports only. Replaced CJS createRequire.resolve with import.meta.resolve. The initial full run likewise passed 130/131 with only that integration setup failure. The next isolated run exposed an open stdin pipe: Pi waits for piped input before command dispatch, while execFile leaves stdin open. The harness now closes stdin immediately and retains its deadline. The subsequent full run proved JSON success/failure events, no model/tool work and plain-print silence; its only failure was an overstrict assertion that Pi would not initialize a temporary auth file. Pi creates an empty auth store in the isolated agent directory, so the assertion now verifies its contents are `{}` rather than forbidding that supported initialization. No actual user auth files are accessed.

### Final terminal verification
- `npm test`: 131/131 passed, zero failures/skips; includes all 128 prior issue regressions and the three new headless tests. Runtime approximately 10.35 seconds.
- `npm run typecheck`: exit 0.
- `git diff --check`: exit 0 (same successful verification chain).
- Active LSP probe for `src/command.ts` and `test/headless.test.ts`: no TypeScript errors; auxiliary ast-grep reports only the unchanged `redactSecrets(...): unknown` return rule.
- Installed-host success/failure JSON custom-message assertions, no-model/tool-run assertions, plain-print silence and isolated empty auth-store checks all passed.
- No recursive agents, commits, merges, pushes, tags or publishing performed. All new fixtures use temporary synthetic configuration; integration environment excludes user credentials and isolates agent/config/cache/session locations.

## Independent check review

### Findings fixed
- Restored exact-source precedence when direct-provider lookup is ambiguous only because of display names. The previous sync implementation continued to global exact-ID lookup in that situation; the new suffix helper prematurely stopped. Only an unambiguous direct exact ID now outranks global exact lookup, while genuine unresolved ambiguity remains terminal. Added a synthetic regression with two direct display-name ties, a shorter direct suffix and a full exact global ID.
- Bounded caught error notifications to 2,000 redacted characters, including bulk apply failures. Successful sync previews were bounded, but errors assembled from many conflicts could still overwhelm TUI/RPC notifications. Added failed-apply coverage asserting bounded/redacted output, unchanged config and no backup.
- Added afterEach temporary fixture cleanup to both sync test files (including failure paths).

### Verification evidence
- First full run: 132/133 passed. The new failure-path test incorrectly forbade the normal authorized proposal from persisting catalog caches before a mocked apply failure; adjusted the assertion to the actual contract (unchanged models.json and no backup). This was a test expectation issue, not a production persistence failure.
- Active LSP checked all six changed TypeScript files: no TypeScript errors reported; three confirmed clean, one push-only clean recheck inconclusive. Two auxiliary ast-grep no-unknown-returns findings remain on unchanged redaction helpers in src/command.ts and src/doctor.ts. These are not compiler diagnostics.
- Final full verification chain completed with exit 0: npm test passed 133/133, zero failures/skips (approximately 10.43 seconds); npm run typecheck passed; git diff --check passed. Installed-host JSON success/failure and plain-print tests passed in the same suite.
- No remaining substantive review findings. No commits, pushes, merges, tags or publishing; main session should update the backend contracts for --all, prefix provenance and headless result reporting before the required commit phase.

## Documentation-only spec review

- Loaded update-spec skill, active PRD and all curated implement context. Reviewed final command/result boundary, bulk presentation, suffix resolver/provenance guard, README mode/status contract and regression tests against backend specs.
- Updated model-doctor-contract in its existing seven-section executable structure: command grammar, live-only --all/empty/fallback behavior, exact-source-before-suffix order and terminal ambiguity, original/source identity and guarded check/fix provenance, bounded presentation, injected final JSON result signature/schema/status, print/exit-code/RPC limitations, validation matrix, good/base/bad examples, regression assertions and wrong/correct bulk/reporting examples.
- Updated error-handling, logging and quality guidance to remove --models-only and notify-only claims and reference the canonical contract rather than duplicate the entire protocol. No source/test/README changes in this dispatch; no host behavior changes requiring additional SDK implementation research.
- Independent checker evidence (recorded above): npm test 133/133 passed with zero failures/skips; npm run typecheck passed; git diff --check passed. This documentation phase relies on that verified implementation run rather than claiming a new suite run.
- PRD marks the first six acceptance items verified from sequential work/check evidence. The confidentiality item remains unchecked pending main-session final staged-diff/commit review; fixtures and examples reviewed here are synthetic and no real gateway data was read or added.
- Runtime .pi/tasks logs remain untracked and must not be staged. No commit, push, merge, tag or publish performed; main session retains final staging/commit responsibility.

## Main-session final verification

- Confirmed branch `pi/sync-gateway-improvements`, still based on v0.4.4 commit `945434f96e26d8dbd592a58c9e499754b0a21464`; master was not moved.
- Independently reran `npm test && npm run typecheck && git diff --check`: completed with exit 0; 133/133 tests passed, zero failures/skips, approximately 10.42 seconds.
- Active LSP checked six changed TypeScript paths: no compiler errors reported; one push-only clean recheck was inconclusive. Two pre-existing auxiliary `no-unknown-returns` findings on unchanged recursive redaction helpers were explicitly deferred, not suppressed or represented as fixed. Full typecheck passed.
- Final privacy-pattern review of 18 changed/task/test files flagged no brief gateway identifier, private keys or credential-shaped literals. User gateway configuration and auth files were never consulted. Runtime shell artifacts and initialized workspace logs are excluded from the proposed commit.
- Presented one coherent work commit plan to the user; awaiting required confirmation before staging/committing. No push, merge, tag or release action was taken.
