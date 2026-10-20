export const stagingTarget = {
  repository: "NadLag/The.alvillas.OS",
  orgId: "team_tVCdcmsKYxqXHGybrNlB0CGS",
  projectId: "prj_GJBdVD7r7fBkG7vH9rn2K2eLwobC",
  teamSlug: "nadirlagnadi-6231s-projects",
  projectName: "the-alvillas-os"
} as const;

export function assertStagingTarget(env: NodeJS.ProcessEnv): void {
  if (env.GITHUB_REPOSITORY !== stagingTarget.repository || env.GITHUB_REF !== "refs/heads/main" ||
      !/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? "") ||
      env.VERCEL_PROJECT_ID !== stagingTarget.projectId || env.VERCEL_ORG_ID !== stagingTarget.orgId) {
    throw new Error("Staging commands require the independent project's merged main workflow");
  }
}
