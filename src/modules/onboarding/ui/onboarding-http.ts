import {NextResponse,type NextRequest} from "next/server";
import {ZodError} from "zod";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession,type AccountActorContext} from "@/platform/authz/session-context";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {captureException} from "@/platform/observability/sentry";
import {NativeOnboardingTeamAuthorizationError,NativeOnboardingTeamConflictError,NativeOnboardingTeamNotFoundError} from "@/platform/onboarding/team-source";
import {NativeOnboardingBookingChannelAuthorizationError,NativeOnboardingBookingChannelNotFoundError,NativeOnboardingBookingChannelValidationError} from "@/platform/onboarding/booking-channels-source";
import {NativeOnboardingInventoryAuthorizationError,NativeOnboardingInventoryConflictError,NativeOnboardingInventoryNotFoundError} from "@/platform/onboarding/inventory-source";
import {onboardingMaximumRequestBytes,OnboardingAccessError,OnboardingConflictError,OnboardingConfigurationError,OnboardingRateLimitError} from "../domain/onboarding-wizard";

const headers={"Cache-Control":"private, no-store",Vary:"Cookie, Origin"};
const failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});
export async function onboardingHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>){
 const requestId=crypto.randomUUID();
 try{
  const actor=await accountActorContextFromSession(await auth());if(!actor)return failure("unauthorized",401);
  if(!isSameOriginContentType(request,"application/json")||request.headers.get("x-alvillas-onboarding-scope")!==actor.organizationId+"."+actor.actorId)return failure("forbidden",403);
  if(request.nextUrl.search)return failure("validation",400);let input:unknown;try{input=await readBoundedJsonRequest(request,onboardingMaximumRequestBytes);}catch{return failure("validation",400);}
  const value=await work(actor,input,requestId),response=NextResponse.json(value,{headers});
  if(["/api/onboarding/read","/api/onboarding/review"].includes(request.nextUrl.pathname)){
   const step=value!==null&&typeof value==="object"&&"draft"in value&&value.draft!==null&&typeof value.draft==="object"&&"step"in value.draft?value.draft.step:null;
   if(step==="WORKFLOWS"||step==="REVIEW")response.headers.set("x-alvillas-onboarding-record-step",step);
  }
  return response;
 }catch(error){
  if(error instanceof OnboardingAccessError||error instanceof NativeOnboardingTeamAuthorizationError||error instanceof NativeOnboardingTeamNotFoundError||error instanceof NativeOnboardingBookingChannelAuthorizationError||error instanceof NativeOnboardingBookingChannelNotFoundError||error instanceof NativeOnboardingInventoryAuthorizationError||error instanceof NativeOnboardingInventoryNotFoundError)return failure("forbidden",403);
  if(error instanceof ZodError||error instanceof NativeOnboardingBookingChannelValidationError)return failure("validation",400);
  if(error instanceof OnboardingConflictError||error instanceof NativeOnboardingTeamConflictError||error instanceof NativeOnboardingInventoryConflictError)return failure("conflict",409);
  if(error instanceof OnboardingConfigurationError)return failure("configuration_unavailable",503);
  if(error instanceof OnboardingRateLimitError){const response=failure("rate_limited",429);response.headers.set("Retry-After",String(Math.max(1,Math.ceil((error.resetAt.getTime()-Date.now())/1000))));return response;}
  try{await captureException(new Error("Private onboarding request unavailable"),{source:"api",requestId,tags:{feature:"F-ONB-01"}});}catch{/* Preserve private responses if telemetry is unavailable. */}
  return failure("unavailable",503);
 }
}
