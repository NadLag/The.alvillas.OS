import {randomUUID} from "node:crypto";
import {z} from "zod";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {authorizeCollection} from "@/platform/authz/authorize";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {encryptSecret,decryptSecret} from "@/platform/auth/secret-encryption";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {LeadRepository} from "../infrastructure/lead-repository";
import {LeadWorkspaceRepository,type LeadWorkspaceCandidate} from "../infrastructure/lead-workspace-repository";
import {leadWorkspaceInputSchema,leadWorkspaceCursorSchema,leadWorkspaceProtocol,leadWorkspaceItemSchema,leadWorkspaceResultSchema} from "../domain/lead-workspace";
import {leadCapturePolicyKey,leadCapturePolicySchema,LeadAccessError,LeadConfigurationError,LeadConflictError} from "../domain/lead-capture";
import {leadStageSchema,leadPipelinePolicySchema,leadPipelinePolicyKey} from "../domain/lead-pipeline";
import {decryptLeadPayload,requireLeadPayloadKeys} from "../domain/lead-payload";
import {retainedLeadProfile} from "./lead-profile-snapshot";
import {leadCaptureBinding,type LeadDependencies} from "./lead-capture-service";

const resource=(organizationId:string,id:string|undefined,stage:string,createdAt:Date)=>({type:"lead",id,organizationId,status:stage,occurredAt:createdAt,dataClass:"personal" as const});
async function phase(actor:AccountActorContext,tx:TenantTransaction){
  const now=await new LeadRepository(tx,actor.organizationId).clock(),stored=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId);assertAccountAuthorization(actor,stored,now,[],new LeadAccessError());
  return{now,stored,cap:commandFingerprint({held:captureAuthorizationCap(actor.authContext),stored:captureAuthorizationCap(stored)})};
}
type Phase=Awaited<ReturnType<typeof phase>>;
function allowed(actor:AccountActorContext,current:Phase,target:ReturnType<typeof resource>,action:"view"|"create"|"edit"){
  try{assertAccountAuthorization(actor,current.stored,current.now,[{action,resource:target}],new LeadAccessError());return true;}catch(error){if(error instanceof LeadAccessError)return false;throw error;}
}
const pointer=(candidate:LeadWorkspaceCandidate)=>({id:candidate.id,createdAt:candidate.createdAtKey});
export async function listLeadWorkspace(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  const input=leadWorkspaceInputSchema.parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const first=await phase(actor,tx);if(![actor.authContext,first.stored].every(ctx=>authorizeCollection(ctx,"view","lead")))throw new LeadAccessError();
    const filter=commandFingerprint({leadId:input.leadId??null,stage:input.stage??null,sourceKey:input.sourceKey??null}),repository=new LeadWorkspaceRepository(tx,actor.organizationId);let asOf=first.now,before:{id:string;createdAt:string}|undefined;
    if(input.cursor){try{requireLeadPayloadKeys(deps.env??process.env,false);const cursor=leadWorkspaceCursorSchema.parse(JSON.parse(decryptSecret(input.cursor,deps.env)));if(cursor.organizationId!==actor.organizationId||cursor.actorId!==actor.actorId||cursor.filter!==filter||cursor.cap!==first.cap||Date.parse(cursor.asOf)>first.now.getTime())throw new LeadConflictError();asOf=new Date(cursor.asOf);before={id:cursor.beforeId,createdAt:cursor.beforeCreatedAt};}catch{throw new LeadConflictError();}}
    type Row=Awaited<ReturnType<LeadWorkspaceRepository["rows"]>>[number];const matches:Array<{candidate:LeadWorkspaceCandidate;row:Row;item:z.infer<typeof leadWorkspaceItemSchema>}>=[];let more=false,scanned=before;
    // Bound candidate work independently of the tenant's total portfolio size.
    for(let round=0;round<20;round++){
      const candidates=await repository.candidates(input,asOf,before),batch=candidates.slice(0,100),rows=await repository.rows(batch.map(c=>c.id)),byId=new Map(rows.map(row=>[row.id,row]));
      for(const candidate of batch){
        scanned=pointer(candidate);const row=byId.get(candidate.id);if(!row)throw new LeadConflictError();const stage=row.stageRevisions[0],profile=row.profileRevisions[0];
        if((stage?.id??null)!==candidate.stageRevisionId||(profile?.id??null)!==candidate.profileRevisionId)throw new LeadConflictError();
        const target=resource(actor.organizationId,row.id,candidate.stage,row.createdAt);if(!allowed(actor,first,target,"view"))continue;
        const payload=profile?retainedLeadProfile(profile,deps.env):decryptLeadPayload(row.encryptedPayload,leadCaptureBinding(row),deps.env),snapshot=z.object({value:leadCapturePolicySchema}).parse(profile?.capturePolicySnapshot??row.policySnapshot),source=snapshot.value.sources.find(s=>s.key===candidate.sourceKey);if(!source)throw new LeadConfigurationError();
        const data={id:row.id,createdAt:row.createdAt.toISOString(),channel:row.channel,sourceKey:candidate.sourceKey,sourceLabel:source.label,locale:profile?.locale??row.locale,stage:leadStageSchema.parse(candidate.stage),stageRevisionId:candidate.stageRevisionId,profileRevisionId:candidate.profileRevisionId,profileNumber:profile?.number??0,fields:payload.fields,canEdit:allowed(actor,first,target,"edit")};
        const item=leadWorkspaceItemSchema.parse(present({...actor.authContext,visibleDataClasses:new Set(["operational"]as const)},"view",{...target,data},catalogFieldPolicy<typeof data>("lead"),first.now));matches.push({candidate,row,item});if(matches.length===21)break;
      }
      if(matches.length===21){more=true;break;}if(candidates.length<=100){more=false;break;}before=pointer(batch[99]);more=true;
    }
    const published=matches.slice(0,20),nextPointer=matches.length===21?pointer(published[19].candidate):more?scanned:undefined;
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_workspace_read",resourceType:"lead",resourceId:null,after:{filterFingerprint:filter,count:published.length,leadIds:published.map(m=>m.row.id)},requestId:deps.requestId??randomUUID(),occurredAt:first.now});
    const final=await phase(actor,tx);if(final.cap!==first.cap)throw new LeadConflictError();const fresh=new Map((await repository.rows(matches.map(m=>m.row.id))).map(row=>[row.id,row]));
    for(const match of matches){const row=fresh.get(match.row.id);if(!row||row.payloadSha256!==match.row.payloadSha256||(row.stageRevisions[0]?.id??null)!==match.candidate.stageRevisionId||(row.profileRevisions[0]?.id??null)!==match.candidate.profileRevisionId)throw new LeadConflictError();assertAccountAuthorization(actor,final.stored,final.now,[{action:"view",resource:resource(actor.organizationId,row.id,match.candidate.stage,row.createdAt)}],new LeadAccessError());}
    let next:string|null=null;if(nextPointer){requireLeadPayloadKeys(deps.env??process.env,true);next=encryptSecret(JSON.stringify({protocol:leadWorkspaceProtocol,organizationId:actor.organizationId,actorId:actor.actorId,filter,cap:first.cap,beforeId:nextPointer.id,beforeCreatedAt:nextPointer.createdAt,asOf:asOf.toISOString()}),deps.env);}
    return leadWorkspaceResultSchema.parse({items:published.map(m=>m.item),next});
  });
}
export async function leadWorkspaceOptions(actor:AccountActorContext,raw:unknown,deps:LeadDependencies){
  z.object({}).strict().parse(raw);return withTenant(deps.db,actor.organizationId,async tx=>{
    const first=await phase(actor,tx);if(![actor.authContext,first.stored].every(ctx=>authorizeCollection(ctx,"view","lead")||authorizeCollection(ctx,"create","lead")))throw new LeadAccessError();
    const configs=new ConfigRuleRepository(tx,actor.organizationId),rule=await configs.resolve({key:leadCapturePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:first.now}),pipeline=await configs.resolve({key:leadPipelinePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:first.now});if(!rule)throw new LeadConfigurationError();const policy=leadCapturePolicySchema.parse(rule.parsedValue),transitions=pipeline?leadPipelinePolicySchema.parse(pipeline.parsedValue).transitions:[];
    await writeAuditEvent(tx,{organizationId:actor.organizationId,actorId:actor.actorId,action:"crm.lead_workspace_options_read",resourceType:"lead",resourceId:null,after:{policyId:rule.id,version:rule.version},requestId:deps.requestId??randomUUID(),occurredAt:first.now});const final=await phase(actor,tx),current=await new ConfigRuleRepository(tx,actor.organizationId).resolve({key:leadCapturePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:final.now});if(final.cap!==first.cap||current?.id!==rule.id||current.version!==rule.version)throw new LeadConflictError();
    const currentPipeline=await configs.resolve({key:leadPipelinePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:final.now});if((currentPipeline?.id??null)!==(pipeline?.id??null)||currentPipeline?.version!==pipeline?.version)throw new LeadConflictError();
    return{channels:policy.channels.filter(channel=>channel!=="WEBSITE"),sources:policy.sources,requiredFields:policy.required_fields,contactRequirement:policy.contact_requirement,referralContactRequired:policy.referral_contact_required,propertyTypes:policy.property_types,rentalStatuses:policy.rental_statuses,otas:policy.otas,transitions,canView:[actor.authContext,final.stored].every(ctx=>authorizeCollection(ctx,"view","lead")),canCreate:allowed(actor,final,resource(actor.organizationId,undefined,"NEW",final.now),"create")};
  });
}
