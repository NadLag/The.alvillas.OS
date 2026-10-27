import { z } from "zod";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { calendarDateAt } from "@/i18n/format";
import { expenseDraftSchema, expenseResource, viewableExpenseResource, isExpenseFundingAccount, type ExpenseDraftInput } from "../domain/expense";
import { ExpenseRepository, type ExpenseRecord } from "../infrastructure/expense-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { prepareExpenseSubmissionPolicy } from "./expense-submission-policy";
import { ExpenseAllocationConfigurationError } from "../domain/configured-finance-rules";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { accountingPeriodState } from "../domain/accounting-period";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class ExpenseAccessError extends Error {}
export class ExpenseConflictError extends Error {}
export class ExpenseConfigurationError extends Error {}
const updateSchema = z.object({ id: z.uuid(), expectedVersion: z.number().int().positive(), draft: expenseDraftSchema }).strict();
const submitSchema = z.object({ id: z.uuid(), expectedVersion: z.number().int().positive(), reason: z.string().trim().min(6).max(500) }).strict();
const correctionDraftSchema = z.object({ id: z.uuid().transform(value => value.toLowerCase()), expectedVersion: z.number().int().positive(),
  amount: expenseDraftSchema.shape.amount, idempotencyKey: z.uuid().transform(value => value.toLowerCase()), reason: z.string().trim().min(6).max(500) }).strict();

function assertActor(ctx: FinanceActorContext) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new ExpenseAccessError();
}
type Property = NonNullable<Awaited<ReturnType<ExpenseRepository["property"]>>>;
function resource(ctx: FinanceActorContext, property: Property, facts: { id: string; amount: string; reservationId?: string | null; state: string; occurredOn: Date; createdBy: string }): Resource {
  return expenseResource(ctx.organizationId,property,facts);
}
async function current(ctx: FinanceActorContext, tx: TenantTransaction): Promise<FinanceActorContext> {
  return { ...ctx, authContext: { ...await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId), personId: ctx.authContext.personId } };
}
async function validateAmount(repository: ExpenseRepository, amount: string, currencyCode: string) {
  const currency = await repository.currency(currencyCode), money = Money.of(amount, currencyCode);
  if (!currency || currency.minorUnit > 2 || money.amount.decimalPlaces() > currency.minorUnit) throw new ExpenseConfigurationError("Expense currency precision is unavailable");
  return money;
}
async function validateFacts(ctx: FinanceActorContext, tx: TenantTransaction, input: ExpenseDraftInput, id: string, now: Date, action: "create" | "edit", sourceTimezone?: string) {
  const repository = new ExpenseRepository(tx, ctx.organizationId), property = await repository.property(input.propertyId);
  if (!property) throw new ExpenseAccessError();
  const target = resource(ctx, sourceTimezone ? { ...property, timezone: sourceTimezone } : property, { id, amount: input.amount, reservationId: input.reservationId, state: "DRAFT",
    occurredOn: new Date(`${input.occurredOn}T00:00:00.000Z`), createdBy: ctx.actorId });
  if (!authorize(ctx.authContext, action, target, now) || !authorize(ctx.authContext, "view",
    { ...target, id: input.fundingAccountId, financialRecordId: input.fundingAccountId, type: "financial_transaction" }, now)) throw new ExpenseAccessError();
  await validateAmount(repository, input.amount, input.currency);
  if (input.reservationId && (await repository.reservation(input.reservationId))?.propertyId !== property.id) throw new ExpenseAccessError();
  const funding = await new FinanceRepository(tx, ctx.organizationId).findLedgerAccountById(input.fundingAccountId);
  if (!funding || !isExpenseFundingAccount(funding))
    throw new ExpenseConfigurationError("Expense funding account requires its authorized payment workflow");
  if (!authorize(ctx.authContext, "view", { ...target, id: funding.id, financialRecordId: funding.id, type: "financial_transaction" }, now)) throw new ExpenseAccessError();
  return { target, property };
}
function facts(row: ExpenseRecord) {
  return { id: row.id, propertyId: row.propertyId, reservationId: row.reservationId, fundingAccountId: row.fundingAccountId,
    amount: row.amount.toFixed(2), currency: row.currency, category: row.category, purpose: row.purpose,
    occurredOn: row.occurredOn.toISOString().slice(0,10), emergency: row.emergency, version: row.version, state: row.state,
    ...(row.correctsExpenseId ? { correctsExpenseId: row.correctsExpenseId, correctsExpenseVersion: row.correctsExpenseVersion } : {}) };
}
function sourceProperty(row: ExpenseRecord) {
  const frozen = z.object({ timezone: z.string().min(1) }).safeParse(row.submission?.snapshot ?? row.correctsExpense?.submission?.snapshot);
  return frozen.success ? { ...row.property, timezone: frozen.data.timezone } : row.property;
}
function sameDraft(row: ExpenseRecord, input: ExpenseDraftInput) {
  return row.propertyId === input.propertyId && row.reservationId === (input.reservationId ?? null) && row.fundingAccountId === input.fundingAccountId &&
    row.amount.eq(input.amount) && row.currency === input.currency && row.category === input.category && row.purpose === input.purpose &&
    row.occurredOn.toISOString().slice(0,10) === input.occurredOn && row.emergency === input.emergency;
}
export async function createExpenseDraft(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  assertActor(ctx); const input = expenseDraftSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId); await repository.lock(`draft:${input.idempotencyKey}`);
    const clock = await repository.clock(); ctx = await current(ctx, tx);
    await validateFacts(ctx, tx, input, clock.id, clock.now, "create");
    const previous = await repository.byKey(input.idempotencyKey);
    if (previous) {
      if (previous.correctsExpenseId || previous.createdBy !== ctx.actorId || !sameDraft(previous, input)) throw new ExpenseConflictError();
      return { id: previous.id, version: previous.version, idempotent: true };
    }
    const row = await repository.create(clock.id, input, ctx.actorId);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "expense.created", resourceType: "expense",
      resourceId: row.id, propertyScopeId: row.propertyId, after: facts(row), reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    return { id: row.id, version: row.version, idempotent: false };
  });
}

