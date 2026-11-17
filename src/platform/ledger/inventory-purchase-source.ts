import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import {ExpenseRepository} from "@/modules/finance/infrastructure/expense-repository";
import {ExpensePurchaseRepository} from "@/modules/finance/infrastructure/expense-purchase-repository";
import {CompanyExpenseInvoiceRepository} from "@/modules/finance/infrastructure/company-expense-invoice-repository";
import {SupplierPayableRepository} from "@/modules/finance/infrastructure/supplier-payable-repository";
import {getExpense,ExpenseAccessError,ExpenseConflictError} from "@/modules/finance/application/expense-service";
import {inspectFinancialAttachmentContext} from "@/modules/finance/application/financial-attachments";
import {inspectSupplierInvoiceSettlementSource} from "@/modules/finance/application/supplier-payment-service";
import {inspectPurchaseReceipt} from "./purchase-evidence";
import type {InventoryPurchaseExpenseSource} from "@/modules/inventory/domain/purchase-expense";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "@/modules/inventory/domain/catalog-errors";
import {FinancialAttachmentAccessError} from "@/modules/finance/domain/financial-attachment";
import {SupplierInvoiceAccessError,SupplierInvoiceConflictError} from "@/modules/finance/application/supplier-invoice-access";
export async function lockInventoryPurchaseExpenseSource(actor:AccountActorContext,tx:TenantTransaction,input:InventoryPurchaseExpenseSource){if(input.kind==="EXPENSE")await new ExpenseRepository(tx,actor.organizationId).lock(input.id);else{const line=await new CompanyExpenseInvoiceRepository(tx,actor.organizationId).line(input.id);if(!line)throw new InventoryCatalogAccessError();await new SupplierPayableRepository(tx,actor.organizationId).lockInvoice(line.revision.invoiceId);}}
/** Read original approved accounting evidence. Receiving goods never recognizes
 * another expense, pays a supplier/employee or changes an allocation or posting. */
export async function inspectInventoryPurchaseExpense(actor:AccountActorContext,tx:TenantTransaction,input:InventoryPurchaseExpenseSource,historical=false){
 async function read(){
  if(input.kind==="EXPENSE"){
   const repository=new ExpenseRepository(tx,actor.organizationId),row=await repository.find(input.id),identity=await repository.inventoryPurchaseIdentity(input.id);if(!row||!identity?.transactionId||!historical&&(identity.state!=="POSTED"||!identity.sealed||identity.reversed))throw new InventoryCatalogAccessError();
   await getExpense(actor,row.id,{db:{$transaction:async work=>work(tx)}});const purchase=await new ExpensePurchaseRepository(tx,actor.organizationId).find(row.id),amount=Money.of(row.amount.toString(),row.currency).toJSON();let receiptIdentity:unknown,receiptSha256:string;
   if(input.receiptSource==="DOCUMENT_VERSION"){
    if(!purchase||purchase.receiptVersionId!==input.receiptId)throw new InventoryCatalogAccessError();const receipt=await inspectPurchaseReceipt(actor,tx,{propertyId:row.propertyId,reservationId:row.reservationId,receiptVersionId:input.receiptId},historical);receiptSha256=receipt.version.admission.sha256;receiptIdentity={id:receipt.version.id,documentId:receipt.root.id,sha256:receipt.version.admission.sha256,fingerprint:receipt.fingerprint};
   }else{
    const context=await inspectFinancialAttachmentContext(actor,tx,identity.transactionId,"view"),receipt=await context.repository.attachment(input.receiptId);if(!receipt||receipt.transactionId!==identity.transactionId||!["RECEIPT","INVOICE"].includes(receipt.admission.kind)||!historical&&receipt.next!==null)throw new InventoryCatalogAccessError();if(purchase){const original=await inspectPurchaseReceipt(actor,tx,{propertyId:row.propertyId,reservationId:row.reservationId,receiptVersionId:purchase.receiptVersionId},historical);if(original.version.admission.sha256!==receipt.admission.sha256)throw new InventoryCatalogAccessError();}await context.recheck();receiptSha256=receipt.admission.sha256;receiptIdentity={id:receipt.id,rootId:receipt.rootId,sha256:receipt.admission.sha256,source:context.native.identity,policy:context.policyIdentity};
   }
   return{kind:input.kind,id:row.id,rootId:purchase?.rootExpenseId??row.correctsExpenseId??row.id,transactionId:identity.transactionId,propertyId:row.propertyId,reservationId:row.reservationId,reference:row.purpose,amount,supplierId:purchase?.supplierId??null,purchaserId:purchase?.purchaserId??null,fundingKind:purchase?.fundingKind??null,receiptId:input.receiptId,receiptSource:input.receiptSource,receiptSha256,fingerprint:jsonbFingerprint({input,identity,purchase,amount,receiptIdentity})};
  }
  const line=await new CompanyExpenseInvoiceRepository(tx,actor.organizationId).line(input.id);if(!line)throw new InventoryCatalogAccessError();const source=await inspectSupplierInvoiceSettlementSource(actor,line.revision.invoiceId,tx),original=source.revision.lines.find(row=>row.id===line.id),recognition=source.existing?.lines.find(row=>row.invoiceLineId===line.id),cost=source.costs.find(row=>row.id===line.id);if(!original||!recognition||!cost)throw new InventoryCatalogAccessError();const journal=source.journals.find(row=>row.id===recognition.transactionId);if(!journal||!historical&&journal.reversedByTransactions.length)throw new InventoryCatalogAccessError();
  const archive=await inspectFinancialAttachmentContext(actor,tx,recognition.transactionId,"view"),receipt=await archive.repository.attachment(input.receiptId);if(!receipt||receipt.transactionId!==recognition.transactionId||!["RECEIPT","INVOICE"].includes(receipt.admission.kind)||!historical&&receipt.next!==null)throw new InventoryCatalogAccessError();await archive.recheck();await source.recheckSettlement(await source.finance.clock());
  return{kind:input.kind,id:line.id,rootId:line.id,transactionId:recognition.transactionId,propertyId:original.propertyId,reservationId:original.reservationId,reference:source.revision.invoiceNumber,amount:cost.amount.toJSON(),supplierId:source.row.supplierId,purchaserId:null,fundingKind:null,receiptId:input.receiptId,receiptSource:input.receiptSource,receiptSha256:receipt.admission.sha256,fingerprint:jsonbFingerprint({input,invoice:{id:source.row.id,version:source.row.version,state:source.row.state},revisionId:source.revision.id,original,recognition:{id:recognition.id,transactionId:recognition.transactionId},amount:cost.amount.toJSON(),receipt:{id:receipt.id,rootId:receipt.rootId,sha256:receipt.admission.sha256},source:archive.native.identity,policy:archive.policyIdentity})};
 }
 const authorized=async()=>{try{return await read();}catch(error){if(error instanceof ExpenseAccessError||error instanceof SupplierInvoiceAccessError||error instanceof FinancialAttachmentAccessError)throw new InventoryCatalogAccessError();if(error instanceof ExpenseConflictError||error instanceof SupplierInvoiceConflictError)throw new InventoryCatalogConflictError();throw error;}};
 const initial=await authorized();return{...initial,recheck:async()=>{const current=await authorized();if(current.fingerprint!==initial.fingerprint)throw new InventoryCatalogConflictError();return current;}};
}
