import {fork} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createWriteStream} from "node:fs";
import {resolve} from "node:path";
import {z} from "zod";

const prepared=z.object({organizationId:z.uuid(),propertyId:z.uuid(),reservationId:z.uuid(),preparationId:z.uuid(),documentGrants:z.record(z.string(),z.uuid()),noticeTitle:z.string().min(1)}).strict(),distributed=z.object({state:z.literal("SENT"),providerPosts:z.literal(1)}).strict(),complete=z.object({signedSha256:z.string().regex(/^[a-f0-9]{64}$/u),certificateSha256:z.string().regex(/^[a-f0-9]{64}$/u),providerPosts:z.literal(1)}).strict();
/** Keep the actual owned provider alive while browser, native durable workers and
 * signed archive share the same original database and encrypted object store. */
export async function nativeGuestAgreementBrowserFixture(input:{origin:string;organizationId:string;accountId:string;personId:string;locale:"en"|"fr"|"ar";log:string}){
 const log=createWriteStream(input.log,{flags:"wx",mode:0o600}),child=fork(resolve("tests/e2e/support/guest-hub-agreement-worker.ts"),[],{execArgv:["--import","tsx"],env:process.env,stdio:["ignore","pipe","pipe","ipc"],serialization:"json"}),pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timeout:ReturnType<typeof setTimeout>}>();child.stdout?.pipe(log,{end:false});child.stderr?.pipe(log,{end:false});
 const rejectAll=()=>{for(const item of pending.values()){clearTimeout(item.timeout);item.reject(Error("Owned native agreement fixture process ended; inspect its private test log"));}pending.clear();};child.on("error",rejectAll);child.on("exit",()=>{rejectAll();log.end();});child.on("message",(raw:unknown)=>{const envelope=z.object({id:z.uuid(),ok:z.boolean(),value:z.unknown().optional(),error:z.string().optional()}).strict().safeParse(raw);if(!envelope.success)return;const item=pending.get(envelope.data.id);if(!item)return;pending.delete(envelope.data.id);clearTimeout(item.timeout);if(envelope.data.ok)item.resolve(envelope.data.value);else item.reject(Error("Owned native agreement phase failed: "+envelope.data.error));});
 const request=(type:"prepare"|"distribute"|"complete"|"close",payload:Record<string,unknown>={})=>new Promise<unknown>((resolve,reject)=>{const id=randomUUID(),timeout=setTimeout(()=>{pending.delete(id);reject(Error("Owned native agreement fixture phase timed out"));},120000);pending.set(id,{resolve,reject,timeout});child.send({id,type,...payload},error=>{if(error){clearTimeout(timeout);pending.delete(id);reject(Error("Owned native agreement fixture channel unavailable"));}});});
 const close=async()=>{if(child.exitCode!==null)return;try{await request("close");}finally{if(child.connected)child.disconnect();}};
 try{const value=prepared.parse(await request("prepare",{origin:input.origin,organizationId:input.organizationId,accountId:input.accountId,personId:input.personId,locale:input.locale}));return{...value,distribute:async(requestId:string)=>distributed.parse(await request("distribute",{requestId})),complete:async()=>complete.parse(await request("complete")),close};}catch(error){await close();throw error;}
}
