import { authorize,type Resource } from "@/platform/authz/authorize";
import { createHash } from "node:crypto";
import { z } from "zod";
import { encryptSecret,decryptSecret } from "@/platform/auth/secret-encryption";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { paymentAccountChoiceInputSchema,PaymentAccountChoiceAccessError } from "../domain/payment-account-choices";
import { expenseFundingChoiceSource } from "./expense-service";
import { isExpenseFundingAccount,expenseFundingWalletResource } from "../domain/expense";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

const cursorSchema=z.object({purpose:z.literal("finance.payment_accounts.v1"),organizationId:z.uuid(),actorId:z.uuid(),source:z.string().regex(/^[a-f0-9]{64}$/),query:z.string().max(120),after:z.uuid()}).strict();

/** Bounded keyset reads. Search is applied only to independently visible metadata. No balance is exposed. */
export async function listPaymentAccountChoices(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=paymentAccountChoiceInputSchema.parse(raw),denied=new PaymentAccountChoiceAccessError(),sourceId=crypto.randomUUID();
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const root:Resource={type:"financial_transaction",organizationId:ctx.organizationId,dataClass:"financial"};
    const source=async()=>input.source.kind==="expense"?expenseFundingChoiceSource(ctx,tx,input.source,sourceId):{target:root,action:"create" as const,version:null,now:new Date()};
    const facts=await source(),sourceChecks=[{action:"view" as const,resource:facts.target},{action:facts.action,resource:facts.target}];
    await recheckFinanceAuthorization(ctx,tx,facts.now,sourceChecks,denied);
    const newExpense=input.source.kind==="expense"&&!input.source.expenseId;
    const binding=createHash("sha256").update(JSON.stringify({source:input.source,version:facts.version,target:{...facts.target,...newExpense?{id:undefined,financialRecordId:undefined}:{}}})).digest("hex");
    let after:string|undefined;
    if(input.after){
      try{const cursor=cursorSchema.parse(JSON.parse(decryptSecret(input.after)));
        if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.source!==binding||cursor.query!==input.query)throw denied;after=cursor.after;
      }catch{throw denied;}
    }
    const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),authorities=[ctx.authContext,{...current,personId:ctx.authContext.personId}];
    const financial=(id:string):Resource=>({...facts.target,type:"financial_transaction",id,financialRecordId:id});
    type Account=Awaited<ReturnType<FinanceRepository["paymentAccountChoicePage"]>>[number];
    const checksFor=(account:Account)=>{
      const occurredAt=facts.target.occurredAt;
      const wallet=input.source.kind==="expense"?expenseFundingWalletResource(ctx.organizationId,account,String(facts.target.amount??"0"),typeof occurredAt==="string"?new Date(occurredAt):occurredAt??undefined):null;
      return[{action:"view" as const,resource:financial(account.id)},...wallet?[{action:"view" as const,resource:wallet}]:[]];
    };
    const allowed=(account:Account)=>!account.code.startsWith("CASH_CUSTODY_")&&(input.source.kind!=="expense"||isExpenseFundingAccount(account))&&authorities.every(authority=>checksFor(account).every(check=>authorize(authority,check.action,check.resource,facts.now)));
    const rootVisible=authorities.every(authority=>authorize(authority,"view",root,facts.now));
    const repository=new FinanceRepository(tx,ctx.organizationId),expense=input.source.kind==="expense",rows=await repository.paymentAccountChoicePage({after,query:rootVisible?input.query:undefined,expense,take:101});
    const visible=rows.slice(0,100).filter(allowed).filter(row=>!input.query||rootVisible||[row.id,row.name,row.code].some(label=>label.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())));
    const accounts=visible.slice(0,50),next=visible.length>50?accounts.at(-1)!.id:rows.length>100?rows[99].id:null;
    const selectedRow=input.selectedId?(await repository.paymentAccountChoicePage({ids:[input.selectedId],expense,take:1}))[0]:undefined;
    const selected=selectedRow&&allowed(selectedRow)?selectedRow:null;
    const returned=selected&&!accounts.some(row=>row.id===selected.id)?[...accounts,selected]:accounts;
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.payment_accounts.viewed",resourceType:"financial_transaction",
      resourceId:input.source.kind==="expense"?input.source.expenseId??input.source.propertyId:ctx.organizationId,
      propertyScopeId:input.source.kind==="expense"?input.source.propertyId:undefined,after:{count:accounts.length,source:input.source.kind},requestId:deps.requestId??crypto.randomUUID(),occurredAt:facts.now});
    const latest=await source();if(JSON.stringify({...latest,now:undefined})!==JSON.stringify({...facts,now:undefined}))throw denied;
    const retained=returned.length?await repository.paymentAccountChoicePage({ids:returned.map(row=>row.id),expense,take:51}):[];
    if(returned.some(row=>!retained.some(value=>JSON.stringify(value)===JSON.stringify(row))))throw denied;
    await recheckFinanceAuthorization(ctx,tx,latest.now,[...sourceChecks,...returned.flatMap(checksFor)],denied);
    const option=({id,name,code}:Account)=>({id,name,code});
    return{accounts:accounts.map(option),selected:selected?option(selected):null,next:next?encryptSecret(JSON.stringify({purpose:"finance.payment_accounts.v1",organizationId:ctx.organizationId,actorId:ctx.actorId,source:binding,query:input.query,after:next})):null};
  });
}
