import {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {inventoryMinimumsKey} from "./inventory-policy";
export const inventoryReorderConfigurationRequested="inventory.reorder.configuration.requested";
export const inventoryReorderConfigurationReferenceSchema=z.object({schemaVersion:z.literal(1),configRuleId:z.uuid(),phase:z.enum(["START","END"]),after:z.object({locationId:z.uuid(),itemId:z.uuid()}).strict().optional(),automationPath:z.array(z.string()).max(16).optional()}).strict();
export type InventoryReorderConfigurationReference=z.infer<typeof inventoryReorderConfigurationReferenceSchema>;
export const inventoryReorderConfigurationKey=(value:InventoryReorderConfigurationReference)=>`inventory-reorder-config:${value.configRuleId}:${value.phase}:${value.after?value.after.locationId+":"+value.after.itemId:"initial"}`;
/** Every native configuration producer uses the existing version writer. The
 * shared outbox delays the approved start/end instants without a second timer. */
export async function appendInventoryReorderConfigurationReferences(tx:TenantTransaction,organizationId:string,rule:{id:string;key:string;lifecycle:string;createdBy:string|null;createdAt:Date;effectiveFrom:Date;effectiveTo:Date|null}){
 if(rule.key!==inventoryMinimumsKey||rule.lifecycle==="DRAFT"||!rule.createdBy)return;
 const outbox=new OutboxRepository(tx,organizationId);
 for(const [phase,at]of[["START",rule.effectiveFrom],["END",rule.effectiveTo]]as const){if(!at)continue;const reference={schemaVersion:1,configRuleId:rule.id,phase}as const;await outbox.append(inventoryReorderConfigurationRequested,reference,inventoryReorderConfigurationKey(reference),rule.createdAt,{nextAttemptAt:at});}
}
