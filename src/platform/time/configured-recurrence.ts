import {z} from "zod";
import {Temporal} from "temporal-polyfill";

const interval=z.number().int().min(1).max(3660);
export const civilRecurrenceSchema=z.object({
 start_on:z.iso.date(),end_on:z.iso.date().nullable(),run_at:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
 cadence:z.discriminatedUnion("kind",[
  z.object({kind:z.literal("DAY"),every:interval}).strict(),
  z.object({kind:z.literal("WEEK"),every:interval,weekdays:z.array(z.number().int().min(1).max(7)).min(1).max(7).refine(days=>new Set(days).size===days.length)}).strict(),
  z.object({kind:z.literal("MONTH"),every:interval,day:z.number().int().min(1).max(31),missing_day:z.enum(["SKIP","LAST_DAY"])}).strict()
 ]),
}).strict().refine(value=>value.end_on===null||value.end_on>=value.start_on,{message:"End date precedes the first occurrence"});
export type CivilRecurrence=z.infer<typeof civilRecurrenceSchema>;

/** ISO civil dates stay anchored to the configured start, including after missed polling ticks. */
export function nextCivilRecurrenceDate(schedule:CivilRecurrence,after:string|null):string|null{
 const start=Temporal.PlainDate.from(schedule.start_on),lower=after&&after>=schedule.start_on?Temporal.PlainDate.from(after).add({days:1}):start,cadence=schedule.cadence;
 let candidate:Temporal.PlainDate|null=null;
 if(cadence.kind==="DAY")candidate=start.add({days:Math.ceil(start.until(lower,{largestUnit:"days"}).days/cadence.every)*cadence.every});
 else if(cadence.kind==="WEEK"){
  const monday=start.subtract({days:start.dayOfWeek-1}),weeks=Math.floor(monday.until(lower,{largestUnit:"days"}).days/7),first=Math.floor(weeks/cadence.every)*cadence.every;
  for(const week of[first,first+cadence.every]){
   for(const weekday of[...cadence.weekdays].sort((a,b)=>a-b)){const day=monday.add({weeks:week,days:weekday-1});if(Temporal.PlainDate.compare(day,lower)>=0){candidate=day;break;}}
   if(candidate)break;
  }
 }else{
  const anchor=start.with({day:1}),months=(lower.year-start.year)*12+lower.month-start.month,first=Math.floor(months/cadence.every)*cadence.every;
  // A Gregorian calendar repeats after 4,800 months. Impossible explicit dates have no occurrence.
  for(let step=0;step<=4800;step++){
   const month=anchor.add({months:first+step*cadence.every});if(month.year>9999||schedule.end_on&&month.toString()>schedule.end_on)break;
   if(cadence.day>month.daysInMonth&&cadence.missing_day==="SKIP")continue;
   const day=month.with({day:Math.min(cadence.day,month.daysInMonth)});if(Temporal.PlainDate.compare(day,lower)>=0){candidate=day;break;}
  }
 }
 if(!candidate||candidate.year>9999)return null;const on=candidate.toString();return schedule.end_on&&on>schedule.end_on?null:on;
}

export function civilRecurrenceDue(on:string,schedule:CivilRecurrence,now:Date,timezone:string){
 const local=Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timezone),today=local.toPlainDate().toString(),time=local.toPlainTime().toString({smallestUnit:"minute"});
 return on<today||on===today&&time>=schedule.run_at;
}

