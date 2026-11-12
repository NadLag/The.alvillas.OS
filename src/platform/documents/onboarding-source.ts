import type {TenantTransaction} from "@/platform/db/tenant";
import {OnboardingDocumentSourceRepository,type OnboardingDocumentSourceHead} from "@/modules/onboarding/infrastructure/onboarding-document-source-repository";
export type {OnboardingDocumentSourceHead};


/** Metadata alone selects document ownership; package values require their separate full source authority. */
export async function nativeOnboardingDocumentSources(tx:TenantTransaction,organizationId:string,ids:readonly string[]){return new Map((await new OnboardingDocumentSourceRepository(tx,organizationId).heads(ids)).map(row=>[row.id,row]));}
export function nativeOnboardingDocumentChoices(tx:TenantTransaction,organizationId:string,query:string,before:string|undefined,take:number){return new OnboardingDocumentSourceRepository(tx,organizationId).candidates(query,before,take);}
export function nativeOnboardingDocumentSource(head:OnboardingDocumentSourceHead){
 const {propertyName,...snapshot}=head,resource={organizationId:head.organizationId,type:"owner",id:head.ownerId,ownerId:head.ownerId,propertyId:head.propertyId,city:head.cityId,region:head.regionId,status:head.propertyStatus,dataClass:"personal"as const};
 return{resource,snapshot,label:propertyName+" · "+head.number,archived:Boolean(head.ownerArchivedAt||head.propertyArchivedAt),checks:[{action:"view"as const,resource:{...resource,type:"property",id:head.propertyId,dataClass:"operational"as const}}]};
}
