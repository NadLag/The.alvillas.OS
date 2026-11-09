import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {configSlugSchema} from "@/platform/config/identifiers";
import {leadCaptureChannels,LeadValidationError} from "./lead-capture";
import {leadStages,leadStageSchema} from "./lead-pipeline";

export const leadAnalyticsPolicyKey="crm.lead_analytics";
export const leadAnalyticsProtocol="NATIVE_ORIGINAL_LEAD_COHORT_ANALYTICS_V1";
export const leadAnalyticsPolicySchema=z.object({
 source:z.literal("NATIVE_LEAD_CAPTURE_AND_OWNER_CONVERSION"),attribution:z.literal("ORIGINAL_CAPTURE"),
 conversion:z.literal("NATIVE_OWNER_CONVERSION"),labels:z.literal("RETAIN_CAPTURED_SOURCE_LABELS"),
 max_range_seconds:z.number().int().positive().max(2147483647),max_source_groups:z.number().int().positive().max(1000),
 read_admission:z.object({requests:z.number().int().positive().max(2147483647),window_seconds:z.number().int().positive().max(2147483647)}).strict()
}).strict();
// Native request times preserve their exact instant; sub-millisecond input is never rounded silently.
const instant=z.iso.datetime().refine(value=>{const fraction=value.match(/\.(\d+)Z$/u)?.[1];return !fraction||fraction.length<=3||/^0*$/u.test(fraction.slice(3));}).transform(value=>new Date(value).toISOString());
export const leadAnalyticsInputSchema=z.object({from:instant,until:instant,sourceKey:configSlugSchema.optional()}).strict().refine(value=>Date.parse(value.from)<Date.parse(value.until));
export type LeadAnalyticsInput=z.infer<typeof leadAnalyticsInputSchema>;
export class LeadAnalyticsRangeError extends LeadValidationError{}
export const leadAnalyticsCountSchema=z.string().regex(/^(0|[1-9]\d{0,29})$/u);
export const leadAnalyticsRowSchema=z.object({sourceKey:configSlugSchema,channel:z.enum(leadCaptureChannels),sourceLabel:localizedTextSchema,stage:leadStageSchema,captured:leadAnalyticsCountSchema,converted:leadAnalyticsCountSchema}).strict();
export type LeadAnalyticsRow=z.infer<typeof leadAnalyticsRowSchema>;
const stagesSchema=z.array(z.object({stage:leadStageSchema,count:leadAnalyticsCountSchema}).strict()).length(leadStages.length).refine(values=>values.every((value,index)=>value.stage===leadStages[index]));
const totalsShape={captured:leadAnalyticsCountSchema,converted:leadAnalyticsCountSchema,stages:stagesSchema};
const totalsBase=z.object(totalsShape).strict();
const consistent=(value:z.infer<typeof totalsBase>)=>BigInt(value.converted)<=BigInt(value.captured)&&value.stages.reduce((sum,stage)=>sum+BigInt(stage.count),0n)===BigInt(value.captured);
const totalsSchema=totalsBase.refine(consistent);
const sourceSchema=z.object({...totalsShape,sourceKey:configSlugSchema,channel:z.enum(leadCaptureChannels),sourceLabel:localizedTextSchema}).strict().refine(consistent);
export const leadAnalyticsResultSchema=z.object({protocol:z.literal(leadAnalyticsProtocol),observedAt:instant,filter:leadAnalyticsInputSchema,totals:totalsSchema,sources:z.array(sourceSchema).max(1000)}).strict().refine(value=>{
 const sum=(key:"captured"|"converted")=>value.sources.reduce((total,source)=>total+BigInt(source[key]),0n);
 return Date.parse(value.filter.until)<=Date.parse(value.observedAt)&&sum("captured")===BigInt(value.totals.captured)&&sum("converted")===BigInt(value.totals.converted)&&
  value.totals.stages.every((stage,index)=>value.sources.reduce((total,source)=>total+BigInt(source.stages[index].count),0n)===BigInt(stage.count))&&
  new Set(value.sources.map(source=>JSON.stringify([source.sourceKey,source.channel,source.sourceLabel]))).size===value.sources.length&&value.sources.every(source=>!value.filter.sourceKey||source.sourceKey===value.filter.sourceKey);
});
export type LeadAnalyticsResult=z.infer<typeof leadAnalyticsResultSchema>;
export const leadAnalyticsOptionsSchema=z.object({observedAt:instant,maxRangeSeconds:z.number().int().positive().max(2147483647),maxSourceGroups:z.number().int().positive().max(1000)}).strict();

export function assertLeadAnalyticsRange(input:LeadAnalyticsInput,policy:z.infer<typeof leadAnalyticsPolicySchema>,observedAt:Date){
 if(Date.parse(input.until)>observedAt.getTime())throw new LeadValidationError();
 if(Date.parse(input.until)-Date.parse(input.from)>policy.max_range_seconds*1000)throw new LeadAnalyticsRangeError();
}

/** Exact complete-cohort counts; neither a signed stage nor one distinct Owner substitutes for a conversion. */
export function assembleLeadAnalytics(raw:unknown,input:LeadAnalyticsInput,observedAt:Date,maxSourceGroups:number):LeadAnalyticsResult{
 const rows=z.array(leadAnalyticsRowSchema).max(maxSourceGroups*leadStages.length+1).parse(raw);
 if(rows.length>maxSourceGroups*leadStages.length)throw new LeadAnalyticsRangeError();
 const empty=()=>({captured:0n,converted:0n,stages:new Map(leadStages.map(stage=>[stage,0n]))}),total=empty(),groups=new Map<string,ReturnType<typeof empty>&Pick<LeadAnalyticsRow,"sourceKey"|"channel"|"sourceLabel">>(),seen=new Set<string>();
 for(const row of rows){
  const identity=JSON.stringify([row.sourceKey,row.channel,row.sourceLabel]),line=identity+":"+row.stage;
  if(seen.has(line)||BigInt(row.captured)===0n||BigInt(row.converted)>BigInt(row.captured)||input.sourceKey&&row.sourceKey!==input.sourceKey)throw new LeadValidationError();seen.add(line);
  let group=groups.get(identity);if(!group){group={...empty(),sourceKey:row.sourceKey,channel:row.channel,sourceLabel:row.sourceLabel};groups.set(identity,group);}
  if(groups.size>maxSourceGroups)throw new LeadAnalyticsRangeError();
  for(const value of[total,group]){value.captured+=BigInt(row.captured);value.converted+=BigInt(row.converted);value.stages.set(row.stage,value.stages.get(row.stage)!+BigInt(row.captured));}
 }
 const counts=(value:ReturnType<typeof empty>)=>({captured:String(value.captured),converted:String(value.converted),stages:leadStages.map(stage=>({stage,count:String(value.stages.get(stage)!)}))});
 return leadAnalyticsResultSchema.parse({protocol:leadAnalyticsProtocol,observedAt:observedAt.toISOString(),filter:input,totals:counts(total),sources:[...groups.values()].map(group=>({sourceKey:group.sourceKey,channel:group.channel,sourceLabel:group.sourceLabel,...counts(group)}))});
}
