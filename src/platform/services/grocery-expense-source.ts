import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {inspectFinancialAttachmentContext} from "@/modules/finance/application/financial-attachments";
import {FinancialAttachmentAccessError} from "@/modules/finance/domain/financial-attachment";
import {GroceryOrderRepository} from "@/modules/services/infrastructure/grocery-order-repository";
import {ServiceOrderRepository} from "@/modules/services/infrastructure/service-order-repository";
import {serviceOrderAuthority} from "@/modules/services/application/service-order-source";
import {ServiceOrderAccessError,ServiceOrderSourceUnavailableError,ServiceOrderConflictError} from "@/modules/services/domain/service-order";
import {ExpensePurchaseRepository} from "@/modules/finance/infrastructure/expense-purchase-repository";
import {ExpenseRepository} from "@/modules/finance/infrastructure/expense-repository";
import {expenseResource} from "@/modules/finance/domain/expense";
import {inspectExpensePurchase} from "@/modules/finance/application/expense-purchase-access";
import {inspectPurchaseReceipt} from "@/platform/ledger/purchase-evidence";
export async function nativeGroceryExpenseSource(actor:AccountActorContext,tx:TenantTransaction,input:{orderId:string;expenseId:string;receiptId:string;receiptSource?:"FINANCIAL_ATTACHMENT"|"DOCUMENT_VERSION"},historical=false){
 const repository=new GroceryOrderRepository(tx,actor.organizationId),orders=new ServiceOrderRepository(tx,actor.organizationId);
 async function read(){const order=await orders.head(input.orderId);if(!order)throw new ServiceOrderAccessError();const authority=await serviceOrderAuthority(actor,tx,order,"approve"),original=await repository.original(order.id);if(!original?.grocery)throw new ServiceOrderSourceUnavailableError();const expense=await repository.expenseIdentity(input.expenseId);if(!expense?.transactionId||expense.propertyId!==order.propertyId||expense.reservationId&&expense.reservationId!==order.reservationId)throw new ServiceOrderSourceUnavailableError();let archive;try{archive=await inspectFinancialAttachmentContext(actor,tx,expense.transactionId,"view");}catch(error){if(error instanceof FinancialAttachmentAccessError)throw new ServiceOrderAccessError();throw error;}const purchase=await new ExpensePurchaseRepository(tx,actor.organizationId).find(expense.id),nativeExpense=await new ExpenseRepository(tx,actor.organizationId).find(expense.id);
 if(!historical&&!purchase||!nativeExpense)throw new ServiceOrderSourceUnavailableError();
 let purchaseFingerprint:string|null=null;
 if(purchase){try{purchaseFingerprint=(await inspectExpensePurchase(actor,tx,{...purchase,propertyId:nativeExpense.propertyId,reservationId:nativeExpense.reservationId,fundingAccountId:nativeExpense.fundingAccountId,amount:nativeExpense.amount.toString()},expenseResource(actor.organizationId,nativeExpense.property,{...nativeExpense,amount:nativeExpense.amount.toString()}),"view",historical)).fingerprint;}catch{throw new ServiceOrderAccessError();}}
 let receipt:unknown;
 if(input.receiptSource==="DOCUMENT_VERSION"){
  if(!purchase||input.receiptId!==purchase.receiptVersionId)throw new ServiceOrderSourceUnavailableError();
  const proof=await inspectPurchaseReceipt(actor,tx,{propertyId:expense.propertyId,reservationId:expense.reservationId,receiptVersionId:input.receiptId},historical);receipt={id:proof.version.id,documentId:proof.root.id,number:proof.version.number,fingerprint:proof.fingerprint};
 }else{const originalReceipt=await archive.repository.attachment(input.receiptId);if(!originalReceipt||originalReceipt.transactionId!==expense.transactionId||!["RECEIPT","INVOICE"].includes(originalReceipt.admission.kind)||!historical&&originalReceipt.next!==null)throw new ServiceOrderSourceUnavailableError();receipt=originalReceipt;}
 if(!historical&&(expense.state!=="POSTED"||!expense.sealed||expense.reversed||["CANCELLED","REJECTED"].includes(order.state)))throw new ServiceOrderSourceUnavailableError();await archive.recheck();return{order,expense,receipt:receipt as {id:string},authority,archive,fingerprint:commandFingerprint({order:{...order,quantity:order.quantity.toString()},original,expense,receipt,purchaseFingerprint,financialSource:archive.native.identity,policy:archive.policyIdentity})};}
 const source=await read();return{...source,recheck:async()=>{const after=await read();if(after.fingerprint!==source.fingerprint)throw new ServiceOrderConflictError();return after;}};
}
