import {z} from "zod";
import {localizedTextSchema} from "@/i18n/content";
import {Money} from "@/platform/money/money";
import {receivableCollectionOutstanding} from "./receivable-collection";
import {receivablePartyKind} from "./receivable-assignment";

import type {ReceivableAgingPolicy} from "./receivable-aging-policy";
export {receivableAgingPolicyKey,receivableAgingPolicySchema} from "./receivable-aging-policy";
export type {ReceivableAgingPolicy} from "./receivable-aging-policy";

const id=z.uuid().transform(value=>value.toLowerCase()),currency=z.string().regex(/^[A-Z]{3}$/u);
export const receivableAgingInput=z.object({currency,bucket:z.string().min(1).max(120).optional(),partyKind:receivablePartyKind.optional(),partyId:id.optional(),search:z.string().trim().max(120).default(""),after:z.string().min(1).max(4096).optional()}).strict()
 .refine(input=>!input.partyId||!!input.partyKind,{path:["partyKind"],message:"A party ID requires its actual party kind"});
export class ReceivableAgingSourceError extends Error{}
export class ReceivableAgingChangedError extends Error{}
const date=z.iso.date(),positiveOrZero=z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),count=z.string().regex(/^(?:0|[1-9]\d*)$/u);
const money=z.object({amount:positiveOrZero,currency}).strict();
export const receivableAgingPageSchema=z.object({source:z.object({
 at:z.iso.datetime(),on:date,timezone:z.string(),currency,
 rule:z.object({id,version:z.number().int().positive()}).strict(),
 totalOutstanding:money,totalCount:count,
 buckets:z.array(z.object({key:z.string(),labels:localizedTextSchema.nullable(),outstanding:money,count}).strict()),
 items:z.array(z.object({id,postingId:id,party:z.object({kind:receivablePartyKind,id}).strict(),purpose:z.string(),dueOn:date.nullable(),daysPastDue:z.number().int().nullable(),bucket:z.string(),assigned:money,collected:money,outstanding:money}).strict()).max(50),
 next:z.string().nullable()
}).strict()}).strict();

/** Internal complete snapshots share the page contract without its presentation limit. */
export const receivableAgingCompleteSourceSchema=receivableAgingPageSchema.shape.source.extend({items:z.array(receivableAgingPageSchema.shape.source.shape.items.element),next:z.null()});

/** A complete financial consumer cannot accept a truncated or inconsistent aggregate. */
export function receivableAgingCompleteSource(raw:unknown){
 const parsed=receivableAgingCompleteSourceSchema.safeParse(raw);if(!parsed.success)throw new ReceivableAgingSourceError();
 const source=parsed.data,currency=source.currency,ids=new Set<string>(),groups=new Map<string,{count:bigint;amount:Money}>();
 for(const group of source.buckets){if(groups.has(group.key)||group.outstanding.currency!==currency||group.labels===null&&!["UNSCHEDULED","NOT_DUE"].includes(group.key))throw new ReceivableAgingSourceError();groups.set(group.key,{count:0n,amount:Money.zero(currency)});}
 let assigned=Money.zero(currency),collected=Money.zero(currency),outstanding=Money.zero(currency);
 for(const item of source.items){
  if(ids.has(item.id)||![item.assigned,item.collected,item.outstanding].every(value=>value.currency===currency))throw new ReceivableAgingSourceError();ids.add(item.id);
  const amount=receivableAgingAmounts(item.assigned.amount,item.collected.amount,currency),group=groups.get(item.bucket);
  if(!group||amount.outstanding.amount!==item.outstanding.amount||!Money.of(item.outstanding.amount,currency).amount.gt(0))throw new ReceivableAgingSourceError();
  assigned=assigned.add(Money.of(item.assigned.amount,currency));collected=collected.add(Money.of(item.collected.amount,currency));outstanding=outstanding.add(Money.of(item.outstanding.amount,currency));group.count++;group.amount=group.amount.add(Money.of(item.outstanding.amount,currency));
 }
 if(source.totalOutstanding.currency!==currency||BigInt(source.totalCount)!==BigInt(source.items.length)||!outstanding.equals(Money.of(source.totalOutstanding.amount,currency)))throw new ReceivableAgingSourceError();
 for(const bucket of source.buckets){const group=groups.get(bucket.key)!;if(group.count!==BigInt(bucket.count)||!group.amount.equals(Money.of(bucket.outstanding.amount,currency)))throw new ReceivableAgingSourceError();}
 return{source,assigned,collected,outstanding};
}

/** These are civil-date ordinals; timezone/DST conversion happens once at the actual database clock. */
export function receivableDaysPastDue(on:string,dueOn:string){
 if(!date.safeParse(on).success||!date.safeParse(dueOn).success)throw new ReceivableAgingSourceError();
 const days=(Date.parse(on+"T00:00:00.000Z")-Date.parse(dueOn+"T00:00:00.000Z"))/86400000;
 if(!Number.isSafeInteger(days))throw new ReceivableAgingSourceError();return days;
}
export function receivableAgingBucket(policy:ReceivableAgingPolicy,on:string,dueOn:string|null){
 if(!date.safeParse(on).success)throw new ReceivableAgingSourceError();
 if(dueOn===null)return"UNSCHEDULED";
 const days=receivableDaysPastDue(on,dueOn);if(days<=0)return"NOT_DUE";
 const band=policy.bands.find(row=>row.from_days<=days&&(row.through_days===null||days<=row.through_days));
 if(!band)throw new ReceivableAgingSourceError();return band.key;
}
/** Original minor units remain exact; invalid financial evidence is rejected rather than rounded or clamped. */
export function receivableAgingAmounts(assigned:string,collected:string,currencyCode:string){
 if(!positiveOrZero.safeParse(assigned).success||!positiveOrZero.safeParse(collected).success)throw new ReceivableAgingSourceError();
 try{const original=Money.of(assigned,currencyCode),received=Money.of(collected,currencyCode),outstanding=receivableCollectionOutstanding(original,received);return{assigned:original.toJSON(),collected:received.toJSON(),outstanding:outstanding.toJSON()};}
 catch{throw new ReceivableAgingSourceError();}
}
type Group={key:string;outstanding:string;count:string};
/** SQL aggregates actual open movements; Money and bigint independently check the complete bucket total. */
export function receivableAgingTotals(policy:ReceivableAgingPolicy,currencyCode:string,groups:readonly Group[]){
 const configured=[{key:"UNSCHEDULED",labels:null},{key:"NOT_DUE",labels:null},...policy.bands.map(band=>({key:band.key,labels:band.labels}))],rows=new Map<string,Group>();
 for(const group of groups){if(rows.has(group.key)||!configured.some(band=>band.key===group.key)||!positiveOrZero.safeParse(group.outstanding).success||!count.safeParse(group.count).success)throw new ReceivableAgingSourceError();
  if((BigInt(group.count)===0n)!==(Money.of(group.outstanding,currencyCode).amount.eq(0)))throw new ReceivableAgingSourceError();rows.set(group.key,group);}
 let total=Money.zero(currencyCode),totalCount=0n;
 const buckets=configured.map(band=>{const row=rows.get(band.key),amount=Money.of(row?.outstanding??"0.00",currencyCode),n=BigInt(row?.count??"0");total=total.add(amount);totalCount+=n;return{...band,outstanding:amount.toJSON(),count:n.toString()};});
 return{buckets,totalOutstanding:total.toJSON(),totalCount:totalCount.toString()};
}
