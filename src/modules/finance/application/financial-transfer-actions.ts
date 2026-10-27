"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession } from "./finance-access";
import { postFinancialTransfer,voidFinancialTransfer,FinancialTransferAccessError,FinancialTransferConflictError,FinancialTransferConfigurationError } from "./financial-transfer-service";
import { AccountingPeriodClosedError } from "../domain/accounting-period";

async function perform(input:unknown,reverse:boolean){
  const requestId=crypto.randomUUID();
  try{
    const actor=await financeActorContextFromSession(await auth());if(!actor)throw new FinancialTransferAccessError();
    const data=reverse?await voidFinancialTransfer(actor,input,{requestId}):await postFinancialTransfer(actor,input,{requestId});
    revalidatePath("/[locale]/app/finance/transfers","page");revalidatePath("/[locale]/app/team/[personId]","page");revalidatePath("/[locale]/app/field/wallet","page");
    return{ok:true as const,data};
  }catch(error){
    const code=error instanceof FinancialTransferAccessError?"forbidden" as const:error instanceof FinancialTransferConflictError?"conflict" as const:
      error instanceof FinancialTransferConfigurationError?"unavailable" as const:error instanceof AccountingPeriodClosedError?"closed" as const:error instanceof z.ZodError?"validation" as const:"error" as const;
    if(code==="error")await captureException(error,{source:"api",requestId,tags:{feature:"financial-transfer"}});
    return{ok:false as const,code};
  }
}
export async function postFinancialTransferAction(input:unknown){return perform(input,false)}
export async function voidFinancialTransferAction(input:unknown){return perform(input,true)}
