import {z} from "zod";
import {localClockLabel} from "@/platform/time/local-instant";
import { guestHubPropertyInformationSchema } from "./guest-hub-property-information";

export const guestHubPresentationPolicyKey="guest_hub.presentation";
function publicOrigin(value:string){
 const url=new URL(value),host=url.hostname;
 if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash||url.pathname!=="/"||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(host)||/^[\d.]+$/u.test(host)||/(?:^|\.)(?:localhost|local|internal|invalid)$/iu.test(host))throw Error("explicit_public_image_origin_required");
 return url.origin;
}
export const guestHubPresentationPolicySchema=z.object({source:z.literal("NATIVE_GUEST_STAY_PRESENTATION"),public_image_origins:z.array(z.string().max(500).refine(value=>{try{publicOrigin(value);return true;}catch{return false;}})).max(30)}).strict().superRefine((value,context)=>{const normalized:string[]=[];for(const origin of value.public_image_origins){try{normalized.push(publicOrigin(origin));}catch{/* The origin validator already records this invalid entry. */}}if(new Set(normalized).size!==normalized.length)context.addIssue({code:"custom",path:["public_image_origins"],message:"distinct_public_image_origins_required"});});
export type GuestHubPresentationPolicy=z.infer<typeof guestHubPresentationPolicySchema>;
function publicImageURL(value:string){const url=new URL(value);publicOrigin(url.origin);if(url.username||url.password||url.search||url.hash||!/\.(?:avif|jpe?g|png|webp)$/iu.test(url.pathname))throw Error("public_property_image_required");return url;}
export const guestHubHomeSchema=z.object({propertyName:z.string().trim().min(1).max(2000),photoUrl:z.url().max(2000).refine(value=>{try{publicImageURL(value);return true;}catch{return false;}}).nullable(),adultCount:z.number().int().nonnegative(),childCount:z.number().int().nonnegative(),checkedAt:z.iso.datetime(),calendarStage:z.enum(["UPCOMING","ARRIVAL_DAY","STAY_DAYS","DEPARTURE_DAY","PAST"]),profileAvailable:z.literal(true).optional(),stayDetailsAvailable:z.literal(true).optional(),identityDocumentsAvailable:z.literal(true).optional(),houseRulesAvailable:z.literal(true).optional(),agreementAvailable:z.literal(true).optional(),propertyInformation:guestHubPropertyInformationSchema.optional()}).strict();

/** Original private/signed URLs never become public merely because a property contains them. */
export function guestHubPublicPhoto(raw:unknown,policy:GuestHubPresentationPolicy|null){
 if(!policy||!Array.isArray(raw))return null;const origins=new Set(policy.public_image_origins.map(publicOrigin));
 for(const candidate of raw.slice(0,30)){if(typeof candidate!=="string"||candidate.length>2000)continue;try{const url=publicImageURL(candidate);if(!origins.has(url.origin))continue;return url.href;}catch{/* Unsafe or unapproved property media is omitted. */}}
 return null;
}

/** Calendar presentation reports dates; it never asserts form completion or operational check-in. */
export function guestHubCalendarStage(checkIn:string,checkOut:string,timezone:string,now:Date){
 z.iso.date().parse(checkIn);z.iso.date().parse(checkOut);if(checkOut<=checkIn)throw Error("actual_guest_stay_interval_required");
 const today=localClockLabel(now.toISOString(),timezone).slice(0,10);
 return today<checkIn?"UPCOMING":today===checkIn?"ARRIVAL_DAY":today<checkOut?"STAY_DAYS":today===checkOut?"DEPARTURE_DAY":"PAST";
}
