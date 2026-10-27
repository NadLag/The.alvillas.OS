import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { ownerPayoutCommandSchema, ownerPayoutDraftSchema, ownerPayoutResource, ownerPayoutFundingChecks } from "../domain/owner-payout";
import { isExpenseFundingAccount, expenseFundingWalletResource } from "../domain/expense";
import { OwnerPayoutRepository } from "../infrastructure/owner-payout-repository";
import { OwnerLedgerRepository } from "../infrastructure/owner-ledger-repository";
import { ExpenseRepository } from "../infrastructure/expense-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { prepareOwnerPayoutPolicy, ownerPayoutMethodHash } from "./owner-payout-policy";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { canViewCompleteOwnerLedger } from "../domain/owner-ledger";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class OwnerPayoutAccessError extends Error {}
export class OwnerPayoutConflictError extends Error {}
export class OwnerPayoutConfigurationError extends Error {}

export async function createOwnerPayout(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = ownerPayoutDraftSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new OwnerPayoutRepository(tx, ctx.organizationId);
    await repository.lockKey(input.idempotencyKey);
    const finance = new FinanceRepository(tx, ctx.organizationId), now = await finance.clock();
    const property = await repository.property(input.propertyId);
    if (!property) throw new OwnerPayoutAccessError();
    const target: Resource = { type: "financial_transaction", organizationId: ctx.organizationId, propertyId: property.id, ownerId: input.ownerId,
      amount: input.amount, status: "DRAFT", assignedUserAccountId: ctx.actorId, city: property.cityId, region: property.regionId, dataClass: "financial" };
    await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: target }, { action: "create", resource: target }], new OwnerPayoutAccessError());
    const existing = await repository.byKey(input.idempotencyKey);
    if (existing) {
      await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: ownerPayoutResource(ctx.organizationId, existing, existing.property) }], new OwnerPayoutAccessError());
      const audit = await repository.audit(existing.id, "finance.owner_payout.created");
      const saved = z.object({ request: ownerPayoutDraftSchema }).safeParse(audit?.after);
      if (!audit || audit.actorId !== ctx.actorId || !saved.success || JSON.stringify(saved.data.request) !== JSON.stringify(input)) throw new OwnerPayoutConflictError();
      return { id: existing.id, idempotent: true };
    }
    const ledger = new OwnerLedgerRepository(tx, ctx.organizationId), owner = await ledger.owner(input.ownerId);
    if (!owner || !owner.propertyOwners.some(row => row.property.id === property.id) && !await ledger.hasPropertyHistory(owner.id, property.id)) throw new OwnerPayoutAccessError();
    const method = await repository.method(input.payoutMethodId), funding = await finance.findLedgerAccountById(input.fundingAccountId);
    const currency = await new ExpenseRepository(tx, ctx.organizationId).currency(input.currency);
    if (!currency || currency.minorUnit > 2 || Money.of(input.amount,input.currency).amount.decimalPlaces() > currency.minorUnit ||
      !method || method.ownerId !== owner.id || method.currency !== input.currency || method.status !== "ACTIVE" || method.archivedAt || !funding || !isExpenseFundingAccount(funding)) throw new OwnerPayoutConfigurationError();
    const source: Resource = { type: "financial_transaction", organizationId: ctx.organizationId, id: funding.id, financialRecordId: funding.id, dataClass: "financial" };
    const wallet = expenseFundingWalletResource(ctx.organizationId, funding, input.amount, now);
    await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: source }, ...(wallet ? [{ action: "view" as const, resource: wallet }] : [])], new OwnerPayoutAccessError());
    if (input.reservationId && (await repository.booking(input.reservationId))?.propertyId !== property.id) throw new OwnerPayoutAccessError();
    const row = await repository.create(input, ctx.actorId);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.owner_payout.created", resourceType: "owner_payout", resourceId: row.id,
      propertyScopeId: property.id, after: { request: input, payoutId: row.id, state: row.state, version: row.version }, reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { id: row.id, idempotent: false };
  });
}

