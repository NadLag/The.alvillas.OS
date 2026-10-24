# ADR 0056: Supervisor validation in the Field app

Date: 2026-10-23

Status: Accepted

The Field app presents supervisor work through the existing Operations task, proxy-validation, evidence, authorization, audit and outbox services. The list intersects current view and validate scopes before pagination, excludes the validator’s own assignments, includes assignees without accounts, and returns only operational card fields. An empty permitted scope explicitly returns no rows or counts. Villa search and pages of fifty support a large portfolio without downloading every task.

The detail screen separates the original performer from the authenticated validator. The server selects the validator and timestamp, checks the exact checklist and current version, and preserves the existing idempotency receipt. The browser cannot choose an arbitrary validator. Stale submissions retain the form and fail; the operator must reload and confirm current work. Completion displays the recorded performer, validator, reason and timestamp. Optional note/photo evidence uses the existing private Operations attachment service and its independent permission checks.

Proxy validation is an online mutation. Its form retains entries while the connection is lost and disables submission. It does not enter the self-completion queue, whose assignment checks intentionally reject validating another person’s work. Durable offline proxy drafts and a separately authorized queued proxy operation remain unfinished and keep F-FLD-15 IN-PROGRESS. Native upload resumption remains F-FLD-14; this screen uses the existing online private-photo attachment.
