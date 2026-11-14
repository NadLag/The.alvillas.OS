import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";

export type GuestHubBrowserState="loading"|"ready"|"uncertain"|"forbidden"|"offline"|"validation"|"conflict"|"configuration_unavailable"|"rate_limited"|"link_unavailable"|"unavailable";
export class GuestHubBrowserError extends Error{constructor(readonly state:GuestHubBrowserState){super(state);}}
export async function guestHubRequest(path:string,input:unknown,signal:AbortSignal,scope?:string):Promise<unknown>{
 const mutation=path==="issue/admit"||path==="revoke/admit";
 try{
  if(!/^(?:issue\/(?:review|admit|recover)|revoke\/(?:review|admit|recover)|directory|visit|links\/[a-f0-9-]{36}\/visit)$/u.test(path))throw new GuestHubBrowserError("validation");
  const response=await fetch("/api/guest-hub/"+path,{method:"POST",credentials:"same-origin",cache:"no-store",signal,headers:{"content-type":"application/json",...scope?{"x-alvillas-guest-hub-scope":scope}:{}},body:JSON.stringify(input)});
  if(response.status===401||response.status===403){await response.body?.cancel().catch(()=>undefined);throw new GuestHubBrowserError("forbidden");}
  const bytes=await readBoundedResponseBytes(response,65536);let value:unknown;try{value=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
  if(!response.ok){const error=z.object({error:z.enum(["validation","conflict","configuration_unavailable","rate_limited","link_unavailable"])}).safeParse(value);if(error.success)throw new GuestHubBrowserError(error.data.error);throw new GuestHubBrowserError(mutation?"uncertain":"unavailable");}
  if(!response.headers.get("content-type")?.includes("application/json"))throw new GuestHubBrowserError(mutation?"uncertain":"unavailable");return value;
 }catch(error){if(error instanceof GuestHubBrowserError)throw error;if(signal.aborted)throw error;throw new GuestHubBrowserError(mutation?"uncertain":typeof navigator!=="undefined"&&!navigator.onLine?"offline":"unavailable");}
}
