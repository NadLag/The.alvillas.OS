import { z } from "zod";
import { authorize } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { expensePostings,expenseResource,isExpenseFundingAccount } from "../domain/expense";
import { ExpenseRepository } from "../infrastructure/expense-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { ExpenseAccessError,ExpenseConflictError,ExpenseConfigurationError } from "./expense-service";

const inputSchema=z.object({id:z.uuid(),expectedVersion:z.number().int().positive(),reason:z.string().trim().min(6).max(500)}).strict();
const moneySchema=z.object({amount:z.string(),currency:z.string()});
const allocationSchema=z.object({owner:moneySchema,alvillas:moneySchema,guest:moneySchema});
const snapshotSchema=z.object({allocation:allocationSchema,policies:z.array(z.object({ownerId:z.uuid(),ownerName:z.string(),shareBps:z.number().int(),allocation:allocationSchema})).min(1)});
type Deps={db?:TenantTransactionRunner;requestId?:string};

/** A final financial approval permits posting; the posting command still requires its own grants. */
export async function postExpense(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=inputSchema.parse(raw);
  if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId)throw new ExpenseAccessError();
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const expenses=new ExpenseRepository(tx,ctx.organizationId);await expenses.lock(input.id);
    const clock=await expenses.clock(),auth=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    const row=await expenses.find(input.id);if(!row||row.property.archivedAt)throw new ExpenseAccessError();
    const target=expenseResource(ctx.organizationId,row.property,{...row,amount:row.amount.toString()});
    if(!authorize(auth,"view",target,clock.now)||!authorize(auth,"pay",target,clock.now)||
      !authorize(auth,"create",{...target,type:"financial_transaction"},clock.now)||
      !authorize(auth,"view",{...target,type:"financial_transaction",id:row.fundingAccountId,financialRecordId:row.fundingAccountId},clock.now))throw new ExpenseAccessError();
    if(row.transactionId){
      const audit=await expenses.lifecycleAudit(row.id,"expense.posted"),before=z.object({version:z.number()}).safeParse(audit?.before);
      if(!audit||audit.actorId!==ctx.actorId||audit.reason!==input.reason||!before.success||before.data.version!==input.expectedVersion)throw new ExpenseConflictError();
      return{id:row.id,version:row.version,transactionId:row.transactionId,idempotent:true};
    }
    if(row.state!=="APPROVED"||row.version!==input.expectedVersion||!row.submission||
      row.approval&&row.approval.state!=="APPROVED"||row.approval?.financialStages.some(stage=>stage.state!=="APPROVED"))throw new ExpenseConflictError();
    const frozen=snapshotSchema.safeParse(row.submission.snapshot);if(!frozen.success)throw new ExpenseConfigurationError("Submitted expense allocation is unavailable");
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
    const journal=await finance.createFinancialTransaction({reference:`EXPENSE:${row.id}`,description:row.purpose,occurredAt:new Date(target.occurredAt!),
      idempotencyKey:`expense:${row.id}:posted`,createdBy:ctx.actorId,postings,
      recheckAuthorization: at => recheckFinanceAuthorization(ctx, tx, at, [
        { action: "view", resource: target }, { action: "pay", resource: target },
        { action: "create", resource: { ...target, type: "financial_transaction" } },
        { action: "view", resource: { ...target, type: "financial_transaction", id: row.fundingAccountId, financialRecordId: row.fundingAccountId } }
      ], new ExpenseAccessError()) });
    if((await expenses.transition(row.id,row.version,"APPROVED","POSTED",ctx.actorId,journal.id)).count!==1)throw new ExpenseConflictError();
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"expense.posted",resourceType:"expense",resourceId:row.id,propertyScopeId:row.propertyId,
      before:{state:row.state,version:row.version},after:{state:"POSTED",version:row.version+1,transactionId:journal.id,submissionId:row.submission.id,amount:amount.toJSON()},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now});
    return{id:row.id,version:row.version+1,transactionId:journal.id,idempotent:false};
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
    const target=expenseResource(ctx.organizationId,row.property,{...row,amount:row.amount.toString()});
    if(!authorize(auth,"view",target,clock.now)||!authorize(auth,"void",target,clock.now)||
      !authorize(auth,"void",{...target,type:"financial_transaction",id:row.transactionId??row.id,financialRecordId:row.transactionId??row.id},clock.now))throw new ExpenseAccessError();
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
        { action: "void", resource: { ...target, type: "financial_transaction", id: original.id, financialRecordId: original.id } }
      ], new ExpenseAccessError()) });
    if((await expenses.transition(row.id,row.version,"POSTED","VOIDED",ctx.actorId)).count!==1)throw new ExpenseConflictError();
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"expense.voided",resourceType:"expense",resourceId:row.id,propertyScopeId:row.propertyId,
      before:{state:row.state,version:row.version},after:{state:"VOIDED",version:row.version+1,transactionId:original.id,reversalTransactionId:reverse.id},
      reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now});
    return{id:row.id,version:row.version+1,transactionId:original.id,reversalTransactionId:reverse.id,idempotent:false};
  });
}
