import { employeeCompensationCostSources } from "./employee-compensation-cost-sources";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { employeeCompensationSourceGroups } from "../domain/employee-compensation-source-identity";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { encryptSecret,decryptSecret } from "@/platform/auth/secret-encryption";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { EmployeeCompensationRunRepository,type CompensationRunRecord } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationClaimRepository } from "../infrastructure/employee-compensation-claim-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { employeeCompensationCostWorkspaceSchema } from "../domain/employee-compensation-cost-workspace";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import { employeeCompensationRunModel } from "./employee-compensation-run-service";
import { employeeCompensationSubmissionFinancialChecks } from "./employee-compensation-submission";
import type { FinanceActorContext } from "./finance-access";

const inputSchema=z.object({runId:z.uuid(),after:z.string().max(4096).optional()}).strict();
const cursorSchema=z.object({kind:z.literal("employee-cost-workspace-v1"),organizationId:z.uuid(),actorId:z.uuid(),runId:z.uuid(),id:z.uuid()}).strict();

/** Readable source facts determine an affordance; each eventual command rechecks its actual cost date and rules. */
export async function employeeCompensationCostAccess(ctx:FinanceActorContext,run:CompensationRunRecord,tx:TenantTransaction){
  const repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId),sources=await repository.claimSources(run.id),facts=employeeCompensationRunFacts(ctx.organizationId,run);
  const frames=await employeeCompensationCostSources(ctx.organizationId,run.createdBy,sources,tx),checks=frames.flatMap(({financial,organizationOnly})=>[{action:"view" as const,resource:financial,organizationOnly},{action:"view" as const,resource:{...financial,amount:facts.total.toJSON().amount},organizationOnly}]);
  const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),now=await new FinanceRepository(tx,ctx.organizationId).clock();
  const canView=checks.every(check=>[ctx.authContext,current].every(auth=>check.organizationOnly?authorizeOrganizationSource(auth,check.action,check.resource,now):authorize(auth,check.action,check.resource,now))),positive=sources.filter(source=>source.amount.gt(0));
  const identities=employeeCompensationSourceGroups(positive),hasOwnActive=Boolean(await repository.activeSubmissions(run.id)),activeWork=canView&&positive.length?Boolean((await new EmployeeCompensationClaimRepository(tx,ctx.organizationId).activeSources(identities.completionEventIds,identities.monthly,identities.percentage)).length):false;
  const canEdit=[ctx.authContext,current].every(auth=>authorize(auth,"edit",facts.resource,now));
  const blocked=run.cancellation?"run_cancelled" as const:!positive.length?"no_positive_work" as const:activeWork?"active_source" as const:!canView||!canEdit?"forbidden" as const:null;
  return{canView,canPrepare:blocked===null,blocked,positiveLineIds:positive.map(source=>source.id),checks,hasOwnActive};
}

export async function getEmployeeCompensationCostWorkspace(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=inputSchema.parse(raw);let after:string|undefined;
  if(input.after)try{const cursor=cursorSchema.parse(JSON.parse(decryptSecret(input.after)));if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.runId!==input.runId)throw new EmployeeCompensationRunAccessError();after=cursor.id;}catch{throw new EmployeeCompensationRunAccessError();}
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),repository=new EmployeeCompensationClaimRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId),run=await runs.find(input.runId);
    if(!run)throw new EmployeeCompensationRunAccessError();const facts=employeeCompensationRunFacts(ctx.organizationId,run);await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts);
    const access=await employeeCompensationCostAccess(ctx,run,tx);if(!access.canView)throw new EmployeeCompensationRunAccessError();
    const rows=await repository.listForRun(run.id,after),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),now=await finance.clock(),selected:typeof rows=[],checks=[...access.checks];let scanned=0;
    for(const row of rows){scanned++;const financial=employeeCompensationSubmissionFinancialChecks(ctx.organizationId,{...row,run:{createdBy:run.createdBy}},facts.total);
      if(!financial.every(check=>[ctx.authContext,current].every(auth=>check.organizationOnly?authorizeOrganizationSource(auth,check.action,check.resource,now):authorize(auth,check.action,check.resource,now))))continue;
      selected.push(row);checks.push(...financial);if(selected.length===10)break;
    }
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.costs_listed",resourceType:"employee_compensation_run",resourceId:run.id,
      after:{runId:run.id,submissionIds:selected.map(row=>row.id)},reason:"Viewed authorized employee cost proposals",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    const refreshed=await runs.find(run.id);if(JSON.stringify(refreshed)!==JSON.stringify(run))throw new EmployeeCompensationRunAccessError();
    const states=await repository.workspaceStates(selected.map(row=>row.id));
    if(selected.some(row=>{const state=states.find(value=>value.id===row.id);return !state||JSON.stringify({id:row.id,withdrawal:row.withdrawal,approval:row.approval})!==JSON.stringify(state);}))throw new EmployeeCompensationRunAccessError();
    await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,"view",checks);const model=employeeCompensationRunModel(ctx,run);
    return employeeCompensationCostWorkspaceSchema.parse({run:{id:model.id,purpose:model.purpose,state:model.state,fromOn:model.fromOn,toOn:model.toOn,timezone:model.timezone,total:model.total,lineCount:model.lineCount},
      canPrepare:access.canPrepare,blocked:access.blocked,positiveLineIds:access.positiveLineIds,proposals:selected.map(row=>({id:row.id,state:row.withdrawal?"WITHDRAWN":row.approval?.state==="PENDING"?"PENDING_APPROVAL":row.approval?.state??"APPROVED",
        costOn:row.costOn.toISOString().slice(0,10),createdAt:row.createdAt.toISOString(),total:facts.total.toJSON(),costCount:row.costs.length,claimCount:row._count.claims})),
      next:scanned&&(scanned<rows.length||rows.length===25)?encryptSecret(JSON.stringify({kind:"employee-cost-workspace-v1",organizationId:ctx.organizationId,actorId:ctx.actorId,runId:run.id,id:rows[scanned-1].id})):null});
  });
}
