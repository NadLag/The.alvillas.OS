import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";

export type ServiceCatalogBrowserState="loading"|"ready"|"offline"|"forbidden"|"uncertain"|"conflict"|"configuration_unavailable"|"validation"|"unavailable"|"storage_unavailable";
export type ServicePrivateBrowserState=ServiceCatalogBrowserState|"source_unavailable";
export class ServicePrivateBrowserError extends Error{constructor(readonly state:ServicePrivateBrowserState){super(state);}}
export class ServiceCatalogBrowserError extends Error{constructor(readonly state:ServiceCatalogBrowserState){super(state);}}
export async function serviceCatalogRequest(operation:"review"|"publish"|"recover"|"page"|"history"|"version"|"financial"|"providers",input:unknown,signal:AbortSignal,scope:string):Promise<unknown>{
 try{return await privateServiceRequest("catalog",operation,input,signal,scope);}catch(error){if(error instanceof ServicePrivateBrowserError)throw new ServiceCatalogBrowserError(error.state==="source_unavailable"?"configuration_unavailable":error.state);throw error;}
}
export async function privateServiceRequest(namespace:"catalog"|"orders",operation:string,input:unknown,signal:AbortSignal,scope:string):Promise<unknown>{
 const mutation=operation==="publish"||operation==="create"||operation==="transition";
 try{
  const response=await fetch("/api/services/"+namespace+"/"+operation,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",signal,headers:{"content-type":"application/json","x-alvillas-service-scope":scope},body:JSON.stringify(input)});
  if(response.status===401||response.status===403){await response.body?.cancel().catch(()=>undefined);throw new ServicePrivateBrowserError("forbidden");}
  const bytes=await readBoundedResponseBytes(response,2097152);let value:unknown;try{value=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
  if(!response.ok){const error=z.object({error:z.enum(["validation","conflict","configuration_unavailable","source_unavailable"])}).safeParse(value);if(error.success)throw new ServicePrivateBrowserError(error.data.error);throw new ServicePrivateBrowserError(mutation?"uncertain":"unavailable");}
  if(!response.headers.get("content-type")?.includes("application/json"))throw new ServicePrivateBrowserError(mutation?"uncertain":"unavailable");return value;
 }catch(error){if(error instanceof ServicePrivateBrowserError)throw error;if(signal.aborted)throw error;throw new ServicePrivateBrowserError(mutation?"uncertain":typeof navigator!=="undefined"&&!navigator.onLine?"offline":"unavailable");}
}
