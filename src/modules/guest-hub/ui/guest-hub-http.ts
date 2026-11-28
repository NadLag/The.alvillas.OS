import {NextResponse,type NextRequest} from "next/server";
import {ZodError} from "zod";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession,type AccountActorContext} from "@/platform/authz/session-context";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {captureException} from "@/platform/observability/sentry";
import {GuestHubAccessError,GuestHubConflictError,GuestHubConfigurationError,GuestHubRateLimitError,guestHubMaximumRequestBytes} from "../domain/guest-hub-policy";
import {GuestHubProfileAccessError,GuestHubProfileConflictError,GuestHubProfileConfigurationError} from "../domain/guest-hub-profile-policy";
import {GuestHubStayDetailsAccessError,GuestHubStayDetailsConflictError,GuestHubStayDetailsConfigurationError} from "../domain/guest-hub-stay-details-policy";
import {GuestHubIdentityDocumentAccessError,GuestHubIdentityDocumentConflictError,GuestHubIdentityDocumentConfigurationError} from "../domain/guest-hub-identity-document-policy";

import {GuestHubHouseRulesAccessError,GuestHubHouseRulesConflictError,GuestHubHouseRulesConfigurationError} from "../domain/guest-hub-house-rules-policy";
import {GuestHubAgreementAccessError,GuestHubAgreementConflictError,GuestHubAgreementConfigurationError} from "../domain/guest-hub-agreement-policy";
import {GuestHubServiceOrderAccessError,GuestHubServiceOrderConflictError,GuestHubServiceOrderConfigurationError} from "../domain/guest-hub-service-order-policy";
import { GuestHubLinkDeliveryAccessError } from "../domain/guest-hub-link-delivery";

export const guestHubPrivateHeaders={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",Vary:"Cookie, Origin"};
export async function guestHubStaffHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>){
 const requestId=crypto.randomUUID(),failure=(error:string,status:number)=>NextResponse.json({error},{status,headers:guestHubPrivateHeaders});
 try{
  const actor=await accountActorContextFromSession(await auth());if(!actor)return failure("unauthorized",401);
  if(!isSameOriginContentType(request,"application/json")||request.headers.get("x-alvillas-guest-hub-scope")!==actor.organizationId+"."+actor.actorId)return failure("forbidden",403);
  if(request.nextUrl.search)return failure("validation",400);let input:unknown;try{input=await readBoundedJsonRequest(request,guestHubMaximumRequestBytes);}catch{return failure("validation",400);}
  return NextResponse.json(await work(actor,input,requestId),{headers:guestHubPrivateHeaders});
 }catch(error){
  if(error instanceof GuestHubServiceOrderAccessError||error instanceof GuestHubLinkDeliveryAccessError)return failure("forbidden",403);
  if(error instanceof GuestHubServiceOrderConflictError)return failure("conflict",409);
  if(error instanceof GuestHubServiceOrderConfigurationError)return failure("configuration_unavailable",503);
  if(error instanceof GuestHubAccessError||error instanceof GuestHubProfileAccessError||error instanceof GuestHubStayDetailsAccessError||error instanceof GuestHubIdentityDocumentAccessError||error instanceof GuestHubHouseRulesAccessError||error instanceof GuestHubAgreementAccessError)return failure("forbidden",403);if(error instanceof ZodError)return failure("validation",400);
  if(error instanceof GuestHubConflictError||error instanceof GuestHubProfileConflictError||error instanceof GuestHubStayDetailsConflictError||error instanceof GuestHubIdentityDocumentConflictError||error instanceof GuestHubHouseRulesConflictError||error instanceof GuestHubAgreementConflictError)return failure("conflict",409);if(error instanceof GuestHubConfigurationError||error instanceof GuestHubProfileConfigurationError||error instanceof GuestHubStayDetailsConfigurationError||error instanceof GuestHubIdentityDocumentConfigurationError||error instanceof GuestHubHouseRulesConfigurationError||error instanceof GuestHubAgreementConfigurationError)return failure("configuration_unavailable",503);if(error instanceof GuestHubRateLimitError)return failure("rate_limited",429);
  try{await captureException(new Error("Private Guest Hub request unavailable"),{source:"api",requestId,tags:{feature:"F-GST-01"}});}catch{/* Private responses remain available without telemetry. */}return failure("unavailable",503);
 }
}
