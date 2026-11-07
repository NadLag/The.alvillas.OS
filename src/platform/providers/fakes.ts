import type {
  EmailProvider as EmailProviderContract,
  NotificationChannel,
  PaymentProvider,
  PdfRenderer,
  RateLimiter,
  ReservationAdapter,
  SignatureProvider,
  StorageProvider
} from "@/platform/providers";
import type { AppLocale } from "@/i18n/routing";
import { createHash } from "node:crypto";
import { captureSignatureRequest, signatureDownloadInputSchema, signatureCertificateInputSchema, SignatureProviderError, type SignatureRequestInput, type SignatureRequestObservation, type SignatureRequestReceipt, type SignatureRequestDownloadInput, type SignatureRequestDownload, type SignatureCertificateDownloadInput, type SignatureCertificateDownload } from "./signature-request";

export function assertFakeProviderAllowed(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv === "production") {
    throw new Error("Fake providers cannot be used in production");
  }
}

export class FakeEmailProvider implements EmailProviderContract {
  readonly sent: Array<Parameters<EmailProviderContract["send"]>[0]> = [];

  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  send(input: Parameters<EmailProviderContract["send"]>[0]): Promise<{ id: string }> {
    this.sent.push(input);
    return Promise.resolve({ id: `fake-email-${this.sent.length}` });
  }
}

export class FakeSignatureProvider implements SignatureProvider {
  private readonly requests = new Map<string, { input: SignatureRequestInput; sent: boolean }>();
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }
  downloadSignatureCertificate(raw: SignatureCertificateDownloadInput): Promise<SignatureCertificateDownload> {
    signatureCertificateInputSchema.parse(raw); return Promise.reject(new SignatureProviderError("NONE"));
  }

  createRequest(input: { documentId: string; signerEmail: string }): Promise<{ requestId: string }> {
    return Promise.resolve({ requestId: `fake-signature-${input.documentId}` });
  }
  prepareSignatureRequest(raw: SignatureRequestInput): Promise<SignatureRequestReceipt> {
    const input = captureSignatureRequest(raw), requestId = "fake-signature-" + (this.requests.size + 1); this.requests.set(requestId, { input, sent: false });
    return Promise.resolve({ requestId, evidence: new TextEncoder().encode(JSON.stringify({ id: requestId, externalId: input.reference, fake: true })) });
  }
  readSignatureRequest(input: { requestId: string; reference: string }): Promise<SignatureRequestObservation> {
    const row = this.requests.get(input.requestId); if (!row || row.input.reference !== input.reference) return Promise.reject(new SignatureProviderError("NONE", 404));
    const recipients = row.input.recipients.map((recipient, index) => ({ id: index + 1, requestId: input.requestId, name: recipient.name, email: recipient.email, role: recipient.role, signingOrder: recipient.signingOrder,
      readStatus: "NOT_OPENED" as const, signingStatus: "NOT_SIGNED" as const, sendStatus: row.sent ? "SENT" as const : "NOT_SENT" as const, signedAt: null, expiresAt: null }));
    let fieldId = 0; const item = { id: "fake-item-" + input.requestId, requestId: input.requestId, title: row.input.file.name }, fields = row.input.recipients.flatMap((recipient, index) => recipient.fields.map(field => ({ ...field, id: ++fieldId, recipientId: index + 1, itemId: item.id }))),
      observation: SignatureRequestObservation = { requestId: input.requestId, reference: row.input.reference, title: row.input.title, status: row.sent ? "PENDING" : "DRAFT", teamId: 1,
        locale: row.input.locale, signingOrder: row.input.signingOrder, methods: { ...row.input.methods }, distributionMethod: row.sent ? "EMAIL" : "NONE", allowDictateNextSigner: false, expiration: structuredClone(row.input.delivery?.expiration ?? null), emailSettings: structuredClone(row.input.delivery?.emailSettings ?? null), recipients, items: [item], fields,
        evidence: new TextEncoder().encode(JSON.stringify({ id: input.requestId, fake: true, sent: row.sent })) };
    return Promise.resolve(observation);
  }
  distributeSignatureRequest(input: { requestId: string }): Promise<SignatureRequestReceipt> {
    const row = this.requests.get(input.requestId); if (!row) return Promise.reject(new SignatureProviderError("NONE", 404)); row.sent = true;
    return Promise.resolve({ requestId: input.requestId, evidence: new TextEncoder().encode(JSON.stringify({ id: input.requestId, fake: true, sent: true })) });
  }
  async downloadSignatureRequest(raw: SignatureRequestDownloadInput): Promise<SignatureRequestDownload> {
    const input = signatureDownloadInputSchema.parse(raw), observation = await this.readSignatureRequest({ requestId: input.requestId, reference: input.reference }), row = this.requests.get(input.requestId);
    if (!row || input.version !== "original" || observation.items[0].id !== input.itemId) throw new SignatureProviderError("NONE");
    const bytes = new Uint8Array(row.input.file.bytes); return { requestId: input.requestId, itemId: input.itemId, version: input.version, bytes, sha256: createHash("sha256").update(bytes).digest("hex"), observation };
  }
}

export class FakePaymentProvider implements PaymentProvider {
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  record(input: { amount: string; currency: string; source: string }): Promise<{ paymentId: string }> {
    return Promise.resolve({ paymentId: `fake-payment-${input.source}-${input.currency}-${input.amount}` });
  }
}

export class FakeStorageProvider implements StorageProvider {
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  createSignedUploadUrl(input: { key: string; contentType: string }): Promise<{ url: string }> {
    return Promise.resolve({ url: `https://fake-storage.invalid/${encodeURIComponent(input.key)}` });
  }
}

export class FakeReservationAdapter implements ReservationAdapter {
  normalize() { return []; }
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  sync(): Promise<{ imported: number }> {
    return Promise.resolve({ imported: 0 });
  }
}

export class FakeNotificationChannel implements NotificationChannel {
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  notify(input: { userId: string; subject: string; body: string }): Promise<{ id: string }> {
    return Promise.resolve({
      id: `fake-notification-${input.userId}-${input.subject.length}-${input.body.length}`
    });
  }
}

export class FakePdfRenderer implements PdfRenderer {
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  render(input: {
    template: string;
    data: Record<string, unknown>;
    locale: AppLocale;
  }): Promise<Uint8Array> {
    return Promise.resolve(
      new TextEncoder().encode(
        JSON.stringify({ template: input.template, data: input.data, locale: input.locale })
      )
    );
  }
}

export class FakeRateLimiter implements RateLimiter {
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  consume(input: {
    key: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    return Promise.resolve({
      allowed: true,
      remaining: input.limit,
      resetAt: new Date(Date.now() + input.windowSeconds * 1000)
    });
  }
}
