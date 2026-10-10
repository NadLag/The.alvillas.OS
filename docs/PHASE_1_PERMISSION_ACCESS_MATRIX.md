# Phase 1 Blueprint: Permission / Access Matrix

Status: verified draft blueprint for review. This document is documentation only and does not mark the Phase 1 exit gate complete. The final permission matrix must be reviewed and tested with concrete users, properties, and financial examples before the phase gate passes.

## Source Traceability

- Master Specification sections 08-16: identity, custom roles, multiple roles, RBAC, ABAC, data scoping, field-level security, permission simulator.
- Sections 17-18: invitation-controlled registration and low-tech authentication.
- Sections 23-25: proxy validation and team wallets.
- Sections 26-35 and 50-62: financial data, ledgers, reconciliation, reports, audit, financial integrity.
- Sections 37, 56-59, 63-69: Guest Hub, Owner Portal, reports, KPIs, Personal OS, Command Center, notifications, no internal messaging.
- Sections 74 and 78: organization root tenant and security principles.
- Non-negotiable principles 11-15, 18-20, 21, 24.

## Approved Decisions Used

- P0-13: ALVILLAS OS is an independent clean-room product.
- P0-14: no internal chat; manual WhatsApp plus Guest Hub links; iCal-first synchronization with adapter boundaries.
- P0-15: full production scope is preserved across all 17 phases.
- P0-16 through P0-18: FR/EN V1, Arabic/RTL-ready, MAD primary, multicurrency-capable money models, and V1 payment methods.
- P0-19: separate configurable Villa 405 and Sultan's House templates; no real property details invented.
- P0-20: every Master Specification KPI is in scope with configurable targets.
- P0-21, P0-22, and P0-24: locked stack, managed-service architecture, and mandatory provider/adaptor boundaries.
- P0-23 partial: self-hosted Documenso is preferred but legal/security/maintenance decisions remain open.
- P0-25: no fixed infrastructure ceiling; paid-service approvals are case by case.

## Core Authorization Principles

- Deny by default.
- Server-side authorization is required on every route/action.
- UI hiding is not authorization.
- Role does not equal data access.
- Operational access does not imply financial access.
- A person can have multiple scoped role assignments.
- Custom roles are first-class.
- Field-level security applies even when a user can view a record.
- Sensitive actions must be audited.
- Permissions are scoped by organization first, then narrower scopes.

## Identity Model

| Concept | Meaning |
|---|---|
| Person | Real human or contact. Can exist without an account. |
| UserAccount | Authentication capability for a person. |
| Role | Reusable set of allowed actions. |
| RoleAssignment | Role + person + scope + conditions + optional compensation. |
| Permission | Action allowed for a role under conditions. |
| DataScope | Organization, city/region, property, owner, reservation, service, task, team, wallet, document, or financial record scope. |
| FieldPolicy | Field-level allow/mask/deny policy for sensitive data. |
| AuditEvent | Append-only record of sensitive activity. |

## Permission Dimensions

Every permission must answer:

- WHO: person, user account, role, assignment.
- WHAT: view, create, edit, void, approve, reject, assign, validate, export, pay, reconcile, configure, override.
- WHERE: organization, city, property, owner, reservation, service, task, team, wallet.
- WHICH DATA: operational, guest, financial, personal, sensitive.
- WHEN/CONDITIONS: assignment active, date range, approval threshold, emergency condition, ownership, task assignment, property scope.

## Data Classes

| Class | Examples | Default stance |
|---|---|---|
| Operational | tasks, checklists, inspections, maintenance status, inventory work, property readiness | Role and scope required. |
| Guest | guest profile, arrival/departure details, Guest Hub forms, guest communication notes | Role, property/reservation scope, and purpose required. |
| Financial | revenue, expenses, commissions, payouts, owner balances, ALVILLAS balances, bank/cash/wallet movements | Explicit financial permission required. |
| Personal | person details, staff documents, compensation, family data | Explicit HR/admin or personal-domain permission required. |
| Sensitive | ID documents, signed contracts, bank data, salaries, sensitive documents, security/audit records | Explicit permission, signed URL/document control where applicable, audit required. |

## Scope Hierarchy

Organization -> Region/City -> Property -> Owner -> Reservation -> Job/Task -> Service -> Financial Record -> Wallet -> Document.

Scopes are additive only through explicit assignments. A broad operational assignment still does not grant financial fields unless financial data class permissions are also granted.

## Baseline Role Matrix

This is a draft matrix. It defines starting expectations, not final approvals.

