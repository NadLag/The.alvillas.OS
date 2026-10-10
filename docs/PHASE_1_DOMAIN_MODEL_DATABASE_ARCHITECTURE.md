# Phase 1 Blueprint: Domain Model / Database Architecture

Status: draft blueprint for review. This document is documentation only and does not create schema, migrations, dependencies, infrastructure, or application code.

## Source Traceability

- Master Specification sections 08-18: identity, role assignment, authorization, registration, authentication.
- Sections 19-25: field app, offline operations, proxy validation, team wallets.
- Sections 26-35 and 50-62: transaction model, money ownership/location, owner money held by ALVILLAS, expenses, commission, approvals, payouts, ledgers, finance, bank/cash, reconciliation, variance, reports, audit, financial integrity.
- Sections 37-42: Guest Hub, reservations, lifecycle, automation, property operating profile.
- Sections 43-49: inventory, laundry, maintenance, assets, suppliers/team.
- Sections 56-69: owner portal, approvals, reports, KPIs, documents, audit, Personal OS, Command Center, work management, notifications, no internal messaging.
- Sections 73-79: technology stack, organization root tenancy, database principles, configuration, event architecture, security, scalability.
- Technology & Architecture Decisions v1.1 sections 2-6, 8-21, 29-30.
- P0-14 approved owner decision: iCal-first V1, no PMS/channel manager in V1.

## Architecture Principles

- PostgreSQL is the relational source of truth.
- Prisma is the planned ORM, pending P0-21 confirmation.
- Organization is the root tenant on every tenant-owned table.
- Business logic must not depend directly on external provider SDKs.
- External integrations flow: external source -> adapter -> normalized ALVILLAS domain -> workflows/reports.
- Important rules are configurable, scoped, effective-dated, versioned, and auditable.
- Financial data is append-only through movements/transactions; no financial hard deletes.
- Money ownership is separate from physical money location/custody.
- Expected -> Actual -> Variance -> Reason -> Action is the reconciliation pattern.
- Offline operations use a local queue, server validation, conflict detection, commit, and acknowledgement.

## Tenancy And Identity Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| Organization | Root tenant. | Owns all tenant data. |
| Region | Optional grouping for cities/properties. | Belongs to Organization. |
| City | Operational geography. | Belongs to Organization/Region. |
| Person | Real human/contact; may not authenticate. | Linked to Owner, Guest, Staff, Supplier contact, UserAccount. |
| UserAccount | Authentication identity. | Belongs to Person and Organization. |
| Role | Reusable permission bundle. | Assigned through RoleAssignment. |
| Permission | Action/data/scope capability. | Belongs to Role or custom role. |
| RoleAssignment | Person + role + scope + conditions. | Links Person, Role, Organization, scope records, compensation where applicable. |
| Invitation | Account activation workflow. | Links Person, inviter, role assignment, one-time code. |
| SessionCredential | Auth/session metadata. | Links UserAccount, device/session, risk controls. |
| DataAccessPolicy | Field/data class rules. | Applies to roles/assignments/data classes. |

Design note: RoleAssignment must support multiple active roles per person and compensation per assignment.

## Owner, Property, And Onboarding Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| Lead | Owner acquisition pipeline record. | May become Owner and Property. |
| Owner | Business owner account/contact domain. | Owns or is linked to Properties and Agreements. |
| OwnerContact | Contact details/preferences. | Belongs to Owner/Person. |
| Property | Managed villa/property. | Belongs to Organization, City, Owner relationship. |
| PropertyOwner | Many-to-many owner/property link. | Supports multiple owners if needed. |
| PropertyTemplate | Reusable setup defaults. | Applied to Property with overrides. |
| OperatingProfile | Services/workflow configuration for a property. | Belongs to Property and versioned config. |
| ManagementAgreement | Commercial/legal agreement shell. | Belongs to Owner/Property, versioned. |
| AgreementVersion | Immutable agreement version/effective dates. | Links DocumentVersion and rule snapshots. |
| OwnerApprovalRule | Configurable approval requirement. | Scoped by Owner/Property/category/threshold. |
| PayoutRule | Configurable payout schedule/model. | Scoped by Owner/Property/agreement. |

Unresolved: final agreement wording, legal approval, and property templates for Villa 405/Villa Sultan.

