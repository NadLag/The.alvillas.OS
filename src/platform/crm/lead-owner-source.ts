import {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import {ownerInputSchema} from "@/modules/core/domain/owner-property";
import type {LeadCaptureInput} from "@/modules/crm/domain/lead-capture";
import {LeadConversionSourceError} from "@/modules/crm/domain/lead-conversion";

/** The existing Core schema is the authority for Owner fields; no silent shortening or invented identity. */
export function nativeLeadOwnerInput(source:Pick<LeadCaptureInput,"fields"|"locale">){
 const result=ownerInputSchema.safeParse({displayName:source.fields.ownerContact,email:source.fields.email,phone:source.fields.phone,preferredLocale:source.locale,representatives:[],payoutMethods:[]});
 if(!result.success)throw new LeadConversionSourceError();return result.data;
}
export async function createNativeLeadOwner(actor:AccountActorContext,tx:TenantTransaction,source:Pick<LeadCaptureInput,"fields"|"locale">,requestId:string){
 const {createOwner}=await import("@/modules/core/application/core-service");
 const owner=await createOwner(actor,nativeLeadOwnerInput(source),{db:{$transaction:work=>work(tx)},requestId});
 const identity=await new CoreRepository(tx,actor.organizationId).findOwnerIdentity(owner.id);if(!identity)throw new LeadConversionSourceError();return identity;
}
export function nativeOwnerIdentityProjection(owner:{displayName:string;email:string|null;phone:string|null;preferredLocale:string}){
 return{displayName:owner.displayName,email:owner.email,phone:owner.phone,preferredLocale:z.enum(["en","fr","ar"]).parse(owner.preferredLocale)};
}
export function nativeLeadOwnerHead(tx:TenantTransaction,organizationId:string,ownerId:string,includeArchived=false){return new CoreRepository(tx,organizationId).findOwnerIdentityHead(ownerId,includeArchived);}
export function lockNativeLeadOwner(tx:TenantTransaction,organizationId:string,ownerId:string){return new CoreRepository(tx,organizationId).lockOwnerIdentity(ownerId);}
export function nativeLeadOwnerIdentity(tx:TenantTransaction,organizationId:string,ownerId:string){return new CoreRepository(tx,organizationId).findOwnerIdentity(ownerId);}
export function nativeLeadOwnerChoices(tx:TenantTransaction,organizationId:string,query:string,after:string|undefined,asOf:Date){return new CoreRepository(tx,organizationId).ownerIdentityPage(query,after,asOf);}
export function nativeLeadOwnerIdentityRows(tx:TenantTransaction,organizationId:string,ids:readonly string[]){return new CoreRepository(tx,organizationId).ownerIdentityRows(ids);}
