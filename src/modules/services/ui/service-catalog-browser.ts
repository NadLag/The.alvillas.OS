import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";

export type ServiceCatalogBrowserState="loading"|"ready"|"offline"|"forbidden"|"uncertain"|"conflict"|"configuration_unavailable"|"validation"|"unavailable"|"storage_unavailable";
export class ServiceCatalogBrowserError extends Error{constructor(readonly state:ServiceCatalogBrowserState){super(state);}}
export async function serviceCatalogRequest(operation:"review"|"publish"|"recover"|"page"|"history"|"version"|"financial"|"providers",input:unknown,signal:AbortSignal,scope:string):Promise<unknown>{
 const mutation=operation==="publish";
 try{
  const response=await fetch("/api/services/catalog/"+operation,{method:"POST",credentials:"same-origin",cache:"no-store",redirect:"error",signal,headers:{"content-type":"application/json","x-alvillas-service-scope":scope},body:JSON.stringify(input)});
  if(response.status===401||response.status===403){await response.body?.cancel().catch(()=>undefined);throw new ServiceCatalogBrowserError("forbidden");}
  const bytes=await readBoundedResponseBytes(response,2097152);let value:unknown;try{value=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
  if(!response.ok){const error=z.object({error:z.enum(["validation","conflict","configuration_unavailable"])}).safeParse(value);if(error.success)throw new ServiceCatalogBrowserError(error.data.error);throw new ServiceCatalogBrowserError(mutation?"uncertain":"unavailable");}
  if(!response.headers.get("content-type")?.includes("application/json"))throw new ServiceCatalogBrowserError(mutation?"uncertain":"unavailable");return value;
 }catch(error){if(error instanceof ServiceCatalogBrowserError)throw error;if(signal.aborted)throw error;throw new ServiceCatalogBrowserError(mutation?"uncertain":typeof navigator!=="undefined"&&!navigator.onLine?"offline":"unavailable");}
}
