import {NextResponse,type NextRequest} from "next/server";
import {z,ZodError} from "zod";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {loginRateLimitIp} from "@/platform/auth/login-rate-limit";
import {captureException} from "@/platform/observability/sentry";
import {viewGuestHubProfile,reviewGuestHubProfile,submitGuestHubProfile,recoverGuestHubProfile} from "../application/guest-hub-profile";
import type {GuestHubDependencies} from "../application/guest-hub-service";
import {guestHubCapabilityCookie} from "../domain/guest-hub-cookie";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {guestHubMaximumRequestBytes,GuestHubInvalidLinkError,GuestHubRateLimitError,GuestHubConfigurationError} from "../domain/guest-hub-policy";

const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",Vary:"Cookie, Origin"},empty=z.object({}).strict();
export async function guestHubProfilePublicHttp(request:NextRequest,deps:GuestHubDependencies&{verificationOrganizationId?:string},rawLinkId:unknown,action:"view"|"review"|"admit"|"recover"){
 const requestId=crypto.randomUUID(),failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});
 try{
  if(!isSameOriginContentType(request,"application/json"))return failure("forbidden",403);if(request.nextUrl.search)return failure("validation",400);
  let input:unknown;try{input=await readBoundedJsonRequest(request,guestHubMaximumRequestBytes);}catch{return failure("validation",400);}
  const linkId=guestHubIdSchema.parse(rawLinkId),cookie=guestHubCapabilityCookie(linkId,deps.env),capability={token:request.cookies.get(cookie.name)?.value??""},context={...deps,requestId,expectedLinkId:linkId,clientKey:loginRateLimitIp(request.headers)};
  let result:unknown;if(action==="view"){empty.parse(input);result=await viewGuestHubProfile(capability,context);}else if(action==="review")result=await reviewGuestHubProfile(capability,input,context);else if(action==="admit")result=await submitGuestHubProfile(capability,input,context);else result=await recoverGuestHubProfile(capability,input,context);
  return NextResponse.json(result,{headers});
 }catch(error){
  if(error instanceof GuestHubInvalidLinkError)return failure("link_unavailable",404);if(error instanceof GuestHubRateLimitError)return failure("rate_limited",429);if(error instanceof ZodError)return failure("validation",400);if(error instanceof GuestHubConfigurationError)return failure("configuration_unavailable",503);
  try{await captureException(new Error("Guest profile request unavailable"),{source:"api",requestId,tags:{feature:"F-GST-03"}});}catch{/* Never forward profile values, capability bytes or original exceptions. */}return failure("unavailable",503);
 }
}
