import type {TenantTransaction} from "@/platform/db/tenant";
import type {Resource} from "@/platform/authz/authorize";
import {inspectPurchaseReceipt} from "@/platform/ledger/purchase-evidence";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {ExpensePurchaseRepository} from "../infrastructure/expense-purchase-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import type {ExpensePurchase} from "../domain/expense-purchase";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

export async function inspectExpensePurchase(ctx:FinanceActorContext,tx:TenantTransaction,input:ExpensePurchase&{propertyId:string;reservationId?:string|null;fundingAccountId:string;amount:string;rootExpenseId?:string},target:Resource,action:"view"|"create"|"pay"|"void"="view",historical=false){
 const repository=new ExpensePurchaseRepository(tx,ctx.organizationId),[person,supplier,funding]=await Promise.all([repository.person(input.purchaserId,historical),repository.supplier(input.supplierId,historical),new FinanceRepository(tx,ctx.organizationId).findLedgerAccountById(input.fundingAccountId)]);
 if(!person||!supplier||!funding||input.fundingKind==="PERSONAL"&&(funding.code!=="EMPLOYEE_PAYABLE"||funding.accountType!=="CLAIM_OWNERSHIP"||funding.normalSide!=="CREDIT"||funding.archivedAt))throw Error("Original purchase funding identity required");
 const checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[{action:"view",resource:{type:"team_member",organizationId:ctx.organizationId,id:person.id,assignedPersonId:person.id,dataClass:"personal"}},{action:"view",resource:{type:"supplier",organizationId:ctx.organizationId,id:supplier.id,dataClass:"personal"}}];
 if(input.fundingKind==="PERSONAL")checks.push({action:"view",resource:{...target,type:"employee_payable",id:input.rootExpenseId??target.id,financialRecordId:input.rootExpenseId??target.financialRecordId,assignedPersonId:person.id}},...(action==="view"?[]:[{action,resource:{...target,type:"employee_payable" as const,id:input.rootExpenseId??target.id,financialRecordId:input.rootExpenseId??target.financialRecordId,assignedPersonId:person.id}}]));
 const receipt=await inspectPurchaseReceipt(ctx,tx,input,historical);
 await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,Error("Purchase source access denied"));
 return{funding,checks,fingerprint:jsonbFingerprint({input,receipt:receipt.fingerprint,receiptVersion:receipt.version.id})};
}
