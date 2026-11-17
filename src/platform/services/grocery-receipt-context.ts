import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {readFinancialAttachments} from "@/modules/finance/application/financial-attachments";
import {FinancialAttachmentAccessError} from "@/modules/finance/domain/financial-attachment";
import {GroceryOrderRepository} from "@/modules/services/infrastructure/grocery-order-repository";
import {ServiceOrderAccessError,ServiceOrderConflictError,ServiceOrderSourceUnavailableError} from "@/modules/services/domain/service-order";
import {ExpensePurchaseRepository} from "@/modules/finance/infrastructure/expense-purchase-repository";
import {ExpenseRepository} from "@/modules/finance/infrastructure/expense-repository";
import {expenseResource} from "@/modules/finance/domain/expense";
import {inspectExpensePurchase} from "@/modules/finance/application/expense-purchase-access";
import {inspectPurchaseReceipt} from "@/platform/ledger/purchase-evidence";
import {nativeGroceryExpenseSource} from "./grocery-expense-source";
export async function nativeGroceryReceiptContext(actor:AccountActorContext,tx:TenantTransaction,expenseId:string,before?:string){
 const repository=new GroceryOrderRepository(tx,actor.organizationId),head=await repository.expenseIdentity(expenseId);if(!head?.transactionId)throw new ServiceOrderSourceUnavailableError();let history;try{history=await readFinancialAttachments(actor,{transactionId:head.transactionId,...before?{before}:{}},{db:{$transaction:work=>work(tx)}});}catch(error){if(error instanceof FinancialAttachmentAccessError)throw new ServiceOrderAccessError();throw error;}const purchase=await new ExpensePurchaseRepository(tx,actor.organizationId).find(expenseId),expense=await new ExpenseRepository(tx,actor.organizationId).find(expenseId);let documentChoice:{id:string;fileName:string;version:number;kind:"RECEIPT";receiptSource:"DOCUMENT_VERSION"}|null=null;
 const recheckPurchase=async()=>{if(purchase&&expense)await inspectExpensePurchase(actor,tx,{...purchase,propertyId:expense.propertyId,reservationId:expense.reservationId,fundingAccountId:expense.fundingAccountId,amount:expense.amount.toString()},expenseResource(actor.organizationId,expense.property,{...expense,amount:expense.amount.toString()}),"view",true);};await recheckPurchase();
 if(purchase){const proof=await inspectPurchaseReceipt(actor,tx,{propertyId:head.propertyId,reservationId:head.reservationId,receiptVersionId:purchase.receiptVersionId},true);documentChoice={id:proof.version.id,fileName:proof.version.admission.fileName,version:proof.version.number,kind:"RECEIPT",receiptSource:"DOCUMENT_VERSION"};}
 const bound=await repository.byExpense(expenseId);if(bound)await(await nativeGroceryExpenseSource(actor,tx,bound,true)).recheck();
 await recheckPurchase();const current=await repository.expenseIdentity(expenseId);if(JSON.stringify(current)!==JSON.stringify(head))throw new ServiceOrderConflictError();return{expenseId:head.id,propertyId:head.propertyId,reservationId:head.reservationId,transactionId:head.transactionId,binding:bound?{bindingId:bound.id,orderId:bound.orderId,expenseId:bound.expenseId,receiptId:bound.receiptId,receiptSource:bound.receiptSource,replayed:true}:null,canBind:Boolean(purchase),items:[...documentChoice&&!before?[documentChoice]:[],...history.items.filter(item=>item.supersededById===null).map(item=>({id:item.id,fileName:item.fileName,version:item.version,kind:item.kind,receiptSource:"FINANCIAL_ATTACHMENT" as const}))],next:history.next};
}
