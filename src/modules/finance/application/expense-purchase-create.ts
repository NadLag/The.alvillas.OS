import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {purchaseExpenseDraftSchema,expenseDraftSchema} from "../domain/expense-input";
import {expenseResource} from "../domain/expense";
import {ExpenseRepository} from "../infrastructure/expense-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {createExpenseDraft,ExpenseAccessError} from "./expense-service";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
/** Workflow adapter; the native expense remains the only approval and cost source. */
export async function createPurchaseExpenseDraft(actor:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=purchaseExpenseDraftSchema.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const expenses=new ExpenseRepository(tx,actor.organizationId),property=await expenses.property(input.propertyId),clock=await expenses.clock();if(!property)throw new ExpenseAccessError();
  const target=expenseResource(actor.organizationId,property,{id:clock.id,reservationId:input.reservationId,amount:input.amount,state:"DRAFT",occurredOn:new Date(input.occurredOn+"T00:00:00Z"),createdBy:actor.actorId});
  await recheckFinanceAuthorization(actor,tx,clock.now,[{action:"create",resource:target},...(input.purchase.fundingKind==="PERSONAL"?[{action:"view" as const,resource:{...target,type:"employee_payable"}},{action:"create" as const,resource:{...target,type:"employee_payable"}}]:[])],new ExpenseAccessError());
  const fundingAccountId=input.purchase.fundingKind==="PERSONAL"?(await new FinanceRepository(tx,actor.organizationId).ensureLedgerAccount({code:"EMPLOYEE_PAYABLE",name:"Employee payable",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"})).id:input.fundingAccountId;
  return createExpenseDraft(actor,expenseDraftSchema.parse({...input,fundingAccountId}),{...deps,db:{$transaction:work=>work(tx)}});
 });
}
