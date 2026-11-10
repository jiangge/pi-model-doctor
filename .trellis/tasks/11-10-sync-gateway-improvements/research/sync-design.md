# Gateway sync implementation research

## Scope and evidence

Resolved active task with `python3 ./.trellis/scripts/task.py current --source`: `.trellis/tasks/11-10-sync-gateway-improvements` (session-scoped). Read task PRD; backend contract, quality, error-handling and logging specs. Research only: no code/config/user models files changed, no gateway requests, no credentials read.

Installed host root used below: `/home/jiang/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent`.

Read installed `docs/extensions.md` in full (3367 lines, including final continuation after tool truncation), `docs/json.md`, `docs/rpc.md`, `docs/rpc-extension-ui.md`, `docs/rpc-commands.md`, and `examples/extensions/message-renderer.ts`. Verified key behavior against installed `dist/modes/print-mode.js`, `dist/core/agent-session.js`, and `dist/core/extensions/runner.js`. Findings are source inspection, not a subprocess integration test or suite execution.

## 1. Existing transactional sync and --all

### Files and flow

- `src/command.ts`: `BOOLEAN_FLAGS`, `COMMAND_FLAGS.sync`, `validateCommand`, `helpText`, and `runSync` (around line 423). Current headless guard rejects missing `--models` before discovery. Interactive no-list sync uses paged selector; explicit IDs bypass selector.
- `src/types.ts`: `SyncInput` currently requires `modelIds: string[]`; `SyncDiscoveryResult` contains candidates, source (`channel`, `models.dev`, `local-explicit`), warnings.
- `src/doctor.ts:253` `discoverSync`: validates inputs, reads config, performs bounded live discovery, otherwise catalog then configured/explicit fallback. A successful empty live response returns `source: channel` with zero candidates; it deliberately does NOT fall back.
- `src/doctor.ts:831` `proposeSync`: deduplicates selected IDs exactly, verifies supplied discovery provenance against a same-instance WeakMap binding and current config, verifies advertised admission on live success, resolves metadata per ID, reuses dry-run `proposeAdd`, merges each model into a shared in-memory config, combines plans and retains a single base fingerprint.
- `applySync` checks blocking conflicts, no-op and base fingerprint, then calls `writeModelsJson` exactly once. Backup/readback/atomic replacement already belong to the shared writer. Never call applyAdd/applySync in a per-model command loop.
- `syncDiscoveryKey` binding should be inspected before changing service inputs: command resolves model IDs after discovery already, so do not accidentally bind a new --all state that makes its own result invalid.

### Recommended minimal design

Accept sync-only boolean `--all`; reject `--all` with `--models` before discovery. Allow headless --all through the missing-selection guard, but retain pre-discovery mutation authorization (`--yes`, with dry-run precedence). Discover once, select exact unique `candidate.id` values, and call existing `proposeSync`/`applySync` once. Do not derive IDs from metadata model IDs or normalize case. Bypass interactive picker in --all mode. Empty live lists must produce an explicit no-model/no-write result; never silently import catalog models when live discovery successfully returned empty.

Decide/document degraded discovery semantics explicitly: the PRD says every *advertised channel* ID, while existing discovery has catalog/local fallback. Safest --all interpretation is require successful channel advertisement rather than claim catalog/local IDs are advertised. If retaining existing fallback for --all, label source prominently and never claim verified channel support. No discovery/network should occur for legacy headless missing --models/--all.

### Output scalability

`runSync` currently emits all selected IDs, every metadata source, every proposal warning. `formatPlan` limits changes to 20 but does NOT limit conflicts or warnings; a provider-add change can embed a whole models array through `formatValue`. Discovery warnings also concatenate without cap.

Use bounded section formatting and overall character/line caps (counts, small sample, explicit omitted count). Preserve total model/change/conflict/default/source counts, final persistence/activation status and backup result. Bound individual IDs/reasons/values as well as item count, because one adversarial long ID/value can defeat item-only limits. Keep full proposal/config arrays intact: truncation is presentation-only. Authorization preview and final notification should share the same bounded preview. Test both many defaults and many ownership conflicts; limiting just the Models line is insufficient.

## 2. Prefix metadata matching without priority regressions

### Current resolution

`proposeSync` performs explicit provider selection, direct configured-target lookup (`findForConfig`), then global model resolution. Exact ID equality is required on resolved models, with special case-variant protection. `findGlobalModel` (`src/models-dev.ts:289`) uses global scored matches, handles cross-provider ties through exact reviewed publisher rules, otherwise returns an ambiguous result with `ambiguousMatches`. `findForConfig` (`:315`) prefers direct provider identity over endpoint evidence. `proposeSync` passes its resolved provider into downstream proposeAdd; `metadataProviderExplicit` distinguishes internal selection from user intent. That distinction and provider-ID collision tests must survive.