/** Prepare a revised invoice for its own approval; the posted source remains unchanged. */
export async function createExpenseCorrectionDraft(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  assertActor(ctx); const input = correctionDraftSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId);
    await repository.lock(`draft:${input.idempotencyKey}`); await repository.lock(input.id);
    const clock = await repository.clock(), original = await repository.find(input.id);
    if (!original || original.property.archivedAt || !original.transactionId || !original.submission) throw new ExpenseAccessError();
    const frozen = z.object({ timezone: z.string().min(1) }).safeParse(original.submission.snapshot);
    if (!frozen.success) throw new ExpenseConfigurationError("Original expense policy is unavailable");
    const occurredAt = await new AccountingPeriodRepository(tx, ctx.organizationId).sourceInstant(original.occurredOn, frozen.data.timezone);
    const source = expenseResource(ctx.organizationId, original.property, { ...original, amount: original.amount.toString(), occurredAt });
    const financial = { ...source, type: "financial_transaction" as const, id: original.transactionId, financialRecordId: original.transactionId,
      occurredAt: original.transaction!.occurredAt };
    await recheckFinanceAuthorization(ctx, tx, clock.now, [{ action: "view", resource: source }, { action: "view", resource: financial },
      { action: "view", resource: { ...financial, id: original.fundingAccountId, financialRecordId: original.fundingAccountId, occurredAt } },
      { action: "override", resource: financial }, { action: "create", resource: { ...source, id: clock.id, financialRecordId: clock.id,
        status: "DRAFT", assignedUserAccountId: ctx.actorId, amount: input.amount } }], new ExpenseAccessError());
    const previous = await repository.byKey(input.idempotencyKey);
    if (previous) {
      const audit = await repository.lifecycleAudit(previous.id, "expense.created");
      if (previous.createdBy !== ctx.actorId || previous.correctsExpenseId !== original.id || previous.correctsExpenseVersion !== input.expectedVersion ||
        !previous.amount.eq(input.amount) || audit?.actorId !== ctx.actorId || audit.reason !== input.reason) throw new ExpenseConflictError();
      return { id: previous.id, version: previous.version, idempotent: true };
    }
    if (original.state !== "POSTED" || original.version !== input.expectedVersion || original.amount.eq(input.amount)) throw new ExpenseConflictError();
    await validateAmount(repository, input.amount, original.currency);
    const funding = await new FinanceRepository(tx, ctx.organizationId).findLedgerAccountById(original.fundingAccountId);
    if (!funding || !isExpenseFundingAccount(funding)) throw new ExpenseConfigurationError("Expense funding account is unavailable");
    const draft = expenseDraftSchema.parse({ propertyId: original.propertyId, reservationId: original.reservationId ?? undefined,
      fundingAccountId: original.fundingAccountId, amount: input.amount, currency: original.currency, category: original.category, purpose: original.purpose,
      occurredOn: original.occurredOn.toISOString().slice(0,10), emergency: false, idempotencyKey: input.idempotencyKey, reason: input.reason });
    const row = await repository.create(clock.id, draft, ctx.actorId, { correctsExpenseId: original.id, correctsExpenseVersion: original.version });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "expense.created", resourceType: "expense", resourceId: row.id,
      propertyScopeId: row.propertyId, after: { ...facts(row), correctsExpenseId: original.id, correctsExpenseVersion: original.version }, reason: input.reason,
      requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.expense.correction_requested",
      resourceType: "financial_transaction", resourceId: original.transactionId, propertyScopeId: row.propertyId,
      after: { originalExpenseId: original.id, originalExpenseVersion: original.version, correctionExpenseId: row.id, amount: Money.of(input.amount, row.currency).toJSON() },
      reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    return { id: row.id, version: row.version, idempotent: false };
  });
}
export async function updateExpenseDraft(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  assertActor(ctx); const { id, expectedVersion, draft: input } = updateSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId); await repository.lock(id);
    const clock = await repository.clock(); ctx = await current(ctx, tx);
    const previous = await repository.find(id);
    if (!previous || previous.property.archivedAt || !authorize(ctx.authContext, "edit", resource(ctx, sourceProperty(previous),
      { ...previous, amount: previous.amount.toString() }), clock.now)) throw new ExpenseAccessError();
    if (previous.correctsExpenseId && (!previous.correctsExpense || input.propertyId !== previous.propertyId ||
      (input.reservationId ?? null) !== previous.reservationId || input.fundingAccountId !== previous.fundingAccountId || input.currency !== previous.currency ||
      input.category !== previous.category || input.purpose !== previous.purpose || input.occurredOn !== previous.occurredOn.toISOString().slice(0,10) || input.emergency ||
      previous.correctsExpense.amount.eq(input.amount))) throw new ExpenseConflictError();
    await validateFacts(ctx, tx, input, id, clock.now, "edit", sourceProperty(previous).timezone);
    if (previous.idempotencyKey !== input.idempotencyKey || previous.version !== expectedVersion || previous.state !== "DRAFT") throw new ExpenseConflictError();
    if ((await repository.updateDraft(id, expectedVersion, input, ctx.actorId)).count !== 1) throw new ExpenseConflictError();
    const row = await repository.find(id); if (!row) throw new ExpenseConflictError();
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "expense.updated", resourceType: "expense", resourceId: id,
      propertyScopeId: row.propertyId, before: facts(previous), after: facts(row), reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    return { id, version: row.version };
  });
}

