import {Temporal} from "temporal-polyfill";
import {localClockInstant,localClockLabel} from "@/platform/time/local-instant";
import {guestHubStayDetailsValuesSchema,guestHubStayDetailsFieldSchema,GuestHubStayDetailsValidationError,GuestHubStayDetailsConfigurationError,type GuestHubStayDetailsValues,type effectiveGuestHubStayDetailsPolicy,type GuestHubStayDetailsIssue,type GuestHubStayDetailsField} from "./guest-hub-stay-details-policy";

export type GuestHubStayCalendar={checkIn:string;checkOut:string;timezone:string};
type EffectivePolicy=ReturnType<typeof effectiveGuestHubStayDetailsPolicy>;
export function guestHubStayDetailsWindows(source:GuestHubStayCalendar,policy:EffectivePolicy){
 try{localClockLabel("2000-01-01T00:00:00Z",source.timezone);const arrival=Temporal.PlainDate.from(source.checkIn),departure=Temporal.PlainDate.from(source.checkOut);if(Temporal.PlainDate.compare(arrival,departure)>=0)throw new GuestHubStayDetailsConfigurationError();return{arrival:{earliest:arrival.add({days:policy.dateWindows.arrival.earliest_day_offset}).toString(),latest:arrival.add({days:policy.dateWindows.arrival.latest_day_offset}).toString()},departure:{earliest:departure.add({days:policy.dateWindows.departure.earliest_day_offset}).toString(),latest:departure.add({days:policy.dateWindows.departure.latest_day_offset}).toString()}};}catch{throw new GuestHubStayDetailsConfigurationError();}
}
/** Planned property-local times never alter canonical booking dates or assert operational check-in. */
export function resolveGuestHubStayDetails(raw:unknown,source:GuestHubStayCalendar,policy:EffectivePolicy,acknowledged:boolean){
 const values=guestHubStayDetailsValuesSchema.parse(raw),issues:Partial<Record<GuestHubStayDetailsField|"acknowledged",GuestHubStayDetailsIssue>>={},windows=guestHubStayDetailsWindows(source,policy),resolved:{arrival:string|null;departure:string|null}={arrival:null,departure:null};
 for(const field of Object.keys(values)){const known=guestHubStayDetailsFieldSchema.parse(field);if(!policy.allowed.includes(known))issues[known]="not_allowed";}
 for(const field of policy.required)if(values[field]==null)issues[field]="required";if(policy.requireAcknowledgement&&!acknowledged)issues.acknowledged="required";
 for(const field of["arrivalMethod","departureMethod"]as const)if(values[field]!=null&&!policy.methods.includes(values[field]))issues[field]="method_unavailable";
 for(const field of["arrival","departure"]as const){const input=values[field];if(!input||issues[field])continue;let local:Temporal.PlainDateTime;try{local=Temporal.PlainDateTime.from(input.local,{overflow:"reject"});}catch{issues[field]="invalid_time";continue;}const day=local.toPlainDate();if(Temporal.PlainDate.compare(day,windows[field].earliest)<0||Temporal.PlainDate.compare(day,windows[field].latest)>0){issues[field]="outside_window";continue;}
  const canonical=local.toString({smallestUnit:"second"});let earlier:string,later:string;try{earlier=localClockInstant(canonical,source.timezone,"earlier");later=localClockInstant(canonical,source.timezone,"later");}catch(error){if(error instanceof RangeError){issues[field]="nonexistent_time";continue;}throw new GuestHubStayDetailsConfigurationError();}
  if(earlier!==later&&input.occurrence==="reject"){issues[field]="occurrence_required";continue;}values[field]={local:canonical,occurrence:earlier===later?"reject":input.occurrence};resolved[field]=input.occurrence==="later"?later:earlier;
 }
 if(resolved.arrival&&resolved.departure&&Temporal.Instant.compare(resolved.departure,resolved.arrival)<=0)issues.departure="chronology";
 if(Object.keys(issues).length)throw new GuestHubStayDetailsValidationError(issues);return{values,resolved,timezone:source.timezone};
}
export function presentGuestHubStayDetails(values:GuestHubStayDetailsValues|null,policy:EffectivePolicy){const parsed=values?guestHubStayDetailsValuesSchema.parse(values):{},result:GuestHubStayDetailsValues={};for(const field of policy.allowed){if(Object.hasOwn(parsed,field)){if((field==="arrivalMethod"||field==="departureMethod")&&parsed[field]!=null&&!policy.methods.includes(parsed[field]))result[field]=null;else Object.assign(result,{[field]:parsed[field]});}else Object.assign(result,{[field]:null});}return guestHubStayDetailsValuesSchema.parse(result);}
