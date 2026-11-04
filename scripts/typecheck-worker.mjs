import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";

const [root, phase, config] = process.argv.slice(2), requireFromRoot = createRequire(join(root, "package.json")), compiler = requireFromRoot.resolve("typescript/lib/tsc.js"), started = process.hrtime.bigint();
process.on("exit", exitCode => {
  process.stdout.write(JSON.stringify({ typecheck: phase, exitCode, elapsedMs: Number((process.hrtime.bigint() - started) / 1000000n), maxRssKiB: process.resourceUsage().maxRSS }) + "\n");
});
process.argv = [process.execPath, compiler, "--noEmit", "--project", config];
requireFromRoot(compiler);
