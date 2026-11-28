import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { authContextForAccount } from "@/platform/authz/account-context";
import { issueGuestHubLink, reviewGuestHubIssue } from "@/modules/guest-hub/application/guest-hub-service";
import { guestHubServiceOrderGrants } from "@/modules/guest-hub/application/guest-hub-service-order-grants";
import { guestHubServiceOrderPolicyKey, type GuestHubServiceCategory } from "@/modules/guest-hub/domain/guest-hub-service-order-policy";
import { previewServiceCatalogChange, publishServiceCatalogChange } from "@/modules/services/application/service-catalog-service";
import { groceryOrderTermsSchema } from "@/platform/config/grocery-order-policy";
import { transferOrderTermsSchema } from "@/platform/config/transfer-order-policy";
import { serviceAllocationPolicySchema } from "@/platform/config/service-allocation-policy";
import { nativeServiceOrderFixture } from "./service-order-fixture";

export async function nativeGuestServiceOrderFixture(admin: PrismaClient, db: PrismaClient, env: NodeJS.ProcessEnv) {
  const fixture = await nativeServiceOrderFixture(admin, db);
  return prepareGuestServiceOrderCapability(fixture, db, env);
}

export async function nativeGuestSpecialOrderFixture(admin: PrismaClient, db: PrismaClient, env: NodeJS.ProcessEnv, kind: "grocery" | "transfer") {
  const fixture = await nativeServiceOrderFixture(admin, db);
  const terms = kind === "grocery"
    ? { grocery_order: groceryOrderTermsSchema.parse({ schemaVersion: 1, task_type: "CUSTOM", purchases: "CANONICAL_PROPERTY_EXPENSE",
      reimbursement: "CONFIGURED_NATIVE_SETTLEMENT" }) }
    : { transfer_order: transferOrderTermsSchema.parse({ schemaVersion: 1, task_type: "TRANSFER", cash: "NATIVE_CASH_CUSTODY" }) };
  const name = kind === "grocery" ? { en: "Approved groceries", fr: "Courses approuvées", ar: "مشتريات معتمدة" }
    : { en: "Approved airport transfer", fr: "Transfert aéroport approuvé", ar: "نقل معتمد من المطار" };
  const draft = { ...fixture.draft, entry: { ...fixture.entry, name, order_terms: { ...fixture.entry.order_terms, ...terms } } };
  const reviewed = await previewServiceCatalogChange(fixture.ctx, draft, fixture.deps);
  await publishServiceCatalogChange(fixture.ctx, { draft, reviewFingerprint: reviewed.reviewFingerprint, idempotencyKey: randomUUID() }, fixture.deps);
  return prepareGuestServiceOrderCapability(fixture, db, env);
}

export async function nativeGuestCategorizedOrdersFixture(admin: PrismaClient, db: PrismaClient, env: NodeJS.ProcessEnv) {
  const fixture = await nativeServiceOrderFixture(admin, db);
  const entries = [
    { key: "owned_cleaning", name: { en: "Mid-stay cleaning", fr: "Ménage pendant le séjour", ar: "تنظيف أثناء الإقامة" }, amount: "95.00" },
    { key: "owned_experience", name: { en: "Guided garden walk", fr: "Promenade guidée au jardin", ar: "جولة في الحديقة" }, amount: "180.00" }
  ];
  const original = serviceAllocationPolicySchema.parse(fixture.policies.allocation.value);
  const recipe = original.services.find(item => item.service_key === fixture.entry.key);
  if (!recipe) throw new Error("The original native allocation recipe is required");
  const allocation = await withTenant(db, fixture.organizationId, tx => new ConfigRuleRepository(tx, fixture.organizationId).createVersion({
    key: "finance.service_allocation", scopeType: "property", scopeId: fixture.property.id, createdBy: fixture.account.id,
    effectiveFrom: new Date("2020-01-01"), reason: "Approve exact synthetic cleaning and experience allocation recipes",
    value: { ...original, services: [...original.services, ...entries.map(entry => ({ ...recipe, service_key: entry.key }))] }
  }));
  for (const entry of entries) {
    const draft = { ...fixture.draft, entry: { ...fixture.entry, ...entry, order_terms: { ...fixture.entry.order_terms,
      allocation_rule_id: allocation.id } } };
    const reviewed = await previewServiceCatalogChange(fixture.ctx, draft, fixture.deps);
    await publishServiceCatalogChange(fixture.ctx, { draft, reviewFingerprint: reviewed.reviewFingerprint, idempotencyKey: randomUUID() }, fixture.deps);
  }
  return prepareGuestServiceOrderCapability({ ...fixture, entry: { ...fixture.entry, ...entries[0] } }, db, env,
    { owned_cleaning: "CLEANING", owned_experience: "EXPERIENCE" });
}

