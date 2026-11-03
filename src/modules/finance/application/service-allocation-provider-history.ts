import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {ServiceAllocationAccessError,ServiceAllocationSourceUnavailableError} from "../domain/service-allocation";
import {serviceAllocationProviderHistorySchema} from "../domain/service-allocation-workspace";
import {ServiceAllocationWorkspaceRepository} from "../infrastructure/service-allocation-workspace-repository";
import {CompanyExpenseInvoiceRepository} from "../infrastructure/company-expense-invoice-repository";
import {CompanyExpenseCompensationRepository} from "../infrastructure/company-expense-compensation-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {recheckServiceAllocationRead} from "./service-allocation-command-service";
import {inspectSupplierInvoiceSettlementSource,getSupplierSettlement} from "./supplier-payment-service";
import {prepareEmployeeCompensationSettlement} from "./employee-compensation-settlement";
import {getEmployeeCompensationPaymentWorkspace} from "./employee-compensation-payment-workspace";
import type {FinanceActorContext} from "./finance-access";

const inputSchema=z.object({sourceId:z.uuid(),bindingId:z.uuid(),before:z.uuid().optional()}).strict();
/** Native invoice/claim payments keep their actual scope; no payment is apportioned to a service cost line. */
export async function readServiceProviderHistory(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=inputSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const root=await recheckServiceAllocationRead(ctx,tx,input.sourceId),repository=new ServiceAllocationWorkspaceRepository(tx,ctx.organizationId),binding=await repository.binding(input.bindingId);if(!binding||binding.sourceId!==root.id)throw new ServiceAllocationAccessError();const native={db:repository.runner(),requestId:deps.requestId},kind=binding.supplierInvoiceLineId?"SUPPLIER_INVOICE_LINE"as const:"EMPLOYEE_COST"as const,costId=binding.supplierInvoiceLineId??binding.employeeCostId!,label=await repository.providerLabel(kind,costId);if(!label)throw new ServiceAllocationSourceUnavailableError();
  let facts:z.input<typeof serviceAllocationProviderHistorySchema>;
  if(binding.supplierInvoiceLineId){
   const line=await new CompanyExpenseInvoiceRepository(tx,ctx.organizationId).line(costId);if(!line)throw new ServiceAllocationSourceUnavailableError();const source=await inspectSupplierInvoiceSettlementSource(ctx,line.revision.invoiceId,tx);if(!source.existing?.lines.some(row=>row.invoiceLineId===line.id))throw new ServiceAllocationSourceUnavailableError();const settlement=await getSupplierSettlement(ctx,{id:line.revision.invoiceId,before:input.before},native);
   facts={sourceId:root.id,bindingId:binding.id,label,cost:{amount:line.amount.toFixed(2),currency:line.currency},scope:"INVOICE",reference:{kind:"INVOICE",id:line.revision.invoiceId},sourceReversed:settlement.claimReversed,outstanding:settlement.outstanding,payments:settlement.payments.map(payment=>({id:payment.id,amount:payment.amount,paidAt:payment.paidAt,reason:payment.reason,reference:payment.reference,fundingName:payment.fundingName,reversed:payment.reversed})),next:settlement.next};await source.recheckSettlement(await source.finance.clock());
  }else{
   const cost=await new CompanyExpenseCompensationRepository(tx,ctx.organizationId).cost(costId);if(!cost)throw new ServiceAllocationSourceUnavailableError();const source=await prepareEmployeeCompensationSettlement(ctx,cost.submissionId,cost.claimId,tx,"view");if(!source.existing?.lines.some(row=>row.costId===cost.id))throw new ServiceAllocationSourceUnavailableError();const settlement=await getEmployeeCompensationPaymentWorkspace(ctx,{id:cost.submissionId,claimId:cost.claimId,before:input.before},native),sourceReversed=source.journals.some(journal=>source.existing!.lines.some(line=>line.transactionId===journal.id)&&journal.reversedByTransactions.length>0);
   facts={sourceId:root.id,bindingId:binding.id,label,cost:{amount:cost.amount.toFixed(2),currency:cost.currency},scope:"EMPLOYEE_CLAIM",reference:{kind:"EMPLOYEE_CLAIM",id:cost.submissionId,claimId:cost.claimId},sourceReversed,outstanding:settlement.outstanding,payments:settlement.payments.map(payment=>({id:payment.id,amount:payment.amount,paidAt:payment.paidAt,reason:payment.reason,reference:payment.reference,fundingName:payment.fundingName,reversed:payment.reversal!==null})),next:settlement.next};await source.recheckSettlement(await source.finance.clock());
  }
  const value=serviceAllocationProviderHistorySchema.parse(facts),data={snapshot:value};await recheckServiceAllocationRead(ctx,tx,root.id);const result=present({...ctx.authContext,visibleDataClasses:new Set(["financial"as const])},"view",{type:"service_allocation",organizationId:ctx.organizationId,id:root.id,financialRecordId:root.id,propertyId:root.collection.propertyId,city:root.collection.property.cityId,region:root.collection.property.regionId,dataClass:"financial",data},catalogFieldPolicy<typeof data>("service_allocation"),await new FinanceRepository(tx,ctx.organizationId).clock());await recheckServiceAllocationRead(ctx,tx,root.id);if(result.snapshot!==value)throw new ServiceAllocationAccessError();return value;
 },{timeout:120000});
}
