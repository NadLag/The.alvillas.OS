import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import type { AuthContext,Resource } from "@/platform/authz/authorize";
import { present,catalogFieldPolicy } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { OwnerLedgerRepository } from "../infrastructure/owner-ledger-repository";
import { ownerLedgerFilters,ownerLedgerChoiceFilters,canViewCompleteOwnerLedger,ownerLedgerBuckets } from "../domain/owner-ledger";
import type { FinanceActorContext } from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Property={id:string;name:string;cityId:string|null;regionId:string|null};
export class OwnerLedgerAccessError extends Error{}
export class OwnerLedgerConfigurationError extends Error{}
function resource(ctx:FinanceActorContext,ownerId:string,property?:Property):Resource{return{type:"owner_statement",organizationId:ctx.organizationId,ownerId,
  propertyId:property?.id,city:property?.cityId,region:property?.regionId,dataClass:"financial"}}
async function authority(ctx:FinanceActorContext,tx:TenantTransaction){
  if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId)throw new OwnerLedgerAccessError();
  const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId);
  if(![ctx.authContext,current].every(auth=>auth.permissions.has("owner_statement:view")))throw new OwnerLedgerAccessError();
  return current;
}
function allowed(ctx:FinanceActorContext,current:AuthContext,target:Resource,now:Date){return[ctx.authContext,current].every(auth=>canViewCompleteOwnerLedger(auth,target,now))}
async function authorizedScope(ctx:FinanceActorContext,tx:TenantTransaction,input:{ownerId:string;propertyId?:string}){
  const current=await authority(ctx,tx),now=await new FinanceRepository(tx,ctx.organizationId).clock(),repository=new OwnerLedgerRepository(tx,ctx.organizationId),owner=await repository.owner(input.ownerId);
  if(!owner)throw new OwnerLedgerAccessError();
  const property=input.propertyId?await repository.property(input.propertyId):undefined;
  if(input.propertyId&&(!property||!owner.propertyOwners.some(row=>row.property.id===input.propertyId)&&!await repository.hasPropertyHistory(owner.id,input.propertyId)))throw new OwnerLedgerAccessError();
  const target=resource(ctx,owner.id,property??undefined);if(!allowed(ctx,current,target,now))throw new OwnerLedgerAccessError();
  return{current,now,repository,owner,property,target};
}
export async function assertOwnerLedgerViewer(ctx:FinanceActorContext,deps:Deps={}){await withTenant(deps.db??prisma,ctx.organizationId,tx=>authority(ctx,tx))}
export async function assertOwnerLedgerScope(ctx:FinanceActorContext,ownerId:string,propertyId?:string,deps:Deps={}){
  const input=ownerLedgerFilters.parse({ownerId,propertyId});await withTenant(deps.db??prisma,ctx.organizationId,tx=>authorizedScope(ctx,tx,input));
}
export async function listOwnerLedgerChoices(ctx:FinanceActorContext,raw:unknown={},deps:Deps={}){
  const input=ownerLedgerChoiceFilters.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const current=await authority(ctx,tx),now=await new FinanceRepository(tx,ctx.organizationId).clock(),repository=new OwnerLedgerRepository(tx,ctx.organizationId);
    const choices:Array<{id:string;name:string;propertyId?:string;propertyName?:string}>=[];let cursor=input.after;
    while(choices.length<51){const batch=await repository.owners({query:input.query,after:cursor});if(!batch.length)break;
      for(const owner of batch){
        if(allowed(ctx,current,resource(ctx,owner.id),now))choices.push({id:owner.id,name:owner.displayName});
        else{const property=owner.propertyOwners.map(row=>row.property).sort((a,b)=>a.id.localeCompare(b.id)).find(property=>allowed(ctx,current,resource(ctx,owner.id,property),now));if(property)choices.push({id:owner.id,name:owner.displayName,propertyId:property.id,propertyName:property.name})}
        if(choices.length===51)break;
      }
      if(batch.length<100)break;cursor=batch.at(-1)!.id;
    }
    return{owners:choices.slice(0,50),next:choices.length>50?choices[49].id:undefined};
  },{isolationLevel:"RepeatableRead"});
}
export async function getOwnerLedger(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=ownerLedgerFilters.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const {current,now,repository,owner,property,target}=await authorizedScope(ctx,tx,input);
    const settings=await repository.settings(),policy=input.timezone?null:await new AccountingPeriodRepository(tx,ctx.organizationId).policy(now),timezone=input.timezone??policy?.value.timezone??settings.timezone;
    if(!timezone)throw new OwnerLedgerConfigurationError();
    const currency=input.currency??settings.baseCurrency;if(!settings.currencies.some(row=>row.code===currency))throw new OwnerLedgerConfigurationError();
    const defaults=await repository.defaults(now,timezone),fromOn=input.fromOn??defaults.fromOn,toOn=input.toOn??defaults.toOn;if(fromOn>toOn)throw new OwnerLedgerConfigurationError();
    const range=await repository.range(fromOn,toOn,timezone),scope={ownerId:owner.id,propertyId:property?.id,currency};
    const statement=await repository.statement(scope,range,owner.displayName,property?.name??null),cursor=input.after?statement.lines.findIndex(row=>row.postingId===input.after):-1;
    if(input.after&&cursor<0)throw new OwnerLedgerAccessError();
    const rows=statement.lines.slice(cursor+1,cursor+52),presentBuckets=new Set(statement.lines.map(row=>row.bucket));
    const data={openingBalance:statement.openingBalance.toJSON().amount,periodCredits:statement.periodCreditTotal.toJSON().amount,periodDebits:statement.periodDebitTotal.toJSON().amount,closingBalance:statement.closingBalance.toJSON().amount,
      bucketTotals:ownerLedgerBuckets.filter(bucket=>presentBuckets.has(bucket)).map(bucket=>({bucket,credits:statement.bucketMovements[bucket].credits.toJSON().amount,debits:statement.bucketMovements[bucket].debits.toJSON().amount,net:statement.bucketTotals[bucket].toJSON().amount})),
      lines:rows.slice(0,50).map(row=>({id:row.postingId,transactionId:row.transactionId,reference:row.reference,description:row.description,side:row.side,bucket:row.bucket,propertyId:row.propertyId,propertyName:row.propertyName,category:row.category,reservationReference:row.reservationReference,source:row.source,
        amount:row.amount.toJSON().amount,runningBalance:row.runningBalance.toJSON().amount,occurredAt:row.occurredAt.toISOString()}))};
    const visible=present({...ctx.authContext,visibleDataClasses:new Set()},"view",{...target,data},catalogFieldPolicy<typeof data>("owner_statement"),now) as typeof data;
    const properties=owner.propertyOwners.map(row=>row.property).filter(property=>allowed(ctx,current,resource(ctx,owner.id,property),now)).map(property=>({id:property.id,name:property.name}));
    if(property&&!properties.some(row=>row.id===property.id))properties.push({id:property.id,name:property.name});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.owner_ledger.viewed",resourceType:"owner_statement",resourceId:owner.id,propertyScopeId:property?.id,
      after:{ownerId:owner.id,propertyId:property?.id??null,fromOn,toOn,currency,timezone,rowCount:visible.lines.length},reason:"Viewed the authorized derived owner ledger",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
    return{owner:{id:owner.id,name:owner.displayName,archived:Boolean(owner.archivedAt)},property:property?{id:property.id,name:property.name}:null,fromOn,toOn,currency,timezone,snapshotAt:now.toISOString(),rowCount:statement.lines.length.toString(),...visible,
      currencies:settings.currencies,canViewAllProperties:allowed(ctx,current,resource(ctx,owner.id),now),properties,next:rows.length>50?rows[49].postingId:undefined};
  },{isolationLevel:"RepeatableRead"});
}
