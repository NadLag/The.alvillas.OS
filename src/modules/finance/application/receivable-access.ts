import type {TenantTransaction} from "@/platform/db/tenant";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {ReceivableAccessError} from "../domain/receivable";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

/** Original company ownership claims can include independently protected salary sources. */
export async function recheckReceivableAuthority(ctx:FinanceActorContext,tx:TenantTransaction,action:"view"|"create"|"edit"="view"){
  if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId)throw new ReceivableAccessError();
  const now=await new FinanceRepository(tx,ctx.organizationId).clock(),target={organizationId:ctx.organizationId,id:ctx.organizationId,dataClass:"financial" as const},
    checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=["receivable","financial_transaction","staff_compensation"].map(type=>({action:"view",resource:{...target,type},organizationOnly:true}));
  if(action!=="view")checks.push({action,resource:{...target,type:"receivable"},organizationOnly:true});
  await recheckFinanceAuthorization(ctx,tx,now,checks,new ReceivableAccessError());return now;
}
