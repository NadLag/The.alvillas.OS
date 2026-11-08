import {NextResponse,type NextRequest} from "next/server";
import {ZodError} from "zod";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession,type AccountActorContext} from "@/platform/authz/session-context";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {captureException} from "@/platform/observability/sentry";
import {leadCaptureMaximumRequestBytes,LeadAccessError,LeadValidationError,LeadConflictError,LeadConfigurationError,LeadRateLimitError} from "../domain/lead-capture";

const headers={"Cache-Control":"private, no-store",Vary:"Cookie, Origin"};
const failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});
async function boundary(request:NextRequest,work:(input:unknown,requestId:string)=>Promise<unknown>,options:{publicIntake:boolean;organizationId?:string}){
  const requestId=crypto.randomUUID();
  try{
    if(!isSameOriginContentType(request,"application/json"))return failure("forbidden",403);
    if(request.nextUrl.search)return failure("validation",400);
    let input:unknown;try{input=await readBoundedJsonRequest(request,leadCaptureMaximumRequestBytes);}catch{return failure("validation",400);}
    const value=await work(input,requestId);
    return options.publicIntake?NextResponse.json({accepted:true},{status:202,headers}):NextResponse.json(value,{headers});
  }catch(error){
    if(error instanceof LeadAccessError)return failure(options.publicIntake?"configuration_unavailable":"forbidden",options.publicIntake?503:403);
    if(error instanceof ZodError||error instanceof LeadValidationError)return failure("validation",400);
    if(error instanceof LeadConflictError)return failure("conflict",409);
    if(error instanceof LeadConfigurationError)return failure("configuration_unavailable",503);
    if(error instanceof LeadRateLimitError){const response=failure("rate_limited",429);response.headers.set("Retry-After",String(Math.max(1,Math.ceil((error.resetAt.getTime()-Date.now())/1000))));return response;}
    try{await captureException(new Error("Private lead request failed"),{source:"api",requestId,organizationId:options.organizationId,tags:{feature:"F-CRM-01"}});}catch{ /* Keep private responses when telemetry is unavailable. */ }
    return failure("unavailable",503);
  }
}

export async function leadHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>){
  try{
    const actor=await accountActorContextFromSession(await auth());if(!actor)return failure("unauthorized",401);
    const scope=request.headers.get("x-alvillas-crm-scope");if(scope!==null&&scope!==actor.organizationId+"."+actor.actorId)return failure("forbidden",403);
    return await boundary(request,(input,requestId)=>work(actor,input,requestId),{publicIntake:false,organizationId:actor.organizationId});
  }catch{
    try{await captureException(new Error("Private lead session unavailable"),{source:"api",requestId:crypto.randomUUID(),tags:{feature:"F-CRM-01"}});}catch{ /* Preserve the private response. */ }
    return failure("unavailable",503);
  }
}
export function websiteLeadHttp(request:NextRequest,work:(input:unknown,requestId:string)=>Promise<unknown>){return boundary(request,work,{publicIntake:true});}
