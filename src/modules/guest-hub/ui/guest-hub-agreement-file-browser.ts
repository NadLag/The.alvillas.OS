import {z} from "zod";
import {readBoundedResponseBytes} from "@/platform/http/read-exact-response";
import {fieldUploadChunkBytes,fieldUploadMaximumParts} from "@/platform/storage/upload-protocol";
import {guestHubAgreementFileInputSchema} from "../domain/guest-hub-agreement-contract";
import {guestHubIdSchema} from "../domain/guest-hub-contract";
import {GuestHubBrowserError} from "./guest-hub-browser";

/** An endpoint-specific reader cannot become another document's download proxy. */
export async function guestHubAgreementFile(linkId:string,kind:"ORIGINAL"|"SIGNED_ORIGINAL"|"CERTIFICATE",signal:AbortSignal){
 try{
  const id=guestHubIdSchema.parse(linkId),input=guestHubAgreementFileInputSchema.parse({kind}),response=await fetch("/api/guest-hub/links/"+id+"/agreement/file",{method:"POST",credentials:"same-origin",cache:"no-store",signal,headers:{"content-type":"application/json"},body:JSON.stringify(input)});
  if(!response.ok){if(response.status===401||response.status===403){await response.body?.cancel();throw new GuestHubBrowserError("forbidden");}const bytes=await readBoundedResponseBytes(response,262144);try{const value=z.object({error:z.enum(["validation","conflict","configuration_unavailable","rate_limited","link_unavailable"])}).safeParse(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)));throw new GuestHubBrowserError(value.success?value.data.error:"unavailable");}finally{bytes.fill(0);}}
  if(response.headers.get("content-type")!=="application/pdf"){await response.body?.cancel();throw new GuestHubBrowserError("unavailable");}
  const bytes=await readBoundedResponseBytes(response,fieldUploadChunkBytes*fieldUploadMaximumParts);if(new TextDecoder().decode(bytes.subarray(0,5))!=="%PDF-"){bytes.fill(0);throw new GuestHubBrowserError("unavailable");}return bytes;
 }catch(error){if(error instanceof GuestHubBrowserError)throw error;if(signal.aborted)throw error;throw new GuestHubBrowserError(typeof navigator!=="undefined"&&!navigator.onLine?"offline":"unavailable");}
}
