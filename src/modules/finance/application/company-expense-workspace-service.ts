import type {CompanyExpenseRevision} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner,type TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {Money} from "@/platform/money/money";
import {calendarDateAt} from "@/i18n/format";
import {companyExpensePolicyKey,companyExpensePolicySchema,CompanyExpenseAccessError} from "../domain/company-expense";
import {companyExpenseWorkspaceReadSchema,companyExpenseWorkspaceSettingsSchema,companyExpensePlanViewSchema,companyExpenseListSchema,companyExpenseDetailSchema,companyExpenseSourceHistorySchema,companyExpenseCandidatesSchema} from "../domain/company-expense-workspace";
import {CompanyExpenseWorkspaceRepository} from "../infrastructure/company-expense-workspace-repository";
import {CompanyExpenseInvoiceRepository} from "../infrastructure/company-expense-invoice-repository";
import {CompanyExpenseCompensationRepository} from "../infrastructure/company-expense-compensation-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {getCompanyExpensePlan,recheckCompanyExpenseAccess} from "./company-expense-service";
import {getCompanyExpenseInvoiceSources} from "./company-expense-invoice-service";
import {getCompanyExpenseCompensationSources} from "./company-expense-compensation-service";
import {inspectSupplierInvoiceSettlementSource} from "./supplier-payment-service";
import {prepareEmployeeCompensationSettlement} from "./employee-compensation-settlement";
import {getEmployeeCompensationPaymentWorkspace} from "./employee-compensation-payment-workspace";
import {canConfigureCompanyExpenseSettings} from "./company-expense-settings-service";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
async function authority(ctx:FinanceActorContext,tx:TenantTransaction,type:string,action:"view"|"create"|"edit"|"void"|"configure"="view",dataClass:"financial"|"personal"="financial"){
 await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),[{action,resource:{type,organizationId:ctx.organizationId,...type==="config_rule"?{id:companyExpensePolicyKey}:{dataClass}},organizationOnly:true}],new CompanyExpenseAccessError());
}
async function allows(ctx:FinanceActorContext,tx:TenantTransaction,type:string,action:"view"|"create"|"edit"|"void"|"configure"="view",dataClass:"financial"|"personal"="financial"){
 try{await authority(ctx,tx,type,action,dataClass);return true;}catch(error){if(error instanceof CompanyExpenseAccessError)return false;throw error;}
}
function view(row:{policySnapshot?:unknown;[key:string]:unknown}){
 const{policySnapshot,configRuleId,...facts}=row;void configRuleId;
 const snapshot=companyExpensePolicySchema.parse({categories:[(policySnapshot as{category:unknown}).category],cost_centers:[(policySnapshot as{costCenter:unknown}).costCenter]});
 return companyExpensePlanViewSchema.parse({...facts,categoryLabels:snapshot.categories[0].labels,costCenterLabels:snapshot.cost_centers[0].labels});
}
function fromRevision(row:CompanyExpenseRevision){return view({id:row.companyExpenseId,revisionId:row.id,version:row.version,state:row.state,...Money.of(row.amount,row.currency).toJSON(),category:row.category,costCenter:row.costCenter,purpose:row.purpose,dueOn:row.dueOn.toISOString().slice(0,10),timezone:row.timezone,dataClass:row.dataClass,policySnapshot:row.policySnapshot,reason:row.reason,at:row.createdAt.toISOString()});}

