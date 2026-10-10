# P0-14 Build-vs-Buy Analysis: Calendar Sync and Guest Messaging

Status: decision-preparation artifact with approved owner outcome recorded after analysis.

P0-14 is DECIDED as of 2026-10-09 by explicit business-owner approval in this ChatGPT conversation. V1 uses iCal-first scheduled calendar synchronization and does not use or research a PMS/channel manager.

## Sources Reviewed

- `docs/ALVILLAS_OS_Master_Specification.docx`
- `docs/ALVILLAS_OS_Build_Checklist.docx`
- `docs/CHECKLIST_STATE.md`
- `docs/PHASE_0_DECISION_REGISTER.md`
- `docs/PHASE_0_DECISION_QUESTIONNAIRE.md`

## Extracted Requirements

### P0-14 Decision Requirement

- P0-14 requires a build-vs-buy check on calendar sync and guest messaging, comparing a channel manager / PMS option against building ALVILLAS-owned capability.
- The current decision register status for P0-14 is DECIDED.
- The decision questionnaire previously listed the supported options as: build iCal-first plus adapters; buy a channel manager / PMS; hybrid; manual WhatsApp/generated links first; WhatsApp Business API/provider later if volume justifies it. P0-14 is now removed from the unanswered questionnaire.
- Before approval, P0-14 blocked reservation adapter scope, guest messaging architecture, background job requirements, and external integration budget. The V1 blocker is now resolved by the approved iCal-first/no-PMS decision.

### Reservation Ingestion

- Reservation sources must include Airbnb, Booking.com, Vrbo, direct, agency, other OTA, and manual sources.
- All sources must normalize into the same ALVILLAS reservation model.
- The reservation model must support the lifecycle: Imported, Confirmed, Guest Preparation, Check-in, Staying, Checkout, Financial Reconciliation, Closed.
- The model must also handle modification, cancellation, refund, early checkout, no-show, date change, duplicate detection, and conflict detection.
- Importing a reservation must create the guest, stay, tasks, and workflow without re-typing; conflicts must appear as exceptions.
- Reservation/stay events trigger workflows such as pre-arrival, cleaning, inspection, inventory preparation, Guest Hub, arrival, mid-stay where applicable, checkout, laundry, and inventory reconciliation.
- A financial snapshot must be created when a reservation is confirmed.

### iCal

- Initial integration priority is iCal.
- iCal sync must run as a scheduled background job.
- iCal is for calendar/reservation synchronization only. The checklist explicitly says Airbnb payout/transaction CSV import is needed early because iCal carries no price, guest name, or payout data.
- Therefore iCal must not be treated as a source for prices, complete guest details, OTA fees, platform fees, taxes, settlements, owner/ALVILLAS allocation, or payout reconciliation.

### OTA Adapters

- Architecture must use adapters so APIs can be added later.
- Required adapter concepts include `ICalAdapter`, `AirbnbAdapter`, `BookingComAdapter`, `VrboAdapter`, `DirectBookingAdapter`, and `CSVAdapter`.
- External integrations must flow through adapters, then into the normalized ALVILLAS domain, then into everything else.
- Provider abstractions are required so business logic does not depend directly on a vendor SDK or external system shape.

### Airbnb Settlement Data

- Airbnb is both a booking source and potentially a settlement source.
- The Airbnb-related domain needs to account for reservation, guest, stay, platform fees, settlement, and owner/ALVILLAS allocation.
- The system must reconcile expected Airbnb money against actual Airbnb money received or settled.
- Airbnb payout/transaction CSV import is required early because iCal does not carry price, guest name, or payout data.
- OTA settlement reconciliation must follow the global pattern: Expected -> Actual -> Variance -> Reason -> Action.

### Duplicate and Conflict Detection

- Reservation lifecycle requirements include duplicate detection and conflict detection.
- Phase 1 requires the OTA/iCal data model to define duplicate and conflict detection rules.
- Phase 5 requires duplicate detection and double-booking conflict detection.
- Conflicts must surface as exceptions rather than being silently overwritten.
- The Command Center must show conflicts.

### Synchronization Failures

- iCal sync must be a scheduled background job.
- Failed sync alerts must be shown in the Command Center.
- The Command Center must show exceptions including conflicts and failed syncs.
- Failed workflows and syncs must be visible through monitoring/alerting before production.

