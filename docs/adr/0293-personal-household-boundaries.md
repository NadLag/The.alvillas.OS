# Personal household boundaries

F-PER-01 and F-PER-02 use a dedicated `personal_*` schema area. Every row belongs to an organization and a household. PostgreSQL policies require a transaction-local personal scope in addition to the normal organization context. Household discovery only reads the actor's membership keys. The only foreign keys outside the personal area refer to organization and account identity.

The personal application builds its authorization context from household grants alone. An operator provisions the initial steward using `npx tsx prisma/bootstrap-personal-household.ts <organization-id> <account-id> <household-name> <steward-name>`. The same request returns the original household identifier. It does not derive authority from a business role. Stewards assign explicit grants to existing tenant accounts. Child memberships cannot administer grants. Household operations serialize against revocation and audit sensitive changes in the same transaction.

Personal audit events reuse the platform writer's validation and redaction and go to a household-scoped append-only table. Restore into the isolated recovery environment, retaining the membership, content and audit tables together. No household data is copied to the business audit or ledger tables.

F-PER-03 through F-PER-08 record money as exact decimal and currency values. Corrections append an opposite movement or a new dated valuation. Budgets and savings progress derive from household movements. A target or a valuation cannot create a cash movement. Reporting groups by currency and intersects the requested report grant with each source grant.

F-PER-09 stores bounded encrypted document originals in the household's recovery data. Its key ring uses `PERSONAL_ENCRYPTION_KEYS` with the platform's versioned key format. Preserve the relevant key versions separately when rehearsing restoration. Download requires a current household grant and is audited. Archive and restore preserve the original bytes.

F-PER-11 uses the explicit transfer record and an append-only resolution. Confirmation requires current household edit access, independent organization journal view and approval, an effective approved `finance.business_personal_transfers` account mapping, and an exact match against one sealed company posting pair. The journal remains read-only in this workflow. A unique settlement reference prevents counting a company posting twice. Personal reports use confirmed bridge records as a distinct transfer total and never return the source journal identity.
