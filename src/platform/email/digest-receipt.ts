import { Webhook } from "svix";
import { z } from "zod";

export const digestReceiptSchema = z.object({ type: z.enum(["email.delivered", "email.failed", "email.bounced"]), created_at: z.iso.datetime(),
  data: z.object({ email_id: z.string().min(1).max(100), tags: z.object({ template: z.literal("notification.digest"), organization_id: z.uuid(), delivery_id: z.uuid() }) }) });
export type DigestReceipt = z.infer<typeof digestReceiptSchema>;
export function verifyDigestReceipt(body: string, headers: Headers, secret: string): DigestReceipt | null {
  new Webhook(secret).verify(body, { "svix-id": headers.get("svix-id") ?? "", "svix-timestamp": headers.get("svix-timestamp") ?? "", "svix-signature": headers.get("svix-signature") ?? "" });
  const parsed = digestReceiptSchema.safeParse(JSON.parse(body));
  return parsed.success ? parsed.data : null;
}
