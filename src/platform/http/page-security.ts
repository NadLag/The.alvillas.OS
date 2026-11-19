import { publicWebsitePaths } from "@/platform/website/site";

const publicPaths = new Set<string>([...publicWebsitePaths, "/offline/field", "/manifest.webmanifest"]);
const safeStorageAccount = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const safeNonce = /^[A-Za-z0-9+/]{24}$/u;

export function usesPrivatePagePolicy(pathname: string): boolean {
  if (pathname === "/") return false;
  const relativePath = pathname.replace(/^\/(?:en|fr|ar)(?=\/|$)/u, "").replace(/\/$/u, "");
  return !publicPaths.has(relativePath);
}

export function pageContentSecurityPolicy(input: {
  nonce?: string;
  development: boolean;
  storageAccount?: string;
}) {
  if (input.nonce !== undefined && !safeNonce.test(input.nonce)) throw new TypeError("Invalid page nonce");
  const scripts = input.nonce
    ? ["'self'", `'nonce-${input.nonce}'`, "'strict-dynamic'"]
    : ["'self'", "'unsafe-inline'"];
  if (input.development) scripts.push("'unsafe-eval'");
  const connect = ["'self'"];
  if (input.storageAccount && safeStorageAccount.test(input.storageAccount)) {
    connect.push(`https://${input.storageAccount}.r2.cloudflarestorage.com`);
  }
  if (input.development) connect.push("ws:", "wss:");
  return [
    "default-src 'self'",
    `script-src ${scripts.join(" ")}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
}
