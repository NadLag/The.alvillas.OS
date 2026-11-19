import process from "node:process";
import {spawnSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath,URL} from "node:url";
import {prepareLintPlan} from "./lint-plan.mjs";

const args=process.argv.slice(2);let root=process.cwd(),batchSize=96,planOnly=false;
for(let index=0;index<args.length;index++){
 if(args[index]==="--root"&&args[index+1])root=resolve(args[++index]);
 else if(args[index]==="--batch-size"&&args[index+1])batchSize=Number(args[++index]);
 else if(args[index]==="--plan")planOnly=true;
 else throw Error("Usage: lint [--root directory] [--batch-size count] [--plan]");
}
const plan=await prepareLintPlan(root,batchSize);if(planOnly){process.stdout.write(JSON.stringify(plan)+"\n");}else{
 const temporary=join(plan.root,".tmp");mkdirSync(temporary,{recursive:true});const directory=mkdtempSync(join(temporary,"typed-lint-")),results=[],worker=fileURLToPath(new URL("./lint-worker.mjs",import.meta.url));let status=0;
 for(const [index,files]of plan.batches.entries()){
  const report=join(directory,index+".json");process.stdout.write(`Typed ESLint ${index+1}/${plan.batches.length}: ${files.length} original files\n`);
  // Fresh processes bound semantic cache growth. Each uses the unchanged root
  // configuration, original project, complete rules and zero-warning policy.
  const result=spawnSync(process.execPath,[worker],{cwd:plan.root,env:process.env,input:JSON.stringify({root:plan.root,files,report}),encoding:"utf8",stdio:["pipe","inherit","inherit"],windowsHide:true});
  if(result.status!==0&&result.status!==1)throw Error("Typed ESLint worker could not complete every assigned file");
  const actual=JSON.parse(readFileSync(report,"utf8"));if(JSON.stringify(actual.files)!==JSON.stringify([...files].sort()))throw Error("Typed ESLint original file coverage mismatch");
  results.push({...actual,exitCode:result.status});if(result.status!==0)status=1;
 }
 const checked=results.flatMap(value=>value.files).sort();if(JSON.stringify(checked)!==JSON.stringify(plan.files)||new Set(checked).size!==plan.files.length)throw Error("Typed ESLint requires every original file exactly once");
 const evidence={complete:true,files:plan.files,results};writeFileSync(join(directory,"complete.json"),JSON.stringify(evidence));
 if(process.env.GITHUB_ACTIONS==="true"&&process.env.GITHUB_JOB==="static"){mkdirSync(join(plan.root,"ci-evidence"),{recursive:true});writeFileSync(join(plan.root,"ci-evidence/lint-coverage.json"),JSON.stringify(evidence));}
 process.stdout.write(JSON.stringify({lintFiles:plan.files.length,batches:results.length,status})+"\n");process.exitCode=status;
}
