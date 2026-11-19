import { randomBytes } from "node:crypto";
import createMiddleware from "next-intl/middleware";
import { NextRequest } from "next/server";
import { routing } from "./i18n/routing";
import { pageContentSecurityPolicy, usesPrivatePagePolicy } from "./platform/http/page-security";

const localize = createMiddleware(routing);

export function proxy(request: NextRequest) {
  const nonce = usesPrivatePagePolicy(request.nextUrl.pathname) ? randomBytes(18).toString("base64") : undefined;
  const policy = pageContentSecurityPolicy({
    nonce, development: process.env.NODE_ENV === "development", storageAccount: process.env.R2_ACCOUNT_ID
  });
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", policy);
  const response = localize(new NextRequest(request, { headers }));
  response.headers.set("Content-Security-Policy", policy);
  if (nonce) response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = {
  matcher: ["/", "/(en|fr|ar)/:path*"]
};
