import { NextResponse,type NextRequest } from "next/server";
import { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { readBoundedJsonRequest } from "@/platform/http/read-exact-response";
import { isSameOriginContentType } from "@/platform/http/same-origin";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession,type FinanceActorContext } from "../application/finance-access";
import { EmployeeCompensationAccessError,EmployeeCompensationSourceUnavailableError,EmployeeCompensationBasisError } from "../domain/employee-compensation";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError,EmployeeCompensationRunPolicyError } from "../domain/employee-compensation-run";
import { EmployeeCompensationClaimSourceError } from "../domain/employee-compensation-claim";
import { ExpensePolicyUnavailableError } from "../application/expense-submission-policy";
import { EmployeeCompensationRecognitionSourceError } from "../domain/employee-compensation-recognition";
import { AccountingPeriodClosedError } from "../domain/accounting-period";

const headers={"Cache-Control":"private, no-store",Vary:"Cookie, Origin"};
const failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});

/** One session, origin, size and private-error boundary for compensation reads and commands. */
export async function compensationHttp(request:NextRequest,work:(actor:FinanceActorContext,input:unknown,requestId:string)=>Promise<unknown>,options:{json?:boolean;maxBytes?:number;feature:string;status?:200|202}){
  const requestId=crypto.randomUUID();
  try{
    const actor=await financeActorContextFromSession(await auth());
    if(!actor)return failure("unauthorized",401);
    let input:unknown;
    if(options.json){
      if(!isSameOriginContentType(request,"application/json"))return failure("forbidden",403);
      try{input=await readBoundedJsonRequest(request,options.maxBytes??65536);}catch{return failure("validation",400);}
    }
    return NextResponse.json(await work(actor,input,requestId),{headers,status:options.status??200});
  }catch(error){
    if(error instanceof ZodError||error instanceof EmployeeCompensationBasisError)return failure("validation",400);
    if(error instanceof EmployeeCompensationAccessError||error instanceof EmployeeCompensationRunAccessError)return failure("forbidden",403);
    if(error instanceof EmployeeCompensationSourceUnavailableError||error instanceof EmployeeCompensationClaimSourceError||error instanceof EmployeeCompensationRecognitionSourceError)return failure("source_unavailable",409);
    if(error instanceof AccountingPeriodClosedError)return failure("period_closed",409);
    if(error instanceof EmployeeCompensationRunPolicyError||error instanceof ExpensePolicyUnavailableError)return failure("configuration_unavailable",409);
    if(error instanceof EmployeeCompensationRunConflictError)return failure("conflict",409);
    try{await captureException(error,{source:"api",requestId,tags:{feature:options.feature}});}catch{/* Preserve the private response if telemetry delivery fails. */}
    return failure("unavailable",503);
  }
}
