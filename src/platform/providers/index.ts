import type { NormalizedReservationAdapter } from "./reservation-types";
import type { AppLocale } from "@/i18n/routing";
import type { BrowserPushSubscription } from "@/platform/notifications/web-push";

export interface EmailProvider {
  send(input: {
    to: string;
    subject: string;
    html: string;
    text?: string;
    locale: AppLocale;
    template: string;
    idempotencyKey?: string;
    deliveryReference?: { organizationId: string; deliveryId: string };
  }): Promise<{ id: string }>;
}

export interface SignatureProvider {
  createRequest(input: { documentId: string; signerEmail: string }): Promise<{ requestId: string }>;
}

export interface PaymentProvider {
  record(input: { amount: string; currency: string; source: string }): Promise<{ paymentId: string }>;
}

export interface StorageProvider {
  createSignedUploadUrl(input: { key: string; contentType: string }): Promise<{ url: string }>;
}

export interface ReservationAdapter extends NormalizedReservationAdapter {
  sync(input: { organizationId: string; sourceId: string }): Promise<{ imported: number }>;
}

export interface NotificationChannel {
  notify(input: { userId: string; subject: string; body: string; locale?: AppLocale; idempotencyKey?: string;
    push?: { subscription: BrowserPushSubscription; deliveryId: string; ttlSeconds: number }
  }): Promise<{ id: string; statusCode?: number }>;
}

export interface PdfRenderer {
  render(input: { template: string; data: Record<string, unknown>; locale: AppLocale }): Promise<Uint8Array>;
}

export interface RateLimiter {
  consume(input: {
    key: string;
    limit: number;
    windowSeconds: number;
  }): Promise<{ allowed: boolean; remaining: number; resetAt: Date }>;
}
