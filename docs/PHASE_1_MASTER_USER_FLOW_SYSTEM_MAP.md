# Phase 1 Blueprint: Master User Flow / System Map

Status: draft blueprint for review. This document is documentation only and does not mark Phase 1 complete. It must be reviewed and tested on paper against real Villa 405 and Villa Sultan data before any checklist item is marked DONE.

## Source Traceability

- Master Specification sections 00-02: product vision, ecosystem, one underlying data model and authorization system.
- Sections 03-07: public website, owner CRM, property onboarding, owner package, document versioning.
- Sections 08-18: identity, roles, permissions, registration, authentication.
- Sections 19-23: field app, offline operations, proxy validation.
- Sections 24-35 and 50-62: wallets, financial engine, money ownership/location, ledgers, reconciliation, reports, audit, financial integrity.
- Sections 37-42: Guest Hub, reservations, lifecycle, automation, property operating profile.
- Sections 43-49: inventory, laundry, maintenance, assets, team.
- Sections 63-69: Personal OS boundary, family permissions, Command Center, work management, property workspace, notifications, no internal messaging.
- Sections 70-83: design, performance, technology, tenancy, configuration, events, security, scalability, development strategy, Golden Path, non-negotiable principles.
- Technology & Architecture Decisions v1.1 sections 6, 8-12, 14-21, 29-30.

## Approved Decisions Used

- P0-13: ALVILLAS OS is an independent clean-room product.
- P0-14: V1 uses iCal-first scheduled calendar synchronization, ALVILLAS-owned reservation normalization, duplicate/conflict detection, sync monitoring/failure handling, Airbnb settlement CSV/import as separate financial data, manual WhatsApp plus generated Guest Hub links, no internal messaging, and no PMS/channel-manager purchase/integration/research in V1.

## System Boundary

ALVILLAS OS is one platform with role-specific experiences over one data model and one authorization system.

```
Public Website
  -> Owner CRM
  -> Property Onboarding
  -> ALVILLAS OS Core
      -> Admin
      -> Operations
      -> Finance
      -> Owner Portal
      -> Guest Hub
      -> Field App
      -> Command Center
      -> Documents
      -> Reports
      -> Audit

Personal OS is a separate financial domain with separate permissions.
```

External systems are inputs or delivery channels, not the ALVILLAS source of truth:

- iCal feeds for V1 calendar synchronization.
- Airbnb settlement CSV/import for financial settlement data.
- Email provider for transactional email.
- Manual WhatsApp for human communication and link sharing.
- Signature provider for signing workflows after legal approval.
- Storage provider for documents/photos.

No internal chat is part of the system.

## Personas

- Prospect
- Owner
- Guest
- Admin
- Operations Manager
- Property Manager
- Co-host
- Housekeeper
- Pool Technician
- Gardener
- Chef
- Driver
- Maintenance
- QA Inspector
- Finance / Accountant
- Procurement
- Revenue Manager
- Contractor
- Owner Representative
- Family members for Personal OS

## Primary Journeys

### 1. Owner Acquisition

1. Prospect submits a property assessment request from the public website.
2. CRM lead is created with owner/contact, phone, email, location, property type, bedrooms, current rental status, current OTAs, objectives, source, status, and assigned ALVILLAS representative.
3. Lead moves through New Lead, Contacted, Qualified, Property Assessment, Proposal, Contract Draft, Sent, Viewed, Signed, ALVILLAS Onboarding, Go Live.
4. Once approved and signed, the owner and property enter the ALVILLAS-controlled onboarding flow.

Exceptions:

- Duplicate lead: merge or link with audit, never silently discard.
- Missing owner data: lead remains incomplete until required fields are provided.
- Legal agreement not approved: onboarding cannot pass the agreement step.

### 2. Property Onboarding