## Reservation And Calendar Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| BookingChannel | Airbnb, Booking.com, Vrbo, direct, agency, other, manual. | Referenced by Reservation and feed/source records. |
| ReservationSourceAccount | Channel/source account or manual source config. | Belongs to Organization/Property. |
| ICalFeed | V1 calendar feed configuration. | Belongs to Property and source account. |
| CalendarSyncRun | Scheduled iCal sync execution. | Links feed, status, started/finished, error summary. |
| CalendarSyncEvent | Parsed feed event/candidate. | Links sync run, raw UID, date range, normalized candidate. |
| ExternalReservationMapping | External IDs/UIDs mapped to Reservation. | Enables idempotency and duplicate detection. |
| Reservation | Normalized reservation model. | Belongs to Organization, Property, BookingChannel, optional Guest/Owner. |
| ReservationStatusHistory | State transitions. | Belongs to Reservation. |
| ReservationDateRange | Check-in/checkout and date changes. | Belongs to Reservation. |
| ReservationConflict | Double-booking/date/source conflict. | Links conflicting reservations/feed events. |
| SyncFailure | Failed sync or import issue. | Links feed/sync run/source and Command Center exception. |
| Stay | Operational stay derived from reservation. | Links Reservation, Property, Guest(s), workflows. |
| Guest | Guest person/domain record. | Links Person, Reservation, GuestHubProfile. |
| GuestHubLink | Unique per-reservation shareable link. | Belongs to Reservation/Guest, status, expiry if configured. |

P0-14 V1 constraints:

- iCal is the first synchronization mechanism.
- iCal must not be assumed to provide price, complete guest details, payout, settlement, platform fees, or owner allocation.
- Airbnb settlement CSV/import is separate financial source data.
- No PMS/channel-manager entity or integration is required for V1.

## Guest Hub And Services Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| GuestProfile | Guest-entered profile and stay details. | Belongs to Guest/Reservation. |
| GuestFormSubmission | Required forms and structured requests. | Belongs to Guest/Reservation. |
| HouseRuleAcceptance | Guest acceptance record. | Links Guest, Reservation, document/version. |
| GuestAgreementSignature | Signature workflow reference. | Links DocumentInstance/Signature. |
| ServiceCatalogItem | Configurable service. | Scoped by property, pricing/rules. |
| ServiceOrder | Guest/admin ordered service. | Links Reservation, Guest, tasks, revenue/cost allocations. |
| ChefMenuItem | Configurable chef item. | Scoped by property/chef/availability. |
| ChefSelection | Guest chef menu selection. | Creates service order, ingredient needs, tasks, allocations. |

Unresolved: guest ID handling, guest agreement wording, signature level, and privacy/retention rules.

## Operations, Work, And Offline Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| WorkflowTemplate | Standard workflow definition. | Scoped by organization/property template. |
| WorkflowInstance | Workflow generated for reservation/stay/property. | Owns tasks. |
| Task | Work item for staff/team. | Links property, reservation/stay, service, issue, assignee. |
| TaskAssignment | Assignment history. | Links Task, Person, RoleAssignment. |
| ChecklistTemplate | Reusable checklist. | Used by task/workflow. |
| ChecklistCompletion | Completed task/checklist evidence. | Links task, user, timestamp, answers. |
| ProxyValidation | Supervisor validation on behalf. | Links task, original assignee, validator, reason. |
| Issue | Operational issue. | Links property, reservation, guest, task, person, supplier, expense, asset, photo, document. |
| WorkOrder | Maintenance/vendor work. | Links issue, supplier/person, estimate, approval, actual cost, evidence. |
| OfflineOperation | Queued offline action. | local_id, user_id, device_id, operation, payload, sync_status. |
| OfflineSyncAttempt | Server sync processing attempt. | Links operations, validation result, conflicts. |
| OfflineConflict | Explicit conflict to resolve. | Links competing operations/records. |

Offline operation examples:

- TaskCompleted
- IssueCreated
- LinenUpdated
- InventoryAdjusted
- PhotoAdded

## Inventory, Laundry, Assets, And Team Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| InventoryItem | Consumable, linen, or asset item. | Belongs to Organization/Property/location. |
| InventoryLocation | Property/storage/team location. | Holds movement references. |
| InventoryMovement | Immutable movement ledger. | purchase, transfer, consumption, laundry send/return, damage, loss, disposal, adjustment, reservation, release. |
| LaundryBatch | Batch of linen sent/returned. | Links stay/property/supplier/invoice/variance. |
| LaundryLine | Item counts/status. | sent, returned, damaged, missing, rejected, lost in transit. |
| Supplier | Supplier/vendor record. | Links documents, price lists, invoices, work orders. |
| SupplierPriceList | Versioned prices. | Effective dates, service/item scope. |
| Asset | Long-life physical item. | property, purchase cost/date, warranty, condition, maintenance. |
| PreventiveMaintenanceSchedule | Recurring asset/property maintenance. | Creates work orders/tasks. |
| TeamProfile | Staff/team details. | Links Person, assignments, availability, wallet. |
| Availability | Person/team availability. | Used for scheduling. |
| CompensationRule | Assignment-based compensation. | Links RoleAssignment/property/effective dates. |

