export function verifyMainCi(run: unknown, expectedSha: string): void;
export function verifyDeployment(
  evidence: { health: unknown; readiness: unknown; version: unknown },
  expectedSha: string,
  environment: "preview" | "production"
): void;
