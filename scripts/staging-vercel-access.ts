import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertStagingTarget, stagingTarget } from "./staging-target";

type Resource = "user" | "team" | "project";
type Probe = {
  resource: Resource;
  httpStatus: number | null;
  outcome: "allowed" | "denied" | "target_mismatch" | "invalid_response" | "unavailable";
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export async function checkStagingVercelAccess(env: NodeJS.ProcessEnv, request: typeof fetch = fetch) {
  assertStagingTarget(env);
  const token = env.VERCEL_TOKEN;
  if (!token || token !== token.trim() || /\s/u.test(token)) {
    return { ready: false, credentialSource: "VERCEL_TOKEN", diagnosis: "missing_or_malformed_token", probes: [] as Probe[] };
  }
  const endpoints: Array<[Resource, string]> = [
    ["user", "/v2/user"],
    ["team", `/v2/teams/${stagingTarget.orgId}`],
    ["project", `/v9/projects/${stagingTarget.projectId}?teamId=${stagingTarget.orgId}`]
  ];
  const probes: Probe[] = [];
  for (const [resource, path] of endpoints) {
    let httpStatus: number | null = null;
    try {
      const response = await request(`https://api.vercel.com${path}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(15000)
      });
      httpStatus = response.status;
      if (!response.ok) {
        // Provider bodies, profiles and headers may contain private data. Never log them.
        await response.body?.cancel();
        probes.push({ resource, httpStatus, outcome: response.status >= 500 || response.status === 429 ? "unavailable" : "denied" });
        continue;
      }
      const body = record(await response.json());
      if (!body) {
        probes.push({ resource, httpStatus, outcome: "invalid_response" });
        continue;
      }
      const user = record(body.user);
      const validUser = user && typeof user.id === "string" && user.id.length > 0;
      const matches = resource === "user" ? validUser
        : resource === "team" ? body.id === stagingTarget.orgId && body.slug === stagingTarget.teamSlug
        : body.id === stagingTarget.projectId && body.accountId === stagingTarget.orgId && body.name === stagingTarget.projectName;
      probes.push({ resource, httpStatus, outcome: matches ? "allowed" : resource === "user" ? "invalid_response" : "target_mismatch" });
    } catch {
      // Network errors and JSON parser errors can echo credentials or response bodies.
      probes.push({ resource, httpStatus, outcome: httpStatus !== null && httpStatus < 300 ? "invalid_response" : "unavailable" });
    }
  }
  const ready = probes.every(probe => probe.outcome === "allowed");
  const diagnosis = ready ? "ready"
    : probes.some(probe => probe.outcome === "target_mismatch") ? "target_mismatch"
    : probes.some(probe => probe.httpStatus === 401) ? "token_rejected"
    : probes.some(probe => probe.outcome === "unavailable" || probe.outcome === "invalid_response") ? "access_check_inconclusive"
    : probes.find(probe => probe.resource === "project")?.outcome === "allowed" ? "project_access_allowed_cli_metadata_denied"
    : "intended_team_or_project_access_denied";
  return { ready, credentialSource: "VERCEL_TOKEN", diagnosis, probes };
}

async function main(): Promise<void> {
  try {
    const result = await checkStagingVercelAccess(process.env);
    const safeOutput = JSON.stringify(result);
    console.log(safeOutput);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Staging Vercel access (read-only)\n\n\`\`\`json\n${safeOutput}\n\`\`\`\n`);
    }
    process.exitCode = result.ready ? 0 : 1;
  } catch {
    console.error("Staging Vercel access check refused: invalid target or unavailable diagnostic output.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
