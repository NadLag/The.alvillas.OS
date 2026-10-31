import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize,type Resource } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { employeeCompensationNoticeSchema } from "../domain/employee-compensation-notice";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

/** A retained owner receipt grants access to its own actual cost slice, without salary or run access. */
export async function getEmployeeCompensationNotice(ctx:FinanceActorContext,id:string,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  id=z.uuid().parse(id);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new NotificationRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId),source=await repository.employeeCostEmergencyNotice(id,ctx.actorId);
    if(!source||!await repository.activeRecipient(ctx.actorId))throw new EmployeeCompensationRunAccessError();
    const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),now=await finance.clock(),property:Resource={type:"property",organizationId:ctx.organizationId,id:source.target.propertyId??undefined,
      propertyId:source.target.propertyId,city:source.target.city,region:source.target.region};
    const nameAllowed=[ctx.authContext,current].every(auth=>authorize(auth,"view",property,now)),checks=[{action:"view" as const,resource:source.target},...(nameAllowed?[{action:"view" as const,resource:property}]:[])];
    await recheckFinanceAuthorization(ctx,tx,now,checks,new EmployeeCompensationRunAccessError());
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.owner_notice_viewed",resourceType:"employee_compensation_owner_notice",resourceId:id,
      after:{noticeId:id},reason:"Viewed the retained owner cost notice",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    if(JSON.stringify(await repository.employeeCostEmergencyNotice(id,ctx.actorId))!==JSON.stringify(source))throw new EmployeeCompensationRunAccessError();
    await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
    return employeeCompensationNoticeSchema.parse(present({...ctx.authContext,visibleDataClasses:new Set()},"view",{...source.target,data:{...source.data,propertyName:nameAllowed?source.data.propertyName:null}},{},await finance.clock()));
  });
}
