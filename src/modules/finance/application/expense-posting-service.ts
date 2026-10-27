import { z } from "zod";
import { authorize, type Action, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { expensePostings,expenseResource,isExpenseFundingAccount } from "../domain/expense";
import { ExpenseRepository } from "../infrastructure/expense-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { AccountingPeriodAdjustmentRepository } from "../infrastructure/accounting-period-adjustment-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { ExpenseAccessError,ExpenseConflictError,ExpenseConfigurationError } from "./expense-service";

const inputSchema=z.object({id:z.uuid().transform(value=>value.toLowerCase()),expectedVersion:z.number().int().positive(),reason:z.string().trim().min(6).max(500)}).strict();
const postInputSchema=inputSchema.extend({currentPeriod:z.boolean().default(false)}).strict();
const moneySchema=z.object({amount:z.string(),currency:z.string()});
const allocationSchema=z.object({owner:moneySchema,alvillas:moneySchema,guest:moneySchema});
const snapshotSchema=z.object({timezone:z.string().min(1),allocation:allocationSchema,policies:z.array(z.object({ownerId:z.uuid(),ownerName:z.string(),shareBps:z.number().int(),allocation:allocationSchema})).min(1)});
type Deps={db?:TenantTransactionRunner;requestId?:string};

/** A final financial approval permits posting; the posting command still requires its own grants. */
export async function postExpense(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=postInputSchema.parse(raw);
  if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId)throw new ExpenseAccessError();
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const expenses=new ExpenseRepository(tx,ctx.organizationId),hint=await expenses.find(input.id);
    if(!hint)throw new ExpenseAccessError();
    for(const id of [...new Set([input.id,...(hint.correctsExpenseId?[hint.correctsExpenseId]:[])])].sort())await expenses.lock(id);
    let clock=await expenses.clock();
    const row=await expenses.find(input.id);if(!row||row.property.archivedAt)throw new ExpenseAccessError();
    const periods=new AccountingPeriodRepository(tx,ctx.organizationId);
    const timezone=z.object({timezone:z.string().min(1)}).safeParse(row.submission?.snapshot);
    const sourceOccurredAt=await periods.sourceInstant(row.occurredOn,timezone.success?timezone.data.timezone:row.property.timezone);
    const target=expenseResource(ctx.organizationId,row.property,{...row,amount:row.amount.toString(),occurredAt:sourceOccurredAt});
    const postingTarget={...target,type:"financial_transaction" as const,occurredAt:row.transaction?.occurredAt??(input.currentPeriod?clock.now:sourceOccurredAt)};
    const original=row.correctsExpenseId?await expenses.find(row.correctsExpenseId):null;
    const correctionChecks:Array<{action:Action;resource:Resource}>=[];
    if(row.correctsExpenseId){
      if(!original?.transactionId||!original.submission||original.property.archivedAt)throw new ExpenseAccessError();
      const oldTimezone=z.object({timezone:z.string().min(1)}).safeParse(original.submission.snapshot);
      if(!oldTimezone.success)throw new ExpenseConfigurationError("Original expense policy is unavailable");
      const oldAt=await periods.sourceInstant(original.occurredOn,oldTimezone.data.timezone);
      const oldExpense=expenseResource(ctx.organizationId,original.property,{...original,amount:original.amount.toString(),occurredAt:oldAt});
      const oldJournal={...oldExpense,type:"financial_transaction" as const,id:original.transactionId,financialRecordId:original.transactionId,occurredAt:original.transaction!.occurredAt};
      correctionChecks.push({action:"view",resource:oldExpense},{action:"void",resource:oldExpense},{action:"view",resource:oldJournal},
        {action:"void",resource:oldJournal},{action:"override",resource:oldJournal});
    }
    const checks:ReadonlyArray<{action:Action;resource:Resource}>=[
      {action:"view",resource:target},{action:"pay",resource:target},{action:"create",resource:postingTarget},
      {action:"view",resource:{...target,type:"financial_transaction",id:row.fundingAccountId,financialRecordId:row.fundingAccountId}},
      ...(input.currentPeriod?[{action:"override" as const,resource:{...target,type:"financial_transaction" as const}}]:[]),...correctionChecks
    ];
    await recheckFinanceAuthorization(ctx,tx,clock.now,checks,new ExpenseAccessError());
    if(row.correctsExpenseId&&!input.currentPeriod)throw new ExpenseConflictError();
    if(row.transactionId){
      const audit=await expenses.lifecycleAudit(row.id,"expense.posted"),before=z.object({version:z.number()}).safeParse(audit?.before);
      const after=z.object({postingDateMode:z.enum(["SOURCE_DATE","CURRENT_OPEN_PERIOD"]).default("SOURCE_DATE")}).safeParse(audit?.after);
      if(!audit||audit.actorId!==ctx.actorId||audit.reason!==input.reason||!before.success||before.data.version!==input.expectedVersion||!after.success||
        after.data.postingDateMode!==(input.currentPeriod?"CURRENT_OPEN_PERIOD":"SOURCE_DATE")||Boolean(row.periodAdjustment||row.correctsExpenseId)!==input.currentPeriod)throw new ExpenseConflictError();
      return{id:row.id,version:row.version,transactionId:row.transactionId,idempotent:true,...(row.periodAdjustment?{accountingPeriodAdjustmentId:row.periodAdjustment.id}:{})};
    }
    if(row.state!=="APPROVED"||row.version!==input.expectedVersion||!row.submission||
      row.approval&&row.approval.state!=="APPROVED"||row.approval?.financialStages.some(stage=>stage.state!=="APPROVED"))throw new ExpenseConflictError();
    const frozen=snapshotSchema.safeParse(row.submission.snapshot);if(!frozen.success)throw new ExpenseConfigurationError("Submitted expense allocation is unavailable");
    let sourcePeriod:Awaited<ReturnType<AccountingPeriodRepository["postingPeriod"]>>=null;
    if(input.currentPeriod){
      const sourceOpen=await periods.postingOpen(sourceOccurredAt);
      if(sourceOpen&&!original)throw new ExpenseConflictError();
      if(!sourceOpen){sourcePeriod=await periods.postingPeriod(sourceOccurredAt);if(!sourcePeriod?.events[0])throw new ExpenseConflictError();}
      clock=await expenses.clock();postingTarget.occurredAt=clock.now;
    }
    let correctionReversal:string|null=null;
    if(original){
      if(original.state!=="POSTED"||original.version!==row.correctsExpenseVersion)throw new ExpenseConflictError();
      const reversed=await voidExpense(ctx,{id:original.id,expectedVersion:row.correctsExpenseVersion,reason:input.reason},
        {db:{$transaction:work=>work(tx)},requestId:deps.requestId});
      correctionReversal=reversed.reversalTransactionId;
    }
    const amount=Money.of(row.amount.toString(),row.currency),money=(value:z.infer<typeof moneySchema>)=>Money.of(value.amount,value.currency);
    const allocation={ownerAmount:money(frozen.data.allocation.owner),alvillasAmount:money(frozen.data.allocation.alvillas),guestAmount:money(frozen.data.allocation.guest)};
    const finance=new FinanceRepository(tx,ctx.organizationId),funding=await finance.findLedgerAccountById(row.fundingAccountId);
    if(!funding||!isExpenseFundingAccount(funding))throw new ExpenseConfigurationError("Expense funding account is unavailable");
    async function account(code:string,name:string,accountType:string,normalSide:"DEBIT"|"CREDIT",needed:boolean){
      if(!needed)return "";
      const result=await finance.ensureLedgerAccount({code,name,accountType,normalSide});
      if(result.archivedAt||result.accountType!==accountType||result.normalSide!==normalSide)throw new ExpenseConfigurationError("Expense ledger account is unavailable");
      return result.id;
    }
    const ownerAccount=await account("OWNER_PAYABLE","Owner payable","CLAIM_OWNERSHIP","CREDIT",allocation.ownerAmount.amount.gt(0));
    const companyAccount=await account("ALVILLAS_EXPENSE","ALVILLAS expense","ALVILLAS_OWN","DEBIT",allocation.alvillasAmount.amount.gt(0));
    const guestAccount=await account("GUEST_RECEIVABLE","Guest receivable","CLAIM_OWNERSHIP","DEBIT",allocation.guestAmount.amount.gt(0));
    const dimensions={expense_id:row.id,property_id:row.propertyId,...(row.reservationId?{reservation_id:row.reservationId}:{}),category:row.category,source:"EXPENSE"};
    const postings=expensePostings({amount,allocation,owners:frozen.data.policies,ownerAmounts:frozen.data.policies.map(policy=>({ownerId:policy.ownerId,amount:money(policy.allocation.owner)})),
      ownerAccounts:new Map(frozen.data.policies.map(policy=>[policy.ownerId,ownerAccount])),companyExpenseAccountId:companyAccount,guestReceivableAccountId:guestAccount,fundingAccountId:funding.id,dimensions});
    const journal=await finance.createFinancialTransaction({reference:`EXPENSE:${row.id}`,description:row.purpose,occurredAt:postingTarget.occurredAt,
      idempotencyKey:`expense:${row.id}:posted`,createdBy:ctx.actorId,postings,
      recheckAuthorization: at => recheckFinanceAuthorization(ctx,tx,at,checks,new ExpenseAccessError()) });
    const adjustment=sourcePeriod?await new AccountingPeriodAdjustmentRepository(tx,ctx.organizationId).create({expenseId:row.id,transactionId:journal.id,
      periodId:sourcePeriod.id,periodEventId:sourcePeriod.events[0].id,sourceOccurredAt,createdBy:ctx.actorId,reason:input.reason}):null;
    if((await expenses.transition(row.id,row.version,"APPROVED","POSTED",ctx.actorId,journal.id)).count!==1)throw new ExpenseConflictError();
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"expense.posted",resourceType:"expense",resourceId:row.id,propertyScopeId:row.propertyId,
      before:{state:row.state,version:row.version},after:{state:"POSTED",version:row.version+1,transactionId:journal.id,submissionId:row.submission.id,amount:amount.toJSON(),
        postingDateMode:input.currentPeriod?"CURRENT_OPEN_PERIOD":"SOURCE_DATE",...(adjustment?{accountingPeriodAdjustmentId:adjustment.id}:{})},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now});
    if(adjustment&&sourcePeriod)await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.period.adjustment_posted",
      resourceType:"financial_transaction",resourceId:journal.id,propertyScopeId:row.propertyId,
      after:{adjustmentId:adjustment.id,expenseId:row.id,transactionId:journal.id,sourcePeriodId:sourcePeriod.id,sourcePeriodEventId:sourcePeriod.events[0].id,
        sourceOccurredAt:sourceOccurredAt.toISOString(),postedAt:postingTarget.occurredAt.toISOString(),sourceSubmissionId:row.submission.id},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now});
    if(original&&correctionReversal)await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.expense.correction_posted",
      resourceType:"financial_transaction",resourceId:journal.id,propertyScopeId:row.propertyId,
      after:{originalExpenseId:original.id,originalExpenseVersion:row.correctsExpenseVersion,originalTransactionId:original.transactionId,
        reversalTransactionId:correctionReversal,correctionExpenseId:row.id,transactionId:journal.id,submissionId:row.submission.id,
        originalAmount:Money.of(original.amount.toString(),original.currency).toJSON(),correctedAmount:amount.toJSON()},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now});
    return{id:row.id,version:row.version+1,transactionId:journal.id,idempotent:false,...(adjustment?{accountingPeriodAdjustmentId:adjustment.id}:{})};
  });
}

