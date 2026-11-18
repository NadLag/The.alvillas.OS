import type {VarianceSourceAuthority} from "@/modules/finance/application/variance-workflow-service";
import type {VarianceFacts} from "@/modules/finance/domain/variance-facts";
import {VarianceWorkflowSourceError,VarianceWorkflowConflictError} from "@/modules/finance/domain/variance-workflow";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {assertSupplierInvoiceAuthority,SupplierInvoiceAccessError} from "@/modules/finance/application/supplier-invoice-access";
import {ActualLaundryInvoiceRepository} from "@/modules/inventory/infrastructure/actual-laundry-invoice-repository";
import {actualLaundryAssociationInTransaction} from "@/modules/inventory/application/actual-laundry-invoice-service";
import {expectedLaundryAssessmentInTransaction} from "@/modules/inventory/application/expected-laundry-invoice-service";
import {inventoryMovementAuthorityInTransaction} from "@/modules/inventory/application/movement-service";
import {InventoryCatalogAccessError,InventoryCatalogConflictError} from "@/modules/inventory/domain/catalog-errors";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {Money} from "@/platform/money/money";
import type {TenantTransaction} from "@/platform/db/tenant";

function translate(error:unknown):never{
 if(error instanceof InventoryCatalogAccessError||error instanceof SupplierInvoiceAccessError)throw new VarianceWorkflowSourceError();
 if(error instanceof InventoryCatalogConflictError)throw new VarianceWorkflowConflictError();
 throw error;
}
export async function authorizeLaundryVarianceBrowsing(ctx:Parameters<VarianceSourceAuthority>[0],tx:TenantTransaction){
 try{await inventoryMovementAuthorityInTransaction(ctx,tx);await assertSupplierInvoiceAuthority(ctx,tx,"view",await new FinanceRepository(tx,ctx.organizationId).clock());}catch(error){translate(error);}
}

/** Compare immutable native invoice associations with their retained original
 * estimate. No amount, posting, payable, allocation or stock row is written. */
export const authorizeLaundryVarianceSource:VarianceSourceAuthority=async(ctx,reference,tx,access)=>{
 if(reference.provider!=="LAUNDRY")throw new VarianceWorkflowSourceError();
 try{
  const finance=new FinanceRepository(tx,ctx.organizationId),repository=new ActualLaundryInvoiceRepository(tx,ctx.organizationId);
  async function read(){
   const expected=await expectedLaundryAssessmentInTransaction(ctx,tx,reference.id),heads=await repository.activeBatch(expected.head.batchId),totals=new Map<string,Money>(),checks:CurrentAuthorityCheck[]=[...expected.batch.source.checks,...expected.quote.selected.checks];
   for(const head of heads){
    const association=await actualLaundryAssociationInTransaction(ctx,tx,head.id);
    checks.push(...association.source.checks,...association.expected.batch.source.checks,...association.expected.quote.selected.checks);
    if(head.expectedInvoiceId===reference.id){const total=association.value.actual.total;totals.set(total.currency,(totals.get(total.currency)??Money.zero(total.currency)).add(Money.of(total.amount,total.currency)));}
   }
   const expectedMoney={amount:expected.value.result.total!,currency:expected.value.result.currency},actualMoney=[...totals.values()].map(value=>value.toJSON()).sort((a,b)=>a.currency.localeCompare(b.currency));
   let facts:VarianceFacts;
   if(actualMoney.length!==1||actualMoney[0].currency!==expectedMoney.currency)facts={kind:"UNAVAILABLE",unit:"LAUNDRY",currency:null,expected:null,actual:null,variance:null,reason:actualMoney.length?"CURRENCY_MISMATCH":heads.length?"BASELINE_CHANGED":"NO_ACTUAL",expectedMoney,actualMoney};
   else facts={kind:"MONEY",unit:"MONEY:"+expectedMoney.currency,currency:expectedMoney.currency,expected:expectedMoney.amount,actual:actualMoney[0].amount,variance:Money.of(actualMoney[0].amount,expectedMoney.currency).subtract(Money.of(expectedMoney.amount,expectedMoney.currency)).toJSON().amount};
   if(access==="history")checks.push({action:"view",organizationOnly:true,resource:{type:"audit_log",organizationId:ctx.organizationId,dataClass:"financial"}});
   const action=access==="ASSIGN"?"edit":access==="RESOLVE"||access==="REOPEN"?"approve":"view";
   await assertSupplierInvoiceAuthority(ctx,tx,action,await finance.clock());
   await recheckAccountAuthorization(ctx,tx,await finance.clock(),checks,new VarianceWorkflowSourceError());
   return{facts,fingerprint:jsonbFingerprint({heads,expected:expected.value,batch:expected.batch.witness,facts})};
  }
  const initial=await read();
  return{facts:initial.facts,recheck:async()=>{try{const current=await read();if(current.fingerprint!==initial.fingerprint)throw new VarianceWorkflowConflictError();}catch(error){translate(error);}}};
 }catch(error){translate(error);}
};
