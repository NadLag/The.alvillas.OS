import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {authorize,type Resource} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {present,catalogFieldPolicy,maskedValue} from "@/platform/authz/present";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {TeamRepository} from "../infrastructure/team-repository";
import {teamScopeChoiceInput,teamScopeChoicePage} from "../domain/team-scope-choices";
import {IdentityAuthorizationError,type IdentityActorContext} from "./identity-access";

/** Bounded, current-authority scope lookup; stored staff assignments load only their retained labels. */
export async function listTeamScopeChoices(ctx:IdentityActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=teamScopeChoiceInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repo=new TeamRepository(tx,ctx.organizationId),role:Resource={type:"role",organizationId:ctx.organizationId},denied=new IdentityAuthorizationError();
  await recheckAccountAuthorization(ctx,tx,await repo.clock(),[{action:"assign",resource:role}],denied);
  if(input.after&&!await repo.scopeChoiceExists(input.type,input.after))throw denied;
  const rows=await repo.scopeChoices(input),current={...await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),personId:ctx.personId},now=await repo.clock(),checks:Array<{action:"assign"|"view";resource:Resource}>=[{action:"assign",resource:role}],items:Array<{id:string;name:string}>=[];
  for(const row of rows.slice(0,25)){
   const resource:Resource={type:input.type,organizationId:ctx.organizationId,id:row.id,...input.type==="property"?{propertyId:row.id}:{},city:row.cityId,region:row.regionId,dataClass:"operational"};
   if(![ctx.authContext,current].every(authority=>authorize(authority,"view",resource,now)))continue;
   const data={id:row.id,name:row.name},policy=catalogFieldPolicy<typeof data>(input.type),held=present({...ctx.authContext,visibleDataClasses:new Set(["operational"] as const)},"view",{...resource,data},policy,now),fresh=present({...current,visibleDataClasses:new Set(["operational"] as const)},"view",{...resource,data},policy,now);
   if(typeof held.name!=="string"||held.name===maskedValue||fresh.name!==held.name)continue;items.push({id:row.id,name:held.name});checks.push({action:"view",resource});
  }
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"team.scope_choices_viewed",resourceType:"team_member",resourceId:ctx.personId,after:{scopeType:input.type,ids:items.map(item=>item.id)},reason:"Viewed authorized role assignment scope choices",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await recheckAccountAuthorization(ctx,tx,await repo.clock(),checks,denied);return teamScopeChoicePage.parse({items,next:rows.length>25?rows[24].id:null});
 });
}
