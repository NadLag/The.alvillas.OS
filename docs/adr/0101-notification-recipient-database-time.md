# 0101 — Database time for notification recipient grants

Status: Accepted

The complete recognition integration run exposed three missing immediate task-notification receipts in existing digest and WhatsApp tests. All three passed in isolation. A controlled PostgreSQL regression reproduces the shared authorization defect: filtering database-timestamped assignments with the application host's clock can suppress a currently active grant, and a lagging host can also treat an expired grant as current.

Extract the existing full-precision clock and eligible-assignment query from `IdentityRepository.authorizationStates` into `authorizationObservation`; the complete loader continues to call it unchanged. Ordinary notification delivery applies that observation to its existing routing candidates and permission snapshot. Routing still selects actual configured people, assigned recipients or configured roles; source authorization, enrollment and review permissions use database time. An atomic notification batch shares the observation with its existing candidate metadata, avoiding repeated permission-graph reads. No observation is retained beyond that operation.

Identity security notices retain their existing subject-only delivery behavior. Financial owner notices retain their full freshly loaded account/permission checks and original source and mandatory-receipt guards. The existing 180-query native-stay budget passes without modification. This changes no routing configuration, authorization scope, financial history, deadline, test timeout, business rule or provider. The regression proves both delivery for a currently active database grant and denial for a grant expired in the database while the application clock is behind.
