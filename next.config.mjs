import createNextIntlPlugin from "next-intl/plugin";
import process from "node:process";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pdfjs-dist"],
  outputFileTracingIncludes: {
    "/api/inngest": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documents/signatures/preparation/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documents/signatures/distribution/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documents/signatures/identity/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/api/documents/signatures/archive/*": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"]
  },
  typescript: { tsconfigPath: process.env.ALVILLAS_BUILD_TSCONFIG ?? "tsconfig.json" },
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  logging: { serverFunctions: false },
  async headers() {
    const security = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "geolocation=(), microphone=(), payment=()" }
    ];
    if (process.env.NODE_ENV === "production") {
      security.push({ key: "Strict-Transport-Security", value: "max-age=31536000" });
    }
    return [{ source: "/:path*", headers: security }, { source: "/sw.js", headers: [
      { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
      { key: "Service-Worker-Allowed", value: "/" },
      { key: "Content-Security-Policy", value: "default-src 'self'; connect-src 'self'" }
    ] }];
  }
};

export default withNextIntl(nextConfig);
