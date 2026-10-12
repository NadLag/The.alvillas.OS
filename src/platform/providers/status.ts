import { parseSentryDsn } from "@/platform/observability/sentry";

export type ProviderStatus = {
  name: string;
  status: "configured" | "missing";
  requiredKeys: string[];
  missingKeys: string[];
  detail: string;
};

type ProviderRequirement = {
  name: string;
  requiredKeys: string[];
  configuredWhen?: (env: Record<string, string | undefined>) => boolean;
  detail: string;
};

const providerRequirements: ProviderRequirement[] = [
  {
    name: "email",
    requiredKeys: ["RESEND_API_KEY", "EMAIL_FROM"],
    detail: "Resend transactional email provider"
  },
  {
    name: "signature",
    requiredKeys: ["DOCUMENSO_URL", "DOCUMENSO_API_TOKEN", "DOCUMENSO_WEBHOOK_SECRET"],
    detail: "Documenso signature provider"
  },
  {
    name: "payment",
    requiredKeys: ["PAYPAL_CLIENT_ID", "PAYPAL_SECRET"],
    detail: "PayPal payment adapter for direct payments"
  },
  {
    name: "storage",
    requiredKeys: ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
    detail: "Cloudflare R2 object storage provider"
  },
  {
    name: "reservation_adapter",
    requiredKeys: ["RESERVATION_ADAPTER_MODE"],
    detail: "Reservation adapter selection"
  },
  {
    name: "notification",
    requiredKeys: ["RESEND_API_KEY", "EMAIL_FROM", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"],
    detail: "Email and web-push notification channel"
  },
  {
    name: "pdf",
    requiredKeys: ["PDF_RENDERER_ENDPOINT", "PDF_RENDERER_TOKEN"],
    detail: "External PDF renderer"
  },
  {
    name: "sentry",
    requiredKeys: ["SENTRY_DSN"],
    configuredWhen: (env) => parseSentryDsn(env.SENTRY_DSN)?.envelopeUrl !== undefined,
    detail: "Sentry web/server/job error reporting"
  },
  {
    name: "inngest",
    requiredKeys: ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"],
    detail: "Inngest event dispatch and function signing"
  },
  {
    name: "rate_limiter",
    requiredKeys: ["DATABASE_URL"],
    detail: "PostgreSQL rate limiter"
  }
];

export function readProviderStatuses(env: Record<string, string | undefined> = process.env): ProviderStatus[] {
  return providerRequirements.map((provider) => {
    const missingKeys = provider.requiredKeys.filter((key) => !env[key]);
    const configured = provider.configuredWhen
      ? provider.configuredWhen(env)
      : missingKeys.length === 0;

    return {
      name: provider.name,
      status: configured ? "configured" : "missing",
      requiredKeys: provider.requiredKeys,
      missingKeys: configured ? [] : missingKeys,
      detail: configured
        ? `${provider.detail} configured`
        : `${provider.detail} missing ${missingKeys.join(", ")}`
    };
  });
}
