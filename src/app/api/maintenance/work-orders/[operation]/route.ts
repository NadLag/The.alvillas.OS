import type {NextRequest} from "next/server";
import {z} from "zod";
import {maintenanceIssueHttp} from "@/platform/maintenance/issue-http";
import {readIssueWorkOrders,workOrderTaskChoices} from "@/modules/maintenance/application/work-order-workspace";
import {previewWorkOrderRegistration,publishWorkOrderRegistration,recoverWorkOrderRegistration,workOrderRegistrationCommandStatus} from "@/modules/maintenance/application/work-order-registration";
import {
  previewWorkOrderFinance, publishWorkOrderFinance, readWorkOrderFinance, searchWorkOrderFinance, workOrderFinanceStatus
} from "@/modules/maintenance/application/work-order-finance";
export const runtime="nodejs";
const operations={read:readIssueWorkOrders,tasks:workOrderTaskChoices,review:previewWorkOrderRegistration,publish:publishWorkOrderRegistration,recover:recoverWorkOrderRegistration,status:workOrderRegistrationCommandStatus, "finance-read":readWorkOrderFinance, "finance-search":searchWorkOrderFinance, "finance-review":previewWorkOrderFinance, "finance-publish":publishWorkOrderFinance, "finance-status":workOrderFinanceStatus};
export async function POST(request:NextRequest,{params}:{params:Promise<{operation:string}>}){
 const operation=z.enum(["read","tasks","review","publish","recover","status","finance-read","finance-search","finance-review","finance-publish","finance-status"]).safeParse((await params).operation);
 return maintenanceIssueHttp(request,(actor,input,requestId)=>{if(!operation.success)throw new z.ZodError([]);return operations[operation.data](actor,input,{requestId});},"F-MNT-02");
}
