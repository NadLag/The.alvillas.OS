import { describe, expect, it, vi } from "vitest";
import { checkStagingVercelAccess } from "../../scripts/staging-vercel-access";
import { stagingTarget } from "../../scripts/staging-target";

const token = "private-test-credential";
const approved: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  GITHUB_REPOSITORY: stagingTarget.repository,
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  VERCEL_ORG_ID: stagingTarget.orgId,
  VERCEL_PROJECT_ID: stagingTarget.projectId,
  VERCEL_TOKEN: token
};
const bodies = [
  { user: { id: "private-user-id", email: "private@example.test" } },
  { id: stagingTarget.orgId, slug: stagingTarget.teamSlug, billing: "private-billing" },
  { id: stagingTarget.projectId, accountId: stagingTarget.orgId, name: stagingTarget.projectName, env: "private-environment" }
];

function responses(statuses = [200, 200, 200], payloads: unknown[] = bodies) {
  let index = 0;
  return vi.fn<typeof fetch>(() => {
    const i = index++;
    return Promise.resolve(new Response(JSON.stringify(payloads[i]), { status: statuses[i] }));
  });
}

describe("staging Vercel authentication preflight", () => {
  it("uses only the environment token, with three fixed read-only API requests and no redirects", async () => {
    const request = responses();
    const result = await checkStagingVercelAccess({ ...approved, VERCEL_ACCESS_TOKEN: "unused-other-token", VERCEL_OIDC_TOKEN: "unused-oidc" }, request);
    expect(result.ready).toBe(true);
    expect(result.diagnosis).toBe("ready");
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      "https://api.vercel.com/v2/user",
      `https://api.vercel.com/v2/teams/${stagingTarget.orgId}`,
      `https://api.vercel.com/v9/projects/${stagingTarget.projectId}?teamId=${stagingTarget.orgId}`
    ]);
    for (const [, init] of request.mock.calls) {
      expect(init).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", cache: "no-store" });
      expect(init?.body).toBeUndefined();
    }
    for (const privateValue of [token, "private-user-id", "private@example.test", "private-billing", "private-environment", "unused-other-token", "unused-oidc"]) {
      expect(JSON.stringify(result)).not.toContain(privateValue);
    }
  });

  it.each([
    { GITHUB_REPOSITORY: "other/product" }, { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_SHA: "main" }, { VERCEL_ORG_ID: "another-team" }, { VERCEL_PROJECT_ID: "another-project" }
  ])("rejects unapproved context before exposing a credential to the network: %j", async override => {
    const request = responses();
    await expect(checkStagingVercelAccess({ ...approved, ...override }, request)).rejects.toThrow("Staging commands require");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " leading", "trailing ", "embedded\nnewline"])("rejects a missing or malformed token before any request: %j", async value => {
    const request = responses();
    expect(await checkStagingVercelAccess({ ...approved, VERCEL_TOKEN: value }, request)).toMatchObject({ ready: false, diagnosis: "missing_or_malformed_token", probes: [] });
    expect(request).not.toHaveBeenCalled();
  });

  it("distinguishes project access from the user/team metadata access required by CLI", async () => {
    const result = await checkStagingVercelAccess(approved, responses([404, 403, 200], [
      { error: { message: token } }, { error: { message: "private error body" } }, bodies[2]
    ]));
    expect(result).toMatchObject({ ready: false, diagnosis: "project_access_allowed_cli_metadata_denied", probes: [
      { resource: "user", httpStatus: 404, outcome: "denied" },
      { resource: "team", httpStatus: 403, outcome: "denied" },
      { resource: "project", httpStatus: 200, outcome: "allowed" }
    ] });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("private error body");
  });

  it("reports rejected authentication without inferring an expiry or printing provider errors", async () => {
    const result = await checkStagingVercelAccess(approved, responses([401, 401, 401]));
    expect(result).toMatchObject({ ready: false, diagnosis: "token_rejected" });
  });

  it.each([
    { id: "wrong-project" }, { accountId: "wrong-team" }, { name: "wrong-project-name" }
  ])("fails closed on a project belonging to another target: %j", async override => {
    expect(await checkStagingVercelAccess(approved, responses([200, 200, 200], [bodies[0], bodies[1], { ...bodies[2], ...override }]))).toMatchObject({ ready: false, diagnosis: "target_mismatch" });
  });

  it("fails closed when returned team identity differs from the configured target", async () => {
    expect(await checkStagingVercelAccess(approved, responses([200, 200, 200], [bodies[0], { ...bodies[1], slug: "wrong-team-slug" }, bodies[2]]))).toMatchObject({ ready: false, diagnosis: "target_mismatch" });
  });

  it("reports target access denied when user authentication works but project access fails", async () => {
    expect(await checkStagingVercelAccess(approved, responses([200, 403, 404]))).toMatchObject({ ready: false, diagnosis: "intended_team_or_project_access_denied" });
  });

  it.each([429, 500, 503])("does not mistake transient provider failures for a token-scope finding: %s", async status => {
    expect(await checkStagingVercelAccess(approved, responses([status, status, status]))).toMatchObject({ ready: false, diagnosis: "access_check_inconclusive" });
  });

  it("never includes exceptions or malformed response text in diagnostic output", async () => {
    const request = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`Authorization: Bearer ${token}`))
      .mockResolvedValueOnce(new Response(`malformed response containing ${token}`, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(bodies[2]), { status: 200 }));
    const result = await checkStagingVercelAccess(approved, request);
    expect(result).toMatchObject({ ready: false, diagnosis: "access_check_inconclusive" });
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
