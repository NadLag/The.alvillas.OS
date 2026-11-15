import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {z} from "zod";

const fixture=z.object({organizationId:z.uuid(),property:z.object({id:z.uuid(),name:z.string()}).strict(),supplier:z.object({id:z.uuid(),label:z.string()}).strict(),grants:z.record(z.string(),z.uuid()),allocationRuleId:z.uuid(),taxRuleId:z.uuid()}).strict();
export async function prepareNativeServiceCatalogBrowserFixture(input:{organizationId:string;accountId:string;personId:string;guestLocale:"en"|"fr"|"ar";output:string}){
 await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/service-catalog-fixture-worker.ts"),JSON.stringify(input)],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});return fixture.parse(JSON.parse(await readFile(input.output,"utf8")));
}
