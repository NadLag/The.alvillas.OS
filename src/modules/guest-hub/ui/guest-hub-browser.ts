import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";

export type GuestHubBrowserState="loading"|"ready"|"uncertain"|"forbidden"|"offline"|"validation"|"conflict"|"configuration_unavailable"|"rate_limited"|"link_unavailable"|"unavailable";
export class GuestHubBrowserError extends Error{constructor(readonly state:GuestHubBrowserState){super(state);}}
export class GuestHubBrowserValidationError extends GuestHubBrowserError{constructor(readonly fields:Readonly<Record<string,string>>){super("validation");}}
type Options={validationFields?:(value:unknown)=>Readonly<Record<string,string>>|null;binary?:Uint8Array};
export async function guestHubRequest(path:string,input:unknown,signal:AbortSignal,scope?:string,options?:Options):Promise<unknown>{
 const binary=options?.binary,mutation=binary!==undefined||path==="issue/admit"||path==="revoke/admit"||path==="agreement/release/admit"||/^(?:profile|stay-details|identity-documents|house-rules)\/grant\/admit$|^links\/[a-f0-9-]{36}\/(?:profile|stay-details|identity-documents|house-rules|agreement)\/admit$|^links\/[a-f0-9-]{36}\/identity-documents\/[a-f0-9-]{36}\/files\/[a-f0-9-]{36}\/(?:admit|complete)$/u.test(path);
 try{
  const jsonPath=/^(?:issue\/(?:review|admit|recover)|revoke\/(?:review|admit|recover)|directory|visit|agreement\/history|agreement\/release\/(?:status|choices|review|admit|recover)|house-rules\/history|(?:profile|stay-details|identity-documents|house-rules)\/grant\/(?:status|review|admit|recover)|links\/[a-f0-9-]{36}\/(?:visit|(?:profile|stay-details|identity-documents|house-rules|agreement)\/(?:view|review|admit|recover)|identity-documents\/[a-f0-9-]{36}\/files\/[a-f0-9-]{36}\/(?:status|admit|complete)))$/u;
  const binaryPath=/^links\/[a-f0-9-]{36}\/identity-documents\/[a-f0-9-]{36}\/files\/[a-f0-9-]{36}\/(?:upload|parts\/(?:0|[1-9]\d*))$/u;
  if(binary===undefined?!jsonPath.test(path):scope!==undefined||!binaryPath.test(path))throw new GuestHubBrowserError("validation");
  const response=await fetch("/api/guest-hub/"+path,{method:"POST",credentials:"same-origin",cache:"no-store",signal,headers:{"content-type":binary===undefined?"application/json":"application/octet-stream",...scope?{"x-alvillas-guest-hub-scope":scope}:{}},body:binary===undefined?JSON.stringify(input):new Uint8Array(binary)});
  if(response.status===401||response.status===403){await response.body?.cancel().catch(()=>undefined);throw new GuestHubBrowserError("forbidden");}
  // The closed three-language processing notice may contain 30 paragraphs of 240 Unicode characters.
  const bytes=await readBoundedResponseBytes(response,262144);let value:unknown;try{value=JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
  if(!response.ok){const error=z.object({error:z.enum(["validation","conflict","configuration_unavailable","rate_limited","link_unavailable"])}).safeParse(value);if(error.success){const fields=error.data.error==="validation"?options?.validationFields?.(value):null;if(fields)throw new GuestHubBrowserValidationError(fields);throw new GuestHubBrowserError(error.data.error);}throw new GuestHubBrowserError(mutation?"uncertain":"unavailable");}
  if(!response.headers.get("content-type")?.includes("application/json"))throw new GuestHubBrowserError(mutation?"uncertain":"unavailable");return value;
 }catch(error){if(error instanceof GuestHubBrowserError)throw error;if(signal.aborted)throw error;throw new GuestHubBrowserError(mutation?"uncertain":typeof navigator!=="undefined"&&!navigator.onLine?"offline":"unavailable");}
}
