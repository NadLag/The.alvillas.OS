import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {z} from "zod";

const prepared=z.object({organizationId:z.uuid(),accountId:z.uuid(),sessionId:z.uuid(),reviewRevisionId:z.uuid(),propertyId:z.uuid(),propertyName:z.string().min(1)}).strict(),completed=z.object({propertyStatus:z.literal("ACTIVE"),phaseCount:z.literal(13),completedEffects:z.literal(5),tasks:z.literal(2),documents:z.literal(2),delivered:z.literal(1)}).strict();
type Common={organizationId:string;accountId:string;origin:string;output:string};
async function worker(input:Common&({mode:"prepare"}|{mode:"complete";sessionId:string;idempotencyKey:string})){await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/onboarding-activation-fixture-worker.ts"),JSON.stringify(input)],{env:process.env,windowsHide:true,timeout:600000,maxBuffer:2*1024*1024});return JSON.parse(await readFile(input.output,"utf8"))as unknown;}
export async function prepareNativeActivationBrowserFixture(input:Common){return prepared.parse(await worker({...input,mode:"prepare"}));}
export async function completeNativeActivationBrowserFixture(input:Common&{sessionId:string;idempotencyKey:string}){return completed.parse(await worker({...input,mode:"complete"}));}