/** Native company readers and settlements remain the only sources of amounts and payment history. */
export async function readCompanyExpenseWorkspace(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=companyExpenseWorkspaceReadSchema.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new CompanyExpenseWorkspaceRepository(tx,ctx.organizationId),native={db:repository.runner(),requestId:deps.requestId};
  await authority(ctx,tx,"company_expense");await authority(ctx,tx,"financial_transaction");
  const finish=async<T>(value:T)=>{await authority(ctx,tx,"company_expense");await authority(ctx,tx,"financial_transaction");return value;};
  if(input.operation==="SETTINGS"){
   const staff=await allows(ctx,tx,"staff_compensation"),now=await new FinanceRepository(tx,ctx.organizationId).clock(),rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:companyExpensePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now}),policy=rule?companyExpensePolicySchema.parse(rule.value):null,calendar=await repository.settings();
   const capabilities={staff,create:await allows(ctx,tx,"company_expense","create"),edit:await allows(ctx,tx,"company_expense","edit"),void:await allows(ctx,tx,"company_expense","void"),invoice:await allows(ctx,tx,"supplier_invoice")&&await allows(ctx,tx,"supplier","view","personal"),employee:staff&&await allows(ctx,tx,"employee_payable"),configure:await canConfigureCompanyExpenseSettings(ctx,tx)};
   return finish(companyExpenseWorkspaceSettingsSchema.parse({timezone:calendar.timezone??null,today:calendar.timezone?calendarDateAt(now,calendar.timezone):null,currencies:await repository.currencies(),categories:policy?.categories.filter(row=>staff||row.data_class==="FINANCIAL")??[],costCenters:policy?.cost_centers??[],capabilities}));
  }
  if(input.operation==="LIST"){
   const staff=await allows(ctx,tx,"staff_compensation"),all=await repository.list(input,staff),rows=all.slice(0,50);
   // Unconditional organization grants cover the bounded page; salary remains an independent grant.
   const result=companyExpenseListSchema.parse({items:rows.map(fromRevision),next:all.length>50?rows.at(-1)!.companyExpenseId:null});
   if(rows.some(row=>row.dataClass==="STAFF_COMPENSATION"))await authority(ctx,tx,"staff_compensation");return finish(result);
  }
  if(input.operation==="DETAIL"){
   const result=await getCompanyExpensePlan(ctx,{id:input.id,beforeVersion:input.beforeVersion},native);
   return finish(companyExpenseDetailSchema.parse({current:view(result.current),history:result.history.map(view),next:result.next}));
  }
  if(input.operation==="INVOICE_HISTORY"){
   const result=await getCompanyExpenseInvoiceSources(ctx,{companyExpenseId:input.id,before:input.before},native);
   return finish(companyExpenseSourceHistorySchema.parse({items:result.items.map(row=>{const settlement=row.settlement.value;if(!settlement)throw new CompanyExpenseAccessError();return{
    id:row.id,sourceId:row.invoiceLineId,version:row.version,planVersion:row.planVersion,state:row.state,active:row.active&&row.version===row.currentVersion&&row.state==="ATTACHED",amount:row.amount,currency:row.currency,label:row.invoiceNumber,reason:row.reason,at:row.at,
    sourceReversed:settlement.claimReversed,scope:row.settlement.scope,outstanding:settlement.outstanding,payments:settlement.payments.map(payment=>({id:payment.id,amount:payment.amount,paidAt:payment.paidAt,reason:payment.reason,reference:payment.reference,fundingName:payment.fundingName,reversed:payment.reversed})),paymentsNext:settlement.next,invoiceId:row.invoiceId
   };}),next:result.next}));
  }
  if(input.operation==="EMPLOYEE_HISTORY"){
   const result=await getCompanyExpenseCompensationSources(ctx,{companyExpenseId:input.id,before:input.before},native);
   return finish(companyExpenseSourceHistorySchema.parse({items:result.items.map(row=>({id:row.id,sourceId:row.employeeCostId,version:row.version,planVersion:row.planVersion,state:row.state,active:row.active&&row.version===row.currentVersion&&row.state==="ATTACHED",amount:row.amount,currency:row.currency,label:row.reason,reason:row.reason,at:row.at,
    sourceReversed:row.sourceReversed,scope:row.settlement.scope,outstanding:row.settlement.value.outstanding,payments:row.settlement.value.payments.map(payment=>({id:payment.id,amount:payment.amount,paidAt:payment.paidAt,reason:payment.reason,reference:payment.reference,fundingName:payment.fundingName,reversed:payment.reversal!==null})),paymentsNext:row.settlement.value.next,submissionId:row.submissionId,claimId:row.claimId})),next:result.next}));
  }
  await repository.lockPlanRead(input.id);const plan=await repository.latest(input.id);if(!plan)throw new CompanyExpenseAccessError();await recheckCompanyExpenseAccess(ctx,tx,plan,"view");
  const staff=await allows(ctx,tx,"staff_compensation");if(input.kind==="EMPLOYEE"){await authority(ctx,tx,"staff_compensation");if(plan.dataClass!=="STAFF_COMPENSATION")throw new CompanyExpenseAccessError();}
  const candidates=await repository.candidates(input.kind,plan,input,staff),invoiceLinks=new CompanyExpenseInvoiceRepository(tx,ctx.organizationId),employeeLinks=new CompanyExpenseCompensationRepository(tx,ctx.organizationId);
  const latest=new Map((input.kind==="INVOICE"?await invoiceLinks.currentMany(candidates.map(row=>row.id)):await employeeLinks.currentMany(candidates.map(row=>row.id))).map(row=>["invoiceLineId"in row?row.invoiceLineId:row.employeeCostId,row]));
  const ids=candidates.slice(0,50).map(row=>row.id),lines=new Map((input.kind==="INVOICE"?await repository.invoices(ids):[]).map(row=>[row.id,row])),costs=new Map((input.kind==="EMPLOYEE"?await repository.employees(ids):[]).map(row=>[row.id,row]));
  const invoiceSources=new Map<string,Awaited<ReturnType<typeof inspectSupplierInvoiceSettlementSource>>>(),employeeSources=new Map<string,Awaited<ReturnType<typeof prepareEmployeeCompensationSettlement>>>(),employeeSettlements=new Map<string,Awaited<ReturnType<typeof getEmployeeCompensationPaymentWorkspace>>>();
  for(const invoiceId of[...new Set([...lines.values()].map(row=>row.revision.invoiceId))].sort())invoiceSources.set(invoiceId,await inspectSupplierInvoiceSettlementSource(ctx,invoiceId,tx));
  const claims=new Map([...costs.values()].map(row=>[[row.submission.runId,row.submissionId,row.claimId].join(":"),row]));
  for(const key of[...claims.keys()].sort()){const cost=claims.get(key)!;employeeSources.set(cost.claimId,await prepareEmployeeCompensationSettlement(ctx,cost.submissionId,cost.claimId,tx,"view"));employeeSettlements.set(cost.claimId,await getEmployeeCompensationPaymentWorkspace(ctx,{id:cost.submissionId,claimId:cost.claimId},native));}
  const items:Array<{id:string;label:string;position?:number;amount:string;currency:string;sourceVersion:number}>=[];
  for(const candidate of candidates.slice(0,50)){
   if(input.kind==="INVOICE"){
    const line=lines.get(candidate.id);if(!line)throw new CompanyExpenseAccessError();const invoiceId=line.revision.invoiceId;
    const source=invoiceSources.get(invoiceId)!;
    if(!source.existing?.lines.some(row=>row.invoiceLineId===line.id))throw new CompanyExpenseAccessError();
    items.push({id:line.id,label:line.revision.invoiceNumber,position:line.position,...Money.of(line.amount,line.currency).toJSON(),sourceVersion:latest.get(line.id)?.version??0});
   }else{
    const cost=costs.get(candidate.id);if(!cost)throw new CompanyExpenseAccessError();
    const settlement=employeeSettlements.get(cost.claimId)!;items.push({id:cost.id,label:[settlement.personName,settlement.purpose,cost.note].filter(Boolean).join(" · "),...Money.of(cost.amount,cost.currency).toJSON(),sourceVersion:latest.get(cost.id)?.version??0});
   }
  }
  // Filtering applies to already authorized human labels; the keyset always advances over the scanned page.
  for(const source of invoiceSources.values())await source.recheckSettlement(await source.finance.clock());for(const source of employeeSources.values())await source.recheckSettlement(await source.finance.clock());
  if(input.kind==="EMPLOYEE"||[...latest.values()].some(row=>row.dataClass==="STAFF_COMPENSATION"))await authority(ctx,tx,"staff_compensation");await recheckCompanyExpenseAccess(ctx,tx,plan,"view");
  return finish(companyExpenseCandidatesSchema.parse({items:items.filter(row=>!input.query||row.label.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())),next:candidates.length>50?candidates[49].id:null}));
 });
}