## Financial Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| Account | Physical location/custody of money: bank, cash, staff wallet, configured account. | Belongs to Organization and optionally Person/Property. |
| Wallet | Person wallet as movement ledger. | Links Person and wallet movements. |
| TransactionGroup | Groups related financial movements. | Reservation, service order, payout, reconciliation, adjustment. |
| Transaction | Immutable financial event. | date, amount, account, owner, property, reservation, guest, person, supplier, category, source, payment method, ownership, status, document, approval, group, audit. |
| EconomicOwner | Who money belongs to. | Owner, ALVILLAS, supplier, staff/person, other configured party. |
| MoneyCustodyTransfer | Movement of physical/custody location. | guest -> staff -> ALVILLAS, bank -> wallet, bank -> owner. |
| PaymentMethod | Airbnb settlement, cash, PayPal, bank transfer, manual, future provider. | Referenced by transactions. |
| SettlementImport | Imported settlement file/run. | Airbnb payout/transaction CSV early. |
| SettlementLine | Settlement row. | Links expected/actual reservation/service/payment data. |
| Reconciliation | Expected vs actual comparison. | OTA settlement, bank, laundry invoice, staff compensation, owner payout, inventory count. |
| Variance | Exception record. | Expected, actual, difference, reason, action, resolved_by, date. |
| OwnerLedgerEntry | Derived/reporting view from transactions. | Not editable balance. |
| Payout | Owner/staff/supplier payout workflow. | Links rules, transactions, approvals, bank movement. |
| ApprovalRequest | Approval workflow. | Owner expense, payout, maintenance, other thresholds. |
| TaxRule | Configurable tax hook. | Scoped by property/service/transaction/effective dates. |
| TaxRate | Configurable rate. | Accountant-approved values only. |
| TaxCategory | Configurable category. | No hard-coded Moroccan tax logic. |

Financial invariants:

- Every important balance is derived from movements.
- No manual balance editing.
- Transactions are voided or adjusted, not deleted or silently edited.
- Each reservation keeps the financial rule snapshot applicable at the time.
- Owner ledger and ALVILLAS ledger remain distinct.

## Documents, Signatures, Audit, And Reporting Entities

| Entity | Purpose | Key relationships |
|---|---|---|
| Document | Logical document record. | Owner contracts, guest agreements, invoices, receipts, reports, property/supplier/staff documents. |
| DocumentTemplate | Template definition. | Versioned and scoped. |
| DocumentVersion | Immutable version. | Effective dates, status, source template. |
| DocumentInstance | Generated document for owner/property/reservation. | Links storage object and version. |
| SignatureRequest | Signature workflow. | Links document instance and provider. |
| Signature | Signature result/certificate reference. | Links signed PDF and audit. |
| StoredObject | File storage metadata. | R2/provider abstraction, signed URL policy. |
| ReportDefinition | Report template/parameters. | Owner/property/company/team/inventory reports. |
| ReportRun | Generated report. | Links requester, filters, document instance, audit. |
| AuditLog | Append-only audit event. | who, what, when, where, before, after, reason. |

## Configuration And Rules

Configuration records must include:

- value
- scope
- effective_from
- effective_to
- version
- created_by
- audit link

Configurable areas:

- commission
- OTA fee treatment
- owner expense treatment
- approval thresholds
- payout schedule
- staff compensation
- laundry pricing
- inventory minimums
- workflows
- service pricing
- tax hooks
- operating rules

## State Machines

### Reservation

Imported -> Confirmed -> Guest Preparation -> Check-in -> Staying -> Checkout -> Financial Reconciliation -> Closed.

Additional transitions:

- Modified
- Cancelled
- Refunded
- Early checkout
- No-show
- Date changed
- Conflict detected

### Task

Created -> Assigned -> In Progress -> Completed -> Validated -> Closed.

Exception states:

- Blocked
- Needs Review
- Reopened
- Proxy Validated

### Approval

Requested -> Pending -> Approved or Rejected -> Applied/Closed.

Exception states:

- Expired
- Cancelled
- Escalated

### Payout

Draft -> Pending Approval -> Approved -> Scheduled -> Paid -> Reconciled -> Closed.

Exception states:

- Failed
- Reversed
- Adjusted

### Document

Draft -> Generated -> Sent For Signature -> Signed -> Archived.

Exception states:

- Voided
- Superseded
- Rejected

### Laundry Batch

Created -> Sent -> Returned -> Invoice Entered -> Reconciled -> Closed.

Exception states:

- Damaged
- Missing
- Rejected
- Lost In Transit
- Variance Open

### Work Order

