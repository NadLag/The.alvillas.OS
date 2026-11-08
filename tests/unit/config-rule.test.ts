import { describe, expect, it, vi } from "vitest";
import {
  ConfigRuleRepository,
  sortConfigRulesForResolution,
  type ConfigRuleRecord
} from "@/platform/config/config-rule-repository";
import type { TenantTransaction } from "@/platform/db/tenant";
import {
  commissionConfigKey,
  configRuleSchemas,
  parseConfigRuleValue,
  reservationTaskTemplatesConfigKey,
  schemaForConfigKey
} from "@/platform/config/rule-registry";

function rule(input: Omit<Partial<ConfigRuleRecord>, "effectiveFrom"> & {
  scopeType: string;
  effectiveFrom: string;
  version: number;
}): ConfigRuleRecord {
  return {
    id: input.id ?? crypto.randomUUID(),
    key: input.key ?? commissionConfigKey,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    value: input.value ?? {
      rate_bps: 1500,
      basis: "GROSS_ACCOMMODATION",
      accrual_event: "ON_RECEIPT"
    },
    effectiveFrom: new Date(input.effectiveFrom),
    effectiveTo: input.effectiveTo ?? null,
    version: input.version,
    createdBy: input.createdBy ?? null,
    reason: input.reason ?? "Unit test",
    lifecycle: input.lifecycle ?? "ACTIVE"
  };
}

