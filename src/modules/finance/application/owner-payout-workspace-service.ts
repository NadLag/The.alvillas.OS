import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize,type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { OwnerPayoutRepository } from "../infrastructure/owner-payout-repository";
import { OwnerLedgerRepository } from "../infrastructure/owner-ledger-repository";
import { FinanceRepository,type FinanceLedgerAccount } from "../infrastructure/finance-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { ownerPayoutResource } from "../domain/owner-payout";
import { canViewCompleteOwnerLedger } from "../domain/owner-ledger";
import { isExpenseFundingAccount,expenseFundingWalletResource } from "../domain/expense";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
import { OwnerPayoutAccessError } from "./owner-payout-service";

type Deps={db?:TenantTransactionRunner};
export const payoutWorkspaceSchema=z.object({ownerId:z.uuid(),propertyId:z.uuid(),after:z.uuid().optional(),fundingAfter:z.uuid().optional(),
  fundingQuery:z.string().trim().max(120).optional(),fundingAccountId:z.uuid().optional(),reservationId:z.uuid().optional(),bookingQuery:z.string().trim().max(120).optional()}).strict();
async function workspaceContext(ctx:FinanceActorContext,input:{ownerId:string;propertyId:string},tx:TenantTransaction){
  const property=await new OwnerPayoutRepository(tx,ctx.organizationId).property(input.propertyId),owners=new OwnerLedgerRepository(tx,ctx.organizationId),owner=await owners.owner(input.ownerId);
  if(!property||!owner||!owner.propertyOwners.some(relation=>relation.property.id===property.id)&&!await owners.hasPropertyHistory(owner.id,property.id))throw new OwnerPayoutAccessError();
  const now=await new FinanceRepository(tx,ctx.organizationId).clock(),resource:Resource={type:"financial_transaction",organizationId:ctx.organizationId,ownerId:owner.id,
    propertyId:property.id,city:property.cityId,region:property.regionId,dataClass:"financial"};
  await recheckFinanceAuthorization(ctx,tx,now,[{action:"view",resource}],new OwnerPayoutAccessError());
  const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
  if(![ctx.authContext,current].every(authority=>canViewCompleteOwnerLedger(authority,resource,now)))throw new OwnerPayoutAccessError();
  return{property,owner,now,current,resource};
}
export async function ownerPayoutCreationTimezone(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=payoutWorkspaceSchema.pick({ownerId:true,propertyId:true}).parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>(await workspaceContext(ctx,input,tx)).property.timezone);
}
export async function getOwnerPayoutWorkspace(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=payoutWorkspaceSchema.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const {property,owner,now,current,resource}=await workspaceContext(ctx,input,tx),repository=new OwnerPayoutRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
    const permits=(target:Resource)=>[ctx.authContext,current].every(authority=>authorize(authority,"view",target,now));
    const visibleFunding=(account:FinanceLedgerAccount)=>{
      const wallet=expenseFundingWalletResource(ctx.organizationId,account,"0",now);
      return isExpenseFundingAccount(account)&&permits({type:"financial_transaction",organizationId:ctx.organizationId,id:account.id,financialRecordId:account.id,amount:"0",occurredAt:now,dataClass:"financial"})&&(!wallet||permits(wallet));
    };
    const accounts:FinanceLedgerAccount[]=[];let cursor=input.fundingAfter;
    while(accounts.length<51){
      const batch=await finance.listLedgerAccounts({after:cursor,query:input.fundingQuery,take:100});if(!batch.length)break;
      for(const account of batch){if(visibleFunding(account))accounts.push(account);if(accounts.length===51)break;}
      if(batch.length<100)break;cursor=batch.at(-1)!.id;
    }
    const fundingNext=accounts.length>50?accounts[49].id:undefined,funding=accounts.slice(0,50);
    if(input.fundingAccountId&&!funding.some(account=>account.id===input.fundingAccountId)){
      const selected=await finance.findLedgerAccountById(input.fundingAccountId);if(!selected||!visibleFunding(selected))throw new OwnerPayoutAccessError();funding.push(selected);
    }
    const [methods,choices,candidates,rows]=await Promise.all([repository.methods(owner.id),new FinancialTransferRepository(tx,ctx.organizationId).currencyChoices(),
      repository.bookings(property.id,input.bookingQuery),repository.page({ownerId:owner.id,propertyId:property.id,after:input.after})]);
    if(input.reservationId&&!candidates.some(row=>row.id===input.reservationId)){
      const selected=await repository.booking(input.reservationId);
      if(!selected||selected.propertyId!==property.id)throw new OwnerPayoutAccessError();candidates.push(selected);
    }
    const reservations=candidates.filter(row=>permits({...resource,type:"reservation",id:row.id,reservationId:row.id,status:row.status,assignedUserAccountId:row.createdBy,dataClass:"operational"})).map(({id,reference})=>({id,reference}));
    const visible=rows.filter(row=>permits(ownerPayoutResource(ctx.organizationId,row,row.property)));
    return{property:{id:property.id,name:property.name,timezone:property.timezone},owner:{id:owner.id,name:owner.displayName},methods,reservations,...choices,
      accounts:funding.map(({id,name})=>({id,name})),fundingNext,rows:visible.slice(0,50).map(row=>({id:row.id,state:row.state,amount:row.amount.toFixed(2),currency:row.currency,purpose:row.purpose,
        createdAt:row.createdAt.toISOString(),scheduledFor:row.scheduledFor?.toISOString()??null,payoutMethodLabel:row.payoutMethod.label})),next:rows.length>50?rows[49].id:undefined,
      canCreate:[ctx.authContext,current].every(authority=>authorize(authority,"create",{...resource,status:"DRAFT",amount:"0",assignedUserAccountId:ctx.actorId},now))};
  });
}
