# ADR 0110: Revalidate compensation authority around contractual rate writes

Accepted: 2026-10-30

Employee compensation runs must use the existing immutable `team_compensation` versions and their `staff.compensation` rules, attached to role assignments. The command that creates those contractual sources previously checked only the supplied authorization context before waiting for the person's lock. A retained caller grant could therefore create a rate after its stored assignment had expired.

Move the existing financial command authority intersection into `platform/authz/current-authority.ts`, keeping the financial wrapper and its behavior. Require both the original caller restrictions and freshly loaded account grants through `authorize()`. Compensation writes use this same helper after the person's lock and after the rate, configuration and audit writes and deferred database guards. Reload the target assignment on each check; reject changed ownership, scope or archival state. Include the actual contractual amount, effective instant and beneficiary in the authorization resource, allowing valid amount/date restrictions without bypassing them.

All rate, configuration and audit writes remain in one tenant transaction. A failed final check rolls back the entire command. No existing versions, financial rows, configuration values or database migrations are changed. Contractual rates remain separate from earned compensation, settlement, wallet offsets and tax treatment; F-FIN-24 remains in progress until those flows and its complete Definition of Done are met.

The regression reproducer runs against real PostgreSQL with the prior production command: a caller without stored authority and revocation after the lock or configuration write all commit incorrectly. The corrected command denies them and preserves the exact original rate/configuration/audit/outbox rows. A separate final-boundary regression expires the actual stored grant after deferred guards. Additional cases exercise stored amount/date limits, a narrower caller limit and actor identity binding. Existing successful compensation fixtures now include real stored financial grants.