export async function submitExpense(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  assertActor(ctx); const input = submitSchema.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId); await repository.lock(input.id);
    const clock = await repository.clock(); ctx = await current(ctx, tx);
    const row = await repository.find(input.id);
    if (!row || row.property.archivedAt) throw new ExpenseAccessError();
    const target = resource(ctx, sourceProperty(row), { ...row, amount: row.amount.toString() });
    if (!authorize(ctx.authContext, "view", target, clock.now) || !authorize(ctx.authContext, "edit", target, clock.now)) throw new ExpenseAccessError();
    if (row.submission) {
      const prior = z.object({ sourceExpenseVersion: z.number(), reason: z.string() }).safeParse(row.submission.snapshot);
      if (!prior.success || row.submission.submittedBy !== ctx.actorId || prior.data.sourceExpenseVersion !== input.expectedVersion || prior.data.reason !== input.reason) throw new ExpenseConflictError();
      return { id: row.id, version: row.version, state: row.state, approvalId: row.approval?.id ?? null, idempotent: true };
    }
    if (row.state !== "DRAFT" || row.version !== input.expectedVersion) throw new ExpenseConflictError();
    await validateFacts(ctx, tx, expenseDraftSchema.parse({ propertyId: row.propertyId, reservationId: row.reservationId ?? undefined,
      fundingAccountId: row.fundingAccountId, amount: row.amount.toString(), currency: row.currency, category: row.category, purpose: row.purpose,
      occurredOn: row.occurredOn.toISOString().slice(0,10), emergency: row.emergency, idempotencyKey: row.idempotencyKey, reason: input.reason }), row.id, clock.now, "edit", sourceProperty(row).timezone);
    let plan: Awaited<ReturnType<typeof prepareExpenseSubmissionPolicy>>;
    try { plan = await prepareExpenseSubmissionPolicy(ctx, row, target, tx, clock.now); }
    catch (error) { if (error instanceof z.ZodError||error instanceof ExpenseAllocationConfigurationError) throw new ExpenseConfigurationError("Expense policy is invalid or incomplete"); throw error; }
    const submission = await repository.submit(row.id, ctx.actorId, { ...plan.snapshot, reason: input.reason }, clock.now);
    if ((await repository.transition(row.id, row.version, "DRAFT", "PENDING_APPROVAL", ctx.actorId)).count !== 1) throw new ExpenseConflictError();
    let approvalId: string | null = null, state = "PENDING_APPROVAL", version = row.version + 1;
    if (plan.stages.length) {
      const approvals = new ApprovalRepository(tx, ctx.organizationId);
      const approval = await approvals.createFinancial({ expenseId: row.id, propertyId: row.propertyId, requestedBy: ctx.actorId,
        title: row.purpose.slice(0,160), details: row.purpose.length >= 6 ? row.purpose : input.reason, stages: plan.stages });
      if (!approval) throw new ExpenseConflictError(); approvalId = approval.id;
      await approvals.event("ApprovalRequested", approval.id, row.propertyId);
      await new NotificationRepository(tx, ctx.organizationId).publish({ kind: "approval_requested", recipientId: ctx.actorId, targetId: approval.id }, `approval:${approval.id}:stage:${approval.financialStages[0].id}:requested`);
    } else {
      if ((await repository.transition(row.id, version, state, "APPROVED", ctx.actorId)).count !== 1) throw new ExpenseConflictError();
      state = "APPROVED"; version++;
      await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "expense.approved_by_policy", resourceType: "expense", resourceId: row.id,
        propertyScopeId: row.propertyId, before: { state: "PENDING_APPROVAL" }, after: { state, submissionId: submission.id },
        reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    }
    const payload = { expenseId: row.id, propertyId: row.propertyId, ...(row.reservationId ? { reservationId: row.reservationId } : {}),
      submissionId: submission.id, version: row.version + 1, state, ...(approvalId ? { approvalId } : {}) };
    await repository.event("ExpenseSubmitted", row.id, payload, clock.now);
    if (plan.overThreshold) await repository.event("ExpenseOverThreshold", row.id, payload, clock.now);
    if (plan.postHocNotices.length) {
      const receipt = await new NotificationRepository(tx,ctx.organizationId).publishExpenseEmergencyNotices(row.id,plan.postHocNotices);
      await writeAuditEvent(tx,{ organizationId:ctx.organizationId,actorId:ctx.actorId,action:"expense.emergency_owner_notified",resourceType:"expense",resourceId:row.id,
        propertyScopeId:row.propertyId,after:{ ownerIds:plan.postHocNotices.map(notice=>notice.ownerId),noticeCount:receipt.count,ownerApprovalBypassed:true },
        reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now });
    }
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "expense.submitted", resourceType: "expense", resourceId: row.id,
      propertyScopeId: row.propertyId, before: facts(row), after: { state, version, submissionId: submission.id, approvalId, policy: plan.snapshot },
      reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: clock.now });
    return { id: row.id, version, state, approvalId, idempotent: false };
  });
}

