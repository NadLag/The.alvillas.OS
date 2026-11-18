import type {NextRequest} from "next/server";
import {inventoryCatalogHttp} from "@/modules/inventory/ui/item-http";
import {InventoryItemAccessError,InventoryItemConflictError} from "@/modules/inventory/domain/item-catalog";
import {MaintenanceIssueAccessError,MaintenanceIssueConflictError,MaintenanceIssueSourceUnavailableError} from "@/modules/maintenance/domain/issue-context";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {WorkOrderAccessError,WorkOrderConflictError} from "@/modules/maintenance/domain/work-order";
/** Reuse native actor scoping, same-origin JSON admission, private headers,
 * bounded I/O and masked errors without a parallel authorization framework. */
export function maintenanceIssueHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>,feature="F-MNT-01"){
 return inventoryCatalogHttp(request,async(actor,input,requestId)=>{
  try{return await work(actor,input,requestId);}catch(error){if(error instanceof MaintenanceIssueAccessError||error instanceof WorkOrderAccessError)throw new InventoryItemAccessError();if(error instanceof MaintenanceIssueConflictError||error instanceof MaintenanceIssueSourceUnavailableError||error instanceof WorkOrderConflictError)throw new InventoryItemConflictError();throw error;}
 },feature,262144);
}
