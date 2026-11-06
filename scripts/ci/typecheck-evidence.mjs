import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import process from "node:process";

export const compilerProjects=Object.freeze(["application","unit","browser-and-tools","postgres-1","postgres-2"]);
const validateReference=reference=>{assert.equal(reference?.version,1);assert.equal(reference.stage,"start");assert.match(reference.sourceHead,/^[a-f0-9]{40}$/u);assert.equal(reference.expectedHead,reference.sourceHead);assert.match(reference.sourceTree,/^[a-f0-9]{40}$/u);for(const key of["testContentSha256","lockSha256"])assert.match(reference[key],/^[a-f0-9]{64}$/u);for(const key of["runId","runAttempt"])assert.match(reference[key],/^\d+$/u);};
const sameSource=(actual,reference)=>{for(const key of["sourceHead","expectedHead","sourceTree","testContentSha256","lockSha256","runId","runAttempt"])assert.equal(actual[key],reference[key],"Exact source evidence required: "+key);};
export function selectBuildTypechecks(plan,env,reference,actualHead){
 const mode=env.ALVILLAS_CI_BUILD_TYPECHECK;
 if(mode===undefined)return{mode:"complete",projects:plan.projects.filter(project=>project.name!=="application")};
 assert.equal(mode,"application","Only the explicit application build mode is supported");
 assert.equal(env.CI,"true");assert.equal(env.GITHUB_ACTIONS,"true");assert(["restore-build","playwright"].includes(env.GITHUB_JOB),"Only independently gated CI build jobs may use static coverage");
 validateReference(reference);
 assert.equal(reference?.stage,"start");assert.equal(reference.job,env.GITHUB_JOB);assert.equal(reference.sourceHead,actualHead);assert.equal(reference.expectedHead,actualHead);
 assert.equal(reference.browserProject,env.GITHUB_JOB==="playwright"?env.CI_BROWSER_PROJECT:null);
 assert.deepEqual(plan.projects.map(project=>project.name).sort(),[...compilerProjects].sort(),"Every original compiler partition remains mandatory in static");
 return{mode,projects:[],reference};
}
export function readTypecheckGate(root,env=process.env){
 const project=env.GITHUB_JOB==="playwright"?"-"+env.CI_BROWSER_PROJECT:"",reference=JSON.parse(readFileSync(join(root,"ci-evidence",env.GITHUB_JOB+project+"-start.json"),"utf8")),head=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 assert.equal(reference.sourceHead,head);assert.equal(reference.expectedHead,head);return{reference,head};
}
export function completeTypecheckEvidence(plan,status,reference,results){
 validateReference(reference);
 assert.equal(reference.job,"static");assert.equal(reference.stage,"start");assert.deepEqual(plan.projects.map(project=>project.name).sort(),[...compilerProjects].sort());
 assert.deepEqual(results.map(result=>result.name).sort(),[...compilerProjects].sort(),"Every compiler must actually report its result");
 return{...reference,stage:"typecheck-complete",status:status===0&&results.every(result=>result.exitCode===0)?"success":"failure",checkedProjects:results.filter(result=>result.exitCode===0).map(result=>result.name),compilerResults:results,originalRoots:plan.originalRoots.length,sharedContextFiles:plan.shared.length,allOriginalInputs:true};
}
export function completeBuildTypecheckEvidence(selection,status,elapsedMs){
 assert.equal(selection.mode,"application");return{...selection.reference,stage:"build-typecheck",status:status===0?"success":"failure",mode:selection.mode,applicationChecked:status===0,
   independentlyCheckedProjects:compilerProjects.filter(name=>name!=="application"),elapsedMs};
}
export function writeTypecheckEvidence(root,name,proof){mkdirSync(join(root,"ci-evidence"),{recursive:true});writeFileSync(join(root,"ci-evidence",name),JSON.stringify(proof,null,2)+"\n",{flag:"wx"});}
export function requireCompleteTypecheckCoverage(reference,staticReport,builds){
 validateReference(reference);
 sameSource(staticReport,reference);assert.equal(staticReport.job,"static");assert.equal(staticReport.stage,"typecheck-complete");assert.equal(staticReport.status,"success");assert.equal(staticReport.allOriginalInputs,true);assert(staticReport.originalRoots>0);assert(staticReport.sharedContextFiles>0);
 assert.deepEqual([...staticReport.checkedProjects].sort(),[...compilerProjects].sort(),"Static must independently check all original compiler partitions");
 assert.deepEqual(staticReport.compilerResults.map(result=>result.name).sort(),[...compilerProjects].sort());assert(staticReport.compilerResults.every(result=>result.exitCode===0&&result.roots>0),"Every original compiler must actually succeed");
 const expected=["restore-build","playwright:chromium","playwright:field-mobile"],observed=[];
 for(const build of builds){sameSource(build,reference);assert.equal(build.stage,"build-typecheck");assert.equal(build.status,"success");assert.equal(build.mode,"application");assert.equal(build.applicationChecked,true);
  assert.deepEqual([...build.independentlyCheckedProjects].sort(),compilerProjects.filter(name=>name!=="application").sort());observed.push(build.job+(build.browserProject?":"+build.browserProject:""));}
 assert.deepEqual(observed.sort(),expected.sort(),"Every independent production build must retain application checking");
 return{...reference,stage:"typecheck-coverage",status:"success",checkedProjects:[...compilerProjects],applicationBuilds:observed,allOriginalInputs:true};
}
