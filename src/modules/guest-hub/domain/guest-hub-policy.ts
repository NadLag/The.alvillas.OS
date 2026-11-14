import {z} from "zod";
import {reservationStateSchema} from "@/modules/reservations/domain/reservation";
import {localClockInstant} from "@/platform/time/local-instant";

export const guestHubLinkPolicyKey="guest_hub.links";
export const guestHubVerificationPolicyKey="guest_hub.verification";
export const guestHubMaximumRequestBytes=8192;
export const guestHubTokenEntropyBytes=32;
const rate=z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict();
const approval=z.string().trim().min(1).max(1000).refine(value=>!/[\p{Cc}]/u.test(value));

/** The trusted server organization owns the pre-signature abuse budget; unverified claims never select it. */
export const guestHubVerificationPolicySchema=z.object({source:z.literal("NATIVE_GUEST_CAPABILITY_VERIFICATION"),enabled:z.boolean(),checks:rate,clients:rate}).strict();
export type GuestHubVerificationPolicy=z.infer<typeof guestHubVerificationPolicySchema>;

/** Security format is fixed; business schedules, eligibility and budgets come from config_rule. */
export const guestHubLinkPolicySchema=z.object({
 source:z.literal("NATIVE_RESERVATION_GUEST_LINKS"),enabled:z.boolean(),
 signature:z.literal("PURPOSE_BOUND_VERSIONED_KEY_RING"),history:z.literal("APPEND_ONLY_GUEST_LINK_HISTORY"),
 checkout_local_time:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
 checkout_grace_seconds:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 allowed_reservation_states:z.array(reservationStateSchema).min(1).max(reservationStateSchema.options.length).refine(values=>new Set(values).size===values.length),
 processing_approval_reference:approval.nullable(),issuance:rate,reads:rate
}).strict().superRefine((value,context)=>{
 if(value.enabled&&!value.processing_approval_reference)context.addIssue({code:"custom",path:["processing_approval_reference"],message:"explicit_guest_processing_approval_required"});
});
export type GuestHubLinkPolicy=z.infer<typeof guestHubLinkPolicySchema>;
export class GuestHubConfigurationError extends Error{constructor(){super("guest_hub_configuration_unavailable");}}
export class GuestHubAccessError extends Error{constructor(){super("guest_hub_access_denied");}}
export class GuestHubConflictError extends Error{constructor(){super("guest_hub_source_changed");}}
export class GuestHubInvalidLinkError extends Error{constructor(){super("guest_hub_link_unavailable");}}
export class GuestHubRateLimitError extends Error{constructor(){super("guest_hub_rate_limit_exceeded");}}

/** Reservation checkout is a property calendar day; an explicit policy supplies its local clock. */
export function configuredGuestHubExpiry(raw:unknown,checkoutDay:string,propertyTimezone:string):Date{
 const policy=guestHubLinkPolicySchema.parse(raw);
 try{
  z.iso.date().parse(checkoutDay);
  const instant=localClockInstant(checkoutDay+"T"+policy.checkout_local_time+":00",propertyTimezone),milliseconds=new Date(instant).getTime()+policy.checkout_grace_seconds*1000;
  if(!Number.isSafeInteger(milliseconds)||!Number.isFinite(new Date(milliseconds).getTime()))throw new GuestHubConfigurationError();
  return new Date(milliseconds);
 }catch{throw new GuestHubConfigurationError();}
}

export type GuestHubLinkState="ACTIVE"|"EXPIRED"|"REVOKED"|"BLOCKED";
export function effectiveGuestHubExpiry(policy:GuestHubLinkPolicy,recordedExpiresAt:Date,currentCheckoutDay:string,propertyTimezone:string):Date{
 if(!Number.isFinite(recordedExpiresAt.getTime()))throw new GuestHubConfigurationError();
 return new Date(Math.min(recordedExpiresAt.getTime(),configuredGuestHubExpiry(policy,currentCheckoutDay,propertyTimezone).getTime()));
}
/** Inputs are protected server metadata, never public claims of eligibility or completion. */
export function guestHubLinkState(input:{policy:GuestHubLinkPolicy;issuedAt:Date;recordedExpiresAt:Date;currentCheckoutDay:string;propertyTimezone:string;now:Date;revoked:boolean;reservationStatus:string;sourceAvailable:boolean;guestSourceMatches:boolean}):GuestHubLinkState{
 const policy=guestHubLinkPolicySchema.parse(input.policy),times=[input.issuedAt,input.recordedExpiresAt,input.now];
 if(times.some(value=>!Number.isFinite(value.getTime()))||input.recordedExpiresAt<=input.issuedAt)throw new GuestHubConfigurationError();
 if(input.revoked)return"REVOKED";
 const expiry=effectiveGuestHubExpiry(policy,input.recordedExpiresAt,input.currentCheckoutDay,input.propertyTimezone).getTime();
 if(input.now.getTime()>=expiry)return"EXPIRED";
 if(input.now<input.issuedAt||!policy.enabled||!policy.processing_approval_reference||!input.sourceAvailable||!input.guestSourceMatches||!policy.allowed_reservation_states.some(state=>state===input.reservationStatus))return"BLOCKED";
 return"ACTIVE";
}
