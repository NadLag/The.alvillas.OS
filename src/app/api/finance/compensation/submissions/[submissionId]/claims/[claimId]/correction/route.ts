import type {NextRequest} from "next/server";
import {compensationHttp} from "@/modules/finance/ui/compensation-http";
import {employeeCompensationCorrectionWorkspaceInput} from "@/modules/finance/domain/employee-compensation-correction-workspace";
import {getEmployeeCompensationCorrectionWorkspace} from "@/modules/finance/application/employee-compensation-correction-workspace";
export const runtime="nodejs";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest,context:{params:Promise<{submissionId:string;claimId:string}>}){
 return compensationHttp(request,async(actor,_input,requestId)=>{const params=await context.params,query=employeeCompensationCorrectionWorkspaceInput.omit({id:true,claimId:true}).parse(Object.fromEntries(request.nextUrl.searchParams));return getEmployeeCompensationCorrectionWorkspace(actor,{...query,id:params.submissionId,claimId:params.claimId},{requestId});},{feature:"employee-compensation-correction-workspace"});
}
