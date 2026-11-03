import {randomUUID} from "node:crypto";
import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {authorize} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {encryptSecret,decryptSecret} from "@/platform/auth/secret-encryption";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {requireCurrentTimezoneData} from "@/platform/time/timezone-data";
import {PropertyFinanceRepository} from "../infrastructure/property-finance-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {propertyFinanceFilters,propertyFinanceAuthorityChecks,propertyFinanceAccountPositions,propertyFinanceViewSchema,PropertyFinanceAccessError,PropertyFinanceConfigurationError,PropertyFinanceSourceChangedError} from "../domain/property-finance";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Property=NonNullable<Awaited<ReturnType<PropertyFinanceRepository["property"]>>>;
const cursor=z.object({purpose:z.literal("property.finance.v1"),organizationId:z.uuid(),actorId:z.uuid(),propertyId:z.uuid(),filter:z.string().regex(/^[a-f0-9]{64}$/u),source:z.string().regex(/^[a-f0-9]{32}$/u),postingId:z.uuid()}).strict();
function resource(ctx:FinanceActorContext,property:Property){return{type:"property_finance",organizationId:ctx.organizationId,id:property.id,propertyId:property.id,city:property.cityId,region:property.regionId,dataClass:"financial"as const};}
async function authority(ctx:FinanceActorContext,tx:TenantTransaction,property:Property){await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),propertyFinanceAuthorityChecks(resource(ctx,property)),new PropertyFinanceAccessError());}
export async function getPropertyFinance(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=propertyFinanceFilters.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const repository=new PropertyFinanceRepository(tx,ctx.organizationId),property=await repository.property(input.propertyId);if(!property)throw new PropertyFinanceAccessError();await authority(ctx,tx,property);
  const now=await new FinanceRepository(tx,ctx.organizationId).clock(),settings=await repository.settings(),currencies=await repository.currencies(),currency=input.currency??settings.baseCurrency,timezone=property.timezone;
  if(!timezone||!currencies.some(row=>row.code===currency&&row.minorUnit<=2))throw new PropertyFinanceConfigurationError();try{requireCurrentTimezoneData();new Intl.DateTimeFormat("en",{timeZone:timezone});}catch{throw new PropertyFinanceConfigurationError();}
  const defaults=await repository.defaults(now,timezone),fromOn=input.fromOn??defaults.fromOn,toOn=input.toOn??defaults.toOn;if(fromOn>toOn)throw new PropertyFinanceConfigurationError();
  const filter=commandFingerprint({propertyId:property.id,fromOn,toOn,currency,timezone});let after:z.infer<typeof cursor>|null=null;
  if(input.after){try{after=cursor.parse(JSON.parse(decryptSecret(input.after)));}catch{throw new PropertyFinanceAccessError();}if(after.organizationId!==ctx.organizationId||after.actorId!==ctx.actorId||after.propertyId!==property.id)throw new PropertyFinanceAccessError();if(after.filter!==filter)throw new PropertyFinanceSourceChangedError();}
  const scope={propertyId:property.id,currency,...await repository.range(fromOn,toOn,timezone),after:after?.postingId},snapshot=await repository.snapshot(scope);if(!snapshot.cursorFound||after&&after.source!==snapshot.fingerprint)throw new PropertyFinanceSourceChangedError();
  const currentAuth=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),both=[ctx.authContext,currentAuth],capabilities={createExpense:!property.archivedAt&&both.every(auth=>authorize(auth,"create",{...resource(ctx,property),type:"expense"},now)),audit:both.every(auth=>authorize(auth,"view",{type:"audit_log",organizationId:ctx.organizationId},now))};
  const rows=snapshot.items.slice(0,50),data=propertyFinanceViewSchema.parse({property:{id:property.id,name:property.name,timezone,archived:property.archivedAt!==null},fromOn,toOn,currency,currencies:currencies.filter(row=>row.minorUnit<=2).map(row=>row.code),accounts:propertyFinanceAccountPositions(snapshot.accounts),items:rows,capabilities,next:snapshot.items.length>50?encryptSecret(JSON.stringify({purpose:"property.finance.v1",organizationId:ctx.organizationId,actorId:ctx.actorId,propertyId:property.id,filter,source:snapshot.fingerprint,postingId:rows.at(-1)!.id})):null});
  const shown=present({...ctx.authContext,visibleDataClasses:new Set(["financial"as const])},"view",{...resource(ctx,property),data},catalogFieldPolicy<typeof data>("property_finance"),now);
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.property_finance.viewed",resourceType:"property_finance",resourceId:property.id,propertyScopeId:property.id,after:{fromOn,toOn,currency,postingIds:rows.map(row=>row.id),accountCount:data.accounts.length},reason:"Viewed original property-attributed financial positions and immutable posting history",requestId:deps.requestId??randomUUID(),occurredAt:now});
  const currentProperty=await repository.property(property.id);if(!currentProperty)throw new PropertyFinanceAccessError();await authority(ctx,tx,currentProperty);if(JSON.stringify(currentProperty)!==JSON.stringify(property))throw new PropertyFinanceSourceChangedError();
  // A second statement closes the read boundary without freezing fresh authorization in a repeatable-read snapshot.
  if((await repository.snapshot(scope)).fingerprint!==snapshot.fingerprint)throw new PropertyFinanceSourceChangedError();await authority(ctx,tx,currentProperty);return propertyFinanceViewSchema.parse(shown);
 });
}
