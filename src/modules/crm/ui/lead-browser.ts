import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";
export type LeadBrowserState="ready"|"loading"|"saved"|"uncertain"|"forbidden"|"offline"|"validation"|"conflict"|"configuration_unavailable"|"rate_limited"|"native_evidence_required"|"unavailable";
export class LeadBrowserError extends Error{constructor(readonly state:LeadBrowserState){super(state);}}
export type LeadEndpoint="capture"|"capture/recover"|"workspace/list"|"workspace/options"|"profiles/review"|"profiles/admit"|"profiles/recover"|"profiles/history"|"stages/review"|"stages/admit"|"stages/recover"|"stages/history"|"work/review"|"work/admit"|"work/recover"|"work/history"|"work/options"|"work/candidates";
export async function leadRequest(scope:string,path:LeadEndpoint,input:unknown,signal:AbortSignal):Promise<unknown>{
  const mutation=path==="capture"||path.endsWith("/admit");
  try{
    const response=await fetch("/api/crm/leads/"+path,{method:"POST",credentials:"same-origin",cache:"no-store",signal,headers:{"content-type":"application/json","x-alvillas-crm-scope":scope},body:JSON.stringify(input)});
    if(response.status===401||response.status===403){await response.body?.cancel().catch(()=>undefined);throw new LeadBrowserError("forbidden");}
    const bytes=await readBoundedResponseBytes(response,path==="workspace/options"?16777216:1048576);let value:unknown;try{value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
    if(!response.ok){const parsed=z.object({error:z.enum(["validation","conflict","configuration_unavailable","rate_limited","native_evidence_required"])}).safeParse(value);if(parsed.success)throw new LeadBrowserError(parsed.data.error);throw new LeadBrowserError(mutation?"uncertain":"unavailable");}
    if(!response.headers.get("content-type")?.includes("application/json"))throw new LeadBrowserError(mutation?"uncertain":"unavailable");return value;
  }catch(error){if(error instanceof LeadBrowserError)throw error;if(signal.aborted)throw error;throw new LeadBrowserError(mutation?"uncertain":"unavailable");}
}
export function readLeadNonce(key:string){try{const value=z.uuid().safeParse(sessionStorage.getItem(key));return value.success?value.data:null;}catch{return null;}}
export function writeLeadNonce(key:string,value:string){try{sessionStorage.setItem(key,z.uuid().parse(value));}catch{/* The nonce also stays in the active operation's memory. */}}
export function clearLeadNonce(key:string,value:string){try{if(sessionStorage.getItem(key)===value)sessionStorage.removeItem(key);}catch{/* Storage is optional. */}}