async function editorChoices(ctx:FinanceActorContext,tx:TenantTransaction,target:Resource,now:Date,selectedReservationId?:string|null,selectedFundingAccountId?:string|null){
  if(!target.propertyId)throw new ExpenseAccessError();
  const repository=new ExpenseRepository(tx,ctx.organizationId),sources=await repository.editorSources();
  const accounts=(await new FinanceRepository(tx,ctx.organizationId).listRevenuePostingAccounts()).filter(account=>!account.code.startsWith("CASH_CUSTODY_")&&
    authorize(ctx.authContext,"view",{...target,type:"financial_transaction",id:account.id,financialRecordId:account.id},now));
  if(selectedFundingAccountId&&!accounts.some(account=>account.id===selectedFundingAccountId)){
    const selected=await new FinanceRepository(tx,ctx.organizationId).findLedgerAccountById(selectedFundingAccountId);
    if(selected&&isExpenseFundingAccount(selected)&&authorize(ctx.authContext,"view",{...target,type:"financial_transaction",id:selected.id,financialRecordId:selected.id},now))
      accounts.push({id:selected.id,name:selected.name,code:selected.code});
  }
  const choices=await repository.reservationChoices(target.propertyId);
  if(selectedReservationId&&!choices.some(row=>row.id===selectedReservationId)){
    const selected=await repository.reservation(selectedReservationId);if(selected?.propertyId===target.propertyId)choices.push(selected);
  }
  const reservations=choices.filter(reservation=>authorize(ctx.authContext,"view",{...target,type:"reservation",id:reservation.id,reservationId:reservation.id,
    dataClass:"operational",status:reservation.status,assignedUserAccountId:reservation.createdBy},now)).map(({id,reference})=>({id,reference}));
  const chart={type:"financial_transaction",organizationId:ctx.organizationId,dataClass:"financial" as const};
  return{...sources,accounts,reservations,canConfigureAccounts:authorize(ctx.authContext,"view",chart,now)&&authorize(ctx.authContext,"configure",chart,now)};
}
export async function getExpenseDraftEditor(ctx:FinanceActorContext,id:string,deps:Deps={}){
  assertActor(ctx);z.uuid().parse(id);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new ExpenseRepository(tx,ctx.organizationId),clock=await repository.clock();ctx=await current(ctx,tx);
    const row=await repository.find(id);if(!row||row.property.archivedAt)throw new ExpenseAccessError();
    const target=resource(ctx,sourceProperty(row),{...row,amount:row.amount.toString()});
    if(!authorize(ctx.authContext,"view",target,clock.now)||!authorize(ctx.authContext,"edit",target,clock.now))throw new ExpenseAccessError();
    if(row.state!=="DRAFT")throw new ExpenseConflictError();
    const choices=await editorChoices(ctx,tx,target,clock.now,row.reservationId,row.fundingAccountId);
    return{editor:{property:{id:row.property.id,name:row.property.name,timezone:row.property.timezone},...choices,today:calendarDateAt(clock.now,row.property.timezone)},
      draft:{...facts(row),idempotencyKey:row.idempotencyKey}};
  });
}
export async function getExpenseEditor(ctx: FinanceActorContext, propertyId: string, deps: Deps = {}, fundingAccountId?: string) {
  assertActor(ctx); z.uuid().parse(propertyId);
  if(fundingAccountId)z.uuid().parse(fundingAccountId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId), clock = await repository.clock(); ctx = await current(ctx, tx);
    const property = await repository.property(propertyId); if (!property) throw new ExpenseAccessError();
    const today = calendarDateAt(clock.now, property.timezone);
    const target = resource(ctx, property, { id: clock.id, amount: "0", state: "DRAFT", createdBy: ctx.actorId, occurredOn: new Date(`${today}T00:00:00Z`) });
    if (!authorize(ctx.authContext, "create", target, clock.now) || !authorize(ctx.authContext, "view", target, clock.now)) throw new ExpenseAccessError();
    const choices=await editorChoices(ctx,tx,target,clock.now,undefined,fundingAccountId);
    if(fundingAccountId&&!choices.accounts.some(account=>account.id===fundingAccountId))throw new ExpenseAccessError();
    return { property: { id: property.id, name: property.name, timezone: property.timezone }, ...choices, today };
  });
}
export async function getExpense(ctx: FinanceActorContext, id: string, deps: Deps = {}) {
  assertActor(ctx); z.uuid().parse(id);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new ExpenseRepository(tx, ctx.organizationId), clock = await repository.clock(); ctx = await current(ctx, tx);
    const row = await repository.find(id); if (!row || row.property.archivedAt) throw new ExpenseAccessError();
    const stored = z.object({ policies:z.array(z.object({ownerId:z.uuid()})),timezone:z.string().optional(),postHocOwnerNotificationRequired:z.boolean().optional() }).safeParse(row.submission?.snapshot ?? row.correctsExpense?.submission?.snapshot);
    const periods=new AccountingPeriodRepository(tx,ctx.organizationId),property={...row.property,timezone:stored.success&&stored.data.timezone?stored.data.timezone:row.property.timezone};
    const occurredAt=await periods.sourceInstant(row.occurredOn,property.timezone),sourceFacts={...row,amount:row.amount.toString(),occurredAt};
    const target = viewableExpenseResource(ctx.authContext,property,sourceFacts,stored.success?stored.data.policies.map(policy=>policy.ownerId):[],clock.now);
    if (!target) throw new ExpenseAccessError();
    const postingSource=expenseResource(ctx.organizationId,property,sourceFacts),financialSource={...postingSource,type:"financial_transaction" as const};
    const payable=row.state==="APPROVED"&&authorize(ctx.authContext,"view",postingSource,clock.now)&&authorize(ctx.authContext,"pay",postingSource,clock.now)&&
      authorize(ctx.authContext,"view",{...financialSource,id:row.fundingAccountId,financialRecordId:row.fundingAccountId},clock.now);
    const calendar=payable?await periods.postingPeriod(occurredAt):null;
    const sourcePeriodClosed=Boolean(calendar&&accountingPeriodState(calendar.events[0],clock.now)==="CLOSED");
    let correctionCanPost=true;
    if(row.correctsExpenseId){
      const original=row.correctsExpense;
      correctionCanPost=Boolean(original?.transactionId&&original.state==="POSTED"&&original.version===row.correctsExpenseVersion);
      if(original?.transactionId&&original.transaction){
        const originalTimezone=z.object({timezone:z.string().min(1)}).safeParse(original.submission?.snapshot);
        if(!originalTimezone.success)correctionCanPost=false;
        else{
          const originalAt=await periods.sourceInstant(original.occurredOn,originalTimezone.data.timezone);
          const source=expenseResource(ctx.organizationId,property,{...original,amount:original.amount.toString(),occurredAt:originalAt});
          const journal={...source,type:"financial_transaction" as const,id:original.transactionId,financialRecordId:original.transactionId,occurredAt:original.transaction.occurredAt};
          correctionCanPost&&=authorize(ctx.authContext,"view",source,clock.now)&&authorize(ctx.authContext,"void",source,clock.now)&&
            authorize(ctx.authContext,"view",journal,clock.now)&&authorize(ctx.authContext,"void",journal,clock.now)&&authorize(ctx.authContext,"override",journal,clock.now);
        }
      }
    }
    const canPostOriginalDate=payable&&!row.correctsExpenseId&&!sourcePeriodClosed&&authorize(ctx.authContext,"create",financialSource,clock.now);
    const canPostInCurrentPeriod=payable&&correctionCanPost&&(Boolean(row.correctsExpenseId)||sourcePeriodClosed)&&authorize(ctx.authContext,"override",financialSource,clock.now)&&
      authorize(ctx.authContext,"create",{...financialSource,occurredAt:clock.now},clock.now);
    const originalJournal={...financialSource,id:row.transactionId??row.id,financialRecordId:row.transactionId??row.id,occurredAt:row.transaction?.occurredAt??occurredAt};
    const canCorrect=row.state==="POSTED"&&Boolean(row.transactionId)&&authorize(ctx.authContext,"view",postingSource,clock.now)&&
      authorize(ctx.authContext,"view",originalJournal,clock.now)&&authorize(ctx.authContext,"override",originalJournal,clock.now)&&
      authorize(ctx.authContext,"create",{...postingSource,id:undefined,financialRecordId:undefined,status:"DRAFT",assignedUserAccountId:ctx.actorId},clock.now)&&
      authorize(ctx.authContext,"view",{...financialSource,id:row.fundingAccountId,financialRecordId:row.fundingAccountId},clock.now);
    const visibleAdjustment=row.periodAdjustment&&row.transactionId&&row.transaction&&authorize(ctx.authContext,"view",{...target,type:"financial_transaction",
      id:row.transactionId,financialRecordId:row.transactionId,occurredAt:row.transaction.occurredAt},clock.now)?row.periodAdjustment:null;
    const data = { ...facts(row), propertyName: row.property.name, approvalId: row.approval?.id ?? null,
      emergencyException:stored.success&&Boolean(stored.data.postHocOwnerNotificationRequired),canSubmit: row.state === "DRAFT" && authorize(ctx.authContext, "edit", target, clock.now),
      canPost:canPostOriginalDate||canPostInCurrentPeriod,canPostOriginalDate,canPostInCurrentPeriod,sourcePeriodClosed,canCorrect,
      postingAdjustment:visibleAdjustment?{id:visibleAdjustment.id,sourcePeriodId:visibleAdjustment.period.id,
        sourceMonth:visibleAdjustment.period.month.toISOString().slice(0,7),sourceOccurredAt:visibleAdjustment.sourceOccurredAt.toISOString(),
        postedAt:row.transaction!.occurredAt.toISOString(),reason:visibleAdjustment.reason}:null,
      canVoid:row.state==="POSTED"&&Boolean(row.transactionId)&&authorize(ctx.authContext,"view",postingSource,clock.now)&&authorize(ctx.authContext,"void",postingSource,clock.now)&&
        authorize(ctx.authContext,"void",{...financialSource,id:row.transactionId!,financialRecordId:row.transactionId!,occurredAt:row.transaction?.occurredAt??occurredAt},clock.now) };
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...target, data }, {}, clock.now) as typeof data;
  });
}
