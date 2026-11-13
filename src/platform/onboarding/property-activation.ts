import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {CoreAuthorizationError,CoreNotFoundError,CoreValidationError} from "@/modules/core/application/core-access";
import {OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError} from "@/modules/onboarding/domain/onboarding-wizard";

/** Core retains lifecycle readiness, agreement checks and audit ownership inside the caller's transaction. */
export async function activateNativeOnboardingProperty(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,beforeStatus:string,reason:string,requestId:string){
 try{const {transitionPropertyLifecycle}=await import("@/modules/core/application/core-service"),dependencies={db:{$transaction:<T>(work:(tx:TenantTransaction)=>Promise<T>)=>work(tx)},requestId};if(beforeStatus==="DRAFT")await transitionPropertyLifecycle(actor,{propertyId,status:"ONBOARDING",reason},dependencies);return await transitionPropertyLifecycle(actor,{propertyId,status:"ACTIVE",reason},dependencies);}
 catch(error){if(error instanceof CoreAuthorizationError)throw new OnboardingAccessError();if(error instanceof CoreNotFoundError)throw new OnboardingConflictError();if(error instanceof CoreValidationError)throw new OnboardingConfigurationError();throw error;}
}
