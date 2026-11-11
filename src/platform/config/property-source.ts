import type {TenantTransaction} from "@/platform/db/tenant";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";

/** Configuration authority uses the same actual, value-free physical source as Core. */
export async function configurationPropertyHead(tx:TenantTransaction,organizationId:string,propertyId:string){return(await new CoreRepository(tx,organizationId).onboardingPropertyHeads([propertyId]))[0]??null;}
export const configurationSourceClock=(tx:TenantTransaction,organizationId:string)=>new CoreRepository(tx,organizationId).clock();
