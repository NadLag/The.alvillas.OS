import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";

const output = await build({ entryPoints: ["src/platform/offline/service-worker.ts"], bundle: true,
  write: false, minify: true, legalComments: "eof", platform: "browser", format: "iife", target: "es2022" });
const path = "src/platform/offline/worker-code.generated.json";
const body = JSON.stringify({ code: output.outputFiles[0].text });
if (await readFile(path, "utf8").catch(() => "") !== body) await writeFile(path, body);
console.log(`field worker built (${output.outputFiles[0].contents.byteLength} bytes)`);
