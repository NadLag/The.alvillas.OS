import type {NextRequest} from "next/server";
import {z} from "zod";
import {maintenanceIssueHttp} from "@/platform/maintenance/issue-http";
import {readIssueWorkOrders,workOrderTaskChoices} from "@/modules/maintenance/application/work-order-workspace";
import {previewWorkOrderRegistration,publishWorkOrderRegistration,recoverWorkOrderRegistration,workOrderRegistrationCommandStatus} from "@/modules/maintenance/application/work-order-registration";
import {
  changeMaintenanceContractor, readMaintenanceContractor, searchMaintenanceContractors
} from "@/modules/maintenance/application/contractor-assignment";
export const runtime="nodejs";
const operations={read:readIssueWorkOrders,tasks:workOrderTaskChoices,review:previewWorkOrderRegistration,publish:publishWorkOrderRegistration,recover:recoverWorkOrderRegistration,status:workOrderRegistrationCommandStatus, "contractor-read":readMaintenanceContractor, "contractor-search":searchMaintenanceContractors, "contractor-publish":changeMaintenanceContractor};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const operation=z.enum(["read","tasks","review","publish","recover","status","contractor-read","contractor-search","contractor-publish"]).safeParse((await params).operation);
 return maintenanceIssueHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-MNT-02");
}
