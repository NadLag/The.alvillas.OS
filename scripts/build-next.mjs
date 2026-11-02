import {spawnSync} from "node:child_process";
import process from "node:process";
import {fileURLToPath,URL} from "node:url";

// Next 16.4 starts tsc as a separate CLI process. That process inherits the
// environment, so a heap flag on next's command alone does not reach it.
const heapArgument="--max-old-space-size=6144";
const result=spawnSync(process.execPath,[heapArgument,fileURLToPath(new URL("../node_modules/next/dist/bin/next",import.meta.url)),"build",...process.argv.slice(2)],{
 stdio:"inherit",
 env:{...process.env,NODE_OPTIONS:[process.env.NODE_OPTIONS,heapArgument].filter(Boolean).join(" ")}
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
