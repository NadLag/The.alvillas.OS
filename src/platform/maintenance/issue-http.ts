import type {NextRequest} from "next/server";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {InventoryItemAccessError,InventoryItemConflictError} from "@/modules/inventory/domain/item-catalog";
import {MaintenanceIssueAccessError,MaintenanceIssueConflictError,MaintenanceIssueSourceUnavailableError} from "@/modules/maintenance/domain/issue-context";
import type {AccountActorContext} from "@/platform/authz/session-context";
/** Reuse native actor scoping, same-origin JSON admission, private headers,
 * bounded I/O and masked errors without a parallel authorization framework. */
export function maintenanceIssueHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>){
 return inventoryCatalogHttp(request,async(actor,input,requestId)=>{
  try{return await work(actor,input,requestId);}catch(error){if(error instanceof MaintenanceIssueAccessError)throw new InventoryItemAccessError();if(error instanceof MaintenanceIssueConflictError||error instanceof MaintenanceIssueSourceUnavailableError)throw new InventoryItemConflictError();throw error;}
 },"F-MNT-01",262144);
}
