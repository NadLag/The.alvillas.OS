import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {z} from "zod";
import {expect,type BrowserContext,type Page,type Request} from "@playwright/test";
import {guestHubLinkPolicySchema} from "@/modules/guest-hub/domain/guest-hub-policy";
import {guestHubWorkspaceSchema} from "@/modules/guest-hub/domain/guest-hub-contract";
import {forwardBrowserPostOnce} from "./forward-browser-post";

const fixture=z.object({organizationId:z.uuid(),property:z.object({id:z.uuid(),name:z.string().min(1)}).strict(),reservation:z.object({id:z.uuid()}).strict(),grants:z.record(z.string(),z.uuid()),policy:guestHubLinkPolicySchema}).strict();
export async function prepareNativeGuestHubBrowserFixture(input:{organizationId:string;accountId:string;personId:string;guestLocale:"en"|"fr"|"ar";output:string;profile?:boolean}){
 await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/guest-hub-fixture-worker.ts"),JSON.stringify(input)],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
 return fixture.parse(JSON.parse(await readFile(input.output,"utf8")));
}
export async function openNativeGuestHubWorkspace(page:Page,reservationId:string,navigate:()=>Promise<unknown>){
 await retainNativeGuestHubResponses(page.context());
 const loaded=page.waitForResponse(response=>{if(new URL(response.url()).pathname!=="/api/guest-hub/directory"||response.request().method()!=="POST")return false;const input:unknown=response.request().postDataJSON(),parsed=z.object({reservationId:z.uuid()}).safeParse(input);return parsed.success&&parsed.data.reservationId===reservationId;},{timeout:30000});
 const [response]=await Promise.all([loaded,navigate()]);expect(response.status()).toBe(200);
 const retained=nativeResponses.get(response.request());expect(retained).toBeDefined();if(!retained)throw Error("Original native directory response must be retained before UI navigation");expect(retained.status).toBe(response.status());
 expect(guestHubWorkspaceSchema.parse(JSON.parse(retained.body.toString("utf8"))as unknown).reservationId).toBe(reservationId);
}
const nativeResponses=new WeakMap<Request,{status:number;body:Buffer}>(),retainedContexts=new WeakSet<BrowserContext>();
/** Retain the one original HTTP acknowledgement before the real UI can replace its browser resource. */
export async function retainNativeGuestHubResponses(context:BrowserContext){
 const database=new URL(process.env.DATABASE_URL??"invalid:");if(!["localhost","127.0.0.1"].includes(database.hostname)||!(database.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&database.pathname==="/alvillas_os"))throw Error("Owned native Guest Hub transport required");
 if(retainedContexts.has(context))return;
 await context.route("**/api/guest-hub/**",async route=>{
  const request=route.request(),target=new URL(request.url());if(request.method()!=="POST"||!["localhost","127.0.0.1"].includes(target.hostname))throw Error("Observed owned Guest Hub POST required");
  let body:Buffer=Buffer.alloc(0),headers:Record<string,string>={};
  const status=await forwardBrowserPostOnce({url:()=>request.url(),method:()=>request.method(),postDataBuffer:()=>request.postDataBuffer(),allHeaders:async()=>({...await request.allHeaders(),"accept-encoding":"identity"})},(bytes,actual)=>{body=bytes;headers=Object.fromEntries(Object.entries(actual).filter(([key,value])=>value!==undefined&&!["connection","keep-alive","transfer-encoding","content-length","content-encoding"].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join("\n"):String(value)]));});
  nativeResponses.set(request,{status,body});await route.fulfill({status,headers,body});
 });
 retainedContexts.add(context);
}
/** Page-level loss/race handlers retain precedence; ordinary replies use the exact original native bytes. */
export async function nativeGuestHubResponse(page:Page,path:string){
 const response=await page.waitForResponse(value=>new URL(value.url()).pathname==="/api/guest-hub/"+path&&value.request().method()==="POST",{timeout:30000}),retained=nativeResponses.get(response.request());if(retained)expect(retained.status).toBe(response.status());
 return{status:()=>response.status(),headers:()=>response.headers(),json:async():Promise<unknown>=>retained?JSON.parse(retained.body.toString("utf8"))as unknown:await response.json()as unknown};
}
