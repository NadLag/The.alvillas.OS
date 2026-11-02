import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { FinanceActorContext } from "./finance-access";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { roleKeysForResource } from "@/platform/authz/authorize";
import { ConfigRuleRepository, configRuleSnapshotMetadata } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { payoutScheduleConfigSchema } from "@/platform/config/rule-registry";
import { referencedConfigs } from "@/platform/automation/rule";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { recurringPayoutDraftPolicyKey, recurringPayoutDraftPolicySchema, RecurringPayoutDraftConfigurationError } from "../domain/recurring-payout-draft";
import { latestPayoutCalendarSlot, PayoutScheduleConfigurationError } from "../domain/payout-schedule";
import { planConfiguredPayout } from "../domain/configured-finance-rules";
import { ownerPayoutResource } from "../domain/owner-payout";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { OwnerLedgerRepository } from "../infrastructure/owner-ledger-repository";
import { OwnerPayoutRepository } from "../infrastructure/owner-payout-repository";
import { RecurringPayoutDraftRepository } from "../infrastructure/recurring-payout-draft-repository";
import { assertOwnerLedgerScope, OwnerLedgerAccessError } from "./owner-ledger-service";
import { createOwnerPayout, recheckOwnerPayoutDraftCreation, OwnerPayoutAccessError, OwnerPayoutConflictError, OwnerPayoutConfigurationError } from "./owner-payout-service";
import { ownerPayoutCapacity, prepareOwnerPayoutPolicy, OwnerPayoutPolicyUnavailableError } from "./owner-payout-policy";
import { recheckFinanceAuthorization } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
async function recheckProposalLedger(ctx: FinanceActorContext, ownerId: string, propertyId: string, db: TenantTransactionRunner) {
  try { await assertOwnerLedgerScope(ctx, ownerId, propertyId, { db }); }
  catch (error) {
    if (error instanceof OwnerLedgerAccessError) throw new OwnerPayoutAccessError("Owner ledger source is not authorized", { cause: error });
    throw error;
  }
}

