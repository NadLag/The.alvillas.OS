import process from "node:process";
import { prepareTypecheckProjects, runTypecheckProjects } from "./typecheck-projects.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--root")) throw Error("Usage: typecheck [--root <repository>]");
const plan = prepareTypecheckProjects(args[1]);
process.stdout.write(JSON.stringify({ typecheckInputs: plan.originalRoots.length, sharedContextFiles: plan.shared.length, projects: plan.projects.map(project => ({ name: project.name, roots: project.roots.length })) }) + "\n");
process.exitCode = await runTypecheckProjects(plan);
