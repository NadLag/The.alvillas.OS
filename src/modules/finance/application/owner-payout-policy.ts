import { createHash } from "node:crypto";
import { z } from "zod";
import type { OwnerPayoutMethod, Prisma } from "@prisma/client";
import type { Resource } from "@/platform/authz/authorize";
import { roleKeysForResource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository, configRuleSnapshotMetadata, type ResolvedConfigRule } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { approvalThresholdsConfigSchema, payoutScheduleConfigSchema } from "@/platform/config/rule-registry";
import { referencedConfigs } from "@/platform/automation/rule";
import { Money } from "@/platform/money/money";
import { calendarDateAt } from "@/i18n/format";
import { calendarDateStart } from "@/platform/time/calendar";
import { readOwnerLedgerStatement } from "@/platform/ledger/owner-statements";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { evaluateConfiguredApproval, planConfiguredPayout } from "../domain/configured-finance-rules";
import { OwnerPayoutRepository, type OwnerPayoutRecord } from "../infrastructure/owner-payout-repository";
import { ExpenseRepository } from "../infrastructure/expense-repository";
import { expenseRevenueWindow } from "./expense-submission-policy";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

export class OwnerPayoutPolicyUnavailableError extends Error {}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
type Evidence = { value: unknown; [key: string]: unknown };
const storedRule = z.object({ config_rule_id: z.uuid(), key: z.string(), config_rule_version: z.number().int().positive(), value: z.unknown() }).passthrough();
const frameRule = z.object({ id: z.uuid(), key: z.string(), version: z.number().int().positive(), scopeType: z.string(), scopeId: z.string().nullable(), value: z.unknown() });
const evidence = (rule: ResolvedConfigRule): Evidence => ({ ...configRuleSnapshotMetadata(rule), value: rule.parsedValue });

/** Hash encrypted recipient terms without decrypting or disclosing bank details. */
export function ownerPayoutMethodHash(method: OwnerPayoutMethod) {
  return createHash("sha256").update(JSON.stringify({ id: method.id, ownerId: method.ownerId, methodType: method.methodType,
    currency: method.currency, accountHolderName: method.accountHolderName, countryCode: method.countryCode,
    detailsEncrypted: method.detailsEncrypted, maskedAccount: method.maskedAccount })).digest("hex");
}

/** Reuse the canonical owner ledger; pending commitments are source amounts, never editable balances. */
export async function ownerPayoutCapacity(ctx: FinanceActorContext, row: OwnerPayoutRecord, tx: TenantTransaction, now: Date) {
  const ledger = await readOwnerLedgerStatement(tx, ctx.organizationId, { ownerId: row.ownerId, ownerName: row.owner.displayName,
    propertyId: row.propertyId, propertyName: row.property.name, currency: row.currency, startsAt: now, endsAt: now });
  const committed = Money.of(await new OwnerPayoutRepository(tx, ctx.organizationId).committedAmount(row.ownerId, row.propertyId, row.currency, row.id), row.currency);
  return { balance: ledger.closingBalance, committed };
}

