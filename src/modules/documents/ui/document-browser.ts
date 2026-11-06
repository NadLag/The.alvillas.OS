import { z } from "zod";

export type DocumentBrowserState = "ready"|"loading"|"sending"|"saved"|"uncertain"|"forbidden"|"offline"|"validation"|"conflict"|"configuration_unavailable"|"storage_unavailable"|"rate_limited"|"unavailable";
export class DocumentBrowserError extends Error { constructor(readonly state:DocumentBrowserState){super(state);} }
export async function documentRequest(scope:string,path:string,input:unknown,signal:AbortSignal){
  const response=await fetch("/api/documents/"+path,{method:"POST",credentials:"same-origin",cache:"no-store",signal,headers:{"content-type":"application/json","x-alvillas-document-scope":scope},body:JSON.stringify(input)});
  if(!response.ok)await rejectDocumentResponse(response);return response;
}
export async function rejectDocumentResponse(response:Response):Promise<never>{
  if(response.status===401||response.status===403)throw new DocumentBrowserError("forbidden");
  if(response.status===400)throw new DocumentBrowserError("validation");
  let code:unknown;try{const value:unknown=await response.json();code=value&&typeof value==="object"&&"error"in value?value.error:null;}catch{/* Preserve a private generic failure. */}
  throw new DocumentBrowserError(code==="conflict"||code==="configuration_unavailable"||code==="storage_unavailable"||code==="rate_limited"?code:"unavailable");
}
export function readDocumentNonce(key:string){try{const parsed=z.uuid().safeParse(sessionStorage.getItem(key));return parsed.success?parsed.data:null;}catch{return null;}}
export function writeDocumentNonce(key:string,value:string){try{sessionStorage.setItem(key,z.uuid().parse(value));}catch{/* The same nonce remains available in memory. */}}
export function clearDocumentNonce(key:string,value:string){try{if(sessionStorage.getItem(key)===value)sessionStorage.removeItem(key);}catch{/* Storage is optional. */}}
