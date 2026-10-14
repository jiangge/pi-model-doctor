# Independent verification

## Findings and fixes

- Fixed `add <existing-provider> --api-key <value>`: command no longer demands a model or opens model selection; service accepts this explicit credential-only request.
- Fixed credential-only provider-id storage identity: reuse the existing provider ID rather than deriving a new ID from a non-URL target.
- Existing provider-only merge exits before model processing, after redacted auth replacement; existing models, transport, headers, custom fields and ownership metadata remain intact.
- Added a command regression covering provider-id-only and provider-id/model forms, without literal opt-in, including raw `$ENV`, `${ENV}`, bare ENV and command references. Assertions verify original model/transport/custom fields and provider-only ownership metadata survive.

## Reviewed boundaries

- Literal authorization is add-only; internal sync calls use `credentialPolicy: "sync"`; configure remains on its original opt-in path.
- New and replaced auth changes redact both before and after; auth is not a managed snapshot field. Proposal config intentionally contains credentials because it is the persistence payload, not a public preview.
- Existing tests cover new-provider literal credentials; both provider-only/model replacement paths; same-value no-op; omitted model-path preservation; whitespace/empty rejection; dry-run no config/cache/backup changes; notifications; backup retains prior key; sync/configure invariance.
- Parser tokenization stores environment/command references as text, with no expansion or execution. The command regressions assert persisted reference text.

## Final checks

- `npm run typecheck`: PASS (exit 0).
- `npm test`: PASS, 109 tests / 109 pass / 0 fail / 0 skipped / 0 cancelled.
- `git diff --check`: PASS.

No commit or Mainline lifecycle performed. Main session owns final review/commit. Existing-provider omission without a model continues to require model selection, preserving the pre-existing command grammar; omission with a model preserves credentials. Provider-only endpoint requests without explicit auth retain the pre-existing already-configured rejection.
