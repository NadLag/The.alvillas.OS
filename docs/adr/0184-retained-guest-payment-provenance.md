# 0184 — Retain original guest payment provenance

Guest receipts must identify the original collector, custody account, guest claim, booking, source and purpose. A property's owners provide booking context; an agreement determines the eventual allocation of accommodation proceeds.

Retain receipt metadata and ordered owner witnesses in the same tenant transaction as the existing native journal and original attributed audit. The retained booking financial snapshot supplies the original owner context. Cash admission retains the field collection's collector, account, timestamp and financial snapshot, separately from the finance actor admitting the guest claim. No additional monetary posting or balance is introduced.

Compound foreign keys, forced tenant row policies, append-only triggers and deferred native guards enforce the complete relationship. A newly sealed guest receipt must have its corresponding provenance and attributed audit. The guard verifies the journal and original audit were created in the current transaction, preventing retroactive attribution of historical receipts. Applied history is preserved without backfill.

Reads use the existing guest-deposit source authorization and final current-grant checks. Personal collector and owner names additionally require their independent personal-resource permissions. Related owners are labelled as retained booking context, with no implied ownership of the guest liability.

External payment intent and capture evidence must remain bound to tenant, actor, original order, exact Money and configured method. Provider HTTP requests belong outside the financial transaction; admission uses the existing native receipt producer and its source locks, audit and idempotency.
