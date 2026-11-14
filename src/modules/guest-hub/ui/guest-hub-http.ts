import {NextResponse,type NextRequest} from "next/server";
import {ZodError} from "zod";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession,type AccountActorContext} from "@/platform/authz/session-context";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {captureException} from "@/platform/observability/sentry";
import {GuestHubAccessError,GuestHubConflictError,GuestHubConfigurationError,GuestHubRateLimitError,guestHubMaximumRequestBytes} from "../domain/guest-hub-policy";

export const guestHubPrivateHeaders={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",Vary:"Cookie, Origin"};
export async function guestHubStaffHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>){
 const requestId=crypto.randomUUID(),failure=(error:string,status:number)=>NextResponse.json({error},{status,headers:guestHubPrivateHeaders});
 try{
  const actor=await accountActorContextFromSession(await auth());if(!actor)return failure("unauthorized",401);
  if(!isSameOriginContentType(request,"application/json")||request.headers.get("x-alvillas-guest-hub-scope")!==actor.organizationId+"."+actor.actorId)return failure("forbidden",403);
  if(request.nextUrl.search)return failure("validation",400);let input:unknown;try{input=await readBoundedJsonRequest(request,guestHubMaximumRequestBytes);}catch{return failure("validation",400);}
  return NextResponse.json(await work(actor,input,requestId),{headers:guestHubPrivateHeaders});
 }catch(error){
  if(error instanceof GuestHubAccessError)return failure("forbidden",403);if(error instanceof ZodError)return failure("validation",400);
  if(error instanceof GuestHubConflictError)return failure("conflict",409);if(error instanceof GuestHubConfigurationError)return failure("configuration_unavailable",503);if(error instanceof GuestHubRateLimitError)return failure("rate_limited",429);
  try{await captureException(new Error("Private Guest Hub request unavailable"),{source:"api",requestId,tags:{feature:"F-GST-01"}});}catch{/* Private responses remain available without telemetry. */}return failure("unavailable",503);
 }
}
