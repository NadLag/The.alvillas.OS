import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {z} from "zod";

const reportFixture=z.object({organizationId:z.uuid(),review:z.object({id:z.uuid(),propertyId:z.uuid()}).strict(),definitions:z.array(z.object({locale:z.enum(["en","fr"]),documentId:z.uuid(),versionId:z.uuid()}).strict()).length(2),propertyName:z.string().min(1),agreementReference:z.string().min(1),agreementId:z.uuid()}).strict();
/** Keep request-only Next imports out of Playwright's runner; no auth, API or provider boundary is replaced. */
export async function prepareOwnerPackageBrowserFixture(input:{organizationId:string;accountId:string;origin:string;output:string}){
 await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/onboarding-owner-package-fixture-worker.ts"),input.organizationId,input.accountId,input.origin,input.output],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});
 return reportFixture.parse(JSON.parse(await readFile(input.output,"utf8")));
}
