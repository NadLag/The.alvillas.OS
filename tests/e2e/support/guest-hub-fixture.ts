import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {z} from "zod";
import {expect,type Page} from "@playwright/test";
import {guestHubLinkPolicySchema} from "@/modules/guest-hub/domain/guest-hub-policy";
import {guestHubWorkspaceSchema} from "@/modules/guest-hub/domain/guest-hub-contract";

const fixture=z.object({organizationId:z.uuid(),property:z.object({id:z.uuid(),name:z.string().min(1)}).strict(),reservation:z.object({id:z.uuid()}).strict(),grants:z.record(z.string(),z.uuid()),policy:guestHubLinkPolicySchema}).strict();
export async function prepareNativeGuestHubBrowserFixture(input:{organizationId:string;accountId:string;personId:string;guestLocale:"en"|"fr"|"ar";output:string}){
 await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/guest-hub-fixture-worker.ts"),JSON.stringify(input)],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
 return fixture.parse(JSON.parse(await readFile(input.output,"utf8")));
}
export async function openNativeGuestHubWorkspace(page:Page,reservationId:string,navigate:()=>Promise<unknown>){
 const loaded=page.waitForResponse(response=>{if(new URL(response.url()).pathname!=="/api/guest-hub/directory"||response.request().method()!=="POST")return false;const input:unknown=response.request().postDataJSON(),parsed=z.object({reservationId:z.uuid()}).safeParse(input);return parsed.success&&parsed.data.reservationId===reservationId;},{timeout:30000});
 const [response]=await Promise.all([loaded,navigate()]);expect(response.status()).toBe(200);
 expect(guestHubWorkspaceSchema.parse(await response.json()).reservationId).toBe(reservationId);
}