type GuestOrderFixture = Pick<Awaited<ReturnType<typeof nativeServiceOrderFixture>>,
  "organizationId" | "account" | "ctx" | "person" | "property" | "reservation"> & { entry: { key: string } };

export async function prepareGuestServiceOrderCapability<F extends GuestOrderFixture>(
  fixture: F, db: PrismaClient, env: NodeJS.ProcessEnv, categories?: Readonly<Record<string, GuestHubServiceCategory>>
) {
  await withTenant(db, fixture.organizationId, async tx => {
    const role = await tx.role.create({ data: { organizationId: fixture.organizationId, key: `guest_services_${randomUUID()}`, name: "Scoped guest service publisher" } });
    const keys = ["guest:edit", "guest_hub_service_orders:view", "guest_hub_service_orders:create", "guest_hub_service_orders:void"];
    const permissions = await tx.permission.findMany({ where: { organizationId: fixture.organizationId, key: { in: keys } } });
    if (permissions.length !== keys.length) throw new Error("The native Guest Hub service permission catalog is incomplete");
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: fixture.organizationId, roleId: role.id, permissionId: permission.id })) });
    await tx.roleAssignment.create({ data: { organizationId: fixture.organizationId, personId: fixture.person.id,
      userAccountId: fixture.account.id, roleId: role.id, scopeType: "property", scopeId: fixture.property.id, validFrom: new Date("2020-01-01") } });
    const text = { en: "Service information", fr: "Informations sur le service", ar: "معلومات الخدمة" };
    await new ConfigRuleRepository(tx, fixture.organizationId).createVersion({ key: guestHubServiceOrderPolicyKey,
      scopeType: "property", scopeId: fixture.property.id, createdBy: fixture.account.id, effectiveFrom: new Date("2020-01-01"),
      reason: "Explicit synthetic Guest Hub offer release policy", value: { source: "NATIVE_CANONICAL_SERVICE_ORDERS",
        history: "APPEND_ONLY_GUEST_NATIVE_ORDER_RECEIPTS", enabled: true, processing_approval_reference: "Owned test policy",
        wording_approval_reference: "Owned test wording", notice: { reference: "Owned order notice", title: text, paragraphs: [text] },
        public_offers: "EXPLICITLY_RELEASED_CANONICAL_CATALOG", request_authority: "HELD_AND_CURRENT_RELEASE_ACTOR",
        allowed_service_keys: categories ? Object.keys(categories) : [fixture.entry.key], ...(categories ? { service_categories: categories } : {}),
        review_lifetime_seconds: 900, release_lifetime_seconds: 3600,
        submissions: { requests: 30, window_seconds: 3600 } } });
  });
  const actor = { ...fixture.ctx, authContext: { ...await authContextForAccount(fixture.organizationId, fixture.account.id, { db }), personId: fixture.person.id } };
  const deps = { db, env, clientKey: "owned-native-guest-orders", verificationOrganizationId: fixture.organizationId };
  const reservation = { reservationId: fixture.reservation.id };
  const issued = await issueGuestHubLink(actor, { ...reservation, idempotencyKey: randomUUID(),
    reviewFingerprint: (await reviewGuestHubIssue(actor, reservation, deps)).reviewFingerprint, reason: "Issue the original synthetic guest capability" }, deps);
  const capability = { token: issued.token };
  async function decide(decision: "GRANTED" | "WITHDRAWN") {
    const input = { linkId: issued.id, decision }, reviewed = await guestHubServiceOrderGrants.review(actor, input, deps);
    return guestHubServiceOrderGrants.record(actor, { ...input, idempotencyKey: randomUUID(), reviewFingerprint: reviewed.reviewFingerprint,
      reason: "Record the original synthetic guest service access decision" }, deps);
  }
  return { fixture, deps, capability, issued, decide };
}