### Guest Communications

- Guest Hub is structured self-service, not chat.
- Guests must be able to complete profile details, arrival/departure details, sign agreements, accept house rules, select services, select chef menu, order groceries, request transfers/cleaning/experiences, see relevant information, and complete required forms.
- Each reservation must have a unique Guest Hub link shareable by WhatsApp, email, or SMS.
- WhatsApp remains the human communication channel.
- The system may later send Guest Hub links through WhatsApp, email, or SMS integrations.
- Notifications must be event-driven and may include in-app, email, push when the PWA need is proven, and WhatsApp links/integrations later.
- The master specification and checklist both prohibit internal chat. ALVILLAS should not become a WhatsApp replacement.
- Information received through WhatsApp can later be converted into structured tasks, issues, requests, service orders, or notes.

## iCal vs OTA API or CSV Data

| Data area | iCal-first sync | OTA API / OTA CSV / settlement export |
|---|---|---|
| Availability dates | Expected core use. Use to block/reserve dates when feed data is reliable. | Usually available if the provider/API/export supports it, but exact fields must be verified. |
| Reservation identity | May expose event UID or feed-specific identifiers, but must not be assumed complete. | May provide stronger booking IDs, reservation statuses, and source metadata if access is granted. |
| Guest details | Must not be assumed. Checklist states iCal carries no guest name. | May be available through an OTA API, PMS export, or reservation CSV, but must be verified per provider and contract. |
| Price / booking value | Must not be assumed. Checklist states iCal carries no price. | May be available through OTA reservation APIs or CSV exports, but field coverage, taxes, fees, and currency handling must be verified. |
| Platform fees | Not an iCal capability for ALVILLAS planning. | May be available through richer OTA data or settlement exports; must be verified. |
| Settlement / payout | Not an iCal capability. Checklist states iCal carries no payout data. | Airbnb payout/transaction CSV import is required early; other OTA settlement sources need external verification. |
| Cancellations / modifications | May be inferred from feed changes, but exact semantics are limited and must be treated carefully. | May provide richer state changes, webhooks, or exports, subject to API access and provider capability. |
| Financial reconciliation | Not sufficient. | Required for expected vs actual settlement, owner ledger, ALVILLAS allocation, and variance handling. |

## Options Compared

### Option A: Build

Build ALVILLAS-owned iCal-first sync, a normalized reservation model, provider adapters, Airbnb payout/transaction CSV import, and manual WhatsApp/generated Guest Hub links.

This matches the documented iCal-first and adapter-first architecture. It maximizes domain control and avoids making a third-party PMS the operating source of truth. Its weakness is that ALVILLAS would own more synchronization reliability, OTA-specific edge cases, and future API expansion work.

### Option B: Buy

Use a third-party PMS/channel manager for supported calendar/reservation functions, integrated through an ALVILLAS-owned adapter.

This could reduce the burden of building OTA/channel synchronization if a vendor has reliable channel coverage, API access, webhooks/exports, and acceptable cost. It cannot replace ALVILLAS-owned domain logic, authorization, financial allocation, audit trails, owner reporting, or the structured Guest Hub. Vendor claims, pricing, API rights, data export, and contract terms require external research.

### Option C: Hybrid

Keep ALVILLAS-owned domain, workflows, financial engine, Guest Hub, and authorization, while selectively using external calendar/channel capabilities where they are proven useful and cost-effective.

This keeps the architecture aligned with the master specification: external integrations enter through adapters, normalize into ALVILLAS, and never become the core source of truth. This option was considered during analysis but is not the approved V1 path because PMS/channel-manager purchase, integration, and research are explicitly out of scope for V1.

## Comparison Matrix

