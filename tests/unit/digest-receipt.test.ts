import { afterEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { digestReceiptSchema, verifyDigestReceipt } from "@/platform/email/digest-receipt";
import { POST } from "@/app/api/webhooks/resend/route";
import { recordDigestReceipt } from "@/platform/notifications/digest-service";

vi.mock("@/platform/notifications/digest-service", () => ({ recordDigestReceipt: vi.fn(() => Promise.resolve(true)) }));
const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const receipt = { type: "email.delivered", created_at: "2026-10-16T12:00:00Z", data: { email_id: crypto.randomUUID(), tags: {
  template: "notification_digest", organization_id: crypto.randomUUID(), delivery_id: crypto.randomUUID()
}, to: ["private-recipient@example.test"], subject: "PRIVATE SUBJECT" } };
function signed(body: string, at = new Date()) {
  return new Headers({ "svix-id": "msg_digest_receipt", "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(secret).sign("msg_digest_receipt", at, body) });
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe("signed Resend digest receipts", () => {
  it("verifies the exact body with the vendor library and strips recipient and subject fields", () => {
    const body = JSON.stringify(receipt); const parsed = verifyDigestReceipt(body, signed(body), secret);
    expect(parsed?.data.email_id).toBe(receipt.data.email_id);
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE"); expect(JSON.stringify(parsed)).not.toContain("private-recipient");
    expect(() => verifyDigestReceipt(body + " ", signed(body), secret)).toThrow();
    expect(() => verifyDigestReceipt(body, signed(body, new Date(Date.now() - 600000)), secret)).toThrow();
    expect(() => verifyDigestReceipt(body, new Headers(), secret)).toThrow();
  });
  it("ignores unrelated templates and rejects invalid tenant references without returning payload details", () => {
    for (const tags of [{ ...receipt.data.tags, template: "unrelated_template" }, { ...receipt.data.tags, organization_id: "wrong" }]) {
      const body = JSON.stringify({ ...receipt, data: { ...receipt.data, tags } }); expect(verifyDigestReceipt(body, signed(body), secret)).toBeNull();
    }
  });
  it("verifies native owner-package receipts through the existing signed HTTP boundary and strips private content", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", secret);
    const body=JSON.stringify({...receipt,data:{...receipt.data,tags:{...receipt.data.tags,template:"onboarding_owner_package"}}});
    expect(verifyDigestReceipt(body,signed(body),secret)?.data.tags.template).toBe("onboarding_owner_package");
    const response=await POST(new Request("https://os.example.test/api/webhooks/resend",{method:"POST",body,headers:signed(body)}));
    expect(response.status).toBe(200);
    expect(recordDigestReceipt).toHaveBeenCalledOnce();
    expect(digestReceiptSchema.parse(vi.mocked(recordDigestReceipt).mock.calls[0][0]).data.tags.template).toBe("onboarding_owner_package");
    expect(JSON.stringify(vi.mocked(recordDigestReceipt).mock.calls)).not.toContain("PRIVATE");
    expect(JSON.stringify(vi.mocked(recordDigestReceipt).mock.calls)).not.toContain("private-recipient");
  });
  it("denies unsigned execution, acknowledges verified receipts and asks the provider to retry storage races", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", secret); const body = JSON.stringify(receipt);
    expect((await POST(new Request("https://os.example.test/api/webhooks/resend", { method: "POST", body }))).status).toBe(401);
    expect(recordDigestReceipt).not.toHaveBeenCalled();
    const response = await POST(new Request("https://os.example.test/api/webhooks/resend", { method: "POST", body, headers: signed(body) }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
    vi.mocked(recordDigestReceipt).mockResolvedValueOnce(false);
    expect((await POST(new Request("https://os.example.test/api/webhooks/resend", { method: "POST", body, headers: signed(body) }))).status).toBe(503);
    vi.mocked(recordDigestReceipt).mockRejectedValueOnce(new Error("PRIVATE DATABASE ERROR"));
    const failed = await POST(new Request("https://os.example.test/api/webhooks/resend", { method: "POST", body, headers: signed(body) }));
    expect(failed.status).toBe(503); expect(await failed.text()).not.toContain("PRIVATE");
    expect((await POST(new Request("https://os.example.test/api/webhooks/resend", { method: "POST", body, headers: { "content-length": "65537" } }))).status).toBe(413);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", ""); expect((await POST(new Request("https://os.example.test/api/webhooks/resend", { method: "POST", body }))).status).toBe(503);
  });
});