1. Admin selects or creates Owner.
2. Admin creates Property with address, city, type, bedrooms, bathrooms, living spaces, pool, garden, parking, amenities, photos, and capacity.
3. Admin configures Operating Profile: cleaning, inspection, pool, garden, laundry, linen, maintenance, mid-stay cleaning, breakfast, chef, transfers, groceries, wellness, and other services.
4. Admin configures Management Agreement terms: commission, basis, effective date, expense treatment, responsibilities, approval rules, payout rules, notice period, and special conditions.
5. Admin assigns team members and scoped role assignments.
6. Admin configures booking channels: Airbnb, Booking.com, Vrbo, direct, agency, other.
7. Admin applies property/inventory/workflow/service templates and overrides.
8. Review validates the complete configuration.
9. Activation runs background workflows for documents, tasks, rules, and notifications.
10. Owner onboarding package is generated from configuration and delivered in approved languages.

Exceptions:

- Missing legal agreement: property cannot go live.
- Missing operating profile: workflows cannot generate.
- Missing role assignment: operational tasks cannot be assigned.
- Missing template data: property can use custom setup, but must be explicit.

### 3. Reservation To Operations

1. Scheduled iCal job fetches configured calendar feeds.
2. `ICalAdapter` parses date/event data and maps it into external reservation candidates.
3. ALVILLAS reservation normalizer creates or updates reservations in the normalized reservation model.
4. Duplicate detection checks external IDs, feed/event UIDs, date ranges, property, source, and known imported reservations.
5. Conflict detection checks double-booking and date conflicts.
6. Valid reservation enters Imported or Confirmed state according to available data and rules.
7. ReservationConfirmed event creates Guest/Stay where data exists, prepares Guest Hub link, creates workflow/tasks, and creates a financial snapshot placeholder.
8. Airbnb settlement CSV/import later supplies financial settlement data; iCal is never assumed to provide price, guest name, or payout data.

Exceptions:

- Duplicate candidate: link/merge requires explicit rule result and audit.
- Double booking: conflict is surfaced in Command Center.
- Failed sync: sync failure appears in Command Center and monitoring.
- Missing guest data: Guest Hub link can be prepared, but complete guest profile remains a guest/admin task.
- Cancellation/date change/no-show/early checkout: reservation state changes and downstream tasks/financial snapshots must be updated with audit.

### 4. Guest Hub

1. Each reservation gets a unique Guest Hub link.
2. ALVILLAS shares the link manually by WhatsApp, email, or SMS where available.
3. Guest completes profile, arrival/departure details, forms, agreement signing, house rules, service requests, chef menu, groceries, transfers, cleaning, and experiences.
4. Guest submissions create structured records: guest profile, document/signature requests, service orders, tasks, revenue/cost/allocations where applicable.

Exceptions:

- Guest ID/document handling remains subject to Phase 0 legal/privacy decisions.
- Guest agreement/house rules wording remains subject to lawyer approval.
- Missing signature provider decision blocks production signing.

### 5. Field Operations

1. Worker signs in through low-tech field authentication.
2. Field app downloads relevant work for assigned scope.
3. Worker completes one task at a time with checklists, linen, inventory, issue/photo capture, and status updates.
4. Offline operations queue locally and sync later.
5. Server validates queued operations, detects conflicts, commits, and acknowledges.
6. Supervisor can proxy validate with validator, reason, timestamp, original assignee, task, and optional note/photo.

Exceptions:

- Offline conflict: explicit resolution for critical inventory/financial operations.
- Worker cannot use app: supervisor proxy validation records performed-by and validated-by separately.
- Photo upload failure: retry and surface unresolved upload failures.

### 6. Checkout To Reconciliation

1. Checkout triggers inspection, laundry, inventory reconciliation, maintenance issues, and any final guest/service records.
2. Expected linen use, laundry cost, inventory consumption, staff compensation, and service allocations are calculated from configuration and movements.
3. Actual invoices, counts, staff payments, bank movements, and settlements are imported/entered.
4. Reconciliation applies Expected -> Actual -> Variance -> Reason -> Action.
5. Variances flow to the Variance Center and Command Center.

Exceptions:

- Missing receipt/invoice: variance remains open.
- Price change: reason/action recorded and supplier price list update may be requested.
- Inventory mismatch: damaged, missing, rejected, and lost-in-transit are distinct outcomes.

### 7. Finance, Owner Ledger, And Payout

