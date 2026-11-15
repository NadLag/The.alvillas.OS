import type {z} from "zod";
import {documentUploadChunkBytes,documentSingleBodyBytes} from "@/modules/documents";
import {guestHubIdentityDocumentFileSchema} from "../domain/guest-hub-identity-document-contract";
import {guestHubIdentityFileStatusSchema} from "../domain/guest-hub-identity-file-read-model";
import {guestHubRequest,GuestHubBrowserError} from "./guest-hub-browser";

type Descriptor=z.infer<typeof guestHubIdentityDocumentFileSchema>;
const interrupted=(signal:AbortSignal)=>{if(signal.aborted)throw new DOMException("Aborted","AbortError");};
async function digest(bytes:Uint8Array){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(bytes))),byte=>byte.toString(16).padStart(2,"0")).join("");}
/** File names and bytes stay transient; only the closed descriptor is reviewed. */
export async function prepareGuestHubIdentityFile(file:File,kind:Descriptor["kind"],part:Descriptor["part"],limit:{maxBytes:number;contentTypes:readonly string[]},signal:AbortSignal){
 interrupted(signal);if(!file.size||file.size>limit.maxBytes||!limit.contentTypes.includes(file.type))throw new GuestHubBrowserError("validation");
 const bytes=new Uint8Array(await file.arrayBuffer());try{
  interrupted(signal);const parts=bytes.length>documentSingleBodyBytes?{schemaVersion:1,chunkBytes:documentUploadChunkBytes,hashes:await Promise.all(Array.from({length:Math.ceil(bytes.length/documentUploadChunkBytes)},(_,index)=>digest(bytes.subarray(index*documentUploadChunkBytes,(index+1)*documentUploadChunkBytes))))}:undefined;
  const descriptor=guestHubIdentityDocumentFileSchema.parse({kind,part,contentType:file.type,fileSize:bytes.length,sha256:await digest(bytes),...parts?{parts}:{}});interrupted(signal);return descriptor;
 }finally{bytes.fill(0);}
}
/** Resume sends the selected original bytes. The server rechecks their original
 * encrypted commitment; no saved browser hash can substitute for those bytes. */
export async function uploadGuestHubIdentityFile(linkId:string,captureId:string,item:{id:string;kind:Descriptor["kind"];part:Descriptor["part"]},file:File,signal:AbortSignal){
 const path="links/"+linkId+"/identity-documents/"+captureId+"/files/"+item.id+"/";
 function checked(raw:unknown){const result=guestHubIdentityFileStatusSchema.parse(raw);if(result.captureId!==captureId||result.fileId!==item.id||result.kind!==item.kind||result.part!==item.part)throw new GuestHubBrowserError("uncertain");return result;}
 if(file.size<=documentSingleBodyBytes){const bytes=new Uint8Array(await file.arrayBuffer());try{interrupted(signal);return checked(await guestHubRequest(path+"upload",null,signal,undefined,{binary:bytes}));}finally{bytes.fill(0);}}
 for(let index=0;index<Math.ceil(file.size/documentUploadChunkBytes);index++){
  interrupted(signal);const bytes=new Uint8Array(await file.slice(index*documentUploadChunkBytes,(index+1)*documentUploadChunkBytes).arrayBuffer());try{const result=checked(await guestHubRequest(path+"parts/"+index,null,signal,undefined,{binary:bytes}));if(result.state==="PUBLISHED")return result;}finally{bytes.fill(0);}
 }
 interrupted(signal);return checked(await guestHubRequest(path+"complete",{},signal));
}
