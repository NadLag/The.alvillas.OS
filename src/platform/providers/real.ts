import { createHash, createHmac } from "node:crypto";
import { escapeHtml } from "@/platform/encoding/html";
import type {
  EmailProvider,
  NotificationChannel,
  PaymentProvider,
  PdfRenderer,
  ReservationAdapter,
  SignatureProvider,
  StorageProvider
} from "@/platform/providers";
import type { AppLocale } from "@/i18n/routing";
import type { AppEnv } from "@/platform/env/env";

export type HttpTransport = (
  url: string,
  init: {
    method: "GET" | "POST" | "PUT";
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  headers?: { get(name: string): string | null };
}>;

type EnvLike = Partial<AppEnv> & Record<string, string | undefined>;

function required(env: EnvLike, key: keyof AppEnv): string {
  const value = env[key];

  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function baseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function jsonRequest<T>(
  transport: HttpTransport,
  url: string,
  init: {
    method: "POST" | "PUT";
    headers?: Record<string, string>;
    body: unknown;
  }
): Promise<T> {
  const response = await transport(url, {
    method: init.method,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    },
    body: JSON.stringify(init.body)
  });

  if (!response.ok) {
    throw new Error(`Provider request failed with ${response.status}: ${await response.text()}`);
  }

  return (await response.json()) as T;
}

export class EmailRequestError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super(`Resend email request failed with status ${status}`); }
}

export class ResendEmailProvider implements EmailProvider {
  private readonly apiKey: string;
  private readonly from: string;

  constructor(
    env: EnvLike = process.env,
    private readonly transport: HttpTransport = fetch
  ) {
    this.apiKey = required(env, "RESEND_API_KEY");
    this.from = required(env, "EMAIL_FROM");
  }

  async send(input: Parameters<EmailProvider["send"]>[0]): Promise<{ id: string }> {
    const content = { to: input.to, subject: input.subject, html: input.html, text: input.text, locale: input.locale, template: input.template };
    const idempotencyKey = input.idempotencyKey ?? `email:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
    if (!/^[\x21-\x7e]{1,256}$/u.test(idempotencyKey)) throw new Error("Invalid email idempotency key");
    const response = await this.transport("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify({
        from: this.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        tags: [
          { name: "template", value: input.template },
          { name: "locale", value: input.locale },
          ...(input.deliveryReference ? [{ name: "organization_id", value: input.deliveryReference.organizationId }, { name: "delivery_id", value: input.deliveryReference.deliveryId }] : [])
        ]
      })
    }).catch(() => { throw new Error("Resend email transport failed"); });
    // Provider response bodies can contain recipients, codes or credentials.
    // Persist only a stable status in the existing outbox error channel.
    if (!response.ok) {
      const value = response.headers?.get("retry-after");
      const delay = value && /^\d+$/u.test(value) ? Number(value) * 1000 : value ? Date.parse(value) - Date.now() : 0;
      throw new EmailRequestError(response.status, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 86400000)) : 0);
    }
    const body = await response.json().catch(() => { throw new Error("Invalid Resend email response"); }) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      throw new Error("Resend response did not include an email id");
    }
    return { id: body.id };
  }
}

export class DocumensoSignatureProvider implements SignatureProvider {
  private readonly apiBaseUrl: string;
  private readonly token: string;

  constructor(
    env: EnvLike = process.env,
    private readonly transport: HttpTransport = fetch
  ) {
    this.apiBaseUrl = `${baseUrl(required(env, "DOCUMENSO_URL"))}/api/v2`;
    this.token = required(env, "DOCUMENSO_API_TOKEN");
  }

  async createRequest(input: {
    documentId: string;
    signerEmail: string;
  }): Promise<{ requestId: string }> {
    const headers = { Authorization: this.token };
    const recipient = await jsonRequest<{ id?: string }>(
      this.transport,
      `${this.apiBaseUrl}/document/recipient/create`,
      {
        method: "POST",
        headers,
        body: {
          documentId: input.documentId,
          email: input.signerEmail,
          name: input.signerEmail,
          role: "SIGNER"
        }
      }
    );
    const distributed = await jsonRequest<{ id?: string; success?: boolean }>(
      this.transport,
      `${this.apiBaseUrl}/document/distribute`,
      {
        method: "POST",
        headers,
        body: { documentId: input.documentId }
      }
    );

    return { requestId: distributed.id ?? recipient.id ?? input.documentId };
  }
}

export class PayPalPaymentProvider implements PaymentProvider {
  private readonly clientId: string;
  private readonly secret: string;
  private readonly apiBaseUrl: string;

  constructor(
    env: EnvLike = process.env,
    private readonly transport: HttpTransport = fetch
  ) {
    this.clientId = required(env, "PAYPAL_CLIENT_ID");
    this.secret = required(env, "PAYPAL_SECRET");
    this.apiBaseUrl = baseUrl(env.PAYPAL_BASE_URL || "https://api-m.paypal.com");
  }

  async record(input: {
    amount: string;
    currency: string;
    source: string;
  }): Promise<{ paymentId: string }> {
    const tokenResponse = await this.transport(`${this.apiBaseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    });