| Dimension | Build | Buy | Hybrid |
|---|---|---|---|
| Functionality | Strong fit for ALVILLAS-specific workflows, Guest Hub links, reservation normalization, tasks, financial snapshots, and audit. Weak initial coverage for richer OTA APIs unless built later. | Potentially stronger channel/calendar features if vendor supports required OTAs. May include unrelated PMS messaging or operational concepts that do not match ALVILLAS. | Best functional fit if ALVILLAS owns the core and buys only proven channel/calendar capabilities. |
| Operational control | Highest. ALVILLAS controls sync behavior, exceptions, workflows, and data model. | Lowest. Vendor controls sync engine behavior, outage handling, feature roadmap, and some data shape. | High for core operations, medium for external channel functions. |
| Reliability | Depends on ALVILLAS implementation quality, background jobs, monitoring, retries, and iCal feed reliability. | May be stronger if vendor has mature OTA integrations, but reliability claims must be verified. Vendor outages become ALVILLAS outages for channel functions. | Better balance: internal monitoring and exception handling, with vendor reliability used only where proven. |
| Recurring cost | Lower vendor cost but higher engineering and support effort. | Higher recurring subscription, per-property, per-channel, onboarding, support, or API costs possible. Actual pricing unknown. | Moderate and controllable if buying is limited to capabilities that save more than they cost. |
| Integration effort | Build iCal, CSV imports, normalization, duplicate/conflict rules, retries, and alerts directly. OTA APIs later add effort. | Requires vendor selection, contract, API/export access, adapter mapping, webhook/retry logic, reconciliation mapping, and security review. | Requires strong adapter boundary plus selective integrations. More architecture discipline, less long-term lock-in. |
| Data ownership | Strong. ALVILLAS stores normalized reservation, guest, task, finance, audit, and reporting records. | Risk that operational history and channel details live primarily in vendor systems unless exports/APIs are complete. | ALVILLAS remains source of truth; vendor data is imported, normalized, and audited. |
| Vendor lock-in | Low for iCal/CSV and internal domain. Future OTA API work remains ALVILLAS-owned. | High unless contract guarantees export/API access, data portability, and acceptable termination terms. | Lower if each vendor is isolated behind adapters and ALVILLAS can continue operating from normalized data. |
| Security | ALVILLAS controls authorization, data scopes, signed URLs, audit logs, and retention. More internal responsibility. | Requires vendor security, privacy, access, data-retention, and subprocessor review. Risk increases if guest/financial data is stored externally. | ALVILLAS controls sensitive domain data; vendor exposure is minimized and reviewed. |
| Scalability to 500+ properties | Achievable, but ALVILLAS must design sync scheduling, rate limits, monitoring, duplicate detection, conflict handling, and data volumes carefully. | May scale operationally if vendor supports 500+ properties and pricing remains acceptable. This is unverified. | Strongest strategic fit if core ALVILLAS data model is designed for 500+ and vendor capabilities are used only where they scale economically. |
| Reconciliation requirements | Full responsibility for expected vs actual settlement, OTA variances, bank matching, and owner ledger. | Vendor may help with channel data but cannot be assumed to satisfy ALVILLAS owner ledger, allocation, and audit requirements. | ALVILLAS keeps reconciliation as a core function; vendor data becomes one input into expected vs actual workflows. |

## Elements That Must Remain ALVILLAS-Owned

Regardless of build, buy, or hybrid, these must stay inside ALVILLAS OS:

- Organization boundaries and tenant root.
- Deny-by-default authorization, RBAC, ABAC, data scopes, and field-level security.
- Normalized reservation model and reservation lifecycle.
- Business rules, including commission, OTA fee treatment, owner expense treatment, approval thresholds, payout schedules, staff compensation, workflows, service pricing, tax hooks, and operating rules.
- Task/workflow generation from reservations and stays.
- Guest Hub as structured self-service.
- Financial allocations between owner and ALVILLAS.
- Owner money held by ALVILLAS, money ownership vs money location, and transaction provenance.
- Owner ledger, ALVILLAS ledger, payouts, and reconciliation.
- Expected vs actual variance handling.
- Audit trails for sensitive actions.
- Owner reporting and statements.
- Document archive, signed URLs, and retention rules.

External systems may supply calendar/channel data, OTA reservation data, or message delivery mechanisms, but they must not become the source of truth for ALVILLAS operations or finances.

## Security and Compliance Considerations

- If a PMS/channel-manager decision is reopened after V1, that future vendor must be reviewed for guest data handling, access control, data retention, export rights, auditability, and subprocessor exposure before any integration.
- No external source should bypass ALVILLAS authorization. Imported data must still be scoped by organization, property, owner, reservation, and role.
- Any external messaging integration must preserve the no-internal-chat rule. ALVILLAS may send links or convert WhatsApp information into structured records, but must not build a chat application.
- Financial records must not be hard-deleted or silently overwritten.
- External data imports must preserve source, timestamp, external ID, raw reference, mapping status, and reconciliation status where relevant.