`proposeAdd` (`src/doctor.ts:~350`) invokes `chooseMatch`; `chooseMatch` around line 2174 treats an internally resolved metadata provider as authoritative. Provenance is built around line 563 by `src/publisher-registry.ts.metadataProvenance`; reasons are currently explicit-provider/direct-catalog/official-reference/catalog-reference/conservative-defaults. `src/types.ts.MetadataProvenance` carries source provider/model, reason, evidence and verifiedAt.

### Recommended structure

Build ordered lookup IDs: original ID first, then successively remove the first slash segment (`a/b/c`, `b/c`, `c`), skipping empty/duplicate variants. Finish ALL existing exact-ID source tiers for the original before trying a stripped ID. For each stripped candidate, retain source order: explicit provider (strictly scoped), direct target, reviewed exact publisher selection, unique catalog. Do not use substring/fuzzy/suffix guessing beyond explicit slash segmentation. Preserve exact original advertised ID in config and runtime target, even when the source model has a shorter ID.

Separate `requestedModelId` / persisted channel ID from `metadataModelId` / source lookup ID. Merely passing a stripped ID to proposeAdd would wrongly rename the runtime model; merely resolving a stripped source in proposeSync then passing only its provider would make proposeAdd re-lookup the unstripped ID and lose metadata. Introduce a narrow internal source-ID input or shared resolved-match helper, and ensure both sync and add use the same resolution semantics where required. Keep mergeProvider ownership checks and metadata-only transport/cost rules unchanged.

Provenance should retain source provider and actual source model ID plus original requested ID and an explicit strip marker (e.g. optional `requestedModelId` and `matchKind: prefix-stripped`; avoid replacing underlying source reason). Update type/schema validation and cache/config validation sites if fields/reasons are extended; old provenance must remain valid. Current sync formatter displays source.modelId on BOTH sides of its arrow, so it needs the original ID separately to render `a/b/c -> source/c` accurately.

Ambiguity is not absence: do not pick the first ambiguous result, and do not continue stripping until a convenient unique model appears after an exact ambiguous result. Preserve existing unresolved-tie error/default semantics deliberately and test them, including explicit invalid provider. `--metadata-provider` must never escape to another provider or defaults. Case-folded catalog helpers are not sufficient proof of exact matching; assert source model.id equality at each tier.

Check/fix (configured-model resolution and checkModel/repair paths around lines 1690/1885/2230) currently look up configured IDs or names and reuse provenance only when source provider/model match. They must honor recorded stripped source IDs, or subsequent check/fix can lose metadata or report erroneous model-ID mismatch. `checkModel` currently reports model-id-mismatch when configured ID differs from source ID: exempt deliberate stripped metadata-only identity, not arbitrary mismatch. Repeat sync must remain runtime no-op with no backup.

### Required regression matrix

- Exact nested ID wins over shorter direct/publisher/global alternatives.
- Two and three segments strip in order, with intermediate suffix preferred over final suffix.
- Explicit source scoping, internally selected source vs explicit provenance, configured provider-ID collision.
- Original advertised ID retained; source ID/provenance and dynamic catalog limits retained.
- Exact/stripped cross-provider ambiguity, within-provider case variants, explicit invalid source.
- No match -> conservative defaults; catalog outage configured-channel fallback unchanged.
- User-owned name/cost/compat/transport/headers/credentials unchanged; managed facts update.
- Repeat sync and check/fix preserve stripped provenance/identity and ownership.

## 3. Pi print/headless dispatch and observable output

### Definitive findings

