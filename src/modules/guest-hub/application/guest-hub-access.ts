import type {Action,Resource} from "@/platform/authz/authorize";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {recheckAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {GuestHubLink} from "@prisma/client";
import type {GuestHubNativeSource,GuestHubRepository} from "../infrastructure/guest-hub-repository";
import {GuestHubAccessError} from "../domain/guest-hub-policy";

export type GuestHubLinkTarget={id:string;propertyId:string;createdAt:Date;city:string;region:string};
export async function guestHubLinkTarget(repository:GuestHubRepository,row:Pick<GuestHubLink,"id"|"propertyId"|"createdAt">,source:GuestHubNativeSource):Promise<GuestHubLinkTarget>{
 const property=row.propertyId===source.propertyId?source:await repository.propertyDimensions(row.propertyId);if(!property)throw new GuestHubAccessError();
 return{id:row.id,propertyId:row.propertyId,createdAt:row.createdAt,city:property.cityId??property.city,region:property.regionId??property.region};
}
export function guestHubResource(organizationId:string,source:GuestHubNativeSource,target?:GuestHubLinkTarget):Resource{
 return{type:"guest_hub",id:target?.id,organizationId,dataClass:"guest",propertyId:target?.propertyId??source.propertyId,reservationId:source.reservationId,
  city:target?.city??source.cityId??source.city,region:target?.region??source.regionId??source.region,status:source.reservationStatus,occurredAt:target?.createdAt??source.reservationCreatedAt};
}
export function guestHubSourceChecks(organizationId:string,source:GuestHubNativeSource):CurrentAuthorityCheck[]{
 const target=guestHubResource(organizationId,source);
 return[{action:"view",resource:{...target,type:"reservation",id:source.reservationId,occurredAt:source.reservationCreatedAt}},
  {action:"view",resource:{...target,type:"guest",id:source.guestId,occurredAt:source.guestCreatedAt}}];
}
/** Link management never replaces independent permission to view the actual reservation and guest. */
export async function requireGuestHubStaffAuthority(actor:AccountActorContext,tx:TenantTransaction,source:GuestHubNativeSource,action:Action,now:Date,link?:GuestHubLinkTarget){
 const target={...guestHubResource(actor.organizationId,source,link),...!link?{occurredAt:now}:{}};
 await recheckAccountAuthorization(actor,tx,now,[{action,resource:target},{action:"view",resource:target},
  ...guestHubSourceChecks(actor.organizationId,source)],new GuestHubAccessError());
 return target;
}
