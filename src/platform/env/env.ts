import { z } from "zod";

const optionalUrl = z.string().url().optional().or(z.literal(""));

export const envSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  DIRECT_DATABASE_URL: z.string().url().optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  AUTH_SECRET: z.string().optional(),
  ADMIN_EMAIL: z.string().email().optional().or(z.literal("")),
  ADMIN_PASSWORD: z.string().optional(),
  ENCRYPTION_KEYS: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional().or(z.literal("")),
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  RESERVATION_ADAPTER_MODE: z.enum(["ical", "none"]).optional().or(z.literal("")),
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
  SENTRY_DSN: optionalUrl,
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
  NEXT_PUBLIC_SENTRY_ENVIRONMENT: z.string().optional(),
  DOCUMENSO_URL: optionalUrl,
  DOCUMENSO_API_TOKEN: z.string().optional(),
  DOCUMENSO_WEBHOOK_SECRET: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  NEXT_PUBLIC_WHATSAPP_NUMBER: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_SECRET: z.string().optional(),
  PAYPAL_BASE_URL: optionalUrl,
  PDF_RENDERER_ENDPOINT: optionalUrl,
  PDF_RENDERER_TOKEN: z.string().optional(),
  INNGEST_EVENT_URL: optionalUrl,
  INNGEST_ENV: z.string().optional(),
  ALVILLAS_STRICT_READINESS: z.enum(["0", "1"]).optional()
});

export type AppEnv = z.infer<typeof envSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}

export type EnvValidationIssue = {
  key: keyof AppEnv | "schema";
  severity: "error" | "warning";
  message: string;
};

const productionRequiredKeys: Array<keyof AppEnv> = [
  "DATABASE_URL",
  "APP_URL",
  "AUTH_SECRET",
  "ENCRYPTION_KEYS"
];

export function validateRuntimeEnv(source: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  issues: EnvValidationIssue[];
} {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        key: (issue.path[0] as keyof AppEnv | undefined) ?? "schema",
        severity: "error",
        message: issue.message
      }))
    };
  }

  const env = parsed.data;
  const isProductionRuntime = source.NODE_ENV === "production" || source.VERCEL_ENV === "production";
  const issues: EnvValidationIssue[] = [];

  if (isProductionRuntime) {
    for (const key of productionRequiredKeys) {
      if (!env[key]) {
        issues.push({
          key,
          severity: "error",
          message: `${key} is required in production`
        });
      }
    }
  }

  if (env.SENTRY_DSN && !env.NEXT_PUBLIC_SENTRY_DSN) {
    issues.push({
      key: "NEXT_PUBLIC_SENTRY_DSN",
      severity: "warning",
      message: "NEXT_PUBLIC_SENTRY_DSN is recommended when SENTRY_DSN is configured"
    });
  }

  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    issues
  };
}
