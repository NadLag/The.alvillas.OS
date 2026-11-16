import {NextResponse,type NextRequest} from "next/server";
import {ZodError} from "zod";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession,type AccountActorContext} from "@/platform/authz/session-context";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {captureException} from "@/platform/observability/sentry";
import {PropertyConfigurationAuthorizationError} from "@/platform/config/property-configuration";
import {ServiceCatalogAccessError,ServiceCatalogConflictError,ServiceCatalogConfigurationError,ServiceCatalogValidationError} from "../domain/service-catalog";

export const serviceCatalogPrivateHeaders={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",Vary:"Cookie, Origin"};
export async function serviceCatalogHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>,classify?:(error:unknown)=>{error:string;status:number}|null){
 const requestId=crypto.randomUUID(),failure=(error:string,status:number)=>NextResponse.json({error},{status,headers:serviceCatalogPrivateHeaders});
 try{
  const actor=await accountActorContextFromSession(await auth());if(!actor)return failure("unauthorized",401);
  if(!isSameOriginContentType(request,"application/json")||request.headers.get("x-alvillas-service-scope")!==actor.organizationId+"."+actor.actorId)return failure("forbidden",403);
  if(request.nextUrl.search)return failure("validation",400);let input:unknown;try{input=await readBoundedJsonRequest(request,262144);}catch{return failure("validation",400);}
  return NextResponse.json(await work(actor,input,requestId),{headers:serviceCatalogPrivateHeaders});
 }catch(error){
  const specific=classify?.(error);if(specific)return failure(specific.error,specific.status);
  if(error instanceof ServiceCatalogAccessError||error instanceof PropertyConfigurationAuthorizationError)return failure("forbidden",403);
  if(error instanceof ServiceCatalogConflictError)return failure("conflict",409);
  if(error instanceof ZodError||error instanceof ServiceCatalogValidationError)return failure("validation",400);
  if(error instanceof ServiceCatalogConfigurationError)return failure("configuration_unavailable",503);
  try{await captureException(new Error("Private service catalog request unavailable"),{source:"api",requestId,tags:{feature:"F-SVC-01"}});}catch{/* Private responses remain available without telemetry. */}return failure("unavailable",503);
 }
}
