"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { localClockInstant } from "@/platform/time/local-instant";
import { financeActorContextFromSession } from "./finance-access";
import { createOwnerPayout,getOwnerPayout,submitOwnerPayout,OwnerPayoutAccessError,OwnerPayoutConflictError,OwnerPayoutConfigurationError } from "./owner-payout-service";
import { ownerPayoutCreationTimezone } from "./owner-payout-workspace-service";
import { OwnerPayoutPolicyUnavailableError } from "./owner-payout-policy";
import { scheduleOwnerPayout,payOwnerPayout,reverseOwnerPayout,failOwnerPayout,cancelOwnerPayout } from "./owner-payout-payment-service";
import { ownerPayoutDraftFormSchema,ownerPayoutScheduleFormSchema } from "../domain/owner-payout";
import { PayoutScheduleConfigurationError } from "../domain/payout-schedule";
import { AccountingPeriodClosedError } from "../domain/accounting-period";

async function run<T>(work:(actor:NonNullable<Awaited<ReturnType<typeof financeActorContextFromSession>>>,requestId:string)=>Promise<T>){
  const requestId=crypto.randomUUID();
  try{
    const actor=await financeActorContextFromSession(await auth());if(!actor)throw new OwnerPayoutAccessError();
    const data=await work(actor,requestId);
    revalidatePath("/[locale]/app/payouts/[id]","page");
    revalidatePath("/[locale]/app/finance/owner-ledgers/properties/[propertyId]/owners/[ownerId]/payouts","page");
    return{ok:true as const,data};
  }catch(error){
    const code:"periodClosed"|"forbidden"|"conflict"|"configuration"|"validation"|"clock"|"error"=error instanceof AccountingPeriodClosedError?"periodClosed":error instanceof OwnerPayoutAccessError?"forbidden":error instanceof OwnerPayoutConflictError?"conflict":
      error instanceof OwnerPayoutConfigurationError||error instanceof OwnerPayoutPolicyUnavailableError||error instanceof PayoutScheduleConfigurationError?"configuration":
        error instanceof RangeError?"clock":error instanceof z.ZodError?"validation":"error";
    if(code==="error")await captureException(error,{source:"api",requestId,tags:{feature:"native-owner-payout"}});
    return{ok:false as const,code};
  }
}
export async function createOwnerPayoutAction(raw:unknown){
  return run(async(actor,requestId)=>{
    const {expectedSettlementLocal,occurrence,...input}=ownerPayoutDraftFormSchema.parse(raw);
    const timezone=expectedSettlementLocal?await ownerPayoutCreationTimezone(actor,{ownerId:input.ownerId,propertyId:input.propertyId}):null;
    return createOwnerPayout(actor,{...input,...(expectedSettlementLocal&&timezone?{expectedSettlementAt:localClockInstant(expectedSettlementLocal,timezone,occurrence)}:{})},{requestId});
  });
}
export async function scheduleOwnerPayoutAction(raw:unknown){
  return run(async(actor,requestId)=>{
    const {scheduledLocal,occurrence,...input}=ownerPayoutScheduleFormSchema.parse(raw),payout=await getOwnerPayout(actor,input.id,{requestId});
    return scheduleOwnerPayout(actor,{...input,scheduledFor:localClockInstant(scheduledLocal,payout.timezone,occurrence)},{requestId});
  });
}
export async function ownerPayoutCommandAction(raw:unknown,command:unknown){
  return run(async(actor,requestId)=>{
    const kind=z.enum(["submit","pay","reverse","fail","cancel"]).parse(command);
    const methods={submit:submitOwnerPayout,pay:payOwnerPayout,reverse:reverseOwnerPayout,fail:failOwnerPayout,cancel:cancelOwnerPayout};
    return methods[kind](actor,raw,{requestId});
  });
}
