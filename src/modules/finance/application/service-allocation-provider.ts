import type {TenantTransaction} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {ServiceAllocationSourceUnavailableError} from "../domain/service-allocation";
import {CompanyExpenseInvoiceRepository} from "../infrastructure/company-expense-invoice-repository";
import {CompanyExpenseCompensationRepository} from "../infrastructure/company-expense-compensation-repository";
import {SupplierPayableRepository} from "../infrastructure/supplier-payable-repository";
import type {ServiceProviderKind} from "../infrastructure/service-allocation-repository";
import {inspectSupplierInvoiceSettlementSource} from "./supplier-payment-service";
import {prepareEmployeeCompensationSettlement} from "./employee-compensation-settlement";
import type {FinanceActorContext} from "./finance-access";

export async function serviceProviderLockIdentity(ctx:FinanceActorContext,kind:ServiceProviderKind,id:string,tx:TenantTransaction){
 if(kind==="SUPPLIER_INVOICE_LINE"){
  const hint=await new CompanyExpenseInvoiceRepository(tx,ctx.organizationId).line(id);if(!hint)throw new ServiceAllocationSourceUnavailableError();return'0:'+hint.revision.invoiceId+':'+id;
 }
 const hint=await new CompanyExpenseCompensationRepository(tx,ctx.organizationId).cost(id);if(!hint)throw new ServiceAllocationSourceUnavailableError();return'1:'+hint.submission.runId+':'+hint.submissionId+':'+hint.claimId+':'+id;
}

/** Native recognition owns the payable and locks. Allocation associates it without copying or paying that obligation. */
export async function inspectServiceProviderCost(ctx:FinanceActorContext,kind:ServiceProviderKind,id:string,tx:TenantTransaction){
 function denied():never{throw new ServiceAllocationSourceUnavailableError();}
 if(kind==="SUPPLIER_INVOICE_LINE"){
  const hint=await new CompanyExpenseInvoiceRepository(tx,ctx.organizationId).line(id)??denied();
  await new SupplierPayableRepository(tx,ctx.organizationId).lockInvoice(hint.revision.invoiceId);
  const source=await inspectSupplierInvoiceSettlementSource(ctx,hint.revision.invoiceId,tx),cost=source.revision.lines.find(row=>row.id===id)??denied(),recognition=source.existing?.lines.find(row=>row.invoiceLineId===id)??denied(),journal=source.journals.find(row=>row.id===recognition.transactionId)??denied();
  const amount=Money.of(cost.amount.toFixed(2),cost.currency);
  if(!journal.sealed||journal.reversesTransactionId||journal.reversedByTransactions.length||!amount.amount.gt(0)||!journal.postings.filter(posting=>posting.side==="DEBIT").reduce((total,posting)=>total.add(Money.of(posting.amount.toFixed(2),posting.currency)),Money.zero(amount.currency)).equals(amount)||journal.postings.some(posting=>posting.side==="DEBIT"&&posting.ledgerAccount.accountType!=="ALVILLAS_OWN"))denied();
  return{sourceKind:kind,costId:id,transactionId:journal.id,partyId:source.row.supplierId,amount,propertyId:cost.propertyId,reservationId:cost.reservationId,recheck:async()=>{await source.recheckSettlement(await source.finance.clock());}};
 }
 const hint=await new CompanyExpenseCompensationRepository(tx,ctx.organizationId).cost(id)??denied(),source=await prepareEmployeeCompensationSettlement(ctx,hint.submissionId,hint.claimId,tx,"view"),cost=source.row.costs.find(row=>row.id===id)??denied(),recognition=source.existing?.lines.find(row=>row.costId===id)??denied(),journal=source.journals.find(row=>row.id===recognition.transactionId)??denied(),amount=Money.of(cost.amount.toFixed(2),cost.currency);
 if(!journal.sealed||journal.reversesTransactionId||journal.reversedByTransactions.length||!amount.amount.gt(0)||!journal.postings.filter(posting=>posting.side==="DEBIT").reduce((total,posting)=>total.add(Money.of(posting.amount.toFixed(2),posting.currency)),Money.zero(amount.currency)).equals(amount)||journal.postings.some(posting=>posting.side==="DEBIT"&&posting.ledgerAccount.accountType!=="ALVILLAS_OWN"))denied();
 return{sourceKind:kind,costId:id,transactionId:journal.id,partyId:source.retained.personId,amount,propertyId:cost.propertyId,reservationId:cost.reservationId,recheck:async()=>{await source.recheckSettlement(await source.finance.clock());}};
}
