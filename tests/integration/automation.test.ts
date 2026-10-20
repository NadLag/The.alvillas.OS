import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { provisionIntegrationRole } from "./support/database-role";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { permissionCatalog } from "@/platform/authz/catalog";
import { authContextForAccount } from "@/platform/authz/account-context";
import {
  automationAdmin,
  automationTick,
  changeAutomationState,
  enqueueAutomationEvent,
  executeAutomationRun,
  previewAutomation,
  replayAutomation,
  saveAutomationRule,
  type AutomationActor,
} from "@/platform/automation/service";
import type { AutomationRule } from "@/platform/automation/rule";
import { consumeAutomationReference } from "@/platform/events/inngest-functions";
import { decideApproval } from "@/platform/approvals/approval-service";
import { installAutomationLibrary } from "@/platform/automation/library";
import { ReservationRepository } from "@/modules/reservations/infrastructure/reservation-repository";
import { deliverNotificationEvent, publishNotifications } from "@/platform/notifications/notification-service";
import { createManualReservation } from "@/modules/reservations/application/reservation-service";
import operationDefaults from "@/platform/config/defaults/operations.json";
import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import { propertyInstant } from "@/modules/reservations/domain/operation-task";
import automationDefaults from "@/platform/config/defaults/automations.json";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
const deps = () => ({ db, requestId: randomUUID() });
const start = new Date("2020-01-01");
function rule(extra: Partial<AutomationRule> = {}): AutomationRule {
  return {
    name: { en: "Prepare arrival", fr: "Préparer l’arrivée" },
    event: "ReservationConfirmed",
    enabled: true,
    conditions: { all: [] },
    actions: [
      {
        key: "prepare",
        type: "create_task",
        task_type: "INSPECTION",
        title: { en: "Inspect arrival", fr: "Contrôler l’arrivée" },
        due: { from: "reservation.check_in", offset_days: 0 },
        priority: "HIGH",
        checklist_template: "inspection",
      },
    ],
    retry: { max_attempts: 2, delay_seconds: 1 },
    ...extra,
  };
}
async function fixture(permissions = permissionCatalog.map((p) => p.key)) {
  const org = randomUUID();
  await admin.organization.create({
    data: { id: org, name: "Automation integration", baseCurrency: "MAD" },
  });
  const f = await withTenant(db, org, async (tx) => {
    const person = await tx.person.create({
        data: { organizationId: org, displayName: "Automation operator" },
      }),
      account = await tx.userAccount.create({
        data: { organizationId: org, personId: person.id },
      });
    const property = await tx.property.create({
      data: {
        organizationId: org,
        name: "Automation villa",
        addressLine1: "Test",
        city: "Marrakech",
        propertyType: "VILLA",
        bedrooms: 2,
        bathrooms: 2,
        maxGuests: 4,
        amenities: [],
        photoUrls: [],
        timezone: "America/New_York",
      },
    });
    const role = await tx.role.create({
      data: {
        organizationId: org,
        key: "automation_operator",
        name: "Automation operator",
      },
    });
    for (const entry of permissionCatalog.filter((p) =>
      permissions.includes(p.key),
    )) {
      const p = await tx.permission.create({
        data: {
          organizationId: org,
          key: entry.key,
          resource: entry.resource,
          action: entry.action,
        },
      });
      await tx.rolePermission.create({
        data: { organizationId: org, roleId: role.id, permissionId: p.id },
      });
    }
    const assignment = await tx.roleAssignment.create({
      data: {
        organizationId: org,
        personId: person.id,
        userAccountId: account.id,
        roleId: role.id,
        scopeType: "organization",
        validFrom: start,
      },
    });
    const reservation = await tx.reservation.create({
      data: {
        organizationId: org,
        propertyId: property.id,
        reference: "AUT-1",
        nights: 7,
        source: "MANUAL",
        status: "CONFIRMED",
        guestName: "Test",
        checkIn: new Date("2027-03-27"),
        checkOut: new Date("2027-04-03"),
        createdBy: account.id,
        idempotencyKey: randomUUID(),
      },
    });
    const config = new ConfigRuleRepository(tx, org);
    await config.createVersion({
      key: "ops.checklists",
      scopeType: "organization",
      effectiveFrom: start,
      value: {
        checklists: [
          {
            key: "inspection",
            name: { en: "Inspection", fr: "Inspection" },
            items: [
              {
                key: "ready",
                label: {
                  en: "Confirm readiness",
                  fr: "Confirmer la préparation",
                },
              },
            ],
          },
        ],
      },
      reason: "Automation integration checklists",
    });
    const event = await tx.outboxEvent.create({
      data: {
        organizationId: org,
        type: "ReservationConfirmed",
        payload: { propertyId: property.id, reservationId: reservation.id },
        idempotencyKey: randomUUID(),
      },
    });
    return { person, account, property, reservation, event, assignment, role };
  });
  const authContext = await authContextForAccount(org, f.account.id, { db });
  return {
    ...f,
    org,
    actor: {
      organizationId: org,
      actorId: f.account.id,
      personId: f.person.id,
      authContext: { ...authContext, personId: f.person.id },
    } satisfies AutomationActor,
  };
}
async function save(
  f: Awaited<ReturnType<typeof fixture>>,
  r = rule(),
  key = "prepare",
) {
  return saveAutomationRule(
    f.actor,
    {
      key,
      propertyId: f.property.id,
      lifecycle: "ACTIVE",
      effectiveFrom: start,
      rule: r,
      reason: "Configure tested automation",
    },
    deps(),
  );
}
async function runs(f: Awaited<ReturnType<typeof fixture>>) {
  return enqueueAutomationEvent(f.org, f.event.id, deps());
}
describe("automation engine on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname))
      throw new Error(
        "Local TEST_DATABASE_URL is required for automation integration",
      );
    execFileSync(
      process.execPath,
      ["node_modules/prisma/build/index.js", "migrate", "deploy"],
      { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" },
    );
    admin = new PrismaClient({ datasourceUrl: url });
    await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const app = new URL(url);
    app.username = "alvillas_ops_tests";
    app.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: app.toString() });
  });
  afterAll(async () => {
    await db?.$disconnect();
    await admin?.$disconnect();
  });
  it("keeps financial idempotency values out of operational metadata and history", async () => {
    const f = await fixture();
    const amount = "913572.68";
    await save(
      f,
      rule({
        event: "ExpenseSubmitted",
        idempotency_key: "{{variance.actual}}",
      }),
    );
    await withTenant(db, f.org, (tx) =>
      tx.outboxEvent.update({
        where: { id: f.event.id },
        data: {
          type: "ExpenseSubmitted",
          payload: {
            propertyId: f.property.id,
            reservationId: f.reservation.id,
            variance: { expected: amount, actual: amount, currency: "MAD" },
          },
        },
      }),
    );
    const [run] = await runs(f);
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    const records = await withTenant(db, f.org, async (tx) => {
      expect(
        (await tx.automationRun.findUniqueOrThrow({ where: { id: run } }))
          .eventKey,
      ).toBe(amount);
      const taskEvents = await tx.operationTaskEvent.findMany();
      expect(taskEvents.length).toBeGreaterThan(0);
      const audit = await tx.auditLog.findMany({
        where: { action: "automation.action.executed" },
      });
      expect(audit).toHaveLength(1);
      const permission = await tx.permission.findFirstOrThrow({
        where: { key: "financial_transaction:view" },
      });
      await tx.rolePermission.deleteMany({
        where: { roleId: f.role.id, permissionId: permission.id },
      });
      return { taskEvents, audit };
    });
    expect(JSON.stringify(records.taskEvents)).not.toContain(amount);
    expect(JSON.stringify(records.audit)).not.toContain(amount);
    const authContext = await authContextForAccount(f.org, f.account.id, {
      db,
    });
    const model = await automationAdmin(
      { ...f.actor, authContext: { ...authContext, personId: f.person.id } },
      undefined,
      deps(),
    );
    expect(model.runs[0].eventKey).toBe("••••••");
  });
  it("authorizes financial inputs before a false predicate can reveal its result", async () => {
    const f = await fixture(
      permissionCatalog
        .map((p) => p.key)
        .filter((key) => !key.startsWith("financial_transaction:")),
    );
    const source = await save(
      f,
      rule({
        event: "ExpenseSubmitted",
        retry: { max_attempts: 1, delay_seconds: 1 },
        conditions: { path: "variance.actual", op: "<", value: "0.00" },
      }),
    );
    await withTenant(db, f.org, (tx) =>
      tx.outboxEvent.update({
        where: { id: f.event.id },
        data: {
          type: "ExpenseSubmitted",
          payload: {
            propertyId: f.property.id,
            variance: { expected: "100.00", actual: "100.00", currency: "MAD" },
          },
        },
      }),
    );
    await expect(
      previewAutomation(
        f.actor,
        { ruleId: source.id, eventId: f.event.id },
        deps(),
      ),
    ).rejects.toThrow("automation_forbidden");
    const [run] = await runs(f);
    expect(await executeAutomationRun(f.org, run, deps())).toBe("FAILED");
    await withTenant(db, f.org, async (tx) => {
      expect(await tx.operationTask.count()).toBe(0);
      expect(
        await tx.automationRun.count({ where: { status: "SKIPPED" } }),
      ).toBe(0);
      expect((await tx.automationAttempt.findFirstOrThrow()).errorCode).toBe(
        "automation_forbidden",
      );
    });
  });
  it("records invalid idempotency input without starving other rules on the event", async () => {
    const f = await fixture();
    await save(
      f,
      rule({
        idempotency_key: "{{task.id}}",
        retry: { max_attempts: 1, delay_seconds: 1 },
      }),
      "broken-key",
    );
    await save(f);
    const ids = await runs(f);
    expect(ids).toHaveLength(2);
    expect(
      (
        await Promise.all(
          ids.map((id) => executeAutomationRun(f.org, id, deps())),
        )
      ).sort(),
    ).toEqual(["FAILED", "SUCCEEDED"]);
    expect((await runs(f)).sort()).toEqual([...ids].sort());
    await withTenant(db, f.org, async (tx) => {
      expect(await tx.operationTask.count()).toBe(1);
      expect(await tx.automationAttempt.count()).toBe(2);
      expect(
        await tx.automationRun.count({
          where: { status: "FAILED", errorCode: "automation_input_missing" },
        }),
      ).toBe(1);
    });
  });
  it("blocks matching cycles while skipping nonmatching rules in the same ancestry", async () => {
    const f = await fixture();
    await save(f);
    const [initial] = await runs(f);
    expect(await executeAutomationRun(f.org, initial, deps())).toBe(
      "SUCCEEDED",
    );
    const task = await withTenant(db, f.org, (tx) =>
      tx.operationTask.findFirstOrThrow(),
    );
    for (const key of ["cycle", "irrelevant"])
      await save(
        f,
        rule({
          event: "TaskCreated",
          retry: { max_attempts: 1, delay_seconds: 1 },
          conditions:
            key === "cycle"
              ? { all: [] }
              : { path: "task.type", op: "=", value: "LAUNDRY" },
        }),
        key,
      );
    const event = await withTenant(db, f.org, (tx) =>
      tx.outboxEvent.create({
        data: {
          organizationId: f.org,
          type: "TaskCreated",
          payload: {
            propertyId: f.property.id,
            taskId: task.id,
            automationPath: [
              "automation.rule.cycle",
              "automation.rule.irrelevant",
            ],
          },
          idempotencyKey: randomUUID(),
        },
      }),
    );
    const ids = await enqueueAutomationEvent(f.org, event.id, deps());
    expect(
      (
        await Promise.all(
          ids.map((id) => executeAutomationRun(f.org, id, deps())),
        )
      ).sort(),
    ).toEqual(["FAILED", "SKIPPED"]);
    await withTenant(db, f.org, async (tx) => {
      expect(await tx.operationTask.count()).toBe(1);
      expect(
        await tx.automationRun.count({
          where: { status: "FAILED", errorCode: "automation_cycle_detected" },
        }),
      ).toBe(1);
      expect(
        await tx.automationRun.count({ where: { status: "SKIPPED" } }),
      ).toBe(1);
    });
  });
  it("applies a paused property override to an already queued organization rule", async () => {
    const f = await fixture();
    await saveAutomationRule(
      f.actor,
      {
        key: "inherited",
        lifecycle: "ACTIVE",
        effectiveFrom: start,
        rule: rule(),
        reason: "Organization automation default",
      },
      deps(),
    );
    const [run] = await runs(f);
    await saveAutomationRule(
      f.actor,
      {
        key: "inherited",
        propertyId: f.property.id,
        lifecycle: "ACTIVE",
        effectiveFrom: new Date(),
        rule: rule({ enabled: false }),
        reason: "Pause this property override",
      },
      deps(),
    );
    expect(await executeAutomationRun(f.org, run, deps())).toBe("PAUSED");
    expect(await withTenant(db, f.org, (tx) => tx.operationTask.count())).toBe(
      0,
    );
  });
  it("retains owner commission snapshot IDs and never rewrites a financial version during replay", async () => {
    const f = await fixture();
    await withTenant(db, f.org, async (tx) => {
      const owner = await tx.owner.create({
        data: { organizationId: f.org, displayName: "Snapshot owner" },
      });
      await tx.propertyOwner.create({
        data: {
          organizationId: f.org,
          propertyId: f.property.id,
          ownerId: owner.id,
        },
      });
      await new ConfigRuleRepository(tx, f.org).createVersion({
        key: "finance.commission",
        scopeType: "property",
        scopeId: f.property.id,
        effectiveFrom: start,
        value: {
          rate_bps: 2500,
          basis: "GROSS_ACCOMMODATION",
          accrual_event: "ON_CHECKOUT",
        },
        reason: "Agreed commission at confirmation",
      });
    });
    await save(f, rule({ actions: [{ key: "snapshot", type: "snapshot" }] }));
    const [run] = await runs(f);
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    const snapshot = await withTenant(db, f.org, (tx) =>
      tx.commissionSnapshot.findFirstOrThrow(),
    );
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "finance.commission",
        scopeType: "property",
        scopeId: f.property.id,
        effectiveFrom: start,
        value: {
          rate_bps: 4000,
          basis: "GROSS_ACCOMMODATION",
          accrual_event: "ON_CHECKOUT",
        },
        reason: "Later agreed commission version",
      }),
    );
    await replayAutomation(
      f.actor,
      { runId: run, reason: "Verify immutable financial replay" },
      deps(),
    );
    await executeAutomationRun(f.org, run, deps());
    expect(
      await withTenant(db, f.org, (tx) => tx.commissionSnapshot.count()),
    ).toBe(1);
    expect(
      (
        await withTenant(db, f.org, (tx) =>
          tx.commissionSnapshot.findFirstOrThrow(),
        )
      ).commissionRateBps,
    ).toBe(2500);
    expect(
      JSON.stringify(
        (
          await withTenant(db, f.org, (tx) =>
            tx.automationRun.findUniqueOrThrow({ where: { id: run } }),
          )
        ).outputs,
      ),
    ).toContain(snapshot.id);
  });
  it("links generated tasks to reservations and reconciles their original date expressions after changes", async () => {
    const f = await fixture();
    await save(
      f,
      rule({
        actions: [
          {
            ...rule().actions[0],
            type: "create_task",
            key: "midstay",
            task_type: "CLEANING_MIDSTAY",
            title: { en: "Mid-stay", fr: "Mi-séjour" },
            due: {
              from: "reservation.check_in",
              offset_days: "floor(nights/2)",
            },
            priority: "NORMAL",
            checklist_template: "inspection",
          },
        ],
      }),
    );
    const [run] = await runs(f);
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    const task = await withTenant(db, f.org, (tx) =>
      tx.operationTask.findFirstOrThrow(),
    );
    expect(task.reservationId).toBe(f.reservation.id);
    expect(task.dueDate.toISOString().slice(0, 10)).toBe("2027-03-30");
    await withTenant(db, f.org, async (tx) => {
      await tx.reservation.update({
        where: { id: f.reservation.id },
        data: {
          checkIn: new Date("2027-04-01"),
          checkOut: new Date("2027-04-11"),
          nights: 10,
        },
      });
      await new ReservationRepository(tx, f.org).reconcileTasks(
        f.reservation.id,
        f.account.id,
        "Change the stay dates",
      );
    });
    expect(
      (
        await withTenant(db, f.org, (tx) =>
          tx.operationTask.findUniqueOrThrow({ where: { id: task.id } }),
        )
      ).dueDate
        .toISOString()
        .slice(0, 10),
    ).toBe("2027-04-06");
    await withTenant(db, f.org, async (tx) => {
      await tx.reservation.update({
        where: { id: f.reservation.id },
        data: { status: "CANCELLED" },
      });
      await new ReservationRepository(tx, f.org).reconcileTasks(
        f.reservation.id,
        f.account.id,
        "Cancel the reservation safely",
      );
    });
    expect(
      (
        await withTenant(db, f.org, (tx) =>
          tx.operationTask.findUniqueOrThrow({ where: { id: task.id } }),
        )
      ).state,
    ).toBe("CANCELLED");
  });
  it("schedules 500 properties in batches and bounds polling reads without duplicate outcomes", async () => {
    const f = await fixture();
    await withTenant(db, f.org, (tx) =>
      tx.property.createMany({
        data: Array.from({ length: 499 }, (_, i) => ({
          organizationId: f.org,
          name: `Scale villa ${i}`,
          addressLine1: "Test",
          city: "Marrakech",
          propertyType: "VILLA",
          bedrooms: 2,
          bathrooms: 2,
          maxGuests: 4,
          amenities: [],
          photoUrls: [],
        })),
      }),
    );
    await saveAutomationRule(
      f.actor,
      {
        key: "daily",
        lifecycle: "ACTIVE",
        effectiveFrom: start,
        reason: "Configured daily inspections at scale",
        rule: rule({
          event: "AutomationScheduled",
          schedule: { hour: 1, minute: 30, weekdays: [0] },
          actions: [
            {
              key: "inspect",
              type: "create_task",
              task_type: "INSPECTION",
              title: { en: "Daily inspection", fr: "Contrôle quotidien" },
              due: { from: "event.date", offset_days: 0 },
              priority: "NORMAL",
              checklist_template: "inspection",
            },
          ],
        }),
      },
      deps(),
    );
    const now = new Date("2026-11-01T12:00Z");
    expect(await automationTick(f.org, { ...deps(), now })).toEqual({
      scheduled: 500,
      processed: 100,
    });
    for (let i = 0; i < 4; i++)
      expect((await automationTick(f.org, { ...deps(), now })).scheduled).toBe(
        0,
      );
    expect(await withTenant(db, f.org, (tx) => tx.automationRun.count())).toBe(
      500,
    );
    expect(await withTenant(db, f.org, (tx) => tx.operationTask.count())).toBe(
      500,
    );
    const connection = new URL(url!);
    connection.username = "alvillas_ops_tests";
    connection.password = "alvillas_ops_tests";
    const measured = new PrismaClient({
      datasourceUrl: connection.toString(),
      log: [{ emit: "event", level: "query" }],
    });
    let reads = 0;
    measured.$on("query", (event) => {
      if (/^SELECT/u.test(event.query)) reads++;
    });
    try {
      expect(await automationTick(f.org, { db: measured, now })).toEqual({
        scheduled: 0,
        processed: 0,
      });
      expect(reads).toBeLessThanOrEqual(10);
    } finally {
      await measured.$disconnect();
    }
  });
  it("installs the complete editable library once and generates every configured stay stage without duplicates", async () => {
    const f = await fixture();
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({
      key: "ops.reservation_task_templates", scopeType: "organization", effectiveFrom: start,
      value: { tasks: [automationDefaults.configuration["ops.reservation_task_templates"].tasks.find(task => task.key === "arrival")!,
        { ...automationDefaults.configuration["ops.reservation_task_templates"].tasks.find(task => task.key === "checkout-cleaning")!,
          key: "checkout", title: { en: "Keep the configured checkout cleaning", fr: "Conserver le nettoyage configuré" } }] },
      reason: "Preserve existing task meanings when standard stage keys collide"
    }));
    expect(
      await installAutomationLibrary(
        f.actor,
        {
          propertyId: f.property.id,
          reason: "Install the complete property workflow",
        },
        deps(),
      ),
    ).toEqual({ created: 7 });
    expect(
      await installAutomationLibrary(
        f.actor,
        {
          propertyId: f.property.id,
          reason: "Repeat safe library installation",
        },
        deps(),
      ),
    ).toEqual({ created: 0 });
    const source = await withTenant(db, f.org, (tx) =>
      tx.configRule.findFirstOrThrow({
        where: {
          key: "automation.rule.standard.stay-workflow",
          scopeId: f.property.id,
        },
      }),
    );
    await changeAutomationState(
      f.actor,
      {
        ruleId: source.id,
        enabled: true,
        reason: "Activate reviewed stay generation",
      },
      deps(),
    );
    await expect(
      changeAutomationState(
        f.actor,
        {
          ruleId: source.id,
          enabled: true,
          reason: "An already published draft must remain historical",
        },
        deps(),
      ),
    ).rejects.toThrow("automation_version_conflict");
    const event = await withTenant(db, f.org, async (tx) => {
      const reservation = await tx.reservation.create({
        data: {
          organizationId: f.org,
          propertyId: f.property.id,
          reference: "AUT-WORKFLOW",
          source: "MANUAL",
          status: "CONFIRMED",
          guestName: "Test",
          nights: 7,
          checkIn: new Date("2027-03-27"),
          checkOut: new Date("2027-04-03"),
          createdBy: f.account.id,
          idempotencyKey: randomUUID(),
        },
      });
      return tx.outboxEvent.create({
        data: {
          organizationId: f.org,
          type: "ReservationConfirmed",
          payload: { propertyId: f.property.id, reservationId: reservation.id },
          idempotencyKey: randomUUID(),
        },
      });
    });
    const [run] = await enqueueAutomationEvent(f.org, event.id, deps());
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    await executeAutomationRun(f.org, run, deps());
    const tasks = await withTenant(db, f.org, (tx) =>
      tx.operationTask.findMany({ orderBy: { dueDate: "asc" } }),
    );
    expect(tasks).toHaveLength(11);
    expect(new Set(tasks.map((t) => t.idempotencyKey)).size).toBe(11);
    expect(tasks.find(task => task.idempotencyKey.endsWith(":checkout"))).toMatchObject({ type: "CHECKOUT_CLEANING",
      titleTranslations: { en: "Keep the configured checkout cleaning" } });
    expect(tasks.find(task => task.idempotencyKey.endsWith(":standard.checkout"))).toMatchObject({ type: "CUSTOM" });
    expect(tasks.map((t) => t.type)).toEqual(
      expect.arrayContaining([
        "ARRIVAL_PREPARATION",
        "CLEANING",
        "CHECKOUT_CLEANING",
        "INSPECTION",
        "INVENTORY",
        "LAUNDRY",
      ]),
    );
    expect(tasks[0].dueDate.toISOString().slice(0, 10)).toBe("2027-03-25");
  });
  it("creates the eleven-stage native stay with bounded queries, current crew capacity, atomic notifications and safe replay", async () => {
    const f = await fixture();
    await installAutomationLibrary(f.actor, { propertyId: f.property.id, reason: "Configure native workflow query budget" }, deps());
    const occupied = await withTenant(db, f.org, async tx => {
      const policy = structuredClone(operationDefaults);
      for (const settings of Object.values(policy.types)) settings.role_keys = [f.role.key];
      policy.types.CLEANING.role_keys = ["unavailable_crew"];
      await new ConfigRuleRepository(tx, f.org).createVersion({
        key: "ops.task_policy", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: start, value: policy, reason: "Use the authorized integration crew for every configured stage"
      });
      await new OperationRepository(tx, f.org).context(f.account.id, randomUUID(), "Existing crew capacity before native stay creation");
      const scheduledStart = propertyInstant("2027-06-11", policy.shift_start_minute, f.property.timezone);
      return tx.operationTask.create({ data: { organizationId: f.org, propertyId: f.property.id,
        type: "INSPECTION", state: "ASSIGNED", dueDate: new Date("2027-06-11"),
        scheduledStart, scheduledEnd: new Date(scheduledStart.getTime() + 60 * 60000),
        assignedToPersonId: f.person.id, assignedToUserAccountId: f.account.id,
        titleTranslations: { en: "Existing crew commitment", fr: "Engagement existant" },
        idempotencyKey: randomUUID(), createdBy: f.account.id } });
    });
    const connection = new URL(url!);
    connection.username = "alvillas_ops_tests";
    connection.password = "alvillas_ops_tests";
    const measured = new PrismaClient({ datasourceUrl: connection.toString(), log: [{ emit: "event", level: "query" }] });
    let queryCount = 0;
    measured.$on("query", () => queryCount++);
    const input = { propertyId: f.property.id, guestName: "Native workflow query budget", guestEmail: "workflow@example.test",
      guestPreferredLocale: "en" as const, source: "MANUAL" as const, checkIn: "2027-06-12", checkOut: "2027-06-19",
      adultCount: 2, childCount: 0, idempotencyKey: randomUUID() };
    try {
      const result = await createManualReservation(f.actor, input, { ...deps(), db: measured });
      expect(result.tasks).toHaveLength(11);
      expect(queryCount).toBeLessThanOrEqual(180);
      const proof = await withTenant(db, f.org, async tx => ({
        tasks: await tx.operationTask.findMany({ where: { reservationId: result.reservation.id }, include: { checklistItems: true } }),
        notices: await tx.notification.findMany({ where: { kind: "task_assigned", targetId: { in: result.tasks.map(task => task.id) } } }),
        audit: await tx.auditLog.findMany({ where: { action: "task.create", resourceId: { in: result.tasks.map(task => task.id) } } })
      }));
      expect(proof.tasks.every(task => task.checklistItems.length > 0)).toBe(true);
      expect(proof.audit).toHaveLength(11);
      const assigned = proof.tasks.filter(task => task.assignedToPersonId);
      expect(assigned.length).toBeGreaterThan(0);
      expect(proof.notices).toHaveLength(assigned.length);
      expect(proof.tasks.find(task => task.idempotencyKey === `${result.reservation.id}:arrival-inspection`)?.assignedToPersonId).toBeNull();
      for (const task of assigned) expect(task.scheduledStart! < occupied.scheduledEnd! && occupied.scheduledStart! < task.scheduledEnd!).toBe(false);
      for (const first of assigned) for (const second of assigned) {
        if (first.id === second.id || first.assignedToPersonId !== second.assignedToPersonId) continue;
        expect(first.scheduledStart! < second.scheduledEnd! && second.scheduledStart! < first.scheduledEnd!).toBe(false);
      }
      const replay = await createManualReservation(f.actor, input, deps());
      expect(replay.idempotent).toBe(true);
      expect(new Set(replay.tasks.map(task => task.id))).toEqual(new Set(result.tasks.map(task => task.id)));
      expect(await withTenant(db, f.org, tx => tx.notification.count({ where: { kind: "task_assigned", targetId: { in: result.tasks.map(task => task.id) } } }))).toBe(proof.notices.length);
      const notices = assigned.map(task => ({ input: { kind: "task_assigned" as const, targetId: task.id, recipientId: f.account.id }, key: `batch-replay:${task.id}` }));
      await Promise.all(Array.from({ length: 4 }, (_, i) => withTenant(db, f.org, tx => publishNotifications(tx, f.org, i % 2 ? [...notices].reverse() : notices))));
      const noticeKeys = notices.map(notice => notice.key);
      const beforeRevocation = await withTenant(db, f.org, async tx => {
        const events = await tx.outboxEvent.findMany({ where: { idempotencyKey: { in: noticeKeys } } });
        expect(events).toHaveLength(notices.length);
        expect(events.every(event => event.status === "DISPATCHED")).toBe(true);
        return tx.notification.count({ where: { eventId: { in: events.map(event => event.id) } } });
      });
      expect(beforeRevocation).toBe(notices.length);
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.assignment.id }, data: { archivedAt: new Date() } }));
      const revoked = notices.map(notice => ({ ...notice, key: `revoked:${notice.key}` }));
      await withTenant(db, f.org, tx => publishNotifications(tx, f.org, revoked));
      await withTenant(db, f.org, async tx => {
        const events = await tx.outboxEvent.findMany({ where: { idempotencyKey: { in: revoked.map(notice => notice.key) } } });
        expect(events).toHaveLength(revoked.length);
        expect(events.every(event => event.status === "DISPATCHED")).toBe(true);
        expect(await tx.notification.count({ where: { eventId: { in: events.map(event => event.id) } } })).toBe(0);
      });
    } finally { await measured.$disconnect(); }
  });
  it("serializes duplicate events and concurrent workers, preserving one task and one immutable attempt", async () => {
    const f = await fixture();
    await save(f);
    const batches = await Promise.all(Array.from({ length: 6 }, () => runs(f)));
    expect(new Set(batches.flat()).size).toBe(1);
    const run = batches[0][0];
    expect(
      await Promise.all(
        Array.from({ length: 5 }, () =>
          executeAutomationRun(f.org, run, deps()),
        ),
      ),
    ).toEqual(Array(5).fill("SUCCEEDED"));
    await replayAutomation(
      f.actor,
      { runId: run, reason: "Verify safe replay" },
      deps(),
    );
    await withTenant(db, f.org, async (tx) => {
      expect(
        await tx.operationTask.count({ where: { organizationId: f.org } }),
      ).toBe(1);
      expect(await tx.automationAttempt.count({ where: { runId: run } })).toBe(
        1,
      );
      await expect(
        withTenant(db, f.org, (tx) =>
          tx.automationRun.update({
            where: { id: run },
            data: { status: "PENDING" },
          }),
        ),
      ).rejects.toThrow("immutable");
      expect(
        await tx.auditLog.count({
          where: { action: "automation.action.executed" },
        }),
      ).toBe(1);
      await expect(
        tx.automationAttempt.updateMany({
          where: { runId: run },
          data: { status: "REWRITTEN" },
        }),
      ).rejects.toThrow("append-only");
    });
  });
  it("dry runs have no business side effects and pause/resume preserves the selected immutable rule version", async () => {
    const f = await fixture(),
      source = await save(f);
    const [run] = await runs(f);
    expect(
      await previewAutomation(
        f.actor,
        { ruleId: source.id, eventId: f.event.id },
        deps(),
      ),
    ).toMatchObject({ matched: true, plans: [{ dueDate: "2027-03-27" }] });
    expect(await withTenant(db, f.org, (tx) => tx.operationTask.count())).toBe(
      0,
    );
    await changeAutomationState(
      f.actor,
      {
        ruleId: source.id,
        enabled: false,
        reason: "Pause for scheduling review",
      },
      deps(),
    );
    expect(await executeAutomationRun(f.org, run, deps())).toBe("PAUSED");
    const paused = await withTenant(db, f.org, (tx) =>
      tx.configRule.findFirstOrThrow({
        where: { key: source.key },
        orderBy: { version: "desc" },
      }),
    );
    await expect(
      changeAutomationState(
        f.actor,
        {
          ruleId: source.id,
          enabled: true,
          reason: "Stale controls must not overwrite a newer version",
        },
        deps(),
      ),
    ).rejects.toThrow("automation_version_conflict");
    await changeAutomationState(
      f.actor,
      {
        ruleId: paused.id,
        enabled: true,
        reason: "Resume approved scheduling",
      },
      deps(),
    );
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    expect(
      (
        await withTenant(db, f.org, (tx) =>
          tx.automationRun.findUniqueOrThrow({ where: { id: run } }),
        )
      ).configRuleId,
    ).toBe(source.id);
  });
  it("rolls back every outcome when a later action fails, retries safely and manually replays after repair", async () => {
    const f = await fixture();
    await save(
      f,
      rule({
        actions: [
          rule().actions[0],
          {
            ...rule().actions[0],
            key: "second",
            type: "create_task",
            task_type: "INSPECTION",
            title: { en: "Second inspection", fr: "Deuxième contrôle" },
            due: { from: "reservation.check_in", offset_days: 1 },
            priority: "NORMAL",
            checklist_template: "missing",
          },
        ],
      }),
    );
    const [run] = await runs(f),
      now = new Date();
    expect(await executeAutomationRun(f.org, run, { ...deps(), now })).toBe(
      "RETRY",
    );
    expect(await withTenant(db, f.org, (tx) => tx.operationTask.count())).toBe(
      0,
    );
    expect(await executeAutomationRun(f.org, run, { ...deps(), now })).toBe(
      "RETRY",
    );
    expect(
      await executeAutomationRun(f.org, run, {
        ...deps(),
        now: new Date(now.getTime() + 2000),
      }),
    ).toBe("FAILED");
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "ops.checklists",
        scopeType: "organization",
        effectiveFrom: start,
        value: {
          checklists: ["inspection", "missing"].map((key) => ({
            key,
            name: { en: key, fr: key },
            items: [
              {
                key: "ready",
                label: { en: "Confirm readiness", fr: "Confirmer" },
              },
            ],
          })),
        },
        reason: "Repair the missing checklist",
      }),
    );
    await replayAutomation(
      f.actor,
      { runId: run, reason: "Replay after checklist repair" },
      deps(),
    );
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    expect(await withTenant(db, f.org, (tx) => tx.operationTask.count())).toBe(
      2,
    );
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.automationAttempt.count({ where: { runId: run } }),
      ),
    ).toBe(3);
  });
  it("rechecks revoked permissions, wrong scopes and wrong tenants without disclosing financial inputs", async () => {
    const f = await fixture();
    await save(f);
    const [run] = await runs(f);
    await withTenant(db, f.org, (tx) =>
      tx.roleAssignment.update({
        where: { id: f.assignment.id },
        data: { validTo: new Date("2021-01-01") },
      }),
    );
    expect(await executeAutomationRun(f.org, run, deps())).toBe("FAILED");
    expect(await withTenant(db, f.org, (tx) => tx.operationTask.count())).toBe(
      0,
    );
    const other = await fixture();
    await expect(
      consumeAutomationReference(
        { organizationId: other.org, outboxEventId: f.event.id },
        f.event.type,
        db,
      ),
    ).rejects.toThrow("automation_reference_denied");
    expect(
      await withTenant(db, other.org, (tx) =>
        tx.automationRun.findMany({ where: { id: run } }),
      ),
    ).toEqual([]);
    const scoped = {
      ...other.actor,
      authContext: {
        ...other.actor.authContext,
        assignments: undefined,
        scopes: [
          {
            organizationId: other.org,
            scopeType: "property" as const,
            scopeId: randomUUID(),
          },
        ],
      },
    };
    await expect(
      saveAutomationRule(
        scoped,
        {
          key: "wrong",
          propertyId: other.property.id,
          lifecycle: "ACTIVE",
          effectiveFrom: start,
          rule: rule(),
          reason: "Denied wrong property",
        },
        deps(),
      ),
    ).rejects.toThrow();
    const operational = await fixture([
      "config_rule:view",
      "config_rule:create",
      "config_rule:configure",
      "property:view",
      "property:edit",
      "task:create",
      "issue:create",
    ]);
    await save(
      operational,
      rule({
        actions: [
          {
            key: "variance",
            type: "create_variance",
            expected: "variance.expected",
            actual: "variance.actual",
            currency: "variance.currency",
            reason: { en: "Investigate variance", fr: "Analyser l’écart" },
          },
        ],
      }),
    );
    await withTenant(db, operational.org, (tx) =>
      tx.outboxEvent.update({
        where: { id: operational.event.id },
        data: {
          payload: {
            propertyId: operational.property.id,
            reservationId: operational.reservation.id,
            variance: { expected: "100.00", actual: "120.00", currency: "MAD" },
          },
        },
      }),
    );
    const [financialRun] = await runs(operational);
    expect(
      await executeAutomationRun(operational.org, financialRun, deps()),
    ).toBe("FAILED");
    const model = await automationAdmin(operational.actor, undefined, deps());
    await expect(
      automationAdmin(operational.actor, undefined, deps(), {
        propertyId: f.property.id,
      }),
    ).rejects.toThrow("automation_forbidden");
    const selectedModel = await automationAdmin(
      operational.actor,
      undefined,
      deps(),
      {
        propertyId: operational.property.id,
      },
    );
    expect(selectedModel.selectedPropertyId).toBe(operational.property.id);
    expect(selectedModel.runs.map((run) => run.id)).toEqual(
      model.runs.map((run) => run.id),
    );
    expect(model.runs[0].inputs).toBe("••••••");
    expect(
      await withTenant(db, operational.org, (tx) => tx.variance.count()),
    ).toBe(0);
  });
  it("freezes effective agreement versions for decisions and uses Money for financial actions", async () => {
    const f = await fixture();
    const agreementRule = await withTenant(db, f.org, async (tx) => {
      const a = await tx.managementAgreement.create({
        data: {
          organizationId: f.org,
          propertyId: f.property.id,
          reference: "AGR-AUT",
          status: "ACTIVE",
          effectiveFrom: start,
        },
      });
      const config = new ConfigRuleRepository(tx, f.org);
      await config.createVersion({
        key: "ops.mid_stay_threshold",
        scopeType: "organization",
        value: { nights: 30 },
        effectiveFrom: start,
        reason: "Organization fallback threshold",
      });
      return config.createVersion({
        key: "ops.mid_stay_threshold",
        scopeType: "agreement",
        scopeId: a.id,
        value: { nights: 4 },
        effectiveFrom: start,
        reason: "Effective agreement threshold",
      });
    });
    await save(
      f,
      rule({
        conditions: {
          path: "reservation.nights",
          op: ">=",
          value: { config: "ops.mid_stay_threshold", path: "nights" },
        },
        actions: [
          {
            key: "variance",
            type: "create_variance",
            expected: "variance.expected",
            actual: "variance.actual",
            currency: "variance.currency",
            reason: { en: "Investigate variance", fr: "Analyser l’écart" },
          },
        ],
      }),
    );
    await withTenant(db, f.org, (tx) =>
      tx.outboxEvent.update({
        where: { id: f.event.id },
        data: {
          payload: {
            propertyId: f.property.id,
            reservationId: f.reservation.id,
            variance: { expected: "100.01", actual: "100.03", currency: "MAD" },
          },
        },
      }),
    );
    const [run] = await runs(f);
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "ops.mid_stay_threshold",
        scopeType: "agreement",
        scopeId: agreementRule.scopeId,
        value: { nights: 100 },
        effectiveFrom: start,
        reason: "Backdated subsequent agreement rule",
      }),
    );
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    const variance = await withTenant(db, f.org, (tx) =>
      tx.variance.findFirstOrThrow(),
    );
    expect(variance.varianceAmount.toFixed(2)).toBe("0.02");
    const log = await withTenant(db, f.org, (tx) =>
      tx.automationRun.findUniqueOrThrow({ where: { id: run } }),
    );
    expect(JSON.stringify(log.inputs)).toContain(agreementRule.id);
  });
  it("creates a pending routed approval and cannot use automation to approve it or pay", async () => {
    const f = await fixture();
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "notification.routing.approval_requested",
        scopeType: "organization",
        effectiveFrom: start,
        value: {
          roles: [f.role.id],
          people: [],
          assigned: false,
          channels: ["in_app"],
        },
        reason: "Route approval to authorized operator",
      }),
    );
    await save(
      f,
      rule({
        actions: [
          {
            key: "approval",
            type: "create_approval_request",
            title: { en: "Review work order", fr: "Valider l’intervention" },
            details: {
              en: "Owner approval is required",
              fr: "Validation du propriétaire requise",
            },
          },
        ],
      }),
    );
    const [run] = await runs(f);
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    const approval = await withTenant(db, f.org, (tx) =>
      tx.approvalRequest.findFirstOrThrow(),
    );
    expect(approval.state).toBe("PENDING");
    const denied = {
      organizationId: f.org,
      accountId: f.account.id,
      authContext: {
        ...f.actor.authContext,
        permissions: new Set<string>(),
        assignments: [],
      },
    };
    await expect(
      decideApproval(
        denied,
        {
          id: approval.id,
          decision: "APPROVED",
          reason: "Unauthorized automatic approval",
        },
        deps(),
      ),
    ).rejects.toThrow();
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.auditLog.count({ where: { action: "approval.requested" } }),
      ),
    ).toBe(1);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.outboxEvent.count({ where: { type: "ApprovalRequested" } }),
      ),
    ).toBe(1);
  });
  it("delivers notification actions once and rechecks the recipient's current property access", async () => {
    const f = await fixture();
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "notification.routing.task_overdue",
        scopeType: "organization",
        effectiveFrom: start,
        value: { roles: [], people: [], assigned: true, channels: ["in_app"] },
        reason:
          "Only configured assigned recipients receive this automation notification",
      }),
    );
    const { recipient, assignment, task } = await withTenant(
      db,
      f.org,
      async (tx) => {
        const person = await tx.person.create({
          data: {
            organizationId: f.org,
            displayName: "Notification recipient",
          },
        });
        const recipient = await tx.userAccount.create({
          data: { organizationId: f.org, personId: person.id },
        });
        const assignment = await tx.roleAssignment.create({
          data: {
            organizationId: f.org,
            personId: person.id,
            userAccountId: recipient.id,
            roleId: f.role.id,
            scopeType: "property",
            scopeId: f.property.id,
            validFrom: start,
          },
        });
        const task = await tx.operationTask.create({
          data: {
            organizationId: f.org,
            propertyId: f.property.id,
            type: "INSPECTION",
            titleTranslations: {
              en: "Scoped inspection",
              fr: "Inspection autorisée",
            },
            dueDate: new Date("2026-01-01"),
            assignedToUserAccountId: recipient.id,
            idempotencyKey: randomUUID(),
          },
        });
        return { recipient, assignment, task };
      },
    );
    await save(
      f,
      rule({
        event: "TaskOverdue",
        actions: [
          {
            key: "notice",
            type: "notify",
            kind: "task_overdue",
            recipient: "task.assigned_to",
            target: "task.id",
          },
        ],
      }),
    );
    const emit = () =>
      withTenant(db, f.org, (tx) =>
        tx.outboxEvent.create({
          data: {
            organizationId: f.org,
            type: "TaskOverdue",
            payload: { propertyId: f.property.id, taskId: task.id },
            idempotencyKey: randomUUID(),
          },
        }),
      );
    const source = await emit();
    const [run] = await enqueueAutomationEvent(f.org, source.id, deps());
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    expect(await enqueueAutomationEvent(f.org, source.id, deps())).toEqual([
      run,
    ]);
    await Promise.all([
      executeAutomationRun(f.org, run, deps()),
      executeAutomationRun(f.org, run, deps()),
    ]);
    const notificationEvent = await withTenant(db, f.org, (tx) =>
      tx.outboxEvent.findFirstOrThrow({
        where: {
          type: "notification.requested",
          idempotencyKey: `${run}:notice`,
        },
      }),
    );
    await Promise.all([
      deliverNotificationEvent(notificationEvent, deps()),
      deliverNotificationEvent(notificationEvent, deps()),
    ]);
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.notification.findMany({
          where: { targetId: task.id, kind: "task_overdue" },
          select: { recipientId: true },
        }),
      ),
    ).toEqual([{ recipientId: recipient.id }]);
    await withTenant(db, f.org, (tx) =>
      tx.roleAssignment.update({
        where: { id: assignment.id },
        data: { archivedAt: new Date() },
      }),
    );
    const laterSource = await emit();
    const [laterRun] = await enqueueAutomationEvent(
      f.org,
      laterSource.id,
      deps(),
    );
    expect(await executeAutomationRun(f.org, laterRun, deps())).toBe(
      "SUCCEEDED",
    );
    expect(
      await withTenant(db, f.org, (tx) =>
        tx.notification.count({
          where: {
            recipientId: recipient.id,
            targetId: task.id,
            kind: "task_overdue",
          },
        }),
      ),
    ).toBe(1);
    const retained = await withTenant(db, f.org, (tx) =>
      tx.outboxEvent.findFirstOrThrow({
        where: {
          type: "notification.requested",
          idempotencyKey: `${laterRun}:notice`,
        },
      }),
    );
    expect(retained.status).toBe("DISPATCHED");
  });
  it("creates a scoped reorder suggestion from configured minimums exactly once", async () => {
    const f = await fixture();
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "inventory.minimums",
        scopeType: "property",
        scopeId: f.property.id,
        effectiveFrom: start,
        value: { minimums: [{ item: "towels", quantity: 12 }] },
        reason: "Configured linen minimum",
      }),
    );
    await save(
      f,
      rule({
        event: "InventoryBelowMinimum",
        actions: [
          {
            key: "reorder",
            type: "reorder_suggestion",
            title: { en: "Reorder towels", fr: "Commander des serviettes" },
          },
        ],
      }),
    );
    const event = await withTenant(db, f.org, (tx) =>
      tx.outboxEvent.create({
        data: {
          organizationId: f.org,
          type: "InventoryBelowMinimum",
          payload: {
            propertyId: f.property.id,
            inventory: { item: "towels", quantity: "7.00" },
          },
          idempotencyKey: randomUUID(),
        },
      }),
    );
    const [run] = await enqueueAutomationEvent(f.org, event.id, deps());
    await withTenant(db, f.org, (tx) =>
      new ConfigRuleRepository(tx, f.org).createVersion({
        key: "inventory.minimums",
        scopeType: "property",
        scopeId: f.property.id,
        effectiveFrom: start,
        value: { minimums: [{ item: "towels", quantity: 99 }] },
        reason: "Backdated edit must preserve the admitted reorder minimum",
      }),
    );
    expect(await executeAutomationRun(f.org, run, deps())).toBe("SUCCEEDED");
    await executeAutomationRun(f.org, run, deps());
    expect(
      (
        await withTenant(db, f.org, (tx) =>
          tx.automationSuggestion.findFirstOrThrow(),
        )
      ).quantity.toFixed(2),
    ).toBe("5.00");
    expect(
      (await automationAdmin(f.actor, undefined, deps())).suggestions,
    ).toHaveLength(1);
    await withTenant(db, f.org, async (tx) => {
      const permission = await tx.permission.findFirstOrThrow({
        where: { key: "issue:view" },
      });
      await tx.rolePermission.deleteMany({
        where: { roleId: f.role.id, permissionId: permission.id },
      });
    });
    const authContext = await authContextForAccount(f.org, f.account.id, {
      db,
    });
    expect(
      (
        await automationAdmin(
          {
            ...f.actor,
            authContext: { ...authContext, personId: f.person.id },
          },
          undefined,
          deps(),
        )
      ).suggestions,
    ).toHaveLength(0);
  });
  it("deduplicates repeated DST slots and recovers scheduled jobs with property timezone", async () => {
    const f = await fixture();
    await save(
      f,
      rule({
        event: "AutomationScheduled",
        schedule: { hour: 1, minute: 30, weekdays: [0] },
        actions: [
          {
            ...rule().actions[0],
            key: "daily",
            type: "create_task",
            task_type: "INSPECTION",
            title: { en: "Daily inspection", fr: "Contrôle quotidien" },
            due: { from: "event.date", offset_days: 0 },
            priority: "NORMAL",
            checklist_template: "inspection",
          },
        ],
      }),
    );
    for (const instant of ["2026-11-01T05:45Z", "2026-11-01T06:45Z"])
      await automationTick(f.org, { ...deps(), now: new Date(instant) });
    expect(await withTenant(db, f.org, (tx) => tx.automationRun.count())).toBe(
      1,
    );
    expect(await withTenant(db, f.org, (tx) => tx.operationTask.count())).toBe(
      1,
    );
  });
});