/** Void by adding an exact opposite journal; the original transaction and its postings remain untouched. */
export async function voidExpense(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=inputSchema.parse(raw);
  if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId)throw new ExpenseAccessError();
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const expenses=new ExpenseRepository(tx,ctx.organizationId);await expenses.lock(input.id);
    const clock=await expenses.clock(),auth=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    const row=await expenses.find(input.id);if(!row||row.property.archivedAt)throw new ExpenseAccessError();
    const timezone=z.object({timezone:z.string().min(1)}).safeParse(row.submission?.snapshot);
    const occurredAt=await new AccountingPeriodRepository(tx,ctx.organizationId).sourceInstant(row.occurredOn,timezone.success?timezone.data.timezone:row.property.timezone);
    const target=expenseResource(ctx.organizationId,row.property,{...row,amount:row.amount.toString(),occurredAt});
    const financialTarget={...target,type:"financial_transaction" as const,id:row.transactionId??row.id,financialRecordId:row.transactionId??row.id,occurredAt:row.transaction?.occurredAt??occurredAt};
    if(!authorize(auth,"view",target,clock.now)||!authorize(auth,"void",target,clock.now)||
      !authorize(auth,"void",financialTarget,clock.now))throw new ExpenseAccessError();
    const finance=new FinanceRepository(tx,ctx.organizationId),journals=await finance.findTransactionsByIdempotencyKeys([`expense:${row.id}:posted`,`expense:${row.id}:voided`]);
    const original=journals.find(journal=>journal.id===row.transactionId),reversal=journals.find(journal=>journal.reversesTransactionId===row.transactionId);
    if(!original)throw new ExpenseConflictError();
    if(row.state==="VOIDED"){
      const audit=await expenses.lifecycleAudit(row.id,"expense.voided"),before=z.object({version:z.number()}).safeParse(audit?.before);
      if(!reversal||!audit||audit.actorId!==ctx.actorId||audit.reason!==input.reason||!before.success||before.data.version!==input.expectedVersion)throw new ExpenseConflictError();
      return{id:row.id,version:row.version,transactionId:original.id,reversalTransactionId:reversal.id,idempotent:true};
    }
    if(row.state!=="POSTED"||row.version!==input.expectedVersion||original.reversedByTransactions.length)throw new ExpenseConflictError();
    const reverse=await finance.createFinancialTransaction({reference:`EXPENSE:${row.id}:VOID`,description:input.reason,occurredAt:clock.now,
      idempotencyKey:`expense:${row.id}:voided`,reversesTransactionId:original.id,createdBy:ctx.actorId,postings:original.postings.map(posting=>({
        ledgerAccountId:posting.ledgerAccountId,side:posting.side==="DEBIT"?"CREDIT" as const:"DEBIT" as const,
        amount:Money.of(posting.amount.toString(),posting.currency),bucket:z.string().parse(posting.bucket),dimensions:z.record(z.string(),z.unknown()).parse(posting.dimensions)
      })), recheckAuthorization: at => recheckFinanceAuthorization(ctx, tx, at, [
        { action: "view", resource: target }, { action: "void", resource: target },
        { action: "void", resource: { ...financialTarget, id: original.id, financialRecordId: original.id, occurredAt: original.occurredAt } }
      ], new ExpenseAccessError()) });
    if((await expenses.transition(row.id,row.version,"POSTED","VOIDED",ctx.actorId)).count!==1)throw new ExpenseConflictError();
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"expense.voided",resourceType:"expense",resourceId:row.id,propertyScopeId:row.propertyId,
      before:{state:row.state,version:row.version},after:{state:"VOIDED",version:row.version+1,transactionId:original.id,reversalTransactionId:reverse.id},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now});
    return{id:row.id,version:row.version+1,transactionId:original.id,reversalTransactionId:reverse.id,idempotent:false};
  });
}