describe("config rule registry", () => {
  it("validates the full configurable business-rule catalog without embedding business values", () => {
    expect(Object.keys(configRuleSchemas).sort()).toEqual([
      "agreement.notice",
      "agreement.responsibilities",
      "agreement.special_conditions",
      "crm.lead_capture",
      "crm.lead_conversion",
      "crm.lead_profile",
      "crm.lead_work",
      "crm.pipeline",
      "documents.archive",
      "documents.expiry_reminders",
      "documents.retention",
      "documents.signatures",
      "feature_flag",
      "field.device_hygiene",
      "field.upload_lifecycle",
      "finance.accountant_exports",
      "finance.accounting_periods",
      "finance.approval_thresholds",
      "finance.bank_statements",
      "finance.commission",
      "finance.company_expenses",
      "finance.expense_allocation",
      "finance.expense_treatment",
      "finance.guest_deposits",
      "finance.ledger_integrity",
      "finance.ota_fee",
      "finance.payment_methods",
      "finance.payout_schedule",
      "finance.receivable_aging",
      "finance.receivable_assignments",
      "finance.receivable_collections",
      "finance.receivable_exports",
      "finance.receivable_reminders",
      "finance.receivables",
      "finance.recurring_company_expenses",
      "finance.recurring_expenses",
      "finance.service_allocation",
      "finance.tax",
      "finance.transaction_attachments",
      "identity.pin_lockout",
      "inventory.minimums",
      "notification.digest.delivery_policy",
      "notification.email.delivery_policy",
      "notification.push.delivery_policy",
      "notification.routing.approval_decided",
      "notification.routing.approval_requested",
      "notification.routing.document_expiring",
      "notification.routing.language_updated",
      "notification.routing.lead_reminder",
      "notification.routing.ledger_integrity_failed",
      "notification.routing.receivable_reminder",
      "notification.routing.reservation_created",
      "notification.routing.security_session_revoked",
      "notification.routing.staff_document_expiring",
      "notification.routing.task_assigned",
      "notification.routing.task_completed",
      "notification.routing.task_overdue",
      "operations.laundry_pricing",
      "ops.checklists",
      "ops.mid_stay_threshold",
      "ops.operating_rules",
      "ops.recurring_tasks",
      "ops.reservation_task_templates",
      "ops.task_policy",
      "ops.workflows",
      "reservation.sync_policy",
      "services.pricing",
      "staff.compensation",
      "staff.compensation_hourly_earnings",
      "staff.compensation_hourly_runs",
      "staff.compensation_monthly_earnings",
      "staff.compensation_percentage_earnings",
      "staff.compensation_percentage_runs",
      "staff.compensation_runs",
      "staff.management_policy"
    ]);

    expect(schemaForConfigKey("feature_flag.owner_portal")).toBeTruthy();
  });

  it("parses known config values and rejects unregistered keys", () => {
    const attachments={source:"ORIGINAL_SEALED_FINANCIAL_TRANSACTION",content_types:["application/pdf"],max_bytes:102400,intent_lifetime_seconds:600,storage_read_ttl_seconds:60,encryption:"APP_MANAGED_AUTHENTICATED_ENCRYPTION",history:"APPEND_ONLY_WITH_RETAINED_SUPERSEDED_FILES",rate_limit:{requests:10,window_seconds:60}};
    expect(parseConfigRuleValue("finance.transaction_attachments",attachments)).toEqual(attachments);
    expect(()=>parseConfigRuleValue("finance.transaction_attachments",{...attachments,encryption:"NONE"})).toThrow();
    const accountant={source:"ORIGINAL_POSTED_FINANCIAL_SOURCES",reports:["TRANSACTIONS","INCOME","EXPENSES","OWNER_STATEMENTS","BANK_RECONCILIATION","SUPPLIER_PAYMENTS","STAFF_PAYMENTS"],formats:["CSV","EXCEL","PDF"],
      classifications:{income:{buckets:["EXPLICIT_INCOME_BUCKET"],account_types:["ALVILLAS_OWN"],sides:["CREDIT"]},expenses:{buckets:["EXPLICIT_EXPENSE_BUCKET"],account_types:["ALVILLAS_OWN"],sides:["DEBIT"]}},
      capacity:{CSV:100,EXCEL:100,PDF:20},rate_limit:{requests:10,window_seconds:60}};
    expect(parseConfigRuleValue("finance.accountant_exports",accountant)).toEqual(accountant);
    expect(()=>parseConfigRuleValue("finance.accountant_exports",{...accountant,classifications:{}})).toThrow();
    const receivables={source:"POSTED_OWNERSHIP_CLAIMS",account_codes:["EXPLICIT_GUEST_CLAIM"]};
    expect(parseConfigRuleValue("finance.receivables",receivables)).toEqual(receivables);
    const assignments={source:"ORIGINAL_POSTED_DEBIT",party_types:["GUEST","OWNER","SUPPLIER","PERSON"],due_date:"EXPLICIT_OR_UNSCHEDULED"};
    expect(parseConfigRuleValue("finance.receivable_assignments",assignments)).toEqual(assignments);
    for(const key of Object.keys(receivables))expect(()=>parseConfigRuleValue("finance.receivables",Object.fromEntries(Object.entries(receivables).filter(([name])=>name!==key)))).toThrow();
    for(const value of[{...receivables,source:"CASH_LOCATION"},{...receivables,account_codes:[]},{...receivables,account_codes:["CLAIM","CLAIM"]},{...receivables,guestId:"current-reservation-guest"}])expect(()=>parseConfigRuleValue("finance.receivables",value)).toThrow();
    const percentageRun={earning_date:"ACTUAL_POSTED_FINANCIAL_BASE",earning_unit:"PERSON_ASSIGNMENT_SELECTED_POSTINGS",timezone:"UTC",max_period_days:31};
    expect(parseConfigRuleValue("staff.compensation_percentage_runs",percentageRun)).toEqual(percentageRun);
    for(const key of Object.keys(percentageRun))expect(()=>parseConfigRuleValue("staff.compensation_percentage_runs",Object.fromEntries(Object.entries(percentageRun).filter(([name])=>name!==key)))).toThrow();
    expect(()=>parseConfigRuleValue("staff.compensation_percentage_runs",{...percentageRun,earning_date:"RECORDED_COMPLETION"})).toThrow();
    const monthly={timezone:"UTC",proration:"COMPLETE_ELIGIBLE_CALENDAR_DAYS",rate_selection:"DAILY_EFFECTIVE",rounding:"HALF_UP_AT_PERIOD_TOTAL"};
    expect(parseConfigRuleValue("staff.compensation_monthly_earnings",monthly)).toEqual(monthly);
    for(const key of Object.keys(monthly))expect(()=>parseConfigRuleValue("staff.compensation_monthly_earnings",Object.fromEntries(Object.entries(monthly).filter(([name])=>name!==key)))).toThrow();
    expect(()=>parseConfigRuleValue("staff.compensation_monthly_earnings",{...monthly,proration:"STATUTORY_DEFAULT"})).toThrow();
    expect(parseConfigRuleValue("staff.compensation_runs",{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31}))
      .toEqual({earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31});
    expect(()=>parseConfigRuleValue("staff.compensation_runs",{timezone:"UTC",max_period_days:31})).toThrow();
    expect(parseConfigRuleValue("finance.accounting_periods", {
      timezone: "Europe/Paris", allow_early_close: false, max_reopen_seconds: 120
    })).toEqual({ timezone: "Europe/Paris", allow_early_close: false, max_reopen_seconds: 120 });
    expect(() => parseConfigRuleValue("finance.accounting_periods", { timezone: "Europe/Paris" })).toThrow();
    expect(parseConfigRuleValue(commissionConfigKey, {
      rate_bps: 2000,
      basis: "GROSS_ACCOMMODATION",
      accrual_event: "ON_RECEIPT"
    })).toMatchObject({ rate_bps: 2000 });

    expect(parseConfigRuleValue(reservationTaskTemplatesConfigKey, {
      tasks: [
        {
          key: "arrival",
          type: "ARRIVAL_PREPARATION",
          title: { en: "Arrival", fr: "Arrivee" },
          due: "CHECK_IN",
          priority: "NORMAL",
          checklist: []
        }
      ]
    })).toMatchObject({ tasks: [{ key: "arrival" }] });
    expect(parseConfigRuleValue("agreement.responsibilities", {
      owner: ["insurance"],
      alvillas: ["guest operations"]
    })).toMatchObject({ owner: ["insurance"] });
    expect(parseConfigRuleValue("agreement.notice", {
      notice_period_days: 60
    })).toMatchObject({ notice_period_days: 60 });
    expect(parseConfigRuleValue("agreement.special_conditions", {
      conditions: ["seasonal staffing"]
    })).toMatchObject({ conditions: ["seasonal staffing"] });

    expect(() => parseConfigRuleValue("finance.unregistered", {})).toThrow("Unknown config rule key");
  });

  it("rejects invalid configurable approval, payout, expense and workflow rules", () => {
    expect(() =>
      parseConfigRuleValue("finance.approval_thresholds", {
        thresholds: [{ key: "maintenance", amount: "1000.00", currency: "MAD", requires_approval_from: [] }]
      })
    ).toThrow();
    expect(() =>
      parseConfigRuleValue("finance.payout_schedule", { cadence: "EVERY_WHENEVER" })
    ).toThrow();
    expect(() =>
      parseConfigRuleValue("finance.expense_allocation", {
        default_treatment: "OWNER_PAID",
        categories: { maintenance: { treatment: "NOT_A_TREATMENT" } }
      })
    ).toThrow();
    expect(() =>
      parseConfigRuleValue("ops.workflows", {
        workflows: [{ key: "midstay", trigger: "ReservationConfirmed", actions: [] }]
      })
    ).toThrow();
  });
});

