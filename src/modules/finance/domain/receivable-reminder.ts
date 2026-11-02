import {z} from "zod";
import {Money} from "@/platform/money/money";
import {receivableDaysPastDue} from "./receivable-aging";
import {receivableReminderPolicySchema} from "./receivable-reminder-policy";

const input=z.object({assignmentId:z.uuid(),policyId:z.uuid(),on:z.iso.date(),localTime:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),dueOn:z.iso.date().nullable(),outstanding:z.object({amount:z.string().regex(/^(?:0|[1-9]\d*)\.\d{2}$/u),currency:z.string().regex(/^[A-Z]{3}$/u)}).strict()}).strict();
/** A missed tick catches up once for the current configured stage and civil occurrence. */
export function receivableReminderOccurrence(rawPolicy:unknown,raw:unknown){
 const policy=receivableReminderPolicySchema.parse(rawPolicy),value=input.parse(raw);
 if(value.dueOn===null||Money.of(value.outstanding.amount,value.outstanding.currency).equals(Money.zero(value.outstanding.currency)))return null;
 const days=receivableDaysPastDue(value.on,value.dueOn),stage=[...policy.stages].reverse().find(stage=>days>=stage.offset_days);if(!stage)return null;
 const cycle=stage.repeat_every_days===null?0:Math.floor((days-stage.offset_days)/stage.repeat_every_days),offset=stage.offset_days+cycle*(stage.repeat_every_days??0),date=new Date(value.dueOn+"T12:00:00.000Z");date.setUTCDate(date.getUTCDate()+offset);const on=z.iso.date().parse(date.toISOString().slice(0,10));if(on===value.on&&value.localTime<policy.send_at)return null;
 return{stage:stage.key,on,labels:stage.labels,idempotencyKey:`receivable-reminder:${value.policyId}:${value.assignmentId}:${stage.key}:${on}`};
}
