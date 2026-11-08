import process from "node:process";
import { prepareTypecheckProjects, runTypecheckProjects } from "./typecheck-projects.mjs";
import {readTypecheckGate,completeTypecheckEvidence,writeTypecheckEvidence} from "./ci/typecheck-evidence.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--root")) throw Error("Usage: typecheck [--root <repository>]");
const plan = prepareTypecheckProjects(args[1]);
process.stdout.write(JSON.stringify({ typecheckInputs: plan.originalRoots.length, sharedContextFiles: plan.shared.length, unitRootCount: plan.unitRootCount, projects: plan.projects.map(project => ({ name: project.name, roots: project.roots.length })) }) + "\n");
const results = [], status = await runTypecheckProjects(plan, plan.projects, result => results.push(result));
if(process.env.GITHUB_ACTIONS==="true"&&process.env.GITHUB_JOB==="static"){
 const {reference}=readTypecheckGate(plan.root);writeTypecheckEvidence(plan.root,"typecheck-complete.json",completeTypecheckEvidence(plan,status,reference,results));
}
process.exitCode = status;
