import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { readEmployeeCompensationRunInTransaction } from "./employee-compensation-run-service";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

export const employeeCompensationRunRecoveryInput=z.object({key:z.uuid().transform(value=>value.toLowerCase())}).strict();
/** An opaque tab-local nonce can recover an acknowledgement, never somebody else's run or a grant. */
export async function recoverEmployeeCompensationRun(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=employeeCompensationRunRecoveryInput.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId);await repository.lockKey(input.key);
    const existing=await repository.byKey(input.key);
    if(existing){
      if(existing.createdBy!==ctx.actorId)throw new EmployeeCompensationRunAccessError();
      return{run:(await readEmployeeCompensationRunInTransaction(ctx,{id:existing.id},tx,deps)).model};
    }
    const now=await new FinanceRepository(tx,ctx.organizationId).clock(),resource={type:"employee_payable",organizationId:ctx.organizationId,dataClass:"financial" as const,amount:"0.00",occurredAt:now};
    await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource},{action:"create",resource}],new EmployeeCompensationRunAccessError());
    return{run:null};
  },{timeout:120000});
}