1. Every financial event becomes an immutable transaction/movement.
2. Money ownership is recorded separately from physical location/custody.
3. Agreement rules determine commission, expenses, approvals, payout timing, service splits, and owner/ALVILLAS allocation.
4. Owner ledger is derived from movements: opening + revenue + services + reimbursements - commission - expenses - payouts +/- adjustments = closing.
5. Payout workflow follows approved payout rules and audit.
6. Owner statement is generated from source data and must tie to the ledger.
7. Accountant exports remain export-first until a later approved integration.

Exceptions:

- Unapproved owner-money legal frame blocks production owner-funds handling.
- Accountant decisions block final tax/accounting behavior and monthly close.
- Post-close edits require adjustment/void model, never silent overwrite.

### 8. Owner Portal

1. Owner sees only authorized properties.
2. Owner sees overview, reservations, revenue, expenses, money collected, money held by ALVILLAS, payouts, statements, approvals, property condition, documents, and reports according to permission.
3. Owner approves/rejects only configured approval requests.
4. Approval decisions feed ledger and audit trail.

Exceptions:

- Internal ALVILLAS information remains hidden unless explicitly granted.
- Owner statements cannot be final until accounting/legal decisions and close rules are approved.

### 9. Command Center

Command Center answers "what needs me today?" with:

- Today: arrivals, departures, turnovers, incomplete jobs.
- Exceptions: approvals, financial variances, low stock, maintenance, conflicts, failed syncs.
- Financial: revenue, expenses, cash, owner payable, ALVILLAS balance for authorized users only.
- Operations: team workload, property readiness, delayed tasks.

### 10. Personal OS Boundary

Personal OS remains a separate financial domain from ALVILLAS OS.

- Business and personal money cannot mix by accident.
- Transfers between business and personal must be explicitly categorized.
- Family permissions are separate from ALVILLAS business permissions.
- Children receive only specifically granted access.

## Draft System Events

- AssessmentSubmitted
- LeadQualified
- AgreementSigned
- PropertyActivated
- ICalSyncStarted
- ICalSyncSucceeded
- ICalSyncFailed
- ReservationImported
- ReservationConfirmed
- ReservationModified
- ReservationCancelled
- ReservationConflictDetected
- GuestHubLinkGenerated
- GuestProfileCompleted
- GuestAgreementSigned
- ServiceOrderCreated
- TaskCreated
- TaskCompleted
- OfflineOperationQueued
- OfflineOperationSynced
- ProxyValidationRecorded
- InventoryBelowMinimum
- LaundryBatchCreated
- ExpenseSubmitted
- ApprovalRequested
- ApprovalApproved
- ApprovalRejected
- SettlementImported
- ReconciliationVarianceDetected
- PayoutPrepared
- PayoutCompleted
- OwnerStatementGenerated
- AuditEventRecorded

## Assumptions

- Phase 1 can draft from the Master Specification even though Phase 0 is not complete, but checklist completion stays gated.
- V1 calendar sync uses iCal and does not research PMS/channel-manager options.
- iCal supplies calendar availability/date data only; pricing, guest name, and payout data come from other sources such as Airbnb settlement CSV/import or manual entry.
- Guest Hub is structured self-service, not chat.
- WhatsApp remains manual/human in V1.
- Reports and dashboards are derived from source data, not manually built spreadsheets.

## Unresolved Decisions

- Final MVP cut and measurable success metrics are not approved.
- First property templates for Villa 405 and Villa Sultan are not defined.
- Legal agreements, guest registration, privacy, retention, signature level, tax/accounting treatment, export formats, and close rules remain unresolved.
- Exact service tiers/cost ceiling and some technical confirmations remain unresolved.

## Acceptance Criteria

- Every required persona is represented.
- Every major journey is mapped end to end: owner acquisition, onboarding, booking, stay, checkout, payout, month close.
- Exception paths cover cancellation, early checkout, no-show, conflict, failed sync, missing receipt, and price change.
- System map includes Public Website, Admin, Operations, Finance, Owner Portal, Guest Hub, Field App, Command Center, and Personal OS boundary.
- No internal messaging app is introduced.
- All external systems remain adapters or delivery channels, not the ALVILLAS source of truth.
- Blueprint is reviewed with the people who do the work and tested on paper against real Villa 405 and Villa Sultan data before checklist completion.
