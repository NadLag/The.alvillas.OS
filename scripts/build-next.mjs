import {spawnSync} from "node:child_process";
import process from "node:process";
import {fileURLToPath,URL} from "node:url";
import {relative} from "node:path";
import {performance} from "node:perf_hooks";
import {prepareTypecheckProjects,runTypecheckProjects} from "./typecheck-projects.mjs";
import {selectBuildTypechecks,readTypecheckGate,completeBuildTypecheckEvidence,writeTypecheckEvidence} from "./ci/typecheck-evidence.mjs";

// Next 16.4 starts tsc as a separate CLI process. That process inherits the
// environment, so a heap flag on next's command alone does not reach it.
const heapArgument="--max-old-space-size=6144";
const started=performance.now(),plan=prepareTypecheckProjects(),gate=process.env.ALVILLAS_CI_BUILD_TYPECHECK===undefined?null:readTypecheckGate(plan.root),selection=selectBuildTypechecks(plan,process.env,gate?.reference,gate?.head),testStatus=await runTypecheckProjects(plan,selection.projects);
if(testStatus!==0)process.exit(testStatus);
const application=plan.projects.find(project=>project.name==="application");
const result=spawnSync(process.execPath,[heapArgument,fileURLToPath(new URL("../node_modules/next/dist/bin/next",import.meta.url)),"build",...process.argv.slice(2)],{
 stdio:"inherit",
 env:{...process.env,ALVILLAS_BUILD_TSCONFIG:relative(plan.root,application.path).replaceAll("\\","/"),NODE_OPTIONS:[process.env.NODE_OPTIONS,heapArgument].filter(Boolean).join(" ")}
});
if(result.error)throw result.error;
if(selection.mode==="application")writeTypecheckEvidence(plan.root,"build-typecheck.json",completeBuildTypecheckEvidence(selection,result.status??1,Math.round(performance.now()-started)));
process.exitCode=result.status??1;
