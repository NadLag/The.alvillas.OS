# 0097 — Serialize accounting policy replacement with close and reopen

A native expense acceptance journey failed while closing an empty historical
month. The retained PostgreSQL log identified the cause: another transaction
replaced finance.accounting_periods after the service resolved its policy but
before the close event's database guard checked that it was still current.
The guard correctly rejected the stale policy and the transaction rolled back.

AccountingPeriodRepository.lock now acquires the existing organization accounting
lock, then the existing ConfigRuleRepository version lock for the organization
accounting policy. Close and reopen already acquire this method before reading the
database clock, current grants and policy. Configuration writers use the same
version lock, so a replacement waits until the attributed event and audit commit.
Other tenants and unrelated configuration scopes remain independent.

Real PostgreSQL regressions pause each actual operation after policy resolution,
start the actual configuration writer, observe its blocked backend, then release
the close or reopen and require both commits. The resulting event retains its
selected policy and the replacement becomes current afterward. The regressions
fail without the lock. Existing current-policy guards, expiry, immutable snapshots,
financial history and migration files remain unchanged.
