import {NextResponse,type NextRequest} from "next/server";
import {z,ZodError} from "zod";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {loginRateLimitIp} from "@/platform/auth/login-rate-limit";
import {captureException} from "@/platform/observability/sentry";
import {visitGuestHubLink} from "../application/guest-hub-visit";
import type {GuestHubDependencies} from "../application/guest-hub-service";
import {guestHubCapabilityCookie} from "../domain/guest-hub-cookie";
import {guestHubIdSchema,guestHubPublicInputSchema} from "../domain/guest-hub-contract";
import {guestHubMaximumRequestBytes,GuestHubInvalidLinkError,GuestHubRateLimitError,GuestHubConfigurationError} from "../domain/guest-hub-policy";

const headers={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",Vary:"Cookie, Origin"},empty=z.object({}).strict();
type Dependencies=GuestHubDependencies&{verificationOrganizationId?:string};
export async function guestHubPublicHttp(request:NextRequest,deps:Dependencies,rawLinkId?:unknown){
 const requestId=crypto.randomUUID(),failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});
 try{
  if(!isSameOriginContentType(request,"application/json"))return failure("forbidden",403);if(request.nextUrl.search)return failure("validation",400);
  let input:unknown;try{input=await readBoundedJsonRequest(request,guestHubMaximumRequestBytes);}catch{return failure("validation",400);}
  const linkId=rawLinkId===undefined?undefined:guestHubIdSchema.parse(rawLinkId),cookie=linkId?guestHubCapabilityCookie(linkId,deps.env):null;
  if(cookie)empty.parse(input);const raw=cookie?{token:request.cookies.get(cookie.name)?.value??""}:input;
  const view=await visitGuestHubLink(raw,{...deps,requestId,clientKey:loginRateLimitIp(request.headers),expectedLinkId:linkId}),response=NextResponse.json(view,{headers});
  if(!cookie){const original=guestHubPublicInputSchema.parse(raw),descriptor=guestHubCapabilityCookie(view.id,deps.env);response.cookies.set({...descriptor,value:original.token});}
  return response;
 }catch(error){
  if(error instanceof GuestHubInvalidLinkError)return failure("link_unavailable",404);if(error instanceof GuestHubRateLimitError)return failure("rate_limited",429);if(error instanceof ZodError)return failure("validation",400);if(error instanceof GuestHubConfigurationError)return failure("configuration_unavailable",503);
  try{await captureException(new Error("Guest Hub visit unavailable"),{source:"api",requestId,tags:{feature:"F-GST-01"}});}catch{/* Never forward a capability or original exception to telemetry. */}return failure("unavailable",503);
 }
}
