import {randomUUID} from "node:crypto";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {Money} from "@/platform/money/money";
import {companyExpenseInvoiceCommandSchema,companyExpenseInvoiceHistorySchema} from "../domain/company-expense-invoice";
import {CompanyExpenseAccessError,CompanyExpenseChangedError} from "../domain/company-expense";
import {CompanyExpenseRepository} from "../infrastructure/company-expense-repository";
import {CompanyExpenseInvoiceRepository} from "../infrastructure/company-expense-invoice-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {SupplierPayableRepository} from "../infrastructure/supplier-payable-repository";
import {inspectSupplierInvoiceSettlementSource,getSupplierSettlement} from "./supplier-payment-service";
import {recheckCompanyExpenseAccess} from "./company-expense-service";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
type Deps={db?:TenantTransactionRunner;requestId?:string};
/** Associates an actual recognized company-only invoice line. Original invoices, journal amounts and payments stay canonical. */
export async function changeCompanyExpenseInvoiceSource(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=companyExpenseInvoiceCommandSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const links=new CompanyExpenseInvoiceRepository(tx,ctx.organizationId),plans=new CompanyExpenseRepository(tx,ctx.organizationId),line=await links.line(input.invoiceLineId);if(!line||line.propertyId||line.reservationId)throw new CompanyExpenseAccessError();
  await new SupplierPayableRepository(tx,ctx.organizationId).lockInvoice(line.revision.invoiceId);await links.lockSource(line.id);await plans.lockPlanRead(input.companyExpenseId);
  const plan=await plans.latest(input.companyExpenseId);if(!plan)throw new CompanyExpenseAccessError();await recheckCompanyExpenseAccess(ctx,tx,plan,"edit");
  const source=await inspectSupplierInvoiceSettlementSource(ctx,line.revision.invoiceId,tx),original=source.revision.lines.find(row=>row.id===line.id),recognition=source.existing?.lines.find(row=>row.invoiceLineId===line.id);if(!original||!recognition||original.propertyId||original.reservationId)throw new CompanyExpenseAccessError();
  const state=input.operation==="ATTACH"?"ATTACHED":"RELEASED",previous=await links.current(line.id);
  const dataClass=previous?.dataClass==="STAFF_COMPENSATION"?previous.dataClass:plan.dataClass,recheckSalary=async()=>{if(dataClass==="STAFF_COMPENSATION")await recheckFinanceAuthorization(ctx,tx,await source.finance.clock(),[{action:"view",resource:{type:"staff_compensation",organizationId:ctx.organizationId,dataClass:"financial"},organizationOnly:true}],new CompanyExpenseAccessError());};await recheckSalary();
  if(previous&&previous.version===input.expectedSourceVersion+1&&previous.state===state&&previous.companyExpenseId===plan.companyExpenseId&&previous.planVersion===input.expectedPlanVersion&&previous.createdBy===ctx.actorId&&previous.reason===input.reason){await source.recheckSettlement(await source.finance.clock());await recheckCompanyExpenseAccess(ctx,tx,plan,"edit");return{id:previous.id,version:previous.version,idempotent:true};}
  if(plan.version!==input.expectedPlanVersion||(previous?.version??0)!==input.expectedSourceVersion||input.operation==="ATTACH"&&(previous?.state==="ATTACHED"||plan.state!=="PLANNED"||line.currency!==plan.currency||line.category!==plan.category||line.costCenter!==plan.costCenter)||input.operation==="RELEASE"&&(!previous||previous.state!=="ATTACHED"||previous.companyExpenseId!==plan.companyExpenseId))throw new CompanyExpenseChangedError();
  const now=await new FinanceRepository(tx,ctx.organizationId).clock(),row=await links.append({invoiceLineId:line.id,companyExpenseId:plan.companyExpenseId,planVersion:plan.version,dataClass,version:(previous?.version??0)+1,state,reason:input.reason,createdBy:ctx.actorId,createdAt:now});
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:state==="ATTACHED"?"company_expense.invoice_attached":"company_expense.invoice_released",resourceType:"company_expense",resourceId:plan.companyExpenseId,before:previous?{linkId:previous.id,companyExpenseId:previous.companyExpenseId,version:previous.version,state:previous.state}:null,after:{linkId:row.id,invoiceLineId:line.id,invoiceId:line.revision.invoiceId,invoiceRevisionId:line.revisionId,version:row.version,state,planVersion:plan.version,...Money.of(line.amount,line.currency).toJSON(),transactionId:recognition.transactionId},reason:input.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});
  await source.recheckSettlement(await source.finance.clock());await recheckCompanyExpenseAccess(ctx,tx,plan,"edit");await recheckSalary();return{id:row.id,version:row.version,idempotent:false};
 });
}
/** Every payment total is the original invoice total; no allocation of a payment to a cost line is invented. */
export async function getCompanyExpenseInvoiceSources(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=companyExpenseInvoiceHistorySchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const plans=new CompanyExpenseRepository(tx,ctx.organizationId),repository=new CompanyExpenseInvoiceRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);await plans.lockPlanRead(input.companyExpenseId);const plan=await plans.latest(input.companyExpenseId);if(!plan)throw new CompanyExpenseAccessError();await recheckCompanyExpenseAccess(ctx,tx,plan,"view");
  const history=await repository.history(input.companyExpenseId,input.before),rows=history.slice(0,50),current=new Map((await repository.currentMany(rows.map(row=>row.invoiceLineId))).map(row=>[row.invoiceLineId,row]));
  const salary=async()=>{if(plan.dataClass==="STAFF_COMPENSATION"||rows.some(row=>row.dataClass==="STAFF_COMPENSATION"||current.get(row.invoiceLineId)?.dataClass==="STAFF_COMPENSATION"))await recheckFinanceAuthorization(ctx,tx,await finance.clock(),[{action:"view",resource:{type:"staff_compensation",organizationId:ctx.organizationId,dataClass:"financial"},organizationOnly:true}],new CompanyExpenseAccessError());};await salary();
  const sources=new Map<string,Awaited<ReturnType<typeof inspectSupplierInvoiceSettlementSource>>>(),settlements=new Map<string,Awaited<ReturnType<typeof getSupplierSettlement>>>();
  for(const invoiceId of[...new Set(rows.map(row=>row.invoiceLine.revision.invoiceId))].sort()){sources.set(invoiceId,await inspectSupplierInvoiceSettlementSource(ctx,invoiceId,tx));settlements.set(invoiceId,await getSupplierSettlement(ctx,{id:invoiceId},{db:repository.runner(),requestId:deps.requestId}));}
  const items=rows.map(row=>{const invoiceId=row.invoiceLine.revision.invoiceId,source=sources.get(invoiceId),line=source?.revision.lines.find(line=>line.id===row.invoiceLineId),claim=source?.existing?.lines.find(link=>link.invoiceLineId===row.invoiceLineId);if(!source||!line||line.propertyId||line.reservationId||!claim)throw new CompanyExpenseAccessError();return{id:row.id,version:row.version,planVersion:row.planVersion,invoiceLineId:line.id,invoiceId,invoiceRevisionId:row.invoiceLine.revisionId,invoiceNumber:row.invoiceLine.revision.invoiceNumber,state:row.state,active:current.get(line.id)?.state==="ATTACHED"&&current.get(line.id)?.companyExpenseId===input.companyExpenseId,...Money.of(line.amount,line.currency).toJSON(),transactionId:claim.transactionId,reason:row.reason,at:row.createdAt.toISOString(),settlement:{scope:"INVOICE"as const,value:settlements.get(invoiceId)}};});
  for(const source of sources.values())await source.recheckSettlement(await finance.clock());await salary();await recheckCompanyExpenseAccess(ctx,tx,plan,"view");return{items,next:history.length>50?rows.at(-1)!.id:null};
 });
}