/** Creates native reviewable drafts. Approval, eligibility freezing and payment remain human workflows. */
export async function createRecurringPayoutDrafts(organizationId: string, deps: Deps = {}) {
  return withTenant(deps.db ?? prisma, organizationId, async tx => {
    const rules = new ConfigRuleRepository(tx, organizationId), repository = new RecurringPayoutDraftRepository(tx, organizationId);
    const finance = new FinanceRepository(tx, organizationId), payouts = new OwnerPayoutRepository(tx, organizationId);
    await rules.lockVersion(recurringPayoutDraftPolicyKey, "organization", null);await repository.lock();
    const now = await finance.clock();
    const rule = await rules.resolve({ key: recurringPayoutDraftPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
    if (!rule) return { configured: false, created: 0, pending: false };
    const parsed = recurringPayoutDraftPolicySchema.safeParse(rule.value);
    if (!parsed.success || !rule.createdBy) throw new RecurringPayoutDraftConfigurationError();
    const ctx = { organizationId, actorId: rule.createdBy, authContext: await authContextForAccountInTransaction(tx, organizationId, rule.createdBy) };
    const authority = [
      { action: "configure" as const, resource: { type: "config_rule", organizationId, id: recurringPayoutDraftPolicyKey }, organizationOnly: true },
      ...["financial_transaction", "owner_statement"].map(type => ({ action: "view" as const, resource: { type, organizationId, dataClass: "financial" as const }, organizationOnly: true }))
    ];
    await recheckFinanceAuthorization(ctx, tx, now, authority, new OwnerPayoutAccessError());
    const properties = new Map((await repository.properties(parsed.data.targets.map(target => target.draft.propertyId))).map(property => [property.id, property]));
    const dueTargets = parsed.data.targets.flatMap(target => {
      const property = properties.get(target.draft.propertyId);if (!property || property.archivedAt) throw new OwnerPayoutConfigurationError();
      const due = latestPayoutCalendarSlot(target.calendar, { asOf: now, startsAt: new Date(target.starts_at), timezone: property.timezone, hashSeed: [organizationId, target.id].join(":") });
      return due ? [{ target, due }] : [];
    });
    const issued = await repository.issued(dueTargets.map(({target,due}) => ({targetId:target.id,slot:due.slot})));
    const candidates = dueTargets.filter(({target}) => !issued.has(target.id));
    const created: string[] = [], generated: Array<{ row: NonNullable<Awaited<ReturnType<OwnerPayoutRepository["find"]>>>; input: Parameters<typeof recheckOwnerPayoutDraftCreation>[1] }> = [];let pending = false;
    for (const { target, due } of candidates) {
      if (created.length >= parsed.data.batch_size) { pending = true;break; }
      const input = target.draft;
      await payouts.lockOwner(input.ownerId, input.propertyId, input.currency);
      await repository.lockSources(rule.id, input.ownerId, input.propertyId, input.payoutMethodId);
      const property = await payouts.property(input.propertyId), owner = await new OwnerLedgerRepository(tx, organizationId).owner(input.ownerId);
      if (!property || property.archivedAt || !owner || owner.archivedAt) throw new OwnerPayoutConfigurationError();
      await recheckProposalLedger(ctx, owner.id, property.id, repository.runner());
      if (await repository.find(target.id, due.slot)) continue;
      if (await payouts.openForOwner(owner.id, property.id, input.currency)) { pending = true;continue; }
      const capacity = await ownerPayoutCapacity(ctx, { ownerId: owner.id, propertyId: property.id, currency: input.currency, owner, property }, tx, now);
      const resource = { type: "financial_transaction", organizationId, ownerId: owner.id, propertyId: property.id, city: property.cityId, region: property.regionId, dataClass: "financial" as const };
      await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: { ...resource, amount: capacity.balance.toJSON().amount } }], new OwnerPayoutAccessError());
      const scopes = await new ReservationConfigScopeRepository(tx, organizationId).scopes({ propertyId: property.id, ownerId: owner.id, asOf: now });
      const snapshot = await rules.scopedSnapshot(scopes, now), payoutRule = snapshot.resolve("finance.payout_schedule");
      if (!payoutRule) throw new RecurringPayoutDraftConfigurationError();
      const config = payoutScheduleConfigSchema.parse(payoutRule.value), references = referencedConfigs(config).map(key => {
        const resolved = snapshot.resolve(key);if (!resolved) throw new RecurringPayoutDraftConfigurationError();return resolved;
      });
      const heldRoles = roleKeysForResource(ctx.authContext, resource, now);
      const current = await authContextForAccountInTransaction(tx, organizationId, ctx.actorId);
      const roles = roleKeysForResource(current, resource, now).filter(role => heldRoles.includes(role));
      const evaluation = { fields: { payout: { propertyId: property.id, ownerId: owner.id, reservationId: null, currency: input.currency,
        amount: capacity.balance.toJSON().amount, availableBalance: capacity.balance.toJSON().amount }, actor: { userAccountId: ctx.actorId, roles } },
        configs: Object.fromEntries(references.map(reference => [reference.key, reference.value])) };
      const selection = planConfiguredPayout(config, { availableBalance: capacity.balance, triggeredAt: now, timezone: property.timezone,
        hashSeed: [organizationId, owner.id, property.id, payoutRule.id].join(":"), evaluation });
      const amount = selection.payableAmount.subtract(capacity.committed);
      if (amount.amount.lte(0)) continue;
      const command = { ...input, amount: amount.toJSON().amount, reason: rule.reason, idempotencyKey: randomUUID() };
      const result = await createOwnerPayout(ctx, command, { db: repository.runner(), requestId: deps.requestId });
      const row = await payouts.find(result.id);
      if (!row || result.idempotent || row.state !== "DRAFT" || row.transactionId || row.approvedAt || row.policySnapshot) throw new OwnerPayoutConflictError();
      const nativePolicy = await prepareOwnerPayoutPolicy(ctx, row, ownerPayoutResource(organizationId, row, row.property), tx, await finance.clock());
      const occurrence = await repository.create({ targetId: target.id, slot: due.slot, configRuleId: rule.id, payoutId: row.id, scheduledAt: due.at, timezone: due.timezone,
        createdBy: ctx.actorId, createdAt: await finance.clock(), evidence: json({ schemaVersion: 1, selectionRule: configRuleSnapshotMetadata(payoutRule), selection,
          availableBalance: capacity.balance.toJSON(), committedAmount: capacity.committed.toJSON(), nativeValidation: nativePolicy.snapshot }) });
      await writeAuditEvent(tx, { organizationId, actorId: ctx.actorId, action: "finance.owner_payout.recurring_draft_created", resourceType: "owner_payout", resourceId: row.id,
        propertyScopeId: row.propertyId, after: { occurrenceId: occurrence.id, configRuleId: rule.id, targetId: target.id, slot: due.slot, payoutId: row.id },
        reason: rule.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: occurrence.createdAt });
      generated.push({row,input:command});created.push(row.id);
    }
    for (const {row,input} of generated) {
      await recheckProposalLedger(ctx, row.ownerId, row.propertyId, repository.runner());
      await recheckFinanceAuthorization(ctx, tx, await finance.clock(), [{ action: "view", resource: ownerPayoutResource(organizationId, row, row.property) },
        { action: "create", resource: ownerPayoutResource(organizationId, row, row.property) }], new OwnerPayoutAccessError());
      // Revalidate the original source facts, funding grants and recipient after any concurrent revocation.
      await recheckOwnerPayoutDraftCreation(ctx, input, tx, await finance.clock());
      await prepareOwnerPayoutPolicy(ctx, row, ownerPayoutResource(organizationId, row, row.property), tx, await finance.clock());
    }
    await recheckFinanceAuthorization(ctx, tx, await finance.clock(), authority, new OwnerPayoutAccessError());
    return { configured: true, created: created.length, pending };
  });
}

export async function tickRecurringPayoutDrafts(organizationId: string, deps: Deps = {}) {
  try { return { ...await createRecurringPayoutDrafts(organizationId, deps), blocked: null }; }
  catch (error) {
    if (error instanceof OwnerPayoutAccessError || error instanceof OwnerLedgerAccessError) return { configured: true, created: 0, pending: true, blocked: "authority_unavailable" as const };
    if (error instanceof RecurringPayoutDraftConfigurationError || error instanceof OwnerPayoutConfigurationError || error instanceof OwnerPayoutPolicyUnavailableError || error instanceof PayoutScheduleConfigurationError)
      return { configured: true, created: 0, pending: true, blocked: "configuration_unavailable" as const };
    if (error instanceof OwnerPayoutConflictError) return { configured: true, created: 0, pending: true, blocked: "source_changed" as const };
    throw error;
  }
}
