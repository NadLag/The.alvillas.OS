import { describe, expect, it, vi } from "vitest";
import {
  DocumensoSignatureProvider,
  HttpPdfRenderer,
  IcalReservationAdapter,
  PayPalPaymentProvider,
  R2StorageProvider,
  ResendEmailProvider,
  type HttpTransport
} from "@/platform/providers/real";

type TransportResponse = {
  ok: boolean;
  status: number;
  body?: unknown;
  textBody?: string;
  binaryBody?: Uint8Array;
};

function response(input: TransportResponse): Awaited<ReturnType<HttpTransport>> {
  return {
    ok: input.ok,
    status: input.status,
    json: () => Promise.resolve(input.body ?? {}),
    text: () => Promise.resolve(input.textBody ?? JSON.stringify(input.body ?? {})),
    arrayBuffer: () =>
      Promise.resolve(
        (input.binaryBody ?? new TextEncoder().encode(input.textBody ?? "")).buffer as ArrayBuffer
      )
  };
}

describe("real provider adapters", () => {
  it("sends transactional email through Resend request shape", async () => {
    const transport = vi.fn<HttpTransport>(() =>
      Promise.resolve(response({ ok: true, status: 200, body: { id: "email_1" } }))
    );
    const provider = new ResendEmailProvider(
      { RESEND_API_KEY: "re_test", EMAIL_FROM: "ALVILLAS <ops@example.test>" },
      transport
    );

    await expect(
      provider.send({
        to: "owner@example.test",
        subject: "Hello",
        html: "<p>Hello</p>",
        text: "Hello",
        locale: "fr",
        template: "owner.invite"
      })
    ).resolves.toEqual({ id: "email_1" });
    const [, request] = transport.mock.calls[0] ?? [];

    expect(transport.mock.calls[0]?.[0]).toBe("https://api.resend.com/emails");
    expect(request?.method).toBe("POST");
    expect(request?.headers?.Authorization).toBe("Bearer re_test");
  });

  it("creates and distributes a Documenso signature request", async () => {
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(response({ ok: true, status: 200, body: { id: "recipient_1" } }))
      .mockResolvedValueOnce(response({ ok: true, status: 200, body: { id: "request_1" } }));
    const provider = new DocumensoSignatureProvider(
      { DOCUMENSO_URL: "https://documenso.example.test", DOCUMENSO_API_TOKEN: "api_test" },
      transport
    );

    await expect(
      provider.createRequest({ documentId: "doc_1", signerEmail: "owner@example.test" })
    ).resolves.toEqual({ requestId: "request_1" });
    const [, request] = transport.mock.calls[0] ?? [];

    expect(transport.mock.calls[0]?.[0]).toBe(
      "https://documenso.example.test/api/v2/document/recipient/create"
    );
    expect(request?.headers?.Authorization).toBe("api_test");
  });

  it("captures a PayPal order through OAuth-backed checkout capture", async () => {
    const transport = vi
      .fn<HttpTransport>()
      .mockResolvedValueOnce(response({ ok: true, status: 200, body: { access_token: "token_1" } }))
      .mockResolvedValueOnce(response({ ok: true, status: 201, body: { id: "capture_1" } }));
    const provider = new PayPalPaymentProvider(
      {
        PAYPAL_CLIENT_ID: "client",
        PAYPAL_SECRET: "secret",
        PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com"
      },
      transport
    );

    await expect(
      provider.record({ amount: "100.00", currency: "MAD", source: "ORDER-1" })
    ).resolves.toEqual({ paymentId: "capture_1" });
    const [, request] = transport.mock.calls[1] ?? [];

    expect(transport.mock.calls[1]?.[0]).toBe(
      "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER-1/capture"
    );
    expect(request?.headers?.Authorization).toBe("Bearer token_1");
  });

  it("creates Cloudflare R2 SigV4 upload URLs without exposing the secret", async () => {
    const provider = new R2StorageProvider(
      {
        R2_ACCOUNT_ID: "account",
        R2_ACCESS_KEY_ID: "access",
        R2_SECRET_ACCESS_KEY: "super-secret",
        R2_BUCKET: "bucket"
      },
      () => new Date("2026-10-11T00:00:00.000Z")
    );

    const signed = await provider.createSignedUploadUrl({
      key: "docs/owner statement.pdf",
      contentType: "application/pdf"
    });
    const url = new URL(signed.url);

    expect(url.hostname).toBe("account.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/bucket/docs/owner%20statement.pdf");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.search).not.toContain("super-secret");
  });

  it("counts imported iCal reservations from a real feed response", async () => {
    const transport = vi.fn<HttpTransport>(() =>
      Promise.resolve(
        response({
          ok: true,
          status: 200,
          textBody: ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "END:VEVENT", "BEGIN:VEVENT", "END:VEVENT", "END:VCALENDAR"].join(
            "\n"
          )
        })
      )
    );

    await expect(
      new IcalReservationAdapter(transport).sync({
        organizationId: "018f0a0b-0000-7000-9000-000000000001",
        sourceId: "https://calendar.example.test/feed.ics"
      })
    ).resolves.toEqual({ imported: 2 });
  });

  it("renders PDFs through an authenticated renderer endpoint", async () => {
    const pdf = new Uint8Array([37, 80, 68, 70]);
    const transport = vi.fn<HttpTransport>(() =>
      Promise.resolve(response({ ok: true, status: 200, binaryBody: pdf }))
    );
    const renderer = new HttpPdfRenderer(
      { PDF_RENDERER_ENDPOINT: "https://pdf.example.test/render", PDF_RENDERER_TOKEN: "pdf-token" },
      transport
    );

    await expect(
      renderer.render({ template: "owner.statement", data: { total: "100.00" }, locale: "en" })
    ).resolves.toEqual(pdf);
    const [, request] = transport.mock.calls[0] ?? [];

    expect(transport.mock.calls[0]?.[0]).toBe("https://pdf.example.test/render");
    expect(request?.headers?.Authorization).toBe("Bearer pdf-token");
  });
});
