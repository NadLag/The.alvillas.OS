import { describe, expect, it } from "vitest";
import { pageContentSecurityPolicy, usesPrivatePagePolicy } from "@/platform/http/page-security";

describe("browser security policies", () => {
  it("uses a nonce for authenticated and secret-link document paths", () => {
    for (const path of ["/en/app", "/fr/guest/link", "/ar/personal/household", "/fr/login", "/ar/activate/token", "/en/recover", "/en/%6cogin", "/en/new-private-feature"]) {
      expect(usesPrivatePagePolicy(path)).toBe(true);
    }
    for (const path of ["/", "/en", "/fr/assessment", "/ar/offline/field", "/en/manifest.webmanifest"]) {
      expect(usesPrivatePagePolicy(path)).toBe(false);
    }
    const nonce = "abcdefghijklmnopqrstuvwx";
    const policy = pageContentSecurityPolicy({ nonce, development: false });
    expect(policy).toContain(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; script-src-attr 'none'`);
    expect(policy).toContain("object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    expect(policy.split("; ").find((rule) => rule.startsWith("script-src "))).not.toContain("'unsafe-inline'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(() => pageContentSecurityPolicy({ nonce: "malformed';", development: false })).toThrow();
  });

  it("retains public framework scripts and limits direct storage connections to the configured account", () => {
    const policy = pageContentSecurityPolicy({ development: false, storageAccount: "alvillas-e2e-local" });
    expect(policy).toContain("script-src 'self' 'unsafe-inline'; script-src-attr 'none'");
    expect(policy).toContain("connect-src 'self' https://alvillas-e2e-local.r2.cloudflarestorage.com;");
    const development = pageContentSecurityPolicy({ development: true, storageAccount: "invalid; example.test" });
    expect(development).toContain("'unsafe-eval'");
    expect(development).toContain("connect-src 'self' ws: wss:;");
    expect(development).not.toContain("example.test");
  });
});
