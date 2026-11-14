import {z} from "zod";
import {guestHubFormBudgetSchema,guestHubFormNoticeSchema,guestHubFormReferenceSchema,retainsGuestHubFormPurpose,intersectGuestHubFormFields} from "./guest-hub-form-policy";

export const guestHubStayDetailsPolicyKey="guest_hub.stay_details";
export const guestHubStayDetailsFieldSchema=z.enum(["arrival","departure","arrivalMethod","arrivalReference","departureMethod","departureReference"]);
export type GuestHubStayDetailsField=z.infer<typeof guestHubStayDetailsFieldSchema>;
export const guestHubStayTravelMethodSchema=z.enum(["AIR","RAIL","ROAD","SEA","OTHER"]);
const integer=z.number().int().min(-2147483648).max(2147483647),window=z.object({earliest_day_offset:integer,latest_day_offset:integer}).strict().refine(value=>value.earliest_day_offset<=value.latest_day_offset),fields=z.array(guestHubStayDetailsFieldSchema).max(6).refine(value=>new Set(value).size===value.length);
export const guestHubStayDetailsPolicySchema=z.object({source:z.literal("NATIVE_RESERVATION_GUEST_STAY_DETAILS"),history:z.literal("APPEND_ONLY_RESERVATION_STAY_DETAILS"),enabled:z.boolean(),processing_approval_reference:guestHubFormReferenceSchema.nullable(),notice:guestHubFormNoticeSchema.nullable(),require_acknowledgement:z.boolean(),allowed_fields:fields.min(1),required_fields:fields,allowed_methods:z.array(guestHubStayTravelMethodSchema).min(1).max(5).refine(value=>new Set(value).size===value.length),date_windows:z.object({arrival:window,departure:window}).strict(),submissions:guestHubFormBudgetSchema}).strict().superRefine((value,context)=>{
 if(value.enabled&&(!value.processing_approval_reference||!value.notice))context.addIssue({code:"custom",path:["processing_approval_reference"],message:"explicit_stay_details_processing_and_notice_required"});
 if(value.required_fields.some(field=>!value.allowed_fields.includes(field)))context.addIssue({code:"custom",path:["required_fields"],message:"required_stay_fields_must_be_explicitly_allowed"});
});
export type GuestHubStayDetailsPolicy=z.infer<typeof guestHubStayDetailsPolicySchema>;
export const guestHubStayClockSchema=z.object({local:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u),occurrence:z.enum(["reject","earlier","later"])}).strict();
const reference=z.preprocess(value=>typeof value==="string"&&!value.trim()?null:value,z.string().trim().min(1).max(240).refine(value=>!/[\p{Cc}]/u.test(value)).nullable()).optional();
export const guestHubStayDetailsValuesSchema=z.object({arrival:guestHubStayClockSchema.nullable().optional(),departure:guestHubStayClockSchema.nullable().optional(),arrivalMethod:guestHubStayTravelMethodSchema.nullable().optional(),arrivalReference:reference,departureMethod:guestHubStayTravelMethodSchema.nullable().optional(),departureReference:reference}).strict();
export type GuestHubStayDetailsValues=z.infer<typeof guestHubStayDetailsValuesSchema>;
export class GuestHubStayDetailsAccessError extends Error{constructor(){super("guest_stay_details_access_unavailable");}}
export class GuestHubStayDetailsConflictError extends Error{constructor(){super("guest_stay_details_review_changed");}}
export class GuestHubStayDetailsConfigurationError extends Error{constructor(){super("guest_stay_details_configuration_unavailable");}}
export type GuestHubStayDetailsIssue="required"|"not_allowed"|"outside_window"|"occurrence_required"|"nonexistent_time"|"invalid_time"|"chronology"|"method_unavailable";
export class GuestHubStayDetailsValidationError extends Error{readonly fields:Readonly<Partial<Record<GuestHubStayDetailsField|"acknowledged",GuestHubStayDetailsIssue>>>;constructor(fields:Partial<Record<GuestHubStayDetailsField|"acknowledged",GuestHubStayDetailsIssue>>){super("guest_stay_details_validation");this.fields=Object.freeze({...fields});}}
export function effectiveGuestHubStayDetailsPolicy(captured:GuestHubStayDetailsPolicy,current:GuestHubStayDetailsPolicy){
 const original=guestHubStayDetailsPolicySchema.parse(captured),latest=guestHubStayDetailsPolicySchema.parse(current),fields=intersectGuestHubFormFields(original,latest);if(!retainsGuestHubFormPurpose(original,latest)||!latest.notice||!fields)throw new GuestHubStayDetailsAccessError();
 const methods=original.allowed_methods.filter(method=>latest.allowed_methods.includes(method)),dateWindows={arrival:{earliest_day_offset:Math.max(original.date_windows.arrival.earliest_day_offset,latest.date_windows.arrival.earliest_day_offset),latest_day_offset:Math.min(original.date_windows.arrival.latest_day_offset,latest.date_windows.arrival.latest_day_offset)},departure:{earliest_day_offset:Math.max(original.date_windows.departure.earliest_day_offset,latest.date_windows.departure.earliest_day_offset),latest_day_offset:Math.min(original.date_windows.departure.latest_day_offset,latest.date_windows.departure.latest_day_offset)}};
 if((fields.allowed.includes("arrivalMethod")||fields.allowed.includes("departureMethod"))&&!methods.length||(["arrival","departure"] as const).some(field=>fields.allowed.includes(field)&&dateWindows[field].earliest_day_offset>dateWindows[field].latest_day_offset))throw new GuestHubStayDetailsAccessError();
 return{...fields,methods,dateWindows,notice:latest.notice,requireAcknowledgement:original.require_acknowledgement||latest.require_acknowledgement,limits:[original.submissions,latest.submissions]};
}
