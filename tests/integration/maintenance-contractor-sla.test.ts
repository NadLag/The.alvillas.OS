import { tickSupplierAlerts } from "@/platform/notifications/supplier-alerts";
import { supplierPriceListKey } from "@/platform/config/supplier-price-list-policy";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { notificationDestination } from "@/platform/notifications/notification";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { maintenanceSlaPolicyKey } from "@/platform/config/maintenance-sla-policy";
import { changeMaintenanceContractor, readMaintenanceContractor, searchMaintenanceContractors } from "@/modules/maintenance/application/contractor-assignment";
import { previewWorkOrderRegistration, publishWorkOrderRegistration } from "@/modules/maintenance/application/work-order-registration";
import { WorkOrderAccessError, WorkOrderConflictError } from "@/modules/maintenance/domain/work-order";
import { reportOperationIssue } from "@/modules/reservations/application/operation-evidence";
import { createOperationTask } from "@/modules/reservations/application/operation-service";
import { ownerPortalActorContextFromSession } from "@/modules/owner-portal/application/owner-portal-access";
import { getOwnerPropertyCondition, listOwnerPortalProperties, OwnerPortalNotFoundError } from "@/modules/owner-portal/application/owner-portal-service";
import { nativeSupplierPriceFixture } from "./support/laundry-pricing-fixture";
import { provisionIntegrationRole } from "./support/database-role";

let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !(url.pathname.startsWith("/alvillas_automation_") ||
    process.env.GITHUB_ACTIONS === "true" && url.pathname === "/alvillas_os")) throw new Error("Owned maintenance contractor test database required");
  admin = new PrismaClient({ datasourceUrl: url.toString() });
  await provisionIntegrationRole(admin, "alvillas_ops_tests");
  url.username = url.password = "alvillas_ops_tests";
  db = new PrismaClient({ datasourceUrl: url.toString() });
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

