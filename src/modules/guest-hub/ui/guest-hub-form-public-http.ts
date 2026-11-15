import {NextResponse,type NextRequest} from "next/server";
import {z,ZodError} from "zod";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {loginRateLimitIp} from "@/platform/auth/login-rate-limit";
import {captureException} from "@/platform/observability/sentry";
import type {GuestHubDependencies} from "../application/guest-hub-service";
import type {GuestHubVisitDependencies} from "../application/guest-hub-visit";
import {guestHubCapabilityCookie} from "../domain/guest-hub-cookie";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {guestHubMaximumRequestBytes,GuestHubInvalidLinkError,GuestHubRateLimitError,GuestHubConfigurationError} from "../domain/guest-hub-policy";

type Command=(capability:unknown,input:unknown,deps:GuestHubVisitDependencies)=>Promise<unknown>;
type Definition={feature:"F-GST-03"|"F-GST-04"|"F-GST-05";maximumRequestBytes?:number;view:(capability:unknown,deps:GuestHubVisitDependencies)=>Promise<unknown>;review:Command;admit:Command;recover:Command;validation?:(error:unknown)=>unknown};
export const guestHubFormPublicHeaders={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",Vary:"Cookie, Origin"};
const headers=guestHubFormPublicHeaders,empty=z.object({}).strict();
/** Every self-service form retains the original cookie, CSRF, body, cache and sanitized-error boundary. */
export async function guestHubFormPublicHttp(request:NextRequest,deps:GuestHubDependencies&{verificationOrganizationId?:string},rawLinkId:unknown,action:"view"|"review"|"admit"|"recover",definition:Definition){
 const requestId=crypto.randomUUID(),failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});
 try{if(!isSameOriginContentType(request,"application/json"))return failure("forbidden",403);if(request.nextUrl.search)return failure("validation",400);let input:unknown;try{input=await readBoundedJsonRequest(request,definition.maximumRequestBytes??guestHubMaximumRequestBytes);}catch{return failure("validation",400);}const linkId=guestHubIdSchema.parse(rawLinkId),cookie=guestHubCapabilityCookie(linkId,deps.env),capability={token:request.cookies.get(cookie.name)?.value??""},context={...deps,requestId,expectedLinkId:linkId,clientKey:loginRateLimitIp(request.headers)};let result:unknown;if(action==="view"){empty.parse(input);result=await definition.view(capability,context);}else result=await definition[action](capability,input,context);return NextResponse.json(result,{headers});
 }catch(error){if(error instanceof GuestHubInvalidLinkError)return failure("link_unavailable",404);if(error instanceof GuestHubRateLimitError)return failure("rate_limited",429);if(error instanceof ZodError)return failure("validation",400);if(error instanceof GuestHubConfigurationError)return failure("configuration_unavailable",503);const validation=definition.validation?.(error);if(validation)return NextResponse.json(validation,{status:400,headers});try{await captureException(new Error("Guest form request unavailable"),{source:"api",requestId,tags:{feature:definition.feature}});}catch{/* Never forward form values, capability bytes or original exceptions. */}return failure("unavailable",503);}
}
