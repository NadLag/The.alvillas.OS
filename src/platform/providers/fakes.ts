import type {
  EmailProvider,
  NotificationChannel,
  PaymentProvider,
  PdfRenderer,
  RateLimiter,
  ReservationAdapter,
  SignatureProvider,
  StorageProvider
} from "@/platform/providers";

export function assertFakeProviderAllowed(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv === "production") {
    throw new Error("Fake providers cannot be used in production");
  }
}

export class FakeEmailProvider implements EmailProvider {
  readonly sent: Array<{ to: string; subject: string; html: string; text?: string }> = [];

  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  send(input: { to: string; subject: string; html: string; text?: string }): Promise<{ id: string }> {
    this.sent.push(input);
    return Promise.resolve({ id: `fake-email-${this.sent.length}` });
  }
}

export class FakeSignatureProvider implements SignatureProvider {
  constructor(nodeEnv?: string) {
    assertFakeProviderAllowed(nodeEnv);
  }

  createRequest(input: { documentId: string; signerEmail: string }): Promise<{ requestId: string }> {
    return Promise.resolve({ requestId: `fake-signature-${input.documentId}` });
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
    locale: string;
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
