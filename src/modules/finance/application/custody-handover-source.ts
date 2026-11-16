import type {TenantTransaction} from "@/platform/db/tenant";
import {cashCustodyDisclosureSources} from "@/platform/authz/cash-custody-resource";
import {Money} from "@/platform/money/money";
import {CashCustodyRepository} from "../infrastructure/cash-custody-repository";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
/** Independent original collection visibility survives assignment changes.
 * Only native physical movements change custody; allocation never spends cash. */
export async function inspectCustodyHandoverSource(ctx:FinanceActorContext,tx:TenantTransaction,id:string,at:Date){
 const repository=new CashCustodyRepository(tx,ctx.organizationId),row=await repository.handoverSource(id);
 if(!row)throw Error("Original custody collection required");
 const sources=cashCustodyDisclosureSources(ctx.organizationId,row);
 const recheck=async()=>recheckFinanceAuthorization(ctx,tx,(await repository.clock()).now,sources.map(resource=>({action:"view"as const,resource})),Error("Original custody source access denied"));await recheckFinanceAuthorization(ctx,tx,at,sources.map(resource=>({action:"view"as const,resource})),Error("Original custody source access denied"));
 return{...row,sources,recheck,available:Money.of(await repository.handoverAvailable(row),row.currency)};
}