it("retains the original supplier, configured SLA, replay outcome and departure of an assignment", async () => {
  const f = await nativeSupplierPriceFixture(admin, db);
  await withTenant(db, f.organizationId, async tx => {
    const role = await tx.role.create({ data: { organizationId: f.organizationId, key: "maintenance_contractor_" + randomUUID(), name: "Work-order dispatcher" } });
    const keys = ["issue:create", "issue:view", "issue:edit", "task:assign", "task:edit", "task:view", "property:view"];
    const permissions = await tx.permission.findMany({ where: { organizationId: f.organizationId, key: { in: keys } } });
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({
      organizationId: f.organizationId, roleId: role.id, permissionId: permission.id
    })) });
    await tx.roleAssignment.create({ data: { organizationId: f.organizationId, roleId: role.id, userAccountId: f.account.id,
      personId: f.person.id, scopeType: "property", scopeId: f.property.id, validFrom: new Date("2020-01-01") } });
    await new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "ops.checklists", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id, reason: "Use the original maintenance checklist",
      value: { checklists: [{ key: "contractor", name: { en: "Repair", fr: "Réparation" }, items: [
        { key: "check", label: { en: "Confirm repair", fr: "Confirmer la réparation" } }
      ] }] } });
  });
  const actor = { ...f.actor, authContext: await authContextForAccount(f.organizationId, f.account.id, { db }) };
  const access = await withTenant(db, f.organizationId, async tx => {
    const owner = await tx.owner.create({ data: { organizationId: f.organizationId, displayName: "Original contractor test villa owner" } });
    await tx.propertyOwner.create({ data: { organizationId: f.organizationId, propertyId: f.property.id, ownerId: owner.id } });
    return tx.ownerPortalAccess.create({ data: { organizationId: f.organizationId, userAccountId: f.account.id, ownerId: owner.id } });
  });
  const owner = await ownerPortalActorContextFromSession({
    user: { id: f.account.id, personId: f.person.id, organizationId: f.organizationId, preferredLocale: "en", sessionId: randomUUID(), sessionRevoked: false, securitySetupRequired: false }, expires: "2032-12-31T23:59:59.000Z"
  }, { db });
  if (!owner) throw new Error("Expected the linked owner portal account");
  await expect(getOwnerPropertyCondition(owner, f.property.id, { db })).resolves.toBe("CLEAR");
  const nativeTask = await withTenant(db, f.organizationId, tx => tx.operationTask.findFirstOrThrow({
    where: { organizationId: f.organizationId, reservationId: f.reservation.id }
  }));
  const issueId = await reportOperationIssue(actor, { taskId: nativeTask.id, title: "Dedicated contractor repair",
    description: "A native issue needs the contractor's scheduled repair", severity: "HIGH", idempotencyKey: randomUUID() }, f.deps);
  const condition = await listOwnerPortalProperties(owner, { db }, { includeCondition: true });
  expect(condition.find(property => property.propertyId === f.property.id)?.condition).toBe("ATTENTION");
  expect(JSON.stringify(condition)).not.toContain("A native issue needs");
  const task = await createOperationTask(actor, { propertyId: f.property.id, type: "MAINTENANCE", priority: "HIGH",
    title: { en: "Contractor repair", fr: "Réparation par le prestataire" }, dueDate: "2031-05-02",
    checklistTemplateKey: "contractor", reason: "Create the actual Operations repair work order", idempotencyKey: randomUUID() }, f.deps);
  const taskId = task.id, intent = { issueId, taskId, reason: "Register the repair against the original issue" };
  const reviewed = await previewWorkOrderRegistration(actor, intent, f.deps);
  await publishWorkOrderRegistration(actor, { intent, idempotencyKey: randomUUID(), reviewFingerprint: reviewed.reviewFingerprint }, f.deps);
  const command = { taskId, contractorId: f.supplier.id, expectedRevision: 0, idempotencyKey: randomUUID(),
    reason: "Assign the native supplier under the active service targets" };
  await expect(changeMaintenanceContractor(actor, command, f.deps)).rejects.toBeInstanceOf(WorkOrderConflictError);
  expect((await readMaintenanceContractor(actor, { taskId }, f.deps)).policyAvailable).toBe(false);
  const normal = { response_minutes: 60, completion_minutes: 360 };
  await withTenant(db, f.organizationId, tx => new ConfigRuleRepository(tx, f.organizationId).createVersion({
    key: maintenanceSlaPolicyKey, scopeType: "property", scopeId: f.property.id, effectiveFrom: new Date("2020-01-01"),
    createdBy: f.account.id, reason: "Define actual service targets for each work-order priority",
    value: { priorities: { LOW: normal, NORMAL: normal, HIGH: { response_minutes: 15, completion_minutes: 45 }, URGENT: normal } }
  }));
  expect((await searchMaintenanceContractors(actor, { taskId, query: "Original laundry price supplier" }, f.deps)).items)
    .toMatchObject([{ id: f.supplier.id }]);
  await expect(changeMaintenanceContractor(actor, { ...command, contractorId: randomUUID() }, f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);
  await expect(Promise.all([changeMaintenanceContractor(actor, command, f.deps), changeMaintenanceContractor(actor, command, f.deps)]))
    .resolves.toEqual([{ recorded: true }, { recorded: true }]);
  const assigned = (await readMaintenanceContractor(actor, { taskId }, f.deps)).current;
  if (!assigned || assigned.state !== "ASSIGNED") throw new Error("Expected original contractor");
  expect(assigned.contractor.id).toBe(f.supplier.id);
  expect(assigned.response.state).toBe("PENDING");
  expect(new Date(assigned.response.dueAt).getTime() - new Date(assigned.at).getTime()).toBe(15 * 60_000);
  await withTenant(db, f.organizationId, async tx => {
    const rules = new ConfigRuleRepository(tx, f.organizationId);
    const identity = { createdBy: f.account.id, reason: "Configure scoped contractor and price alerts" };
    const routing = { roles: [], people: [f.person.id], assigned: false, channels: ["in_app"] };
    await rules.createVersion({ ...identity, key: "notification.routing.supplier_performance_alert", scopeType: "property",
      scopeId: f.property.id, effectiveFrom: new Date("2020-01-01"), value: routing });
    await rules.createVersion({ ...identity, key: "notification.routing.supplier_prices_changed", scopeType: "organization",
      effectiveFrom: new Date("2020-01-01"), value: routing });
    for (const price of [{ date: "2020-01-01", rate: "105.00" }, { date: "2021-01-01", rate: "110.03" }]) {
      await rules.createVersion({ ...identity, key: supplierPriceListKey(f.supplier.id), scopeType: "organization",
        effectiveFrom: new Date(price.date), value: { currency: "MAD", items: [{ code: "REPAIR", name: "Equipment repair", unit: "visit", amount: price.rate }] } });
    }
    await tx.notificationPreference.upsert({
      where: { organizationId_userAccountId: { organizationId: f.organizationId, userAccountId: f.account.id } },
      create: { organizationId: f.organizationId, userAccountId: f.account.id, inAppEnabled: true, inAppOperations: true },
      update: { inAppEnabled: true, inAppOperations: true }
    });
  });
  const observed = new Date(new Date(assigned.response.dueAt).getTime() + 1000);
  expect(await tickSupplierAlerts(f.organizationId, db, observed)).toBe(2);
  expect(await tickSupplierAlerts(f.organizationId, db, observed)).toBe(0);
  await withTenant(db, f.organizationId, async tx => {
    const notices = await tx.notification.findMany({ where: { organizationId: f.organizationId, recipientId: f.account.id,
      kind: { in: ["supplier_performance_alert", "supplier_prices_changed"] } } });
    expect(notices.map(notice => notice.kind).sort()).toEqual(["supplier_performance_alert", "supplier_prices_changed"]);
    const targets = await new NotificationRepository(tx, f.organizationId).targets(notices);
    for (const notice of notices) {
      const kind = notice.kind === "supplier_prices_changed" ? notice.kind : "supplier_performance_alert";
      expect(notificationDestination(actor.authContext, { kind, recipientId: f.account.id, targetId: notice.targetId },
        targets.get(notice.targetId) ?? null, "en")).toBe("/en/app/finance/suppliers/" + f.supplier.id);
    }
  });
  const clear = { taskId, contractorId: null, expectedRevision: 1, idempotencyKey: randomUUID(),
    reason: "Retain the completed record of the contractor assignment" };
  await changeMaintenanceContractor(actor, clear, f.deps);
  expect((await readMaintenanceContractor(actor, { taskId }, f.deps)).history).toMatchObject([
    { state: "CLEARED", revision: 2 },
    { state: "ASSIGNED", revision: 1, response: { state: "CANCELLED" } }
  ]);
  await withTenant(db, f.organizationId, tx => tx.roleAssignment.update({
    where: { id: f.grants["supplier:view"] }, data: { archivedAt: new Date() }
  }));
  expect((await readMaintenanceContractor(actor, { taskId }, f.deps)).history[1]).toEqual({ state: "MASKED" });
  await withTenant(db, f.organizationId, tx => tx.ownerPortalAccess.update({
    where: { id: access.id }, data: { archivedAt: new Date() }
  }));
  await expect(getOwnerPropertyCondition(owner, f.property.id, { db })).rejects.toBeInstanceOf(OwnerPortalNotFoundError);
  expect(await withTenant(db, f.organizationId, tx => tx.auditLog.count({
    where: { organizationId: f.organizationId, resourceId: taskId, action: "maintenance.work_order.contractor_changed" }
  }))).toBe(2);
});
