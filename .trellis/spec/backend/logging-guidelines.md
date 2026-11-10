# Logging Guidelines

This extension does not use a logging framework. TUI/RPC diagnostics go through Pi's `ctx.ui.notify`; noninteractive registration also emits one final supported `model-doctor-result` custom message via `pi.sendMessage(..., { triggerTurn: false })`. Pure modules return structured results or throw typed errors. See [Model Doctor Contract §3](./model-doctor-contract.md) for the executable payload/status and mode contract. Avoid `console.log` in production code so command output stays deterministic.

## Safe Diagnostics

- Provider ids, model ids, endpoint hostnames, finding codes, cache source, and change paths may be shown.
- API key values, bearer tokens, custom secret headers, passwords, and credential command output must never be shown or logged.
- Change formatting in `src/command.ts` recursively redacts values beneath sensitive paths (`apiKey`, `token`, `secret`, `authorization`, `password`, `credential`).
- The change record for adding `apiKey` uses the literal `[redacted]`, not the configured value.
- Bulk sync samples/counts models, sources, warnings, changes and conflicts; bound individual lines/values too. Truncation is presentation-only: never truncate proposal/config data. Preserve final status/backup output and share the bounded preview with authorization.
- Caught errors are redacted/capped at 2,000 characters. Final headless content is redacted/capped at 12,000 characters. Details contain only command, success, status, severity and final=true, never raw arguments/flags/plans/config/errors or credentials.
- Discovery is progress, not another final result. JSON consumers select custom `message_end` results; TUI/RPC keep notify with no duplicate custom message. Plain-print silence and exit zero are not proof of success.

## Levels

Use Pi notification types consistently:

- `info`: successful proposals, list/check results, refresh summaries, cancellations.
- `warning`: stale cache, deprecated models, preserved user overrides, non-blocking conflicts.
- `error`: invalid configuration, failed backups/writes, malformed targets, unavailable data with no usable fallback.

## Anti-pattern

Never print ad-hoc stdout (host owns JSONL/RPC framing), trigger a model turn to report results, or derive machine status by parsing human text. Never interpolate a full provider/model object into a notification. Use `formatPlan`, `formatFindings`, or a deliberately selected safe field list.
