import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {z} from "zod";
import {guestHubLinkPolicySchema} from "@/modules/guest-hub/domain/guest-hub-policy";

const fixture=z.object({organizationId:z.uuid(),property:z.object({id:z.uuid()}).strict(),reservation:z.object({id:z.uuid()}).strict(),grants:z.record(z.string(),z.uuid()),policy:guestHubLinkPolicySchema}).strict();
export async function prepareNativeGuestHubBrowserFixture(input:{organizationId:string;accountId:string;personId:string;guestLocale:"en"|"fr"|"ar";output:string}){
 await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/guest-hub-fixture-worker.ts"),JSON.stringify(input)],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
 return fixture.parse(JSON.parse(await readFile(input.output,"utf8")));
}
