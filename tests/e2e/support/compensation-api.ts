import { createHash } from "node:crypto";
import type { Page,TestInfo } from "@playwright/test";
import type { AppLocale } from "@/i18n/routing";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { saveTeamCompensation } from "@/modules/identity/application/team-service";
import { openFieldFixture } from "./field-fixture";

/** Actual MFA sign-in, field work and effective-dated contract shared by native financial API journeys. */
export async function openCompensationApiFixture(page:Page,info:TestInfo,locale:AppLocale){
  const f=await openFieldFixture(page,info,locale),origin=new URL(page.url()).origin;
  const source=await withTenant(f.db,f.organizationId,async tx=>{
    const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),account=await tx.userAccount.findUniqueOrThrow({where:{id:task.assignedToUserAccountId!}});
    const assignment=await tx.roleAssignment.findFirstOrThrow({where:{organizationId:f.organizationId,userAccountId:account.id,scopeType:"organization",archivedAt:null,role:{key:"admin"}}});
    return{account,assignment};
  });
  const actor={organizationId:f.organizationId,actorId:source.account.id,personId:source.account.personId,
    authContext:{...await authContextForAccount(f.organizationId,source.account.id,{db:f.db}),personId:source.account.personId}};
  const rate=await saveTeamCompensation(actor,{assignmentId:source.assignment.id,expectedVersion:0,mode:"PER_JOB",amount:"500.25",currency:"MAD",
    effectiveFrom:new Date().toISOString(),reason:"Native API verification of the actual contractual rate"},{db:f.db});
  const facts=()=>withTenant(f.db,f.organizationId,async tx=>createHash("sha256").update(JSON.stringify({
    journals:await tx.financialTransaction.findMany({orderBy:{id:"asc"}}),postings:await tx.posting.findMany({orderBy:{id:"asc"}})
  })).digest("hex"));
  return{...f,origin,source,actor,rate,facts,original:await facts()};
}
