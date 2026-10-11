export const serviceName = "alvillas-os";

export type ServiceInfoEnv = {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
  VERCEL_GIT_COMMIT_REF?: string;
  VERCEL_DEPLOYMENT_ID?: string;
};

export type ServiceInfo = {
  service: typeof serviceName;
  environment: string;
  version: string;
  commitRef: string;
  deploymentId: string | null;
  timestamp: string;
};

export function readServiceInfo(
  source: ServiceInfoEnv = process.env,
  now: Date = new Date()
): ServiceInfo {
  return {
    service: serviceName,
    environment: source.VERCEL_ENV ?? source.NODE_ENV ?? "development",
    version: source.VERCEL_GIT_COMMIT_SHA ?? "local",
    commitRef: source.VERCEL_GIT_COMMIT_REF ?? "local",
    deploymentId: source.VERCEL_DEPLOYMENT_ID ?? null,
    timestamp: now.toISOString()
  };
}