export async function getOwnerPayout(ctx: FinanceActorContext, rawId: string, deps: Deps = {}) {
  const id = z.uuid().parse(rawId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new OwnerPayoutRepository(tx, ctx.organizationId), row = await repository.find(id);
    if (!row) throw new OwnerPayoutAccessError();
    const now = await new FinanceRepository(tx, ctx.organizationId).clock(), target = ownerPayoutResource(ctx.organizationId, row, row.property);
    await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: target }], new OwnerPayoutAccessError());
    const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
    const permits=(action:"edit"|"pay"|"void"|"create",resource:Resource=target)=>[ctx.authContext,current].every(authority=>authorize(authority,action,resource,now));
    const funding=await new FinanceRepository(tx,ctx.organizationId).findLedgerAccountById(row.fundingAccountId);
    const fundingAllowed=(action:"pay"|"void")=>funding&&ownerPayoutFundingChecks(ctx.organizationId,funding,row.amount.toString(),row.paidAt??now,action)
      .every(check=>[ctx.authContext,current].every(authority=>authorize(authority,check.action,check.resource,now)));
    const frozen=z.object({payout:z.object({timezone:z.string()})}).safeParse(row.policySnapshot);
    const recipientChanged=Boolean(row.methodSnapshotHash&&ownerPayoutMethodHash(row.payoutMethod)!==row.methodSnapshotHash);
    const canViewLedger=[ctx.authContext,current].every(authority=>canViewCompleteOwnerLedger(authority,{type:"owner_statement",organizationId:ctx.organizationId,
      ownerId:row.ownerId,propertyId:row.propertyId,city:row.property.cityId,region:row.property.regionId,dataClass:"financial"},now));
    const data = { id: row.id, ownerId:row.ownerId,propertyId:row.propertyId,ownerName: row.owner.displayName, propertyName: row.property.name, state: row.state, version: row.version,
      amount: row.amount.toFixed(2), currency: row.currency, purpose: row.purpose, payoutMethodLabel: row.payoutMethod.label,
      expectedSettlementAt: row.expectedSettlementAt?.toISOString() ?? null,
      eligibleAt: row.eligibleAt?.toISOString() ?? null, scheduledFor: row.scheduledFor?.toISOString() ?? null, paidAt: row.paidAt?.toISOString() ?? null,
      approvedAt:row.approvedAt?.toISOString()??null,createdAt:row.createdAt.toISOString(),failureReason:row.failureReason,approvalId:row.approvals[0]?.id??null,
      timezone:frozen.success?frozen.data.payout.timezone:row.property.timezone,now:now.toISOString(),recipientChanged,
      canViewWorkspace:canViewLedger&&[ctx.authContext,current].every(authority=>canViewCompleteOwnerLedger(authority,{type:"financial_transaction",organizationId:ctx.organizationId,
        ownerId:row.ownerId,propertyId:row.propertyId,city:row.property.cityId,region:row.property.regionId,dataClass:"financial"},now)),
      canViewLedger,
      paymentReference: row.paymentReference, canEdit: row.state === "DRAFT" && permits("edit"),canSchedule:row.state==="APPROVED"&&permits("edit"),
      canPay:row.state==="SCHEDULED"&&Boolean(row.scheduledFor&&row.scheduledFor<=now)&&permits("pay")&&permits("create")&&Boolean(fundingAllowed("pay"))&&
        Boolean(funding&&isExpenseFundingAccount(funding))&&row.payoutMethod.status==="ACTIVE"&&!row.payoutMethod.archivedAt&&!recipientChanged,
      canReverse:row.state==="PAID"&&permits("void")&&Boolean(fundingAllowed("void"))&&Boolean(row.transaction&&permits("void",{...target,id:row.transaction.id,financialRecordId:row.transaction.id,occurredAt:row.transaction.occurredAt})),
      canFail:row.state==="SCHEDULED"&&permits("edit"),canCancel:["DRAFT","PENDING_APPROVAL","APPROVED","SCHEDULED"].includes(row.state)&&permits("void") };
    const result = present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...target, data }, {}) as typeof data;
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.owner_payout.viewed", resourceType: "owner_payout", resourceId: row.id,
      propertyScopeId: row.propertyId, after: { payoutId: row.id, state: row.state }, reason: "Viewed the authorized owner payout", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return result;
  });
}