1. **`pi -p '/model-doctor ...' DOES invoke the registered extension command.** Installed `runPrintMode` calls `session.prompt`; AgentSession.prompt checks extension commands before input expansion/model work. `_tryExecuteExtensionCommand` obtains command context and awaits handler. It returns handled even when command handler throws (host emits extension error). Built-in TUI slash commands are different: they are not available through prompt.
2. **`ctx.ui.notify` is invisible in print and JSON mode.** The default UI in `dist/core/extensions/runner.js:136` defines `notify: () => {}`. Docs list hasUI false for print/json. Doctor currently sends success AND caught failures exclusively through notify (`runCommand:111-160`), explaining silent failures and successes even when a mutation occurred.
3. **`pi.sendMessage` without triggering a turn is supported structured JSON output, not text-print output.** Idle `sendCustomMessage` calls `_appendCustomMessage`, which persists a custom message and emits message_start/message_end. JSON print mode subscribes to all events and serializes them. Plain text print mode prints ONLY the last assistant message; a custom message is not an assistant, so simply adding sendMessage does not make `pi -p` text visible. Never promise that it does.
4. **`triggerTurn: true` is not a reporting fix.** It starts LLM work, consumes credentials/tokens, and can mutate/interpret command results. Avoid it for deterministic command reporting.
5. RPC has `ctx.hasUI === true`; notify becomes an `extension_ui_request` with `method: notify` and notifyType. Sending an extension command via RPC prompt works, but response `success: true` / disposition handled means dispatch succeeded, NOT doctor operation success. Since doctor catches errors, clients must inspect doctor report severity/status. A handled slash command need not emit agent_settled, so do not wait for it indefinitely.
6. Plain-text print exit status is not a doctor success contract. `runPrintMode` returns nonzero for assistant failure or top-level exception, but handler errors are swallowed by command dispatch and doctor catches its own errors. Do not claim nonzero on doctor failure without an actual supported mechanism. A resumed session could even retain unrelated assistant output; use fresh/no-session examples.
7. Stdout belongs to host JSONL/RPC framing. Do not console.log or write arbitrary result lines from doctor. The supported logger alternative is stderr diagnostics, but it is not structured application protocol and should not silently become a machine success contract.

### Recommended change / documented contract

Provide a narrow reporter at the command boundary, keeping interactive notify behavior, and for print/json (`!ctx.hasUI`) send a redacted bounded custom message via injected ExtensionAPI `pi.sendMessage` with `triggerTurn: false` (or omitted, idle context). Use a fixed customType such as `model-doctor-result`, human-readable content, and small structured details such as severity, command, success/status when known. Do not put raw arguments, flags, config, plans or error objects in details. Ensure BOTH success and failures (including parse/validation errors) reach it. RegisterModelDoctorCommand has pi access; runCommand currently does not, so inject an optional reporter/sink rather than import a global host object. Keep standalone service tests independent of host UI.

Document canonical observable one-shot usage:

```sh
pi --mode json --no-session -e ./index.ts '/model-doctor sync sample-channel --all --dry-run'
```

(Use package installation instead of -e when installed.) Parse records where `type == message_end` and `message.role == custom` and `message.customType == model-doctor-result`; use content/details to distinguish operation result. Do not filter only assistant messages or wait for agent_settled. JSON mode alone does NOT fix existing notify-only output until reporter is implemented. Plain `-p` still executes but has no guaranteed visible doctor text; explicitly direct automation to JSON mode. RPC is a workable existing alternative using prompt + notify protocol (explicit --models/--all and --yes avoid interactive dialogs). SDK embedding is another alternative, but no new CLI needed.

If choosing docs-only rather than reporter, RPC notification success/failure visibility already works; clearly document print limits and test the supported RPC notification contract. However the cause is doctor notify-only reporting, so JSON custom-message reporting is the more actionable fix within scope.

### Regression tests

- `test/model-doctor.test.ts` already tests command registration, runCommand with mocked ctx, headless authorization, dry-run precedence and sync provenance; add reporter registration tests with fake ExtensionAPI sendMessage, asserting no triggerTurn and safe content/details for success and failure.
- Assert TUI keeps notifications without duplicate messages, RPC keeps protocol notification path (hasUI true), JSON/print uses injected supported sink instead of notify-only. Test invalid flags and missing args as well as service failure.
- Add installed-host integration through existing host resolver scripts, or isolated fresh temporary agent directory subprocess, proving slash dispatch with no model request, custom message_end visibility in JSON, and plain print custom-message silence if documenting it. All settings/models/cache/session paths must be temporary; do not use user models/auth files. Avoid external network by testing help/invalid commands, not actual catalog refresh. Use a timeout and ensure resources clean up.

## Relevant specifications to curate

- `.trellis/spec/backend/model-doctor-contract.md`: command grammar, single proposal/apply, ownership, discovery and metadata provenance.
- `.trellis/spec/backend/quality-guidelines.md`: strict types, tests, source priority vs explicit provenance.
- `.trellis/spec/backend/error-handling.md`: authorization/dry-run/error redaction, unresolved ambiguity, channel identity.
- `.trellis/spec/backend/logging-guidelines.md`: no stdout printing, selected safe fields only.

Specs currently say headless sync requires --models and diagnostics only notify. These need updates after the chosen implementation, not before pretending --all/reporter already exists.