export async function prepareOwnerPayoutPolicy(ctx: FinanceActorContext, row: OwnerPayoutRecord, target: Resource, tx: TenantTransaction, now: Date) {
  const repository = new OwnerPayoutRepository(tx, ctx.organizationId);
  let payoutRule: Evidence, approvalRule: Evidence;
  let resolveReference: (key: string) => Evidence | null;
  let checkoutDate: Date | undefined;
  let ownershipSnapshotId: string | null = null;
  if (row.reservationId) {
    const reservation = await repository.reservation(row.reservationId);
    if (!reservation || reservation.propertyId !== row.propertyId) throw new OwnerPayoutPolicyUnavailableError("Original payout booking is unavailable");
    const commission = reservation.commissionSnapshots.find(snapshot => snapshot.ownerId === row.ownerId);
    if (!commission?.configRuleId) throw new OwnerPayoutPolicyUnavailableError("Original booking owner agreement is required");
    const frozen = z.object({ config_rule_version: z.number().int().positive(), payout_rule: z.unknown().optional(), approval_thresholds: z.unknown().optional(),
      expense_policy_rules: z.object({ approval: storedRule.nullable(), references: z.array(storedRule) }).optional() }).parse(commission.snapshotValue);
    const frame = reservation.reverseReservationFinancialSnapshotreservationIdLink.find(snapshot => z.object({ rules: z.array(frameRule) }).safeParse(snapshot.rules).success);
    const frames = frame ? z.object({ rules: z.array(frameRule) }).parse(frame.rules).rules : [];
    ownershipSnapshotId = frame?.id ?? commission.id;
    const inline = (key: string, value: unknown): Evidence => ({ key, value, config_rule_id: commission.configRuleId,
      config_rule_version: frozen.config_rule_version, config_rule_scope_type: "reservation_snapshot", config_rule_scope_id: row.reservationId,
      commissionSnapshotId: commission.id });
    resolveReference = key => {
      const original = frozen.expense_policy_rules?.references.find(rule => rule.key === key);
      if (original) return original;
      const rule = frames.find(rule => rule.key === key);
      return rule ? { ...rule, config_rule_id: rule.id, config_rule_version: rule.version } : null;
    };
    const payout = frozen.payout_rule !== undefined ? inline("finance.payout_schedule", frozen.payout_rule) : resolveReference("finance.payout_schedule");
    const approval = frozen.approval_thresholds !== undefined ? inline("finance.approval_thresholds", frozen.approval_thresholds)
      : frozen.expense_policy_rules?.approval ?? resolveReference("finance.approval_thresholds");
    if (!payout || !approval) throw new OwnerPayoutPolicyUnavailableError("Original booking payout and approval terms are required");
    payoutRule = payout; approvalRule = approval;
    checkoutDate = calendarDateStart(reservation.checkOut.toISOString().slice(0,10), row.property.timezone);
  } else {
    const scopes = await new ReservationConfigScopeRepository(tx, ctx.organizationId).scopes({ propertyId: row.propertyId, ownerId: row.ownerId, asOf: now });
    const snapshot = await new ConfigRuleRepository(tx, ctx.organizationId).scopedSnapshot(scopes, now);
    resolveReference = key => { const rule = snapshot.resolve(key); return rule ? evidence(rule) : null; };
    const payout = resolveReference("finance.payout_schedule"), approval = resolveReference("finance.approval_thresholds");
    if (!payout || !approval) throw new OwnerPayoutPolicyUnavailableError("Explicit payout and approval policies are required");
    payoutRule = payout; approvalRule = approval;
  }
  const payoutConfig = payoutScheduleConfigSchema.parse(payoutRule.value), approvalConfig = approvalThresholdsConfigSchema.parse(approvalRule.value);
  const references = [...new Set([...referencedConfigs(payoutConfig), ...referencedConfigs(approvalConfig)])].map(key => {
    const rule = resolveReference(key); if (!rule) throw new OwnerPayoutPolicyUnavailableError("A referenced payout policy is unavailable"); return rule;
  });
  const amount = Money.of(row.amount.toString(), row.currency), capacity = await ownerPayoutCapacity(ctx, row, tx, now);
  await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: { ...target, amount: capacity.balance.toJSON().amount } }], new OwnerPayoutPolicyUnavailableError("Owner balance source is not authorized"));
  const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
  const callerRoles = roleKeysForResource(ctx.authContext, target, now), roles = roleKeysForResource(current, target, now).filter(role => callerRoles.includes(role));
  const evaluation = { fields: { payout: { id: row.id, propertyId: row.propertyId, ownerId: row.ownerId, reservationId: row.reservationId,
    amount: amount.toJSON().amount, currency: row.currency, availableBalance: capacity.balance.toJSON().amount }, actor: { userAccountId: ctx.actorId, roles } },
    configs: Object.fromEntries(references.map(rule => [String(rule.key), rule.value])) };
  const payout = planConfiguredPayout(payoutConfig, { availableBalance: capacity.balance, requestedAmount: amount, triggeredAt: now,
    checkoutDate, settlementAt:row.expectedSettlementAt??undefined, timezone: row.property.timezone,
    hashSeed: [ctx.organizationId,row.ownerId,row.propertyId,payoutRule.config_rule_id].join(":"), evaluation });
  if (["AFTER_CHECKOUT", "PER_BOOKING"].includes(payout.cadence) && !checkoutDate) throw new OwnerPayoutPolicyUnavailableError("Event payout requires its source booking");
  if (payout.cadence === "OTA_SPLIT_EXPECTED_SETTLEMENT" && !row.expectedSettlementAt) throw new OwnerPayoutPolicyUnavailableError("OTA payout requires an attributed expected-settlement instant");
  if (amount.amount.gt(payout.payableAmount.subtract(capacity.committed).amount)) throw new OwnerPayoutPolicyUnavailableError("Payout exceeds the derived uncommitted owner payable");
  let periodRevenue: Money | undefined, revenueEvidence: unknown = null;
  if (approvalConfig.thresholds.some(threshold => threshold.percentage_of_revenue_bps !== undefined)) {
    const window = expenseRevenueWindow(approvalConfig, calendarDateAt(now,row.property.timezone),row.property.timezone,row.reservationId);
    periodRevenue = Money.of(await new ExpenseRepository(tx,ctx.organizationId).periodRevenue({ ...window,propertyId:row.propertyId,currency:row.currency }),row.currency);
    if (periodRevenue.amount.lt(0)) throw new OwnerPayoutPolicyUnavailableError("Approval revenue source cannot be negative");
    await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource:{...target,amount:periodRevenue.toJSON().amount}}],new OwnerPayoutPolicyUnavailableError("Approval revenue source is not authorized"));
    revenueEvidence = { ...window, period: approvalConfig.revenue_period, amount:periodRevenue.toJSON() };
  }
  const approval = evaluateConfiguredApproval(approvalConfig,{category:"owner_payout",amount,periodRevenue,evaluation});
  const stages: Array<{kind:string;ownerId:string;amount:string;currency:string;routing:Prisma.InputJsonObject;recipients:string[]}> = [];
  const notifications = new NotificationRepository(tx,ctx.organizationId);
  for (const kind of approval.requiredSteps.flatMap(step => step === "manager_owner" ? ["manager","owner"] : [step])) {
    const routing = notificationRoutingSchema.parse(approvalConfig.routing?.[kind as "manager"|"owner"|"finance"]);
    await notifications.validateRoutingReferences(routing,row.propertyId);
    const recipients = await notifications.approvers(routing,{...target,status:"PENDING_APPROVAL"});
    if (!recipients.length) throw new OwnerPayoutPolicyUnavailableError("Configured payout approval has no authorized recipient");
    stages.push({kind,ownerId:row.ownerId,amount:amount.toJSON().amount,currency:row.currency,routing:json(routing),recipients});
  }
  const method = await repository.method(row.payoutMethodId);
  if (!method || method.ownerId !== row.ownerId || method.currency !== row.currency || method.status !== "ACTIVE" || method.archivedAt) throw new OwnerPayoutPolicyUnavailableError("Payout recipient terms are unavailable");
  const methodSnapshotHash = ownerPayoutMethodHash(method);
  return { stages, eligibleAt:payout.eligibleOn, methodSnapshotHash, snapshot:json({schemaVersion:1,payoutId:row.id,sourceVersion:row.version,
    ownerId:row.ownerId,propertyId:row.propertyId,reservationId:row.reservationId,fundingAccountId:row.fundingAccountId,payoutMethodId:row.payoutMethodId,
    amount:amount.toJSON(),expectedSettlementAt:row.expectedSettlementAt,methodSnapshotHash,submittedBy:ctx.actorId,submittedAt:now,timezone:row.property.timezone,ownershipSnapshotId,
    payout,approval,stages,payoutRule,approvalRule,configReferences:references,revenueEvidence,availableBalance:capacity.balance.toJSON(),committedAmount:capacity.committed.toJSON()}) };
}
