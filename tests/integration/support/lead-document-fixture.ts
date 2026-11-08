import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {authContextForAccount} from "@/platform/authz/account-context";
import {documentTemplateMediaType} from "@/modules/documents/domain/document-template-format";
import {nativeLeadProfileFixture} from "./lead-fixture";

export async function nativeLeadArchiveFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,typeKey="acquisition_proposal"){
 const f=await nativeLeadProfileFixture(admin,db,env),grants=await withTenant(db,f.organizationId,async tx=>{
  const result:Record<string,string>={"lead:view":f.assignments.view};
  for(const key of["lead:export","document:view","document:create","document:edit","document:export","document_template:view","document_template:create","document_template:edit","document_template:export","document_instance:view","document_instance:create","document_instance:edit","document_instance:export","organization:view","organization:export","signature:view","signature:create","team_member:view","team_member:export","staff_document:view","staff_document:export"]){
   const role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_proposal_"+randomUUID(),name:"Independent actual proposal "+key}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});result[key]=assignment.id;
  }
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"documents.archive",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Explicit approved native acquisition document types",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:30,upload_admission:{window_seconds:3600,max_requests:100},upload_transport:{window_seconds:3600,max_requests:100},types:[{key:typeKey,labels:{en:"Approved acquisition proposal",fr:"Proposition approuvée",ar:"عرض معتمد"},sources:["ORGANIZATION","LEAD"],privacy:["sensitive"],content_types:["application/pdf",documentTemplateMediaType],max_bytes:1048576}]}});
  return result;
 });return{...f,originalHeld:f.ctx,grants,ctx:{...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}}};
}
