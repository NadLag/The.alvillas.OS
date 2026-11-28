import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {nativePurchasePersonChoices} from "@/platform/ledger/purchase-person-choices";
import {inspectPurchaseReceipt} from "@/platform/ledger/purchase-evidence";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {ExpensePurchaseRepository} from "../infrastructure/expense-purchase-repository";
import {ExpenseRepository} from "../infrastructure/expense-repository";
import {expensePurchaseChoiceInput,expensePurchaseChoicePage} from "../domain/expense-purchase-choices";
import {expenseResource} from "../domain/expense";
import {listSuppliers} from "./supplier-service";
import {ExpenseAccessError,ExpenseConflictError} from "./expense-service";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
export async function listExpensePurchaseChoices(actor:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=expensePurchaseChoiceInput.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const repository=new ExpenseRepository(tx,actor.organizationId),property=await repository.property(input.propertyId);if(!property)throw new ExpenseAccessError();if(input.reservationId&&(await repository.reservation(input.reservationId))?.propertyId!==property.id)throw new ExpenseAccessError();const clock=await repository.clock(),target=expenseResource(actor.organizationId,property,{id:clock.id,reservationId:input.reservationId,amount:"0",state:"DRAFT",occurredOn:clock.now,createdBy:actor.actorId});
  const recheck=async()=>{await recheckFinanceAuthorization(actor,tx,(await repository.clock()).now,[{action:"create",resource:target}],new ExpenseAccessError());};
  async function read(){await recheck();if(input.kind==="PURCHASER")return nativePurchasePersonChoices(actor,tx,input.query,input.page);
   if(input.kind==="SUPPLIER"){const page=await listSuppliers(actor,{query:input.query,after:input.after},{db:{$transaction:work=>work(tx)}});return{items:page.suppliers.filter(row=>!row.archived).map(row=>({id:row.id,label:row.displayName})),next:page.next??null};}
   const rows=await new ExpensePurchaseRepository(tx,actor.organizationId).receiptChoices(input.propertyId,input.query,input.after,input.reservationId),items=[];
   for(const row of rows.slice(0,50)){await inspectPurchaseReceipt(actor,tx,{propertyId:input.propertyId,reservationId:input.reservationId,receiptVersionId:row.id});items.push(row);}
   return{items,next:rows.length>50?rows[49].id:null};
  }
  const value=expensePurchaseChoicePage.parse(await read());await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"expense.purchase_choices_viewed",resourceType:"expense",resourceId:clock.id,propertyScopeId:property.id,after:{kind:input.kind,sourceIds:value.items.map(item=>item.id)},reason:"Viewed original authorized purchase source choices",requestId:deps.requestId??crypto.randomUUID(),occurredAt:clock.now});const final=expensePurchaseChoicePage.parse(await read());if(jsonbFingerprint(final)!==jsonbFingerprint(value))throw new ExpenseConflictError();await recheck();return value;
 });
}