| Role | Typical scope | Operational data | Guest data | Financial data | Sensitive data | Notes |
|---|---|---|---|---|---|---|
| Admin | Organization | Full by configuration | Full by configuration | Full by configuration | Full by configuration | Highest risk; MFA/passkey; all sensitive actions audited. |
| Operations Manager | City/portfolio | View/create/edit/assign/validate operational work | View relevant guest stay details | Masked by default unless explicitly granted | Limited | Can manage work without default revenue/profit access. |
| Property Manager | Assigned properties | View/create/edit/assign tasks/issues/workflows | View guests for assigned reservations | Masked by default; explicit approval/expense fields only as configured | Limited | Strong example of operational access not implying financial access. |
| Co-host | Assigned properties/reservations | View reservations, guests, tasks, services, issues | View relevant guest details | No portfolio revenue/profit/owner payouts by default | Limited | Matches Master Spec co-host example. |
| Guest Experience | Assigned reservations/properties | View Guest Hub status, service requests, notes | View/edit guest profile and arrival/departure where needed | No financials except service price if explicitly needed | Limited | Cannot see owner/company profit. |
| Housekeeper | Assigned tasks/properties | View/update assigned jobs, checklists, linen/inventory use, issues/photos | Minimal stay context only | No | No | Mobile field UX; offline queue allowed. |
| Pool Technician | Assigned pool jobs/properties | View/update assigned pool tasks and issues/photos | No or minimal stay context | No | No | No unrelated property/task access. |
| Gardener | Assigned garden jobs/properties | View/update assigned garden tasks and issues/photos | No or minimal stay context | No | No | Simple mobile access. |
| Chef | Assigned chef/service jobs | View/update assigned service prep tasks | Minimal guest preferences/allergens if needed | No margin/cost by default | Limited | Service orders can generate tasks and costs; financial visibility explicit only. |
| Driver | Assigned transfer jobs | View assigned transfer task and arrival/departure logistics | Minimal guest contact/logistics if needed | No | No | No reservation financials. |
| Maintenance | Assigned work orders/properties | View/update assigned work orders, photos, estimates if configured | Minimal context | Cost fields masked unless explicitly granted | Limited | Approval thresholds may route to manager/owner. |
| QA Inspector | Assigned inspections/properties | View/update inspections, photos, readiness, issues | Minimal stay context | No by default | Limited | Can validate quality but not finances. |
| Finance | Organization/portfolio/property | View relevant operational references | View guest/reservation references needed for finance | View/create/reconcile/export/pay as assigned | Limited sensitive | Requires MFA; high audit coverage. |
| Accountant | Organization/portfolio/export scope | View operational references needed for accounting | Limited as needed | Export/reconcile/report as assigned | Limited | May receive CSV/Excel/PDF exports; direct system access scoped. |
| Procurement | Organization/property/supplier | View supplier, purchase, stock, price lists | No by default | Supplier costs if granted | Limited | Cannot see owner payouts unless granted. |
| Revenue Manager | Portfolio/property | View reservations/calendar/occupancy | Limited | ADR/RevPAR/revenue metrics if granted | No by default | No bank/cash/wallet access by default. |
| Contractor | Assigned work order | View/update assigned work only | No | No | No | Temporary, narrow scope, expiry required. |
| Owner | Owned properties only | View property condition, reservations, approvals | Limited guest details as configured | Own revenue/expenses/money held/payouts/statements | Own docs only | Internal ALVILLAS data hidden unless explicitly granted. |
| Owner Representative | Owner/property scope | Same as delegated owner permissions | Same as delegated owner permissions | Same as delegated owner permissions | Same as delegated owner permissions | Delegation must be explicit and audited. |
| Guest | Own reservation/Guest Hub | Guest-facing stay info | Own profile/forms | Own charges/services where shown | Own docs/forms | No ALVILLAS internal workspace access. |
| Family Member | Personal OS scope | Personal OS only unless separately granted business role | Personal domain only | Personal domain only | As configured | Business access configured separately. |

## Field-Level Restrictions

Restricted by default:

- Revenue
- Profit
- Commissions
- Salaries
- Staff compensation
- Wallet balances and movements
- Supplier costs
- Owner payouts
- Bank balances
- Cash balances
- Owner money held by ALVILLAS
- ALVILLAS profitability
- Guest ID documents
- Signed contracts
- Audit records
- Signature provider administration
- Infrastructure cost and subscription settings
- Provider credentials and integration secrets

Field policy options:

- Deny field entirely.
- Mask value, for example amount hidden.
- Allow read only.
- Allow create/edit with approval.
- Allow export only to authorized role.

## Delegation And Proxy Validation

Delegation:

- Owner representatives and temporary workers require explicit assignment, scope, start/end dates, and audit.
- Delegated access must never exceed the grantor's approved scope.
- Family access to Personal OS is separate from ALVILLAS OS business access.

