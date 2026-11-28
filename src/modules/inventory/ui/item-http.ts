import {NextResponse,type NextRequest} from "next/server";
import {ZodError} from "zod";
import {auth} from "@/platform/auth/session";
import {accountActorContextFromSession,type AccountActorContext} from "@/platform/authz/session-context";
import {isSameOriginContentType} from "@/platform/http/same-origin";
import {readBoundedJsonRequest} from "@/platform/http/read-exact-response";
import {captureException} from "@/platform/observability/sentry";
import {InventoryItemAccessError,InventoryItemConflictError,InventoryItemDefinitionError,InventoryItemStockHeldError} from "../domain/item-catalog";
export const inventoryPrivateHeaders={"Cache-Control":"private, no-store","Referrer-Policy":"no-referrer",Vary:"Cookie, Origin"};
export const inventoryItemHttp=(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>)=>inventoryCatalogHttp(request,work);
export async function inventoryCatalogHttp(request:NextRequest,work:(actor:AccountActorContext,input:unknown,requestId:string)=>Promise<unknown>,feature="F-INV-01"){
 const requestId=crypto.randomUUID(),failure=(error:string,status:number)=>NextResponse.json({error},{status,headers:inventoryPrivateHeaders});
 try{
  const actor=await accountActorContextFromSession(await auth());if(!actor)return failure("unauthorized",401);
  if(!isSameOriginContentType(request,"application/json")||request.headers.get("x-alvillas-inventory-scope")!==actor.organizationId+"."+actor.actorId)return failure("forbidden",403);
  if(request.nextUrl.search)return failure("validation",400);let input:unknown;try{input=await readBoundedJsonRequest(request,32768);}catch{return failure("validation",400);}
  return NextResponse.json(await work(actor,input,requestId),{headers:inventoryPrivateHeaders});
 }catch(error){
  if(error instanceof InventoryItemAccessError)return failure("forbidden",403);
  if(error instanceof InventoryItemConflictError)return failure("conflict",409);
  if(error instanceof InventoryItemStockHeldError)return failure("stock_held",409);
  if(error instanceof InventoryItemDefinitionError||error instanceof ZodError)return failure("validation",400);
  try{await captureException(new Error("Private inventory catalog request unavailable"),{source:"api",requestId,tags:{feature}});}catch{/* Preserve the private failure response if telemetry is unavailable. */}
  return failure("unavailable",503);
 }
}
