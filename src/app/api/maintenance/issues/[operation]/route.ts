import type {NextRequest} from "next/server";
import {z} from "zod";
import {maintenanceIssueHttp} from "@/platform/maintenance/issue-http";
import {readMaintenanceIssue} from "@/modules/maintenance/application/issue-read-service";
import {readMaintenanceIssueHistory} from "@/modules/maintenance/application/issue-history-service";
import {maintenanceIssueSourceChoices} from "@/modules/maintenance/application/issue-source-choices";
import {previewMaintenanceIssueLink,publishMaintenanceIssueLink,recoverMaintenanceIssueLink,maintenanceIssueCommandStatus} from "@/modules/maintenance/application/issue-link-service";
export const runtime="nodejs";
const operations={read:readMaintenanceIssue,history:readMaintenanceIssueHistory,sources:maintenanceIssueSourceChoices,review:previewMaintenanceIssueLink,publish:publishMaintenanceIssueLink,recover:recoverMaintenanceIssueLink,status:maintenanceIssueCommandStatus};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const operation=z.enum(["read","history","sources","review","publish","recover","status"]).safeParse((await params).operation);
 return maintenanceIssueHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});});
}