Proxy validation:

- Supervisor can validate on behalf of an assigned worker only when allowed.
- Required fields: validator, reason, timestamp, original assignee, task, optional note/photo.
- Record must show performed-by and validated-by separately.
- Proxy validation applies to cleaning, maintenance, pool, garden, chef, inspections, inventory, and other operational jobs.
- Proxy validation must not falsely attribute the original work to the validator.

## Audit Requirements

Audited events include:

- Permission changes
- Role assignments
- Invitation creation/use
- Account access for sensitive users
- Financial edits, voids, adjustments
- Payouts
- Approvals/rejections
- Proxy validations
- Agreement changes
- Expense modifications
- Wallet adjustments
- Bank reconciliations
- Report generation/export
- Document access/signature events
- Sync failures and conflict resolutions

Audit record fields:

- actor person/account
- role assignment used
- action
- target record
- scope
- before/after where applicable
- reason where applicable
- timestamp
- source IP/device where available
- correlation/event ID

Audit logs are append-only and viewable only by authorized users.

## Worked Examples

### Co-host - Villa Sultan

Can see:

- Assigned Villa Sultan reservations
- Assigned Villa Sultan guests needed for operations
- Tasks, issues, services, property readiness
- Guest Hub completion status

Cannot see unless explicitly granted:

- Portfolio revenue
- Owner profitability
- ALVILLAS profitability
- Other properties
- Other staff wallets
- Salaries
- Company bank accounts

### Property Manager - Villa 405

Can:

- Manage assigned property tasks, issues, inspections, and workflow status.
- Assign workers inside configured scope.
- View reservation dates and operational readiness.
- Trigger owner approval request where configured.

Cannot by default:

- View owner payout details.
- View ALVILLAS profit.
- Export financial reports.
- Reconcile bank or settlement data.

### Pool Worker

Can:

- Sign in with phone + PIN.
- See today's assigned pool jobs.
- Complete checklist, add photos/notes, report issue.
- Work offline and sync later.

Cannot:

- View guest financials, owner data, other workers' jobs, unrelated properties, or wallets.

### Owner

Can:

- See only owned/authorized properties.
- View own reservations, revenue, expenses, money collected, money held, payouts, statements, approvals, documents, and reports as configured.
- Approve/reject configured requests.

Cannot:

- See internal ALVILLAS margin, staff compensation, other owners, other properties, company bank balances, or unrelated audit logs unless explicitly granted.

### Accountant

Can:

- Access approved exports and accounting reports.
- Reconcile or review transactions if granted.
- View financial data needed for accounting scope.

Cannot by default:

- Change operational workflows.
- Change permissions.
- Access guest ID documents unless required and approved.

## Permission Simulator Requirements

Admin can preview access as a user:

- Select person.
- Select role assignment.
- Show CAN SEE and CANNOT SEE by module, action, data class, scope, and fields.
- Show masked fields distinctly.
- Never mutate real permissions or data.
- Produce an audit event for simulator use if sensitive records are inspected.

## Assumptions

- Custom roles use the same permission dimensions as standard roles.
- Financial access must be explicit even for managers.
- Owner access is scoped to owned/authorized properties.
- Guest access is reservation-scoped and link/account scoped.
- Personal OS and ALVILLAS OS remain separate financial domains.
- Provider administration, paid-service configuration, and signature operations are sensitive administrative permissions and require explicit grants.
- KPI dashboards inherit field-level financial restrictions; a user can see only KPI values backed by data they are authorized to view.

## Unresolved Decisions

- Final legal/privacy decisions may add restrictions for guest ID documents and sensitive documents.
- Accountant decisions may add export permissions and close/reopen restrictions.
- Final signature-level, certificate/trust, Documenso maintenance, and security decisions may add signature administration permissions.
- Real Villa 405 and Sultan's House staff assignments, owner representatives, and property-specific permission examples are not yet supplied.
- Paid-service administration permissions may be refined when services and account ownership are activated.

## Acceptance Criteria

- Every standard role and the custom-role mechanism are represented.
- Actions include view, create, edit, void, approve, reject, assign, validate, export, pay, reconcile, configure, override.
- Data scopes include organization, city, property, owner, reservation, service, task, team, wallet.
- Data classes include operational, guest, financial, personal, sensitive.
- Field-level restrictions cover revenue, profit, commissions, salaries, wallets, supplier costs, owner payouts, and bank balances.
- Worked examples cover co-host, property manager, pool worker, owner, and accountant.
- Deny-by-default and operational-vs-financial separation are testable.
- Matrix is reviewed and paper-tested before checklist completion.
