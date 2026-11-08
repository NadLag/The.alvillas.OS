import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {leadCapturePolicyKey,type LeadCaptureInput,type LeadCapturePolicy} from "@/modules/crm/domain/lead-capture";
import {leadStages,leadPipelineEvidenceKinds,type LeadPipelinePolicy} from "@/modules/crm/domain/lead-pipeline";
import {captureLead} from "@/modules/crm/application/lead-capture-service";

const label={en:"Actual assessment",fr:"Évaluation réelle",ar:"تقييم فعلي"};
export function nativeLeadPolicy(changes:Partial<LeadCapturePolicy>={}):LeadCapturePolicy{return{
  source:"NATIVE_PRIVATE_LEAD_CAPTURE",channels:["WEBSITE","MANUAL","REFERRAL"],sources:[{key:"assessment",label,channels:["WEBSITE","MANUAL","REFERRAL"]}],
  required_fields:["ownerContact","location"],contact_requirement:"PHONE_OR_EMAIL",referral_contact_required:false,
  property_types:[{key:"villa",label}],rental_statuses:[{key:"available",label}],otas:[],
  processing_approval_reference:"explicit-native-test-processing-approval",website_notice:{approval_reference:"explicit-native-test-notice",notice_sha256:"a".repeat(64)},
  encryption:"APP_MANAGED_AUTHENTICATED_ENCRYPTION",history:"APPEND_ONLY_ORIGINAL_CAPTURE",rate_limit:{requests:100,window_seconds:3600},...changes
};}
export function nativeLeadInput(changes:Partial<LeadCaptureInput>={}):LeadCaptureInput{return{
  idempotencyKey:randomUUID(),channel:"MANUAL",sourceKey:"assessment",locale:"fr",
  fields:{ownerContact:"Propriétaire privé",email:"private-lead@example.test",location:"Marrakech",propertyTypeKey:"villa",bedrooms:3,currentRentalStatusKey:"available",currentOtaKeys:[],objectives:"Actual acquisition assessment",notes:"Private original acquisition details"},...changes
};}
export function nativeWebsiteLeadInput():LeadCaptureInput{return nativeLeadInput({channel:"WEBSITE",websiteAcknowledgement:{approvalReference:"explicit-native-test-notice",noticeSha256:"a".repeat(64),affirmed:true}});}

export async function nativeLeadFixture(admin:PrismaClient,db:PrismaClient,changes:Partial<LeadCapturePolicy>={}){
  const organizationId=randomUUID();await admin.organization.create({data:{id:organizationId,name:"Actual private lead acceptance"}});
  await ensureStandardIdentitySetup(organizationId,{db:admin});
  const saved=await withTenant(admin,organizationId,async tx=>{
    const person=await tx.person.create({data:{organizationId,displayName:"Actual lead operator"}}),account=await tx.userAccount.create({data:{organizationId,personId:person.id}});
    const assignments:Record<string,string>={};
    for(const[name,keys]of Object.entries({create:["lead:create"],view:["lead:view"],configure:["config_rule:view","config_rule:configure"]})){
      const role=await tx.role.create({data:{organizationId,key:"actual_lead_"+name+"_"+randomUUID(),name:"Actual independent lead "+name}}),permissions=await tx.permission.findMany({where:{organizationId,key:{in:keys}}});
      if(permissions.length!==keys.length)throw Error("Actual native lead permissions must exist");
      await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId,roleId:role.id,permissionId:permission.id}))});
      const assignment=await tx.roleAssignment.create({data:{organizationId,userAccountId:account.id,personId:person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});assignments[name]=assignment.id;
    }
    const policy=nativeLeadPolicy(changes),rule=await new ConfigRuleRepository(tx,organizationId).createVersion({key:leadCapturePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:account.id,value:policy,reason:"Explicit approved native CRM acquisition policy"});
    return{person,account,assignments,policy,rule};
  });
  const ctx={organizationId,actorId:saved.account.id,authContext:{...await authContextForAccount(organizationId,saved.account.id,{db}),personId:saved.person.id}};
  return{organizationId,...saved,ctx};
}

export function nativeLeadStagePolicy(changes:Partial<LeadPipelinePolicy>={}):LeadPipelinePolicy{return{
  source:"NATIVE_IMMUTABLE_LEAD_PIPELINE",history:"APPEND_ONLY_STAGE_MOVEMENTS",document_types:{proposal:["acquisition_proposal"],contract:["management_contract"]},
  admission:{requests:100,window_seconds:3600},transitions:[...leadStages.slice(0,-1).map((from,index)=>({from,to:leadStages[index+1],kind:"ADVANCE" as const,evidence:[...leadPipelineEvidenceKinds.slice(0,Math.max(0,index-2))]})),
    {from:"CONTACTED",to:"NEW",kind:"CORRECTION",evidence:[]},{from:"QUALIFIED",to:"NEW",kind:"CORRECTION",evidence:[]},{from:"PROPERTY_ASSESSMENT",to:"NEW",kind:"CORRECTION",evidence:[]}],...changes
};}
export async function nativeLeadStageFixture(admin:PrismaClient,db:PrismaClient,env:NodeJS.ProcessEnv,changes:Partial<LeadPipelinePolicy>={}){
  const base=await nativeLeadFixture(admin,db),saved=await withTenant(db,base.organizationId,async tx=>{
    const role=await tx.role.create({data:{organizationId:base.organizationId,key:"actual_stage_editor_"+randomUUID(),name:"Independent actual lead stage editor"}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:base.organizationId,key:"lead:edit"}});
    await tx.rolePermission.create({data:{organizationId:base.organizationId,roleId:role.id,permissionId:permission.id}});
    const assignment=await tx.roleAssignment.create({data:{organizationId:base.organizationId,userAccountId:base.account.id,personId:base.person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}}),stagePolicy=nativeLeadStagePolicy(changes),stageRule=await new ConfigRuleRepository(tx,base.organizationId).createVersion({key:"crm.pipeline",scopeType:"organization",createdBy:base.account.id,effectiveFrom:new Date("2020-01-01"),value:stagePolicy,reason:"Actual explicit native acquisition stage policy"});return{stagePolicy,stageRule,editAssignmentId:assignment.id};
  });
  const ctx={...base.ctx,authContext:{...await authContextForAccount(base.organizationId,base.account.id,{db}),personId:base.person.id}},input=nativeLeadInput(),lead=await captureLead(ctx,input,{db,env});
  const assignments:Record<string,string>={...base.assignments,edit:saved.editAssignmentId};
  return{...base,...saved,ctx,assignments,input,lead};
}
