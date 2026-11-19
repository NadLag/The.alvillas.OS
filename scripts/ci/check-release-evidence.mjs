import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const requiredJobs = [
  "static", "unit", "postgres", "restore-build", "playwright (chromium)",
  "playwright (field-mobile)", "checks", "deploy-staging"
];
const stagedSteps = ["Smoke staging deployment", "Assign stable staging alias"];
const shaPattern = /^[0-9a-f]{40}$/u;

function requireRevision(expectedSha) {
  if (!shaPattern.test(expectedSha ?? "")) throw new Error("An exact release commit is required");
}

export function verifyMainCi(run, expectedSha) {
  requireRevision(expectedSha);
  if (run?.workflowName !== "CI" || run?.event !== "push" || run?.headBranch !== "main" || run?.headSha !== expectedSha
    || run?.status !== "completed" || run?.conclusion !== "success" || !Array.isArray(run?.jobs)) {
    throw new Error("The exact main commit has no successful CI and staging run");
  }
  for (const name of requiredJobs) {
    const matching = run.jobs.filter((job) => job?.name === name);
    if (matching.length !== 1 || matching[0].status !== "completed" || matching[0].conclusion !== "success") {
      throw new Error(`Missing successful release job ${name}`);
    }
  }
  const staging = run.jobs.find((job) => job?.name === "deploy-staging");
  for (const name of stagedSteps) {
    if (!Array.isArray(staging.steps) || !staging.steps.some((step) =>
      step?.name === name && step.status === "completed" && step.conclusion === "success")) {
      throw new Error(`Missing successful staging step ${name}`);
    }
  }
}

export function verifyDeployment({ health, readiness, version }, expectedSha, environment) {
  requireRevision(expectedSha);
  if (environment !== "preview" && environment !== "production") throw new Error("Invalid release environment");
  const isExact = (source) => source?.service === "alvillas-os" && source?.version === expectedSha;
  const isRelease = (source) => isExact(source) && source.environment === environment && source.commitRef === "main";
  if (!isExact(health) || health.status !== "ok" || !isRelease(version)) {
    throw new Error("Deployment health or exact release identity did not pass");
  }
  if (readiness?.status !== "ready" || !isRelease(readiness.service)) {
    throw new Error("Deployment readiness did not pass for the exact release");
  }
}

function main(args) {
  const [mode, ...values] = args;
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));
  if (mode === "ci" && values.length === 2) {
    const [sha, file] = values;
    verifyMainCi(read(file), sha);
    return console.log(`Mandatory CI and staging passed for ${sha}.`);
  }
  if (mode === "deployment" && values.length === 5) {
    const [sha, target, health, readiness, version] = values;
    verifyDeployment({ health: read(health), readiness: read(readiness), version: read(version) }, sha, target);
    return console.log(`Deployment health and readiness passed for ${sha} in ${target}.`);
  }
  throw new Error("Expected ci <sha> <run-file> or deployment <sha> <environment> <health-file> <readiness-file> <version-file>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof SyntaxError ? "Invalid release evidence JSON" : (error instanceof Error ? error.message : "Release evidence failed"));
    process.exitCode = 1;
  }
}
