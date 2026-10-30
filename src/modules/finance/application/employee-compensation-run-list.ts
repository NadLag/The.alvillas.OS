import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { encryptSecret,decryptSecret } from "@/platform/auth/secret-encryption";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeCompensationRunFacts } from "./employee-compensation-run-access";
import { employeeCompensationRunModel } from "./employee-compensation-run-service";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

const filters=z.object({query:z.string().trim().max(160).default(""),state:z.enum(["all","draft","cancelled"]).default("all")});
const inputSchema=filters.extend({after:z.string().min(1).max(4096).optional()}).strict();
const cursorSchema=filters.extend({kind:z.literal("employee-compensation-run-list-v1"),organizationId:z.uuid(),actorId:z.uuid(),id:z.uuid()}).strict();

/** Each concrete run and every original salary source is authorized before inclusion. */
export async function listEmployeeCompensationRuns(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=inputSchema.parse(raw);let after:string|undefined;
  if(input.after){
    try{
      const cursor=cursorSchema.parse(JSON.parse(decryptSecret(input.after)));
      if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.query!==input.query||cursor.state!==input.state)throw new EmployeeCompensationRunAccessError();
      after=cursor.id;
    }catch{throw new EmployeeCompensationRunAccessError();}
  }
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
    const rows=await repository.list({...input,after}),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),now=await finance.clock();
    const selected:typeof rows=[],checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[];
    let scanned=0;
    for(const row of rows){
      scanned++;const facts=employeeCompensationRunFacts(ctx.organizationId,row),resources=[facts.resource,...facts.salarySources];
      if(!resources.every(resource=>[ctx.authContext,current].every(auth=>authorize(auth,"view",resource,now))))continue;
      selected.push(row);checks.push(...resources.map(resource=>({action:"view" as const,resource})));
      if(selected.length===10)break;
    }
    // A read receipt contains only rows that will actually be disclosed; no hidden counts or identifiers leave this boundary.
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation_run.listed",resourceType:"employee_compensation_run",
      resourceId:null,after:{runIds:selected.map(row=>row.id)},reason:"Viewed authorized compensation runs",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    const refreshed=await repository.findMany(selected.map(row=>row.id)),byId=new Map(refreshed.map(row=>[row.id,row]));
    if(selected.some(row=>JSON.stringify(row)!==JSON.stringify(byId.get(row.id))))throw new EmployeeCompensationRunAccessError();
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
    const capability={type:"employee_payable",organizationId:ctx.organizationId,dataClass:"financial" as const,amount:"0.00",occurredAt:await finance.clock()};
    const latest=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
    return{runs:selected.map(row=>{
      const {id,purpose,state,fromOn,toOn,timezone,createdAt,total,lineCount}=employeeCompensationRunModel(ctx,row);
      return{id,purpose,state,fromOn,toOn,timezone,createdAt,total,lineCount};
    }),next:scanned>0&&(scanned<rows.length||rows.length===25)?encryptSecret(JSON.stringify({kind:"employee-compensation-run-list-v1",organizationId:ctx.organizationId,actorId:ctx.actorId,
      query:input.query,state:input.state,id:rows[scanned-1].id})):null,
      canCreate:[ctx.authContext,latest].every(auth=>authorize(auth,"view",capability,now)&&authorize(auth,"create",capability,now))};
  },{timeout:120000});
}