    if (!tokenResponse.ok) {
      throw new Error(`PayPal OAuth failed with ${tokenResponse.status}: ${await tokenResponse.text()}`);
    }

    const tokenBody = (await tokenResponse.json()) as { access_token?: string };
    const accessToken = tokenBody.access_token;

    if (!accessToken) {
      throw new Error("PayPal OAuth response did not include an access token");
    }

    const capture = await jsonRequest<{ id?: string }>(
      this.transport,
      `${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(input.source)}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "PayPal-Request-Id": `${input.source}:${input.currency}:${input.amount}`
        },
        body: {}
      }
    );

    return { paymentId: capture.id ?? input.source };
  }
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function isoBasic(date: Date): { dateStamp: string; amzDate: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/gu, "");

  return {
    dateStamp: iso.slice(0, 8),
    amzDate: iso
  };
}

export class R2StorageProvider implements StorageProvider {
  private readonly accountId: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly bucket: string;

  constructor(
    env: EnvLike = process.env,
    private readonly now: () => Date = () => new Date()
  ) {
    this.accountId = required(env, "R2_ACCOUNT_ID");
    this.accessKeyId = required(env, "R2_ACCESS_KEY_ID");
    this.secretAccessKey = required(env, "R2_SECRET_ACCESS_KEY");
    this.bucket = required(env, "R2_BUCKET");
  }

  createSignedUploadUrl(input: { key: string; contentType: string }): Promise<{ url: string }> {
    void input.contentType;
    const { dateStamp, amzDate } = isoBasic(this.now());
    const host = `${this.accountId}.r2.cloudflarestorage.com`;
    const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
    const canonicalUri = `/${encodePath(this.bucket)}/${encodePath(input.key)}`;
    const query = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": "900",
      "X-Amz-SignedHeaders": "host"
    });
    const canonicalQuery = [...query.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const canonicalRequest = [
      "PUT",
      canonicalUri,
      canonicalQuery,
      `host:${host}`,
      "",
      "host",
      "UNSIGNED-PAYLOAD"
    ].join("\n");
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      createHash("sha256").update(canonicalRequest).digest("hex")
    ].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, dateStamp), "auto"), "s3"),
      "aws4_request"
    );
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

    query.set("X-Amz-Signature", signature);

    return Promise.resolve({
      url: `https://${host}${canonicalUri}?${query.toString()}`
    });
  }
}

export class IcalReservationAdapter implements ReservationAdapter {
  constructor(private readonly transport: HttpTransport = fetch) {}

  async sync(input: { organizationId: string; sourceId: string }): Promise<{ imported: number }> {
    void input.organizationId;
    const response = await this.transport(input.sourceId, { method: "GET" });

    if (!response.ok) {
      throw new Error(`iCal sync failed with ${response.status}: ${await response.text()}`);
    }

    const body = await response.text();

    return { imported: (body.match(/^BEGIN:VEVENT$/gmu) ?? []).length };
  }
}

export class EmailNotificationChannel implements NotificationChannel {
  constructor(private readonly emailProvider: EmailProvider) {}

  async notify(input: {
    userId: string;
    subject: string;
    body: string;
    locale?: AppLocale;
    idempotencyKey?: string;
  }): Promise<{ id: string }> {
    return this.emailProvider.send({
      to: input.userId,
      subject: input.subject,
      html: `<p>${escapeHtml(input.body)}</p>`,
      text: input.body,
      locale: input.locale ?? "en",
      template: "notification.system",
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
    });
  }
}

export class HttpPdfRenderer implements PdfRenderer {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(
    env: EnvLike = process.env,
    private readonly transport: HttpTransport = fetch
  ) {
    this.endpoint = required(env, "PDF_RENDERER_ENDPOINT");
    this.token = required(env, "PDF_RENDERER_TOKEN");
  }

  async render(input: Parameters<PdfRenderer["render"]>[0]): Promise<Uint8Array> {
    const response = await this.transport(this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      throw new Error(`PDF renderer failed with ${response.status}: ${await response.text()}`);
    }

    return new Uint8Array(await response.arrayBuffer());
  }
}
