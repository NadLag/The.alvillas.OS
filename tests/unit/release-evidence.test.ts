import { describe, expect, it } from "vitest";
import { verifyDeployment, verifyMainCi } from "../../scripts/ci/check-release-evidence.mjs";

const sha = "a".repeat(40);
const jobs = ["static", "unit", "postgres", "restore-build", "playwright (chromium)",
  "playwright (field-mobile)", "checks", "deploy-staging"];
const stageSteps = ["Smoke staging deployment", "Assign stable staging alias"];

function releaseRun() {
  return {
    workflowName: "CI", event: "push", headBranch: "main", headSha: sha, status: "completed", conclusion: "success",
    jobs: jobs.map((name) => ({
      name, status: "completed", conclusion: "success",
      steps: name === "deploy-staging" ? stageSteps.map((name) => ({ name, status: "completed", conclusion: "success" })) : []
    }))
  };
}

function deployment(environment = "preview") {
  const version = { service: "alvillas-os", version: sha, environment, commitRef: "main" };
  return { health: { service: "alvillas-os", version: sha, status: "ok" }, readiness: { status: "ready", service: { ...version } }, version };
}

describe("release evidence", () => {
  it("requires the exact main run, both zero-retry browser jobs and a completed staging assignment", () => {
    expect(() => verifyMainCi(releaseRun(), sha)).not.toThrow();
    expect(() => verifyMainCi({ ...releaseRun(), event: "pull_request" }, sha)).toThrow();
    expect(() => verifyMainCi(releaseRun(), "b".repeat(40))).toThrow();
    const missing = releaseRun();
    missing.jobs = missing.jobs.filter((job) => job.name !== "playwright (field-mobile)");
    expect(() => verifyMainCi(missing, sha)).toThrow("playwright (field-mobile)");
    const skipped = releaseRun();
    skipped.jobs.at(-1)!.steps.at(-1)!.conclusion = "skipped";
    expect(() => verifyMainCi(skipped, sha)).toThrow("Assign stable staging alias");
  });

  it("rejects unhealthy, stale or unintended deployment artifacts before aliasing or promotion", () => {
    expect(() => verifyDeployment(deployment(), sha, "preview")).not.toThrow();
    expect(() => verifyDeployment(deployment("production"), sha, "production")).not.toThrow();
    expect(() => verifyDeployment(deployment("preview"), sha, "production")).toThrow();
    const unready = deployment();
    unready.readiness.status = "not_ready";
    expect(() => verifyDeployment(unready, sha, "preview")).toThrow("readiness");
    const stale = deployment();
    stale.readiness.service.version = "b".repeat(40);
    expect(() => verifyDeployment(stale, sha, "preview")).toThrow("readiness");
  });
});
