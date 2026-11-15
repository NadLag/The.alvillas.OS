import {NextResponse,type NextRequest} from "next/server";
import {ZodError} from "zod";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {loginRateLimitIp} from "@/platform/auth/login-rate-limit";
import {captureException} from "@/platform/observability/sentry";
import type {GuestHubAgreementVisitDependencies} from "../application/guest-hub-agreement-requests";
import {guestHubAgreementFileInputSchema} from "../domain/guest-hub-agreement-contract";
import {guestHubCapabilityCookie} from "../domain/guest-hub-cookie";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {GuestHubAgreementAccessError,GuestHubAgreementConfigurationError} from "../domain/guest-hub-agreement-policy";
import {guestHubMaximumRequestBytes,GuestHubInvalidLinkError,GuestHubRateLimitError,GuestHubConfigurationError} from "../domain/guest-hub-policy";
import {guestHubFormPublicHeaders} from "./guest-hub-form-public-http";

type Dependencies=Omit<GuestHubAgreementVisitDependencies,"clientKey">;
type Download=(capability:unknown,input:unknown,context:GuestHubAgreementVisitDependencies)=>Promise<{bytes:Uint8Array;contentType:string;fileName:string}>;
export async function guestHubAgreementFileHttp(request:NextRequest,deps:Dependencies,rawLinkId:unknown,download:Download){
 const requestId=crypto.randomUUID(),headers=guestHubFormPublicHeaders,failure=(error:string,status:number)=>NextResponse.json({error},{status,headers});
 try{
  if(request.method!=="POST"||!isSameOriginContentType(request,"application/json"))return failure("forbidden",403);if(request.nextUrl.search)return failure("validation",400);
  let raw:unknown;try{raw=await readBoundedJsonRequest(request,guestHubMaximumRequestBytes);}catch{return failure("validation",400);}
  const input=guestHubAgreementFileInputSchema.parse(raw),linkId=guestHubIdSchema.parse(rawLinkId),cookie=guestHubCapabilityCookie(linkId,deps.env),capability={token:request.cookies.get(cookie.name)?.value??""},file=await download(capability,input,{...deps,clientKey:loginRateLimitIp(request.headers),expectedLinkId:linkId,requestId});
  try{if(file.contentType!=="application/pdf")throw new GuestHubAgreementAccessError();const body=new Uint8Array(file.bytes),response=new NextResponse(body,{headers:{...headers,"Content-Type":"application/pdf","Content-Length":String(body.byteLength),"Content-Disposition":'attachment; filename="guest-agreement.pdf"',"Content-Security-Policy":"sandbox","X-Content-Type-Options":"nosniff","Cross-Origin-Resource-Policy":"same-origin"}});return response;}finally{file.bytes.fill(0);}
 }catch(error){
  if(error instanceof GuestHubInvalidLinkError||error instanceof GuestHubAgreementAccessError)return failure("link_unavailable",404);if(error instanceof GuestHubRateLimitError)return failure("rate_limited",429);if(error instanceof ZodError)return failure("validation",400);if(error instanceof GuestHubConfigurationError||error instanceof GuestHubAgreementConfigurationError)return failure("configuration_unavailable",503);
  try{await captureException(new Error("Guest agreement file unavailable"),{source:"api",requestId,tags:{feature:"F-GST-07"}});}catch{/* Never forward document, contact or capability bytes. */}return failure("unavailable",503);
 }
}
