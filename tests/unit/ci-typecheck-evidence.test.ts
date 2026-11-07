import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const names = ["application", "unit", "browser-and-tools", "postgres-1", "postgres-2"], plan = { projects: names.map(name => ({ name })), nativeRootCount: 2, originalRoots: Array.from({ length: 20 }, (_, index) => String(index)), shared: ["ambient.d.ts"] },
  reference = { version: 1, stage: "start", job: "checks", browserProject: null, sourceHead: "a".repeat(40), expectedHead: "a".repeat(40), sourceTree: "b".repeat(40), testContentSha256: "c".repeat(64), lockSha256: "d".repeat(64), runId: "1234", runAttempt: "1" },
  staticReport = { ...reference, job: "static", stage: "typecheck-complete", status: "success", checkedProjects: names, compilerResults: names.map(name => ({ name, exitCode: 0, roots: 5, elapsedMs: 1 })), nativeRootCount: 2, originalRoots: 20, sharedContextFiles: 1, allOriginalInputs: true },
  builds = [["restore-build", null], ["playwright", "chromium"], ["playwright", "field-mobile"]].map(([job, browserProject]) => ({ ...reference, job, browserProject, stage: "build-typecheck", status: "success", mode: "application", applicationChecked: true, nativeRootCount: 2, independentlyCheckedProjects: names.filter(name => name !== "application") }));
function run(operation: string, args: unknown[]) {
  const url = pathToFileURL(join(process.cwd(), "scripts/ci/typecheck-evidence.mjs")).href,
    code = `import * as evidence from ${JSON.stringify(url)};const input=JSON.parse(process.argv[1]);try{console.log(JSON.stringify({result:evidence[input.operation](...input.args)}));}catch(error){console.log(JSON.stringify({error:String(error)}));}`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code, JSON.stringify({ operation, args })], { encoding: "utf8", windowsHide: true })) as { result?: { mode?: string; projects?: Array<{ name: string }>; allOriginalInputs?: boolean }; error?: string };
}
describe("independent mandatory compiler and production-build evidence", () => {
  it("retains every existing non-application build check for local and deployment builds", () => {
    const result = run("selectBuildTypechecks", [plan, {}]); expect(result.error).toBeUndefined(); expect(result.result?.mode).toBe("complete"); expect(result.result?.projects?.map(project => project.name)).toEqual(names.filter(name => name !== "application"));
  });
  it("requires matching exact-head CI build evidence before relying on the separate complete static gate", () => {
    const result = run("selectBuildTypechecks", [plan, { CI: "true", GITHUB_ACTIONS: "true", GITHUB_JOB: "restore-build", ALVILLAS_CI_BUILD_TYPECHECK: "application" }, { ...reference, job: "restore-build" }, reference.sourceHead]);
    expect(result.error).toBeUndefined(); expect(result.result).toMatchObject({ mode: "application", projects: [] });
  });
  it.each([{ CI: "false" }, { GITHUB_ACTIONS: "false" }, { GITHUB_JOB: "static" }, { GITHUB_JOB: "deploy-staging" }, { ALVILLAS_CI_BUILD_TYPECHECK: "skip" }])("rejects accidental or unsupported build coverage selection %#", change => {
    expect(run("selectBuildTypechecks", [plan, { CI: "true", GITHUB_ACTIONS: "true", GITHUB_JOB: "restore-build", ALVILLAS_CI_BUILD_TYPECHECK: "application", ...change }, { ...reference, job: "restore-build" }, reference.sourceHead]).error).toBeDefined();
  });
  it("keeps all five compiler partitions and all three application builds mandatory", () => {
    expect(run("requireCompleteTypecheckCoverage", [reference, staticReport, builds])).toMatchObject({ result: { status: "success", allOriginalInputs: true, checkedProjects: names } });
  });
  it.each([
    { status: "failure" }, { checkedProjects: names.filter(name => name !== "postgres-2") }, { allOriginalInputs: false }, { sourceHead: "e".repeat(40) }, { runAttempt: "2" }, { testContentSha256: "f".repeat(64) }, { compilerResults: names.map(name => ({ name, exitCode: name === "postgres-2" ? 1 : 0, roots: 5 })) }
  ])("rejects failed, partial, stale or changed-input static coverage %#", change => {
    expect(run("requireCompleteTypecheckCoverage", [reference, { ...staticReport, ...change }, builds]).error).toBeDefined();
  });
  it.each([{ status: "failure" }, { applicationChecked: false }, { sourceHead: "e".repeat(40) }, { independentlyCheckedProjects: ["unit"] }])("rejects missing application checking or mismatched production build coverage %#", change => {
    expect(run("requireCompleteTypecheckCoverage", [reference, staticReport, [{ ...builds[0], ...change }, ...builds.slice(1)]]).error).toBeDefined();
  });
  it("rejects a missing original mobile build and refuses coverage from an unrelated source", () => {
    expect(run("requireCompleteTypecheckCoverage", [reference, staticReport, builds.slice(0, 2)]).error).toBeDefined();
    expect(run("selectBuildTypechecks", [plan, { CI: "true", GITHUB_ACTIONS: "true", GITHUB_JOB: "restore-build", ALVILLAS_CI_BUILD_TYPECHECK: "application" }, { ...reference, job: "restore-build" }, "f".repeat(40)]).error).toBeDefined();
  });
  it("requires every additional native group and matching discovered inputs in all independent builds", () => {
    const expanded = [...names, "postgres-3"], report = { ...staticReport, nativeRootCount: 73, originalRoots: 100, checkedProjects: expanded, compilerResults: expanded.map(name => ({ name, exitCode: 0, roots: 25, elapsedMs: 1 })) }, actualBuilds = builds.map(build => ({ ...build, nativeRootCount: 73, independentlyCheckedProjects: expanded.filter(name => name !== "application") }));
    expect(run("requireCompleteTypecheckCoverage", [reference, report, actualBuilds])).toMatchObject({ result: { status: "success", checkedProjects: expanded, allOriginalInputs: true } });
    for (const changed of [{ checkedProjects: names }, { compilerResults: report.compilerResults.filter(result => result.name !== "postgres-3") }, { nativeRootCount: 2 }]) expect(run("requireCompleteTypecheckCoverage", [reference, { ...report, ...changed }, actualBuilds]).error).toBeDefined();
    expect(run("requireCompleteTypecheckCoverage", [reference, report, [{ ...actualBuilds[0], nativeRootCount: 72 }, ...actualBuilds.slice(1)] ]).error).toBeDefined();
    expect(run("requireCompleteTypecheckCoverage", [reference, report, [{ ...actualBuilds[0], independentlyCheckedProjects: names.filter(name => name !== "application") }, ...actualBuilds.slice(1)] ]).error).toBeDefined();
    expect(run("selectBuildTypechecks", [{ ...plan, nativeRootCount: 73 }, {}]).error).toBeDefined();
  });
  it("rejects missing or invalid native input counts before selecting compiler coverage", () => {
    for (const nativeRootCount of [undefined, -1, 1.5]) expect(run("selectBuildTypechecks", [{ ...plan, nativeRootCount }, {}]).error).toBeDefined();
  });
});
