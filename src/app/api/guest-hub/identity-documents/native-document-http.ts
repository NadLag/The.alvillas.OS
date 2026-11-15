import {NextResponse,type NextRequest} from "next/server";
import {z,ZodError} from "zod";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest,readBoundedRequestBytes} from "@/platform/http/read-exact-response";
import {loginRateLimitIp} from "@/platform/auth/login-rate-limit";
import {fieldUploadMaximumParts} from "@/platform/storage/upload-protocol";
import {captureException} from "@/platform/observability/sentry";
import type {GuestHubDependencies} from "@/modules/guest-hub/application/guest-hub-service";
import {createGuestHubIdentityUploadRequest,createGuestHubIdentityFileStatusRequest} from "@/modules/guest-hub/application/guest-hub-identity-upload-request";
import {guestHubFormPublicHttp,guestHubFormPublicHeaders} from "@/modules/guest-hub/ui/guest-hub-form-public-http";
import {guestHubCapabilityCookie} from "@/modules/guest-hub/domain/guest-hub-cookie";
import {guestHubIdentityDocumentMaximumJsonBytes} from "@/modules/guest-hub/domain/guest-hub-identity-document-contract";
import {GuestHubInvalidLinkError,GuestHubRateLimitError,GuestHubConfigurationError} from "@/modules/guest-hub/domain/guest-hub-policy";
import {DocumentAccessError,DocumentConflictError,DocumentRateLimitError,DocumentConfigurationError,DocumentStorageError} from "@/modules/documents/domain/document-command";
import {documentSingleBodyBytes,documentUploadChunkBytes} from "@/modules/documents/domain/document-upload-parts";
import type {DocumentObjectStore} from "@/modules/documents/application/document-files";
import {configuredDocumentObjects} from "@/modules/documents/application/document-files";
import {nativeGuestIdentityDocumentAuthority} from "./native-document-authority";
import {nativeGuestIdentityCaptures} from "./native-document-services";
import {createNativeGuestIdentityFileArchive} from "./native-document-archive";

type Dependencies=GuestHubDependencies&{verificationOrganizationId?:string;objects?:()=>DocumentObjectStore};
export function nativeGuestIdentityCaptureHttp(request:NextRequest,deps:Dependencies,linkId:unknown,action:"view"|"review"|"admit"|"recover"){
 return guestHubFormPublicHttp(request,deps,linkId,action,{feature:"F-GST-05",maximumRequestBytes:guestHubIdentityDocumentMaximumJsonBytes,view:(capability,context)=>nativeGuestIdentityCaptures.view(capability,context),review:(capability,input,context)=>nativeGuestIdentityCaptures.review(capability,input,context),admit:(capability,input,context)=>nativeGuestIdentityCaptures.record(capability,input,context),recover:(capability,input,context)=>nativeGuestIdentityCaptures.recover(capability,input,context)});
}
const fileReference=z.object({linkId:z.uuid(),captureId:z.uuid(),fileId:z.uuid()}).strict();
type Action="status"|"admit"|"upload"|"part"|"complete";
/** Cookie-only private capabilities and bounded bytes never enter URLs, telemetry,
 * browser storage or an outer database transaction around object I/O. */
export async function nativeGuestIdentityFileHttp(request:NextRequest,deps:Dependencies,rawReference:unknown,action:Action,rawIndex?:unknown){
 const requestId=crypto.randomUUID(),headers=guestHubFormPublicHeaders,failure=(error:string,status:number)=>NextResponse.json({error},{status,headers}),binary=action==="upload"||action==="part";
 try{
  if(!isSameOriginContentType(request,binary?"application/octet-stream":"application/json"))return failure("forbidden",403);
  if(request.nextUrl.search)return failure("validation",400);const reference=fileReference.parse(rawReference),index=action==="part"?Number(z.string().regex(/^(?:0|[1-9]\d*)$/u).parse(rawIndex)):undefined;if(index!==undefined&&(!Number.isSafeInteger(index)||index>=fieldUploadMaximumParts))throw new ZodError([]);
  const {objects:objectFactory,...base}=deps,cookie=guestHubCapabilityCookie(reference.linkId,deps.env),capability={token:request.cookies.get(cookie.name)?.value??""},context={...base,requestId,expectedLinkId:reference.linkId,clientKey:loginRateLimitIp(request.headers)};
  const factory=action==="status"?createGuestHubIdentityFileStatusRequest:createGuestHubIdentityUploadRequest,lease=await factory(capability,{captureId:reference.captureId,fileId:reference.fileId},context,nativeGuestIdentityDocumentAuthority),file=await createNativeGuestIdentityFileArchive(lease,{...context,...binary||action==="complete"?{objects:(objectFactory??configuredDocumentObjects)()}: {}});
  let result:unknown;if(binary){let bytes:Uint8Array;try{bytes=await readBoundedRequestBytes(request,action==="part"?documentUploadChunkBytes:documentSingleBodyBytes);}catch{return failure("validation",400);}try{result=action==="part"?await file.part(index!,bytes):await file.upload(bytes);}finally{bytes.fill(0);}}
  else{try{z.object({}).strict().parse(await readBoundedJsonRequest(request,256));}catch{return failure("validation",400);}result=action==="status"?await file.status():action==="admit"?await file.admit():await file.complete();}
  return NextResponse.json(result,{headers});
 }catch(error){
  if(error instanceof GuestHubInvalidLinkError||error instanceof DocumentAccessError)return failure("link_unavailable",404);
  if(error instanceof GuestHubRateLimitError||error instanceof DocumentRateLimitError)return failure("rate_limited",429);
  if(error instanceof ZodError)return failure("validation",400);if(error instanceof DocumentConflictError)return failure("conflict",409);
  if(error instanceof GuestHubConfigurationError||error instanceof DocumentConfigurationError)return failure("configuration_unavailable",503);if(error instanceof DocumentStorageError)return failure("storage_unavailable",503);
  try{await captureException(new Error("Private guest file request unavailable"),{source:"api",requestId,tags:{feature:"F-GST-05"}});}catch{/* Never forward original capability, document or file errors. */}return failure("unavailable",503);
 }
}
