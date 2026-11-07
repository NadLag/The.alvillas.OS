import { ICalAdapter } from "@/modules/reservations/domain/adapters";
import { createHash, createHmac } from "node:crypto";
import { escapeHtml } from "@/platform/encoding/html";
import { privateUploadUrlLifetimeSeconds, temporaryUploadPartKey, type TemporaryUploadPart } from "@/platform/storage/upload-protocol";
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
import { paymentCaptureIntent, verifiedPayPalCapture, verifiedPayPalCaptureEvidence, payPalOrderState, PaymentCaptureEvidenceError } from "./payment-capture";
import { paymentRefundIntent, paymentRefundLookup, verifiedPayPalRefundResult, PaymentRefundEvidenceError } from "./payment-refund";
import { z } from "zod";
import { readBoundedResponseBytes } from "@/platform/http/read-exact-response";
import { captureSignatureRequest, signatureMaximumEvidenceBytes, signatureMaximumPdfBytes, signatureTransportTimeoutMs, signatureRequestIdSchema, signatureRecipientRoleSchema, signatureProviderStatusSchema, signatureDownloadInputSchema, signatureCertificateInputSchema, signatureRequestHasCompletedActions, signatureExpirationSchema, signatureEmailSettingsSchema, signatureRequestObservationSchema,
  SignatureProviderError, SignatureProviderConfigurationError, type SignatureRequestInput, type SignatureRequestReceipt, type SignatureRequestObservation, type SignatureRequestDownloadInput, type SignatureRequestDownload, type SignatureCertificateDownloadInput, type SignatureCertificateDownload } from "./signature-request";

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
  constructor(readonly status: number, readonly retryAfterMs = 0, readonly code?: "invalid_idempotent_request" | "concurrent_idempotent_requests") { super(`Resend email request failed with status ${status}`); }
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
    // Resend tag values permit ASCII letters, numbers, underscores and dashes.
    const templateTag = input.template.replaceAll(".", "_");
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(templateTag)) throw new Error("Invalid email template tag");
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
          { name: "template", value: templateTag },
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
      const body = await response.json().catch(() => null) as { name?: unknown } | null;
      const code = body?.name === "invalid_idempotent_request" || body?.name === "concurrent_idempotent_requests" ? body.name : undefined;
      throw new EmailRequestError(response.status, Number.isFinite(delay) ? Math.max(0, Math.min(delay, 86400000)) : 0, code);
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
    private readonly transport: HttpTransport = fetch,
    private readonly signatureTransport: typeof fetch = fetch
  ) {
    this.apiBaseUrl = `${baseUrl(required(env, "DOCUMENSO_URL"))}/api/v2`;
    this.token = required(env, "DOCUMENSO_API_TOKEN");
    this.nodeEnv = env.NODE_ENV;
  }

  private readonly nodeEnv: string | undefined;
  private signatureEndpoint(path: string) {
    try { const base = new URL(this.apiBaseUrl), owned = this.nodeEnv === "test" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
      if (base.username || base.password || base.search || base.hash || (base.protocol !== "https:" && !(owned && base.protocol === "http:"))) throw new SignatureProviderConfigurationError();
      return this.apiBaseUrl + path;
    } catch { throw new SignatureProviderConfigurationError(); }
  }
  private async signatureJson(path: string, body?: BodyInit, json = false) {
    const effect = body === undefined ? "NONE" : "UNCERTAIN", endpoint = this.signatureEndpoint(path); let status: number | undefined;
    try {
      const response = await this.signatureTransport(endpoint, { method: body === undefined ? "GET" : "POST", body, credentials: "omit", cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(signatureTransportTimeoutMs), headers: { Authorization: this.token, ...json ? { "content-type": "application/json" } : {} } }); status = response.status;
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") { await response.body?.cancel().catch(() => undefined); throw new SignatureProviderError(effect, status); }
      const bytes = await readBoundedResponseBytes(response, signatureMaximumEvidenceBytes), value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return { value, evidence: bytes };
    } catch { throw new SignatureProviderError(effect, status); }
  }
  async prepareSignatureRequest(raw: SignatureRequestInput): Promise<SignatureRequestReceipt> {
    const input = captureSignatureRequest(raw); if (input.locale === "ar") throw new SignatureProviderConfigurationError();
    const payload = { type: "DOCUMENT", title: input.title, externalId: input.reference, visibility: "ADMIN", recipients: input.recipients.map(recipient => ({ ...recipient, fields: recipient.fields.map(field => ({ ...field, identifier: 0 })) })),
      meta: { language: input.locale, signingOrder: input.signingOrder, distributionMethod: "NONE", allowDictateNextSigner: false, typedSignatureEnabled: input.methods.typed, drawSignatureEnabled: input.methods.draw, uploadSignatureEnabled: input.methods.upload,
        ...input.delivery ? { envelopeExpirationPeriod: input.delivery.expiration, reminderSettings: input.delivery.reminders, emailSettings: input.delivery.emailSettings } : {} } };
    const encoded = JSON.stringify(payload); if (Buffer.byteLength(encoded) > signatureMaximumEvidenceBytes) throw new SignatureProviderConfigurationError();
    const form = new FormData(); form.set("payload", encoded); form.append("files", new Blob([new Uint8Array(input.file.bytes)], { type: "application/pdf" }), input.file.name);
    const response = await this.signatureJson("/envelope/create", form);
    try { return { requestId: z.object({ id: signatureRequestIdSchema }).parse(response.value).id, evidence: response.evidence }; }
    catch { throw new SignatureProviderError("UNCERTAIN"); }
  }
  async readSignatureRequest(raw: { requestId: string; reference: string }): Promise<SignatureRequestObservation> {
    const input = z.object({ requestId: signatureRequestIdSchema, reference: z.string().min(1).max(255) }).strict().parse(raw), response = await this.signatureJson("/envelope/" + encodeURIComponent(input.requestId));
    const position = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/u).transform(Number)]).pipe(z.number().min(0).max(100)), date = z.iso.datetime({ offset: true }).nullable();
    try {
      const envelope = z.object({ id: signatureRequestIdSchema, externalId: z.string().min(1).max(255), title: z.string().min(1).max(255), type: z.literal("DOCUMENT"), source: z.literal("DOCUMENT"), visibility: z.literal("ADMIN"), status: signatureProviderStatusSchema, teamId: z.number().int().positive(), createdAt: date.optional(),
        documentMeta: z.object({ language: z.enum(["en", "fr"]), signingOrder: z.enum(["PARALLEL", "SEQUENTIAL"]), distributionMethod: z.enum(["NONE", "EMAIL"]), allowDictateNextSigner: z.boolean(), typedSignatureEnabled: z.boolean(), drawSignatureEnabled: z.boolean(), uploadSignatureEnabled: z.boolean(), envelopeExpirationPeriod: signatureExpirationSchema.nullish(), emailSettings: signatureEmailSettingsSchema.nullish() }),
        recipients: z.array(z.object({ id: z.number().int().positive(), envelopeId: signatureRequestIdSchema, name: z.string().max(255), email: z.email().max(254), role: signatureRecipientRoleSchema, signingOrder: z.number().int().nonnegative().nullable(),
          readStatus: z.enum(["NOT_OPENED", "OPENED"]), signingStatus: z.enum(["NOT_SIGNED", "SIGNED", "REJECTED"]), sendStatus: z.enum(["NOT_SENT", "SENT"]), signedAt: date, expiresAt: date })).max(100),
        envelopeItems: z.array(z.object({ id: signatureRequestIdSchema, envelopeId: signatureRequestIdSchema, title: z.string().max(255) })).min(1).max(100),
        fields: z.array(z.object({ id: z.number().int().positive(), recipientId: z.number().int().positive(), envelopeItemId: signatureRequestIdSchema, type: z.string().min(1).max(40), page: z.number().int().positive(), positionX: position, positionY: position, width: position, height: position })).max(10000)
      }).parse(response.value);
      if (envelope.id !== input.requestId || envelope.externalId !== input.reference) throw new SignatureProviderError("NONE");
      return signatureRequestObservationSchema.parse({ requestId: envelope.id, reference: envelope.externalId, title: envelope.title, status: envelope.status, teamId: envelope.teamId, ...envelope.createdAt ? { createdAt: new Date(envelope.createdAt).toISOString() } : {},
        locale: envelope.documentMeta.language, signingOrder: envelope.documentMeta.signingOrder, methods: { typed: envelope.documentMeta.typedSignatureEnabled, draw: envelope.documentMeta.drawSignatureEnabled, upload: envelope.documentMeta.uploadSignatureEnabled }, distributionMethod: envelope.documentMeta.distributionMethod, allowDictateNextSigner: envelope.documentMeta.allowDictateNextSigner,
        expiration: envelope.documentMeta.envelopeExpirationPeriod ?? null, emailSettings: envelope.documentMeta.emailSettings ?? null,
        recipients: envelope.recipients.map(({ envelopeId, ...recipient }) => ({ ...recipient, requestId: envelopeId })), items: envelope.envelopeItems.map(({ envelopeId, ...item }) => ({ ...item, requestId: envelopeId })),
        fields: envelope.fields.map(({ envelopeItemId, ...field }) => ({ ...field, itemId: envelopeItemId })), evidence: response.evidence });
    } catch { throw new SignatureProviderError("NONE"); }
  }
  async distributeSignatureRequest(raw: { requestId: string }): Promise<SignatureRequestReceipt> {
    const input = z.object({ requestId: signatureRequestIdSchema }).strict().parse(raw), response = await this.signatureJson("/envelope/distribute", JSON.stringify({ envelopeId: input.requestId, meta: { distributionMethod: "EMAIL" } }), true);
    try { const result = z.object({ id: signatureRequestIdSchema, success: z.literal(true), recipients: z.array(z.object({ id: z.number().int().positive() })).min(1).max(100) }).parse(response.value);
      if (result.id !== input.requestId) throw new SignatureProviderError("UNCERTAIN"); return { requestId: result.id, evidence: response.evidence }; }
    catch { throw new SignatureProviderError("UNCERTAIN"); }
  }
  async downloadSignatureRequest(raw: SignatureRequestDownloadInput): Promise<SignatureRequestDownload> {
    const input = signatureDownloadInputSchema.parse(raw), eligible = (observation: SignatureRequestObservation) => observation.items.length === 1 && observation.items[0].id === input.itemId &&
      (input.version === "original" || signatureRequestHasCompletedActions(observation));
    const lookup = { requestId: input.requestId, reference: input.reference }, before = await this.readSignatureRequest(lookup); if (!eligible(before)) throw new SignatureProviderError("NONE");
    // The provider can return its unsigned original for a premature signed download. Verify
    // completion before and after the authenticated binary read instead of trusting the query.
    const downloaded = await this.signaturePdf("/envelope/item/" + encodeURIComponent(input.itemId) + "/download?version=" + input.version);
    const observation = await this.readSignatureRequest(lookup); if (!eligible(observation)) throw new SignatureProviderError("NONE", 200);
    return { requestId: input.requestId, itemId: input.itemId, version: input.version, ...downloaded, observation };
  }
  async downloadSignatureCertificate(raw: SignatureCertificateDownloadInput): Promise<SignatureCertificateDownload> {
    const input = signatureCertificateInputSchema.parse(raw), before = await this.readSignatureRequest(input); if (!signatureRequestHasCompletedActions(before)) throw new SignatureProviderError("NONE");
    const downloaded = await this.signaturePdf("/envelope/" + encodeURIComponent(input.requestId) + "/certificate/download"), observation = await this.readSignatureRequest(input);
    if (!signatureRequestHasCompletedActions(observation)) throw new SignatureProviderError("NONE", 200);
    return { requestId: input.requestId, ...downloaded, observation };
  }
  private async signaturePdf(path: string) {
    let status: number | undefined;
    try {
      const response = await this.signatureTransport(this.signatureEndpoint(path),
        { method: "GET", credentials: "omit", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(signatureTransportTimeoutMs), headers: { Authorization: this.token } });
      status = response.status;
      if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/pdf") { await response.body?.cancel().catch(() => undefined); throw new SignatureProviderError("NONE", status); }
      const bytes = await readBoundedResponseBytes(response, signatureMaximumPdfBytes);
      if (bytes.length < 8 || Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new SignatureProviderError("NONE", status);
      return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    } catch { throw new SignatureProviderError("NONE", status); }
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

  private async accessToken() {
    const tokenResponse = await this.transport(`${this.apiBaseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.secret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: "grant_type=client_credentials"
    }).catch(() => { throw new PaymentCaptureEvidenceError(); });

    if (!tokenResponse.ok) {
      throw new PaymentCaptureEvidenceError(tokenResponse.status);
    }

    const tokenBody: unknown = await tokenResponse.json().catch(() => { throw new PaymentCaptureEvidenceError(); });
    const accessToken = tokenBody && typeof tokenBody === "object" && "access_token" in tokenBody ? tokenBody.access_token : null;

    if (typeof accessToken !== "string" || !accessToken || /\s/u.test(accessToken)) {
      throw new PaymentCaptureEvidenceError();
    }
    return accessToken;
  }

  async lookup(input: { amount: string; currency: string; source: string }) {
    const intent = paymentCaptureIntent(input), accessToken = await this.accessToken();
    const response = await this.transport(`${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(intent.source)}`, {
      method: "GET", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    }).catch(() => { throw new PaymentCaptureEvidenceError(); });
    if (!response.ok) throw new PaymentCaptureEvidenceError(response.status);
    return payPalOrderState(await response.json().catch(() => { throw new PaymentCaptureEvidenceError(); }), intent);
  }

  private async captureResponse(input: { amount: string; currency: string; source: string }) {
    const intent = paymentCaptureIntent(input), accessToken = await this.accessToken();

    const capture = await this.transport(`${this.apiBaseUrl}/v2/checkout/orders/${encodeURIComponent(intent.source)}/capture`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          "PayPal-Request-Id": createHash("sha256").update(JSON.stringify(intent)).digest("hex").slice(0, 38)
        },
        body: "{}"
      }).catch(() => { throw new PaymentCaptureEvidenceError(); });
    if (!capture.ok) throw new PaymentCaptureEvidenceError(capture.status);
    return { body: await capture.json().catch(() => { throw new PaymentCaptureEvidenceError(); }), intent };
  }
  async record(input: { amount: string; currency: string; source: string }): Promise<{ paymentId: string }> {
    const response = await this.captureResponse(input); return verifiedPayPalCapture(response.body, response.intent);
  }
  async capture(input: { amount: string; currency: string; source: string }) {
    const response = await this.captureResponse(input); return verifiedPayPalCaptureEvidence(response.body, response.intent);
  }

  /** The durable caller must commit its refund reservation and attempt before this single POST. */
  async refund(input: { captureId: string; requestId: string; amount: string; currency: string }) {
    const intent = paymentRefundIntent(input);
    let accessToken: string;
    try { accessToken = await this.accessToken(); } catch { throw new PaymentRefundEvidenceError(); }
    const response = await this.transport(`${this.apiBaseUrl}/v2/payments/captures/${encodeURIComponent(intent.captureId)}/refund`, {
      method: "POST", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Prefer: "return=representation", "PayPal-Request-Id": intent.requestId },
      body: JSON.stringify({ amount: { value: intent.amount, currency_code: intent.currency }, custom_id: intent.requestId })
    }).catch(() => { throw new PaymentRefundEvidenceError(); });
    if (!response.ok) throw new PaymentRefundEvidenceError(response.status);
    return verifiedPayPalRefundResult(await response.json().catch(() => { throw new PaymentRefundEvidenceError(); }), intent, this.apiBaseUrl);
  }

  /** A retained refund identity is reconciled by GET; an unknown POST outcome never triggers an SDK retry. */
  async lookupRefund(input: { intent: { captureId: string; requestId: string; amount: string; currency: string }; refundId: string }) {
    const { intent, refundId } = paymentRefundLookup(input);
    let accessToken: string;
    try { accessToken = await this.accessToken(); } catch { throw new PaymentRefundEvidenceError(); }
    const response = await this.transport(`${this.apiBaseUrl}/v2/payments/refunds/${encodeURIComponent(refundId)}`, {
      method: "GET", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }
    }).catch(() => { throw new PaymentRefundEvidenceError(); });
    if (!response.ok) throw new PaymentRefundEvidenceError(response.status);
    return verifiedPayPalRefundResult(await response.json().catch(() => { throw new PaymentRefundEvidenceError(); }), intent, this.apiBaseUrl, refundId);
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
    private readonly now: () => Date = () => new Date(),
    private readonly uploadTransport: typeof fetch = fetch
  ) {
    this.accountId = required(env, "R2_ACCOUNT_ID");
    this.accessKeyId = required(env, "R2_ACCESS_KEY_ID");
    this.secretAccessKey = required(env, "R2_SECRET_ACCESS_KEY");
    this.bucket = required(env, "R2_BUCKET");
  }

  createSignedUploadUrl(input: { key: string; contentType: string }): Promise<{ url: string }> {
    void input.contentType;
    return this.signedUrl(input.key, "PUT", privateUploadUrlLifetimeSeconds);
  }

  createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }> {
    if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds < 1 || input.expiresInSeconds > 900) throw new Error("Invalid private document link duration");
    return this.signedUrl(input.key, "GET", input.expiresInSeconds);
  }

  async deleteTemporaryUploadPart(input: TemporaryUploadPart): Promise<void> {
    const key = temporaryUploadPartKey(input);
    try {
      const signed = await this.signedUrl(key, "DELETE", 900);
      const response = await this.uploadTransport(signed.url, { method: "DELETE", signal: AbortSignal.timeout(15000) });
      if (!response.ok && response.status !== 404) throw new Error("cleanup_failed");
    } catch { throw new Error("Temporary upload cleanup unavailable"); }
  }

  private signedUrl(key: string, method: "PUT" | "GET" | "DELETE", expiresInSeconds: number): Promise<{ url: string }> {
    const { dateStamp, amzDate } = isoBasic(this.now());
    const host = `${this.accountId}.r2.cloudflarestorage.com`;
    const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
    const canonicalUri = `/${encodePath(this.bucket)}/${encodePath(key)}`;
    const query = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${this.accessKeyId}/${credentialScope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresInSeconds),
      "X-Amz-SignedHeaders": "host"
    });
    const canonicalQuery = [...query.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const canonicalRequest = [
      method,
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

export class IcalReservationAdapter extends ICalAdapter implements ReservationAdapter {
  constructor(private readonly transport: HttpTransport = fetch) { super(); }

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
