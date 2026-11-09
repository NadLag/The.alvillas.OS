import type {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import {onboardingOwnerInputSchema} from "./contracts";
export {nativeOwnerIdentityProjection,nativeLeadOwnerHead as nativeOnboardingOwnerHead,lockNativeLeadOwner as lockNativeOnboardingOwner,nativeLeadOwnerIdentity as nativeOnboardingOwnerIdentity,nativeLeadOwnerChoices as nativeOnboardingOwnerChoices,nativeLeadOwnerIdentityRows as nativeOnboardingOwnerIdentityRows} from "@/platform/crm/lead-owner-source";

export function nativeOnboardingOwnerWitness(tx:TenantTransaction,organizationId:string,ownerId:string,includeArchived=false){return new CoreRepository(tx,organizationId).ownerIdentitySourceWitness(ownerId,includeArchived);}
export async function createNativeOnboardingOwner(actor:AccountActorContext,tx:TenantTransaction,input:z.infer<typeof onboardingOwnerInputSchema>,requestId:string){
 const{createOwner}=await import("@/modules/core/application/core-service"),owner=await createOwner(actor,{...onboardingOwnerInputSchema.parse(input),representatives:[],payoutMethods:[]},{db:{$transaction:work=>work(tx)},requestId});
 const identity=await new CoreRepository(tx,actor.organizationId).findOwnerIdentity(owner.id);if(!identity)throw Error("native_onboarding_owner_unavailable");return identity;
}
