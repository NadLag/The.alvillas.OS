import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

describe("complete compiler partition coverage", () => {
  it("preserves shared ambient declarations and reports an error from either native partition", () => {
    const directory = join(process.cwd(), ".tmp"); mkdirSync(directory, { recursive: true });
    const root = mkdtempSync(join(directory, "compiler-coverage-"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: "ES2023", types: [], skipLibCheck: true, ignoreDeprecations: "6.0" }, include: ["**/*.ts"], exclude: [".tmp"] }));
    writeFileSync(join(root, "ambient.ts"), 'interface RetainedContext { amount: string }\n');
    for (const name of ["a", "b", "c", "d"]) {
      const path = join(root, "tests/integration", name + ".ts"); mkdirSync(join(root, "tests/integration"), { recursive: true });
      writeFileSync(path, 'export const value: RetainedContext = { amount: "0.07" };\n');
    }
    const moduleUrl = pathToFileURL(join(process.cwd(), "scripts/typecheck-projects.mjs")).href;
    const plan = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `import {prepareTypecheckProjects} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(prepareTypecheckProjects(${JSON.stringify(root)})));`], { encoding: "utf8", windowsHide: true })) as { originalRoots: string[]; shared: string[]; projects: { name: string; path: string; roots: string[] }[] };
    const native = plan.projects.filter(project => project.name.startsWith("postgres-"));
    expect(native).toHaveLength(2);
    expect(new Set(plan.projects.flatMap(project => project.roots))).toEqual(new Set([...plan.originalRoots, ...plan.shared]));
    for (const project of native) {
      expect(plan.shared.every(file => project.roots.includes(file))).toBe(true);
      const run = () => spawnSync(process.execPath, ["node_modules/typescript/lib/tsc.js", "--noEmit", "--project", project.path], { cwd: process.cwd(), encoding: "utf8", windowsHide: true });
      const valid = run(); expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      const source = project.roots.find(file => file.replaceAll("\\", "/").includes("/tests/integration/"))!;
      const original = readFileSync(source, "utf8"); writeFileSync(source, 'export const value: RetainedContext = { amount: 0.07 };\n');
      const failed = run(); expect(failed.status).not.toBe(0); expect(failed.stdout).toContain("TS2322");
      writeFileSync(source, original);
    }
    const observed = execFileSync(process.execPath, ["--input-type=module", "-e", `import {prepareTypecheckProjects,runTypecheckProjects} from ${JSON.stringify(moduleUrl)};const plan=prepareTypecheckProjects(${JSON.stringify(root)}),results=[];const status=await runTypecheckProjects(plan,plan.projects,result=>results.push(result));console.log(JSON.stringify({compilerResults:results,status}));process.exitCode=status;`], { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/u).at(-1)!;
    const results = JSON.parse(observed) as { status: number; compilerResults: Array<{ name: string; exitCode: number; roots: number }> };
    expect(results.status).toBe(0); expect(results.compilerResults.map(result => result.name).sort()).toEqual(plan.projects.map(project => project.name).sort());
    expect(results.compilerResults.every(result => result.exitCode === 0 && result.roots > 0)).toBe(true);
  });
});