Opened -> Assigned -> Estimate Submitted -> Approval Required/Approved -> In Progress -> Completed -> Invoiced -> Reconciled -> Closed.

### Variance

Detected -> Investigating -> Action Selected -> Resolved -> Closed.

## iCal Sync Design

V1 scheduled flow:

1. Scheduler triggers iCal sync job per active feed.
2. Job records CalendarSyncRun.
3. Adapter fetches feed and parses events.
4. Each event is stored as CalendarSyncEvent with raw identifiers/date range/source metadata.
5. Normalizer maps event into a reservation candidate.
6. Duplicate detection uses external UID, feed/source, property, date range, known mappings, and reservation state.
7. Conflict detection checks overlapping reservations for the same property.
8. Valid candidate creates/updates Reservation and ExternalReservationMapping.
9. Failures create SyncFailure and Command Center exception.
10. Reservation events trigger workflow generation and Guest Hub link preparation.

Explicit limitations:

- Do not infer price from iCal.
- Do not infer guest name from iCal.
- Do not infer payout/settlement/platform fees from iCal.
- Do not treat iCal as financial source data.

## Airbnb Settlement Import Design

V1 financial flow:

1. User imports Airbnb payout/transaction CSV or equivalent export.
2. SettlementImport records file metadata, importer, source, and status.
3. SettlementLine records row-level data and mapping status.
4. Reconciliation links settlement lines to expected reservation/service/payment records.
5. Variance records differences between expected and actual settlement.
6. Approved/reconciled settlement lines create or link immutable transactions.

Unresolved: actual Airbnb CSV sample, column names, currency handling, fee/tax fields, and accountant-approved treatment.

## Index Plan

High-frequency indexes should cover:

- organization_id
- property_id
- owner_id
- reservation date ranges
- reservation status
- booking channel/source
- external reservation mapping IDs
- sync run status/feed ID
- transaction date
- transaction type/category
- account_id
- economic owner
- person_id
- supplier_id
- task status
- task assignee
- inventory location
- laundry status
- approval status
- audit target/action/timestamp

## API And Report Contracts To Define Next

Draft API contract groups:

- CRM/lead intake
- Property onboarding
- Reservation import/sync
- Guest Hub
- Workflow/task operations
- Offline sync
- Inventory/laundry/maintenance
- Financial transactions/reconciliation
- Owner portal
- Documents/signatures
- Reports/exports
- Permission simulator

Report templates:

- Owner monthly statement
- Owner annual statement
- Property P&L
- Occupancy/ADR/RevPAR
- ALVILLAS company P&L
- Team productivity/compensation
- Inventory/laundry variance
- Bank reconciliation
- Accountant exports

## Backup And Disaster Recovery Parameters To Define

The final backup/DR parameters are not approved yet. Design must support:

- PostgreSQL backups and tested restore.
- Object storage backup/retention strategy.
- Document and signed PDF preservation.
- Audit log preservation.
- Recovery of scheduled jobs/sync state.
- Recovery test evidence before production.

## Assumptions

- PostgreSQL + Prisma are the design target from the Master Specification, pending final P0-21 approval.
- Provider abstractions are treated as required in the blueprint, pending P0-24 approval.
- V1 reservation synchronization is iCal-first and no PMS/channel manager is used.
- Tax/accounting rules are modeled as configurable hooks, not hard-coded rules.
- Legal/privacy decisions will refine document retention, guest ID handling, and signature requirements.

## Unresolved Decisions

- P0-11 tax confirmation and accountant validation.
- P0-15 MVP cut.
- P0-16 languages.
- P0-17 currency approval.
- P0-18 payment methods approval.
- P0-19 first property templates.
- P0-20 success metrics.
- P0-21 stack confirmation.
- P0-22 services confirmation.
- P0-23 signature deployment and maintainer.
- P0-24 provider abstractions confirmation.
- P0-25 infrastructure cost ceiling.
- Legal/accounting decisions P0-01 through P0-10 and P0-12 where dependent.

## Acceptance Criteria

- Entity list covers owner, property, reservation, guest, person, user account, role, role assignment, task, transaction, ledger, payout, document, audit, and supporting domains.
- Financial model separates ownership from physical money location/custody.
- Owner ledger formula is represented as derived from immutable transactions.
- State machines cover reservation, task, approval, payout, document, laundry batch, work order, and variance.
- OTA/iCal model includes duplicate and conflict detection rules.
- Offline synchronization includes queue fields, server validation, and explicit conflict resolution.
- Automation uses event -> rule -> action.
- Configuration, agreements, price lists, and documents are versioned.
- Index plan covers high-frequency queries.
- API/report/backups are identified for detailed specification.
- Blueprint is reviewed and paper-tested against real Villa 405 and Villa Sultan data before checklist completion.
