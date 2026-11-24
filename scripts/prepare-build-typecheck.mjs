import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { prepareTypecheckProjects } from "./typecheck-projects.mjs";

const plan = prepareTypecheckProjects();
const file = join(plan.directory, "plan.json");
writeFileSync(file, JSON.stringify(plan), { flag: "wx" });
process.stdout.write(file + "\n");
