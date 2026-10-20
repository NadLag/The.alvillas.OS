# Versioned automation execution

F-AUT-01–07 extends DEC-08/09 without a second rule store. Automation definitions
use `automation.rule.*` keys in `config_rule`. Activation and pause/resume append
versions through the existing configuration service. Library installation is an
explicit property-scoped administrator action; rules start as drafts and existing
configuration is preserved.

Inngest receives only organization/outbox references and authenticates requests.
The event catalog is partitioned across consumers with at most ten triggers each,
matching the [Inngest SDK v4 trigger limit](https://www.inngest.com/docs/reference/typescript/v4/functions/create).
Consumers load the durable source under RLS, resolve effective scoped rules, and
freeze referenced configuration versions and evaluation inputs. A unique
organization/rule/outcome/property key and PostgreSQL advisory locks serialize
duplicate delivery. Retries and replay retain the original rule and principal;
every attempt reloads that principal's current grants. Pausing linearizes against
execution through the configuration version lock.

Actions call the existing operations, approval, financial snapshot and notification
services on the same tenant transaction. A savepoint rolls back all outcomes when
any action fails; run/attempt/audit records then commit the safe failure code.
Attempts are append-only. Replaying a successful run cannot create new outcomes.
Automation cannot approve requests or execute payments; the action catalog accepts
neither. Financial actions independently authorize financial access and use Money.

Property-local daily schedules are persisted as outbox occurrences, deduplicated
by local date, including the repeated DST hour. Missed polling within a local day
recovers at the next tick; nonexistent DST times execute on the first tick after
the requested local time. Business schedules and retry policies are versioned
configuration. The minute polling cadence is infrastructure.

An outbox trigger propagates an automation's rule ancestry to business events;
re-entering a rule or exceeding the bounded chain fails closed. Internal
notification/identity delivery envelopes retain their existing strict schemas.
