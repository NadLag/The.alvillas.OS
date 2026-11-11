import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { availableParallelism, freemem } from "node:os";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const worker = fileURLToPath(new URL("./typecheck-worker.mjs", import.meta.url));
// A technical compiler resource bound; every original root remains checked.
export const nativeCompilerMaxRoots = 36;
export const unitCompilerMaxRoots = 96;
export function compilerProjectNames(nativeRootCount, unitRootCount) {
  if (!Number.isSafeInteger(nativeRootCount) || nativeRootCount < 0) throw RangeError("A complete native root count is required");
  if (!Number.isSafeInteger(unitRootCount) || unitRootCount < 0) throw RangeError("A complete unit root count is required");
  return ["application", ...Array.from({ length: Math.max(1, Math.ceil(unitRootCount / unitCompilerMaxRoots)) }, (_, index) => index === 0 ? "unit" : "unit-" + (index + 1)), "browser-and-tools", ...Array.from({ length: Math.max(2, Math.ceil(nativeRootCount / nativeCompilerMaxRoots)) }, (_, index) => "postgres-" + (index + 1))];
}
export function prepareTypecheckProjects(projectRoot = process.cwd()) {
  const root = resolve(projectRoot), requireFromRoot = createRequire(join(root, "package.json")), ts = requireFromRoot("typescript");
  const configPath = join(root, "tsconfig.json"), loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(parsed.errors, { getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => "\n" }));
  const groups = new Map(["application", "unit", "postgres", "browser-and-tools"].map(name => [name, []])), shared = [];
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
  const declaresNamespace = node => ts.isModuleDeclaration(node) || ts.forEachChild(node, declaresNamespace) === true;
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile || !ts.isExternalModule(source) || declaresNamespace(source) || source.libReferenceDirectives.length || source.typeReferenceDirectives.length || source.referencedFiles.length) shared.push(source.fileName);
  }
  const sharedSet = new Set(shared), originalInputs = new Set(program.getSourceFiles().map(source => source.fileName));
  for (const file of parsed.fileNames) {
    const name = relative(root, file).replaceAll("\\", "/");
    if (sharedSet.has(file)) continue;
    const group = name.startsWith("tests/unit/") ? "unit" : name.startsWith("tests/integration/") ? "postgres" : name.startsWith("tests/") ? "browser-and-tools" : "application";
    groups.get(group).push(file);
  }
  // Independent native and unit test modules share the same ambient context. Bound each
  // compiler process as the catalog grows; no original input is dropped.
  const native = groups.get("postgres").sort(), units = groups.get("unit").sort(), names = compilerProjectNames(native.length, units.length), nativeNames = names.filter(name => name.startsWith("postgres-")), size = Math.ceil(native.length / nativeNames.length);
  groups.delete("postgres");
  for (const [index, name] of nativeNames.entries()) groups.set(name, native.slice(index * size, (index + 1) * size));
  const unitNames = names.filter(name => name === "unit" || name.startsWith("unit-")), unitSize = Math.ceil(units.length / unitNames.length);
  for (const [index, name] of unitNames.entries()) groups.set(name, units.slice(index * unitSize, (index + 1) * unitSize));
  const directory = join(root, ".tmp", "typecheck-" + randomUUID()); mkdirSync(directory, { recursive: true });
  const portable = file => relative(directory, file).replaceAll("\\", "/");
  const projects = [...groups].map(([name, files]) => {
    const roots = [...new Set([...shared, ...files])], path = join(directory, name + ".json");
    writeFileSync(path, JSON.stringify({ extends: portable(configPath), compilerOptions: { baseUrl: portable(root) || "." }, files: roots.map(portable), include: name === "application" ? [portable(join(root, ".next/types/**/*.ts")), portable(join(root, ".next/dev/types/**/*.ts")), portable(join(root, "next-env.d.ts"))] : [],
      ...parsed.projectReferences?.length ? { references: parsed.projectReferences.map(reference => ({ path: reference.path })) } : {} }, null, 2) + "\n", { flag: "wx" });
    return { name, path, roots };
  });
  const retained = new Set(projects.flatMap(project => project.roots));
  if (parsed.fileNames.some(file => !retained.has(file)) || [...retained].some(file => !originalInputs.has(file))) throw Error("Every original TypeScript input must remain in a checked project");
  return { root, originalRoots: parsed.fileNames, shared, projects, nativeRootCount: native.length, unitRootCount: units.length, directory, parallelSafe: !parsed.options.incremental && !parsed.options.composite && !parsed.options.tsBuildInfoFile };
}
export async function runTypecheckProjects(plan, projects = plan.projects, onResult) {
  const megabyte = 1024 * 1024, reserve = 1024 * megabyte, free = () => process.availableMemory?.() ?? freemem();
  const isNative = project => project.name.startsWith("postgres-");
  // Browser acceptance imports the same complete application contracts. Keep its
  // roots intact and give that group the application's existing heap allowance.
  const heap = project => isNative(project) ? 6144 : ["application", "browser-and-tools"].includes(project.name) ? 3072 : 2048;
  const run = project => new Promise(resolve => {
    const started = Date.now(); let settled = false;
    const finished = exitCode => { if(settled)return;settled=true;onResult?.({name:project.name,exitCode,roots:project.roots.length,elapsedMs:Date.now()-started});resolve(exitCode); };
    const child = spawn(process.execPath, ["--max-old-space-size=" + heap(project), worker, plan.root, project.name, project.path], { cwd: plan.root, stdio: "inherit", env: process.env, windowsHide: true });
    child.once("error", error => { process.stderr.write(String(error) + "\n"); finished(1); });
    child.once("exit", status => finished(status ?? 1));
  });
  let failure = 0;
  // All native partitions keep the original heap and run serially, even after
  // a failure, so every partition produces diagnostic evidence.
  for (const project of projects.filter(isNative)) { const status = await run(project); failure ||= status; }
  const queue = projects.filter(project => !isNative(project)), active = new Map(), budget = Math.max(0, free() - reserve);
  const parallel = plan.parallelSafe && availableParallelism() >= 2;
  while (queue.length || active.size) {
    while (queue.length && active.size < (parallel ? 2 : 1)) {
      const project = queue[0], liveBudget = [...active.values()].reduce((total, item) => total + heap(item) * megabyte, 0);
      if (active.size && (liveBudget + heap(project) * megabyte > budget || free() < heap(project) * megabyte + reserve)) break;
      queue.shift(); const pending = run(project).then(status => ({ pending, status })); active.set(pending, project);
    }
    const finished = await Promise.race(active.keys()); active.delete(finished.pending); failure ||= finished.status;
  }
  return failure;
}
