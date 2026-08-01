# Logging Guidelines

This extension does not use a logging framework. User-visible diagnostics go through Pi's `ctx.ui.notify`; pure modules return structured results or throw typed errors. Avoid `console.log` in production code so command output stays deterministic.

## Safe Diagnostics

- Provider ids, model ids, endpoint hostnames, finding codes, cache source, and change paths may be shown.
- API key values, bearer tokens, custom secret headers, passwords, and credential command output must never be shown or logged.
- Change formatting in `src/command.ts` recursively redacts values beneath sensitive paths (`apiKey`, `token`, `secret`, `authorization`, `password`, `credential`).
- The change record for adding `apiKey` uses the literal `[redacted]`, not the configured value.

## Levels

Use Pi notification types consistently:

- `info`: successful proposals, list/check results, refresh summaries, cancellations.
- `warning`: stale cache, deprecated models, preserved user overrides, non-blocking conflicts.
- `error`: invalid configuration, failed backups/writes, malformed targets, unavailable data with no usable fallback.

## Anti-pattern

Never interpolate a full provider/model object into a notification. Use `formatPlan`, `formatFindings`, or a deliberately selected safe field list.