describe("config rule resolver ordering", () => {
  it("uses handbook specificity, then latest effective date, then highest version", () => {
    const sorted = sortConfigRulesForResolution([
      rule({ scopeType: "organization", effectiveFrom: "2026-01-01T00:00:00.000Z", version: 99 }),
      rule({ scopeType: "owner", effectiveFrom: "2026-05-01T00:00:00.000Z", version: 1 }),
      rule({ scopeType: "property", effectiveFrom: "2026-02-01T00:00:00.000Z", version: 1 }),
      rule({ scopeType: "property", effectiveFrom: "2026-02-01T00:00:00.000Z", version: 2 }),
      rule({ scopeType: "agreement", effectiveFrom: "2026-01-15T00:00:00.000Z", version: 1 })
    ]);

    expect(sorted[0]?.scopeType).toBe("agreement");
    expect(sorted[1]?.scopeType).toBe("property");
    expect(sorted[1]?.version).toBe(2);
    expect(sorted.at(-1)?.scopeType).toBe("organization");
  });

  it("creates append-only versions without mutating previous rule rows", async () => {
    const create = vi.fn((args: { data: { version: number; lifecycle?: string } }) => Promise.resolve({
      id: "018f0a0b-0000-7000-9000-000000000101",
      key: "feature_flag.owner_portal",
      scopeType: "organization",
      scopeId: null,
      value: { enabled: true },
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      effectiveTo: null,
      version: args.data.version,
      lifecycle: args.data.lifecycle,
      createdBy: "018f0a0b-0000-7000-9000-000000000102",
      reason: "Enable owner portal flag"
    }));
    const update = vi.fn();
    const tx = {
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      configRule: {
        findFirst: vi.fn(() => Promise.resolve({ version: 2 })),
        create,
        update
      }
    } as unknown as TenantTransaction;
    const repository = new ConfigRuleRepository(
      tx,
      "018f0a0b-0000-7000-9000-000000000100"
    );

    const created = await repository.createVersion({
      key: "feature_flag.owner_portal",
      scopeType: "organization",
      value: { enabled: true },
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      createdBy: "018f0a0b-0000-7000-9000-000000000102",
      reason: "Enable owner portal flag"
    });

    expect(created.version).toBe(3);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(update).not.toHaveBeenCalled();
  });

  it("uses retired rows as effective-dated tombstones without mutating history", async () => {
    const tx = {
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      configRule: {
        findMany: vi.fn(() =>
          Promise.resolve([
            rule({
              scopeType: "organization",
              effectiveFrom: "2026-01-01T00:00:00.000Z",
              version: 1,
              lifecycle: "ACTIVE"
            }),
            rule({
              scopeType: "organization",
              effectiveFrom: "2026-03-01T00:00:00.000Z",
              version: 2,
              lifecycle: "RETIRED"
            })
          ])
        )
      }
    } as unknown as TenantTransaction;
    const repository = new ConfigRuleRepository(
      tx,
      "018f0a0b-0000-7000-9000-000000000100"
    );

    await expect(
      repository.resolve({
        key: commissionConfigKey,
        scopes: [{ scopeType: "organization", scopeId: null }],
        asOf: new Date("2026-04-01T00:00:00.000Z")
      })
    ).resolves.toBeNull();
  });
});
