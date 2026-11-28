import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {ReservationConfigScopeRepository} from "@/platform/config/reservation-scope-repository";
import {nativeOrganizationTimezone} from "@/platform/config/organization-timezone";
import {inventoryMinimumsKey} from "@/platform/config/inventory-policy";
import {InventoryRepository} from "./inventory-repository";
import {InventoryMovementRepository} from "./movement-repository";
import type {ConfigRuleRecord} from "@/platform/config/config-rule-repository";
export type NativeInventorySuggestionRow={id:string;propertyId:string|null;locationId:string;itemId:string;quantity:string;title:unknown;createdAt:Date;nativeSource:{eventId:string;signal:unknown};automation:{configs:unknown;rule:unknown}|null};
export class InventoryReorderRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 private suggestionSelect(){return Prisma.sql`SELECT s.id,s.property_id AS "propertyId",s.location_id AS "locationId",s.item_id AS "itemId",s.quantity::text,s.title,s.created_at AS "createdAt",s.native_source AS "nativeSource",
  (SELECT jsonb_build_object('configs',r.inputs->'configs','rule',c.value) FROM automation_run r JOIN config_rule c ON c.organization_id=r.organization_id AND c.id=r.config_rule_id WHERE r.organization_id=s.organization_id AND r.id::text=split_part(s.outcome_key,':',1)) AS automation FROM automation_suggestion s`;}
 automationAuditSources(ids:readonly string[]){return this.tx.auditLog.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]},resourceType:"automation"},select:{id:true,resourceId:true,propertyScopeId:true,after:true}});}
 async suggestionsByIds(ids:readonly string[]):Promise<NativeInventorySuggestionRow[]>{if(!ids.length)return[];return this.tx.$queryRaw<NativeInventorySuggestionRow[]>(Prisma.sql`${this.suggestionSelect()} WHERE organization_id=${this.organizationId}::uuid AND native_source IS NOT NULL AND id IN(${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))})`);}
 async latestSuggestion(locationId:string,itemId:string,position:unknown,ruleId:string){const rows=await this.tx.$queryRaw<NativeInventorySuggestionRow[]>(Prisma.sql`${this.suggestionSelect()} WHERE organization_id=${this.organizationId}::uuid AND location_id=${locationId}::uuid AND item_id=${itemId}::uuid AND status='OPEN' AND native_source#>'{signal,position}'=${JSON.stringify(position)}::jsonb AND native_source#>>'{signal,minimumRule,id}'=${ruleId} ORDER BY created_at DESC,id DESC LIMIT 1`);return rows[0]??null;}
 async configurationTargets(cause:ConfigRuleRecord,at:Date,after?:{locationId:string;itemId:string}){
  const applies=(alias:"cause"|"policy")=>alias==="cause"?Prisma.sql`(${cause.scopeType}='organization' AND ${cause.scopeId}::uuid IS NULL OR ${cause.scopeType}='property' AND l.property_id=${cause.scopeId}::uuid OR ${cause.scopeType}='city' AND p.city_id=${cause.scopeId}::uuid OR ${cause.scopeType}='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=l.organization_id AND a.id=${cause.scopeId}::uuid AND a.property_id=l.property_id))`:Prisma.sql`(c.scope_type='organization' AND c.scope_id IS NULL OR c.scope_type='property' AND c.scope_id=l.property_id OR c.scope_type='city' AND c.scope_id=p.city_id OR c.scope_type='agreement' AND EXISTS(SELECT 1 FROM management_agreement a WHERE a.organization_id=l.organization_id AND a.id=c.scope_id AND a.property_id=l.property_id AND a.archived_at IS NULL AND a.status<>'DRAFT' AND a.effective_from<=${at} AND(a.effective_to IS NULL OR a.effective_to>${at})))`;
  return this.tx.$queryRaw<Array<{locationId:string;itemId:string}>>(Prisma.sql`SELECT l.id AS "locationId",i.id AS "itemId" FROM inventory_location l JOIN inventory_item i ON i.organization_id=l.organization_id LEFT JOIN property p ON p.organization_id=l.organization_id AND p.id=l.property_id
   WHERE l.organization_id=${this.organizationId}::uuid AND l.archived_at IS NULL AND i.archived_at IS NULL AND(l.property_id IS NULL OR p.id IS NOT NULL AND p.archived_at IS NULL) AND ${applies("cause")}
   AND EXISTS(SELECT 1 FROM config_rule c WHERE c.organization_id=l.organization_id AND c.key=${inventoryMinimumsKey} AND c.lifecycle<>'DRAFT' AND c.effective_from<=${at} AND(c.effective_to IS NULL OR c.effective_to>${at}) AND ${applies("policy")}
    AND(c.value->'minimums' @> jsonb_build_array(jsonb_build_object('item',i.key)) OR EXISTS(SELECT 1 FROM jsonb_array_elements(c.value->'location_overrides') entry WHERE entry->>'location_id'=l.id::text AND entry->'minimums' @> jsonb_build_array(jsonb_build_object('item',i.key)))))
   ${after?Prisma.sql`AND(l.id,i.id)>(${after.locationId}::uuid,${after.itemId}::uuid)`:Prisma.empty} ORDER BY l.id,i.id LIMIT 51`);
 }
 async snapshot(locationId:string,itemId:string,at:Date){
  const inventory=new InventoryRepository(this.tx,this.organizationId),[location,item]=await Promise.all([inventory.locationCatalogById(locationId),inventory.catalogItemById(itemId)]);if(!location||!item)return null;
  const scopes=location.propertyId?await new ReservationConfigScopeRepository(this.tx,this.organizationId).scopes({propertyId:location.propertyId,asOf:at}):[{scopeType:"organization",scopeId:null}],rule=await new ConfigRuleRepository(this.tx,this.organizationId).resolve({key:inventoryMinimumsKey,scopes,asOf:at});
  if(!rule)return null;
  const [position,timezone]=await Promise.all([new InventoryMovementRepository(this.tx,this.organizationId).position(locationId,itemId),location.propertyId?this.propertyTimezone(location.propertyId):nativeOrganizationTimezone(this.tx,this.organizationId)]);
  if(!timezone)return null;return{location,item,position,rule,scopes,timezone};
 }
 private async propertyTimezone(id:string){const row=await this.tx.property.findFirst({where:{organizationId:this.organizationId,id},select:{timezone:true}});return row?.timezone??null;}
 async originalSource(input:{kind:"MOVEMENT"|"STOCKTAKE"|"CONFIGURATION";id:string;locationId:string;itemId:string;revision:string}){
  if(input.kind==="MOVEMENT")return(await this.tx.$queryRaw<Array<{actorId:string;recordedAt:Date}>>(Prisma.sql`SELECT actor_id AS "actorId",created_at AS "recordedAt" FROM inventory_movement WHERE organization_id=${this.organizationId}::uuid AND movement_group_id=${input.id}::uuid AND location_id=${input.locationId}::uuid AND item_id=${input.itemId}::uuid AND revision=${input.revision}::bigint`))[0]??null;
  if(input.kind==="STOCKTAKE")return(await this.tx.$queryRaw<Array<{actorId:string;recordedAt:Date}>>(Prisma.sql`SELECT actor_id AS "actorId",received_at AS "recordedAt" FROM inventory_stocktake WHERE organization_id=${this.organizationId}::uuid AND id=${input.id}::uuid AND location_id=${input.locationId}::uuid AND item_id=${input.itemId}::uuid AND revision=${input.revision}::bigint`))[0]??null;
  return(await this.tx.$queryRaw<Array<{actorId:string|null;recordedAt:Date}>>(Prisma.sql`SELECT created_by AS "actorId",created_at AS "recordedAt" FROM config_rule WHERE organization_id=${this.organizationId}::uuid AND id=${input.id}::uuid AND key=${inventoryMinimumsKey}`))[0]??null;
 }
}
