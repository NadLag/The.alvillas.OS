import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import {bookingChannelInputSchema} from "@/modules/core/domain/owner-property";
import {onboardingBookingChannelsTargetSchema,onboardingBookingChannelsSnapshotSchema} from "@/modules/onboarding/domain/onboarding-booking-channels";
export {CoreAuthorizationError as NativeOnboardingBookingChannelAuthorizationError,CoreNotFoundError as NativeOnboardingBookingChannelNotFoundError,CoreValidationError as NativeOnboardingBookingChannelValidationError} from "@/modules/core/application/core-service";

/** Internal metadata boundary. Parent/source authorization belongs to the native application. */
export const nativeOnboardingBookingChannelHeads=(tx:TenantTransaction,organizationId:string,propertyId:string,selection:{ids:readonly string[]}|{sourceKeys:readonly string[]},includeArchived=false)=>new CoreRepository(tx,organizationId).onboardingBookingChannelHeads(propertyId,selection,includeArchived);
export const nativeOnboardingBookingChannelRows=(tx:TenantTransaction,organizationId:string,propertyId:string,ids:readonly string[],includeArchived=false)=>new CoreRepository(tx,organizationId).onboardingBookingChannelRows(propertyId,ids,includeArchived);
export const nativeOnboardingBookingChannelPage=(tx:TenantTransaction,organizationId:string,propertyId:string,query:string,after:string|undefined,asOf:Date)=>new CoreRepository(tx,organizationId).onboardingBookingChannelPage(propertyId,query,after,asOf);
export const nativeOnboardingBookingChannelPins=(rows:Awaited<ReturnType<typeof nativeOnboardingBookingChannelHeads>>)=>rows.map(({id,propertyId,rowVersion,tuple})=>({id,propertyId,rowVersion,tuple}));
export function nativeOnboardingBookingChannelProjection(propertyId:string,rows:Awaited<ReturnType<typeof nativeOnboardingBookingChannelRows>>){return onboardingBookingChannelsSnapshotSchema.parse({propertyId,channels:rows.map(row=>({...row,createdAt:row.createdAt.toISOString(),archivedAt:row.archivedAt?.toISOString()??null}))});}

/** The sole Core writer remains inside the caller's transaction; every batch effect rolls back together. */
export async function configureNativeOnboardingBookingChannels(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown,requestId:string){
 const target=onboardingBookingChannelsTargetSchema.parse(raw);if(target.mode!=="CONFIGURE"||target.propertyId!==propertyId)throw Error("native_onboarding_booking_channels_configuration_required");
 await new CoreRepository(tx,actor.organizationId).lockOnboardingProperty(propertyId);
 const {upsertPropertyBookingChannel}=await import("@/modules/core/application/core-service"),ids:string[]=[];
 for(const input of target.channels){const result=await upsertPropertyBookingChannel(actor,bookingChannelInputSchema.parse({...input,propertyId,externalListingId:input.externalListingId??undefined,listingUrl:input.listingUrl??undefined,syncEndpointUrl:input.syncEndpointUrl??undefined}),{db:{$transaction:work=>work(tx)},requestId});ids.push(result.id);}
 return ids;
}