export async function submitOwnerPayout(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = ownerPayoutCommandSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new OwnerPayoutRepository(tx,ctx.organizationId), initial = await repository.find(input.id);
    if (!initial) throw new OwnerPayoutAccessError();
    await repository.lockOwner(initial.ownerId,initial.propertyId,initial.currency);
    await repository.lock(initial.id);
    const row = await repository.find(initial.id);
    if (!row || row.ownerId!==initial.ownerId || row.propertyId!==initial.propertyId || row.currency!==initial.currency) throw new OwnerPayoutConflictError();
    const now = await new FinanceRepository(tx,ctx.organizationId).clock(), target = ownerPayoutResource(ctx.organizationId,row,row.property);
    await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource:target},{action:"edit",resource:target}],new OwnerPayoutAccessError());
    if (row.state!=="DRAFT") {
      const audit = await repository.audit(row.id,"finance.owner_payout.submitted");
      if (!audit || audit.actorId!==ctx.actorId || audit.reason!==input.reason ||
        !z.object({version:z.literal(input.expectedVersion)}).safeParse(audit.before).success) throw new OwnerPayoutConflictError();
      return {id:row.id,version:row.version,state:row.state,approvalId:row.approvals[0]?.id??null,idempotent:true};
    }
    if (row.version!==input.expectedVersion) throw new OwnerPayoutConflictError();
    const funding = await new FinanceRepository(tx,ctx.organizationId).findLedgerAccountById(row.fundingAccountId);
    if (!funding || !isExpenseFundingAccount(funding)) throw new OwnerPayoutConfigurationError();
    const wallet = expenseFundingWalletResource(ctx.organizationId,funding,row.amount.toString(),now);
    await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource:{type:"financial_transaction",organizationId:ctx.organizationId,
      id:funding.id,financialRecordId:funding.id,dataClass:"financial"}},...(wallet?[{action:"view" as const,resource:wallet}]:[])],new OwnerPayoutAccessError());
    const policy = await prepareOwnerPayoutPolicy(ctx,row,target,tx,now);
    if ((await repository.transition(row.id,row.version,"DRAFT","PENDING_APPROVAL",ctx.actorId,{policySnapshot:policy.snapshot,
      methodSnapshotHash:policy.methodSnapshotHash,eligibleAt:policy.eligibleAt})).count!==1) throw new OwnerPayoutConflictError();
    let state="PENDING_APPROVAL", version=row.version+1, approvalId:string|null=null;
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.owner_payout.submitted",resourceType:"owner_payout",resourceId:row.id,
      propertyScopeId:row.propertyId,before:{version:row.version,state:row.state},after:{payoutId:row.id,version,state,policy:policy.snapshot},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
    if (policy.stages.length) {
      const approvals = new ApprovalRepository(tx,ctx.organizationId), approval = await approvals.createFinancial({payoutId:row.id,propertyId:row.propertyId,
        requestedBy:ctx.actorId,title:row.purpose.slice(0,160),details:row.purpose.length>=6?row.purpose:input.reason,stages:policy.stages});
      if (!approval) throw new OwnerPayoutConflictError();approvalId=approval.id;
      await approvals.event("ApprovalRequested",approval.id,row.propertyId);
      await new NotificationRepository(tx,ctx.organizationId).publish({kind:"approval_requested",recipientId:ctx.actorId,targetId:approval.id},
        `approval:${approval.id}:stage:${approval.financialStages[0].id}:requested`);
    } else {
      if ((await repository.transition(row.id,version,"PENDING_APPROVAL","APPROVED",ctx.actorId,{approvedAt:now})).count!==1) throw new OwnerPayoutConflictError();
      await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.owner_payout.approved",resourceType:"owner_payout",resourceId:row.id,
        propertyScopeId:row.propertyId,before:{version,state},after:{payoutId:row.id,version:version+1,state:"APPROVED",approvalByPolicy:true},
        reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
      state="APPROVED";version++;
    }
    return {id:row.id,version,state,approvalId,idempotent:false};
  });
}
