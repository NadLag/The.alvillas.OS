import { Temporal } from "temporal-polyfill";
import { requireCurrentTimezoneData } from "./timezone-data";

/** Financial local inputs use the server's current IANA data, independently of browser data. */
export function localClockInstant(value:string,timezone:string,occurrence:"reject"|"earlier"|"later"="reject"):string{
  requireCurrentTimezoneData();
  const local=Temporal.PlainDateTime.from(value),early=local.toZonedDateTime(timezone,{disambiguation:"earlier"}),late=local.toZonedDateTime(timezone,{disambiguation:"later"});
  if(!early.toPlainDateTime().equals(local)||!late.toPlainDateTime().equals(local))throw new RangeError("Local time does not exist in this timezone");
  if(early.epochMilliseconds!==late.epochMilliseconds&&occurrence==="reject")throw new RangeError("Choose the occurrence of a repeated local time");
  return(occurrence==="later"?late:early).toInstant().toString();
}
export function localClockLabel(instant:string,timezone:string):string{
  requireCurrentTimezoneData();
  return Temporal.Instant.from(instant).toZonedDateTimeISO(timezone).toPlainDateTime().toString({smallestUnit:"second"});
}