## PMS Vendor Research Stopped For V1

The owner decision on 2026-10-09 stops PMS/channel-manager purchase, integration, and vendor research for V1. No PMS vendor shortlist, pricing review, API review, contract review, or integration plan is required or approved for V1.

## Approved Decision

**APPROVED FOR V1:** choose the Build approach with iCal-first calendar synchronization and no third-party PMS/channel manager.

Approved shape:

- Build and keep ALVILLAS-owned reservation normalization, duplicate/conflict detection, reservation lifecycle, workflows, Guest Hub, authorization, financial snapshots, settlement reconciliation, owner ledger, audit trails, and owner reporting.
- Start V1 with iCal-first scheduled sync for calendar visibility, plus early Airbnb payout/transaction CSV import because iCal does not carry price, guest name, or payout data.
- Use manual WhatsApp plus generated Guest Hub links first.
- Defer WhatsApp Business API/provider integration until volume justifies it.
- Do not buy, integrate, or research a PMS/channel manager for V1.
- Keep provider/reservation adapters extensible for future needs without implementing unnecessary integrations.

Rationale:

- Pure Build aligns with the approved V1 owner decision and the specification's iCal-first, adapter-normalized architecture.
- Pure Buy may reduce channel sync work but cannot satisfy ALVILLAS-specific authorization, financial auditability, owner reporting, configurable business rules, Guest Hub, and no-internal-chat requirements.
- Future hybrid or buy options are out of V1 scope unless the owner explicitly reopens the decision later.

## Owner Decision Section

### Approved Choice

Use ALVILLAS-owned iCal-first scheduled calendar synchronization for V1. No PMS/channel-manager purchase, integration, or research is approved for V1.

### Tradeoffs

- ALVILLAS keeps control of core operations and finances, but must build a robust adapter/domain layer.
- Initial iCal-first delivery is simpler and lower cost, but does not solve guest details, pricing, settlement, or rich OTA state.
- Not buying selected channel capabilities avoids recurring vendor cost and lock-in, but ALVILLAS owns more sync monitoring, duplicate detection, conflict handling, and operating procedures.
- Manual WhatsApp/generated links fit V1, but later WhatsApp Business API integration may be needed if message volume grows.

### Prerequisites

- Confirmation of active channels and near-term property count.
- Definition of duplicate/conflict detection rules in the Phase 1 domain model.
- Definition of reservation normalization fields and external ID strategy.
- Airbnb settlement CSV sample and reconciliation requirements.
- Security/privacy review for any future messaging provider before non-manual WhatsApp/API use.
- Owner approval is recorded with date and evidence in the decision register and tracker.

### Acceptance Criteria Recorded For P0-14 Closure

- The owner selected Build/iCal-first explicitly.
- The selected option includes a clear no-vendor decision for V1.
- The selected option documents what data is available from iCal and CSV imports, and what must not be assumed from iCal.
- The selected option preserves ALVILLAS-owned authorization, reservation normalization, workflows, financial allocations, audit trails, and owner reporting.
- The selected option respects the no-internal-chat rule.
- Failed syncs, conflicts, and settlement variances have a defined exception path.
- P0-14 is updated with approval evidence, owner, and date.

## Open Questions

- Which OTAs and agencies are active for the first villas, and which are planned for the first 90 days?
- Are current iCal feeds available and stable for Airbnb, Booking.com, Vrbo, and any agency channels?
- What Airbnb payout/transaction CSV format will ALVILLAS use for early reconciliation?
- Are Booking.com and Vrbo settlement exports/API data needed in V1, or can they be manual/CSV initially?
- Does ALVILLAS need two-way availability pushing in V1, or is read/import plus manual channel operation acceptable at launch?
- What level of delay is acceptable for scheduled sync jobs?
- Who handles sync failures operationally, and what escalation path is required?
- What owner-facing explanation is needed when external channel data conflicts with ALVILLAS data?
- Which future OTA APIs, if any, may be worth adding after V1 without changing the iCal-first decision?

## Decision Status

P0-14 is DECIDED.

Business-owner approval is recorded in this ChatGPT conversation on 2026-10-09.

No implementation is authorized by this document.
