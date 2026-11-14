import type {Action,Resource} from "@/platform/authz/authorize";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {GuestHubNativeSource} from "../infrastructure/guest-hub-repository";
import {GuestHubAccessError} from "../domain/guest-hub-policy";

export function guestHubResource(organizationId:string,source:GuestHubNativeSource,id?:string):Resource{
 return{type:"guest_hub",id,organizationId,dataClass:"guest",propertyId:source.propertyId,reservationId:source.reservationId,
  city:source.cityId??source.city,region:source.regionId??source.region,status:source.reservationStatus,occurredAt:source.reservationCreatedAt};
}
/** Link management never replaces independent permission to view the actual reservation and guest. */
export async function requireGuestHubStaffAuthority(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,action:Action,now:Date,linkId?:string){
 const target=guestHubResource(actor.organizationId,source,linkId);
 await recheckAccountAuthorization(actor,tx,now,[{action,resource:target},{action:"view",resource:target},
  {action:"view",resource:{...target,type:"reservation",id:source.reservationId}},
  {action:"view",resource:{...target,type:"guest",id:source.guestId,occurredAt:source.guestCreatedAt}}],new GuestHubAccessError());
 return target;
}
