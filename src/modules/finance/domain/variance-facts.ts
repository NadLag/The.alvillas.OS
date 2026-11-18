import {z} from "zod";
import {Money} from "@/platform/money/money";

const amount=z.string().regex(/^-?(?:0|[1-9]\d*)(?:\.\d{2})?$/u).max(200);
const money=z.object({amount:amount.refine(value=>/^-?(?:0|[1-9]\d*)\.\d{2}$/u.test(value)),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict();
const originalFacts=z.object({kind:z.enum(["MONEY","QUANTITY"]),unit:z.string().min(1).max(200),currency:z.string().regex(/^[A-Z]{3}$/u).nullable(),expected:amount,actual:amount,variance:amount,priceChangeAssociations:z.array(z.uuid()).optional()}).strict().superRefine((value,context)=>{
 if(value.kind==="MONEY"?value.currency===null||value.unit!=="MONEY:"+value.currency||[value.expected,value.actual,value.variance].some(value=>! /^-?(?:0|[1-9]\d*)\.\d{2}$/u.test(value)):value.currency!==null||!/^QUANTITY(?::.+)?$/u.test(value.unit)||[value.expected,value.actual,value.variance].some(value=>! /^-?(?:0|[1-9]\d*)$/u.test(value)))context.addIssue({code:"custom",message:"Retain original monetary or physical units and precision"});
});
export const varianceFactsSchema=z.union([originalFacts,z.object({kind:z.literal("UNAVAILABLE"),unit:z.literal("LAUNDRY"),currency:z.null(),expected:z.null(),actual:z.null(),variance:z.null(),reason:z.enum(["NO_ACTUAL","BASELINE_CHANGED","CURRENCY_MISMATCH"]),expectedMoney:money,actualMoney:z.array(money).max(200)}).strict()]);
export type VarianceFacts=z.infer<typeof varianceFactsSchema>;

/** Signed percentage at one decimal, half away from zero. A zero baseline has
 * no defined percentage; this never changes the original monetary variance. */
export function exactVariancePercentage(expected:string,actual:string,currency:string):string|null{
 const baseline=Money.of(expected,currency),observed=Money.of(actual,currency);
 const denominator=BigInt(baseline.toJSON().amount.replace(".",""));
 if(denominator<=0n)return null;
 const numerator=(BigInt(observed.toJSON().amount.replace(".",""))-denominator)*1000n;
 const magnitude=numerator<0n?-numerator:numerator;
 const rounded=magnitude/denominator+(magnitude%denominator*2n>=denominator?1n:0n),digits=rounded.toString().padStart(2,"0");
 return(numerator<0n&&rounded!==0n?"-":"")+digits.slice(0,-1)+"."+digits.slice(-1);
}
