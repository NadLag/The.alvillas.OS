import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import type {AuthContext,Resource} from "@/platform/authz/authorize";
import {authorize} from "@/platform/authz/authorize";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {SupplierRepository} from "@/modules/finance/infrastructure/supplier-repository";
import {TeamRepository} from "@/modules/identity/infrastructure/team-repository";
import {ServiceCatalogAccessError,ServiceCatalogConflictError} from "@/modules/services/domain/service-catalog";
import type {z} from "zod";
import type {serviceCatalogProviderSchema} from "@/platform/config/service-catalog-policy";

type Reference=z.infer<typeof serviceCatalogProviderSchema>;
export async function nativeServiceCatalogActor(actor:AccountActorContext,tx:TenantTransaction){
 const[account]=await new TeamRepository(tx,actor.organizationId).onboardingTeamAccountHeads([actor.actorId]);
 if(!account?.personId||account.status!=="ACTIVE"||actor.authContext.personId!==undefined&&actor.authContext.personId!==account.personId)throw new ServiceCatalogAccessError();
 return{...actor,personId:account.personId};
}
/** Cross-module provider reads retain the canonical tenant repositories and
 * actual team memberships. A catalog property never fabricates a person's scope. */
export async function nativeServiceCatalogProviders(actor:AccountActorContext,tx:TenantTransaction,references:readonly Reference[],stored:AuthContext,now:Date){
 const supplierIds=[...new Set(references.filter(row=>row.kind==="SUPPLIER").map(row=>row.id))],personIds=[...new Set(references.filter(row=>row.kind==="PERSON").map(row=>row.id))],suppliers=new SupplierRepository(tx,actor.organizationId),team=new TeamRepository(tx,actor.organizationId),[supplierHeads,people,scopes]=await Promise.all([suppliers.sourceHeads(supplierIds),team.onboardingTeamPersonHeads(personIds),team.onboardingTeamPersonScopes(personIds,now)]);
 if(supplierHeads.length!==supplierIds.length||people.length!==personIds.length||supplierHeads.some(row=>row.archivedAt)||people.some(row=>row.archivedAt))throw new ServiceCatalogAccessError();
 const checks:CurrentAuthorityCheck[]=supplierHeads.map(row=>({action:"view",organizationOnly:true,resource:{type:"supplier",organizationId:actor.organizationId,id:row.id,dataClass:"personal",occurredAt:row.createdAt}}));
 for(const person of people){const base:Resource={type:"team_member",organizationId:actor.organizationId,id:person.id,assignedPersonId:person.id,dataClass:"personal"},candidates=[base,...scopes.filter(row=>row.personId===person.id).map(row=>({...base,propertyId:row.propertyId,city:row.city,region:row.region,jobId:row.jobId}))],permitted=candidates.find(resource=>[actor.authContext,stored].every(context=>authorize(context,"view",resource,now)));if(!permitted)throw new ServiceCatalogAccessError();checks.push({action:"view",resource:permitted});}
 assertAccountAuthorization(actor,stored,now,checks,new ServiceCatalogAccessError());
 const[supplierLabels,personLabels]=await Promise.all([supplierIds.length?suppliers.sourceLabels(supplierIds):[],personIds.length?team.onboardingTeamPersonRows(personIds):[]]);
 if(supplierLabels.length!==supplierIds.length||personLabels.length!==personIds.length)throw new ServiceCatalogConflictError();const labels=new Map([...supplierLabels.map(row=>["SUPPLIER:"+row.id,row.displayName]as const),...personLabels.map(row=>["PERSON:"+row.id,row.displayName]as const)]);
 return{items:references.map(row=>({...row,label:labels.get(row.kind+":"+row.id)!})),fingerprint:commandFingerprint({supplierHeads,people,scopes,labels:[...labels].sort(([left],[right])=>left.localeCompare(right))}),checks};
}
