import type {AccountActorContext} from "@/platform/authz/session-context";
import type {TenantTransaction} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {laundrySupplierPricePolicyKey} from "@/platform/config/laundry-pricing-policy";
import {actualLaundryAssociationInTransaction,actualLaundrySourceContext} from "@/modules/inventory/application/actual-laundry-invoice-service";
import {supplierPriceVersionInTransaction,verifySupplierPriceSourcesInTransaction,getSupplierPriceVersion} from "@/modules/inventory/application/supplier-price-service";
import {inspectActualLaundryInvoiceSource,lockActualLaundryInvoiceSource} from "@/platform/ledger/laundry-invoice-source";
import {ActualLaundryInvoiceRepository} from "@/modules/inventory/infrastructure/actual-laundry-invoice-repository";
import {InventoryCatalogAccessError,InventoryCatalogConflictError,InventoryCatalogDefinitionError} from "@/modules/inventory/domain/catalog-errors";
import {validateLaundryPriceChange,type LaundryPriceChangeEvidence} from "@/modules/inventory/domain/laundry-price-change";
import type {SupplierPriceDraft} from "@/modules/inventory/domain/supplier-price-command";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";

/** A source proof for the original price writer, never a parallel catalog. */
export async function laundryPriceChangeSource(actor:AccountActorContext,tx:TenantTransaction,id:string,basisId?:string,recordedId?:string){
 const original=await actualLaundryAssociationInTransaction(actor,tx,id),repository=new ActualLaundryInvoiceRepository(tx,actor.organizationId);
 if(original.head.operation==="VOID"||await repository.successor(id))throw new InventoryCatalogConflictError();
 const source=await inspectActualLaundryInvoiceSource(actor,tx,original.value.draft.selection,actualLaundrySourceContext(original.expected.batch));
 const config=new ConfigRuleRepository(tx,actor.organizationId),scope=original.expected.quote.selected.scope,supplierId=original.expected.batch.head.supplierId!;
 const latest=await config.latestScopeMetadata(laundrySupplierPricePolicyKey(supplierId),scope.scopeType,scope.scopeId);
 if(!latest||basisId&&latest.id!==basisId&&latest.id!==recordedId)throw new InventoryCatalogConflictError();
 const basis=await supplierPriceVersionInTransaction(actor,tx,basisId??latest.id);
 if(basis.head.supplierId!==supplierId||jsonbFingerprint(basis.selected.scope)!==jsonbFingerprint(scope)||basis.rule.lifecycle==="RETIRED")throw new InventoryCatalogAccessError();
 const affected=[...new Set(original.expected.value.result.lines.filter(line=>line.billable&&BigInt(line.quantity)>0n).map(line=>line.itemKey))].sort();
 await verifySupplierPriceSourcesInTransaction(actor,tx,basis,false);await source.recheck();
 await recheckAccountAuthorization(actor,tx,await basis.context.inventory.catalogClock(),[...basis.selected.checks,...original.expected.batch.source.checks,...original.expected.quote.selected.checks,...source.checks],new InventoryCatalogAccessError());
 return{original,source,basis,affected,fingerprint:jsonbFingerprint({association:original.value,source:source.fingerprint,batch:original.expected.batch.witness,basis:basis.rule,affected})};
}
export async function validateLaundryPriceEvidence(actor:AccountActorContext,tx:TenantTransaction,draft:SupplierPriceDraft,recordedId?:string){
 if(draft.kind!=="CREATE"||!draft.evidence)return;
 const original=await actualLaundryAssociationInTransaction(actor,tx,draft.evidence.associationId);
 await lockActualLaundryInvoiceSource(tx,actor.organizationId,original.head.invoiceId);
 await new ActualLaundryInvoiceRepository(tx,actor.organizationId).lockInvoice(original.head.invoiceId);
 await original.expected.batch.repository.lock(original.head.batchId);
 const value=await laundryPriceChangeSource(actor,tx,draft.evidence.associationId,draft.evidence.basisVersionId,recordedId);
 if(value.fingerprint!==draft.evidence.sourceFingerprint)throw new InventoryCatalogConflictError();
 if(draft.supplierId!==value.basis.head.supplierId||jsonbFingerprint(draft.scope)!==jsonbFingerprint(value.basis.selected.scope)||value.source.total.currency!==value.basis.policy.currency)throw new InventoryCatalogDefinitionError();
 validateLaundryPriceChange(value.basis.policy,draft.policy,value.affected);
}
export async function authorizeHistoricalLaundryPriceEvidence(actor:AccountActorContext,tx:TenantTransaction,evidence:LaundryPriceChangeEvidence){
 await actualLaundryAssociationInTransaction(actor,tx,evidence.associationId);
 await supplierPriceVersionInTransaction(actor,tx,evidence.basisVersionId);
}
export async function laundryPriceChangeContext(actor:AccountActorContext,tx:TenantTransaction,id:string){
 const first=await laundryPriceChangeSource(actor,tx,id),runner={$transaction:async<T>(work:(transaction:TenantTransaction)=>Promise<T>)=>work(tx)},basis=await getSupplierPriceVersion(actor,{id:first.basis.head.id},{db:runner}),last=await laundryPriceChangeSource(actor,tx,id);
 if(last.fingerprint!==first.fingerprint)throw new InventoryCatalogConflictError();
 const original=last.original.value,expected={amount:original.expected.total,currency:original.expected.currency},actual=last.source.total;
 return{associationId:id,basis,affected:last.affected,evidence:{associationId:id,basisVersionId:basis.id,sourceFingerprint:last.fingerprint,confirmedUnitPrices:true as const},expected,actual,state:expected.currency!==actual.currency||actual.currency!==basis.policy.currency?"CURRENCY_MISMATCH" as const:expected.amount===actual.amount?"MATCHED" as const:"POSSIBLE_CHANGE" as const,receipt:{documentId:last.source.receipt.documentId,version:last.source.receiptNumber,title:last.source.receipt.title},invoice:{id:last.source.invoice.id,number:last.source.invoice.invoiceNumber},retainedPrices:last.original.expected.value.result.lines.filter(line=>last.affected.includes(line.itemKey)).map(line=>({item:line.itemKey,unit:line.unit,price:line.unitPrice}))};
}
