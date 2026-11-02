import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import process from "node:process";
import console from "node:console";

const stage=process.argv[2],job=process.env.GITHUB_JOB??"local";
if(!["start","end"].includes(stage)||!/^[a-z][a-z0-9-]*$/u.test(job))throw Error("Known verification stage and job required");
const git=args=>execFileSync("git",args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const event=process.env.GITHUB_EVENT_PATH?JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,"utf8")):{},head=git(["rev-parse","HEAD"]),expected=event.pull_request?.head.sha??process.env.GITHUB_SHA??head;
if(head!==expected)throw Error("Verification must execute the exact requested source head");
const tests=git(["ls-files","tests/"]).split(/\r?\n/u).filter(Boolean),digest=createHash("sha256");
for(const file of tests){digest.update(file);digest.update("\0");digest.update(readFileSync(file));digest.update("\0");}
mkdirSync("ci-evidence",{recursive:true});
const proof={version:1,stage,job,at:new Date().toISOString(),status:process.env.CI_GATE_STATUS??"running",sourceHead:head,sourceTree:git(["rev-parse","HEAD^{tree}"]),expectedHead:expected,event:process.env.GITHUB_EVENT_NAME??"local",runId:process.env.GITHUB_RUN_ID??null,runAttempt:process.env.GITHUB_RUN_ATTEMPT??null,node:process.version,timezoneData:process.versions.tz??null,testFiles:tests.length,testContentSha256:digest.digest("hex"),lockSha256:createHash("sha256").update(readFileSync("package-lock.json")).digest("hex"),browserRetries:0};
const output=`ci-evidence/${job}-${stage}.json`;if(existsSync(output))throw Error("Verification evidence must not be overwritten");writeFileSync(output,JSON.stringify(proof,null,2)+"\n",{flag:"wx"});console.log(JSON.stringify({job,stage,sourceHead:head,status:proof.status,testFiles:tests.length}));
