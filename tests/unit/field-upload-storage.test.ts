import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { R2StorageProvider } from "@/platform/providers/real";

const env = { R2_ACCOUNT_ID: "account", R2_BUCKET: "bucket", R2_ACCESS_KEY_ID: "local-access", R2_SECRET_ACCESS_KEY: "local-secret" };
const now = () => new Date("2026-10-23T00:00:00Z");
describe("temporary upload part cleanup", () => {
  it("deletes only the computed part key with a signature bound to DELETE", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })), provider = new R2StorageProvider(env, now, transport);
    const part = { organizationId: randomUUID(), uploadId: randomUUID(), index: 4 };
    await provider.deleteTemporaryUploadPart(part);
    expect(transport).toHaveBeenCalledTimes(1); const [signed, options] = transport.mock.calls[0];
    const url = new URL(typeof signed === "string" ? signed : signed instanceof URL ? signed.href : signed.url);
    const key = `${part.organizationId}/uploads/${part.uploadId}/part-4`;
    expect(url.pathname).toBe(`/bucket/${key}`); expect(options?.method).toBe("DELETE"); expect(options?.signal).toBeInstanceOf(AbortSignal);
    const get = new URL((await provider.createSignedDownloadUrl({ key, expiresInSeconds: 900 })).url);
    expect(url.searchParams.get("X-Amz-Signature")).not.toBe(get.searchParams.get("X-Amz-Signature"));
  });
  it("rejects path injection and out-of-range parts before any storage request", async () => {
    const transport = vi.fn<typeof fetch>(), provider = new R2StorageProvider(env, now, transport), org = randomUUID(), upload = randomUUID();
    for (const part of [{ organizationId: `${org}/../../financial`, uploadId: upload, index: 0 },
      { organizationId: org, uploadId: `${upload}/../team`, index: 0 }, { organizationId: org, uploadId: upload, index: -1 }])
      await expect(provider.deleteTemporaryUploadPart(part)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("accepts a missing temporary part on retry", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(new R2StorageProvider(env, now, transport).deleteTemporaryUploadPart({ organizationId: randomUUID(), uploadId: randomUUID(), index: 0 })).resolves.toBeUndefined();
  });
  it("sanitizes failed and interrupted storage requests", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 })).mockRejectedValueOnce(new Error("signed-url-with-private-token"));
    const provider = new R2StorageProvider(env, now, transport), part = { organizationId: randomUUID(), uploadId: randomUUID(), index: 0 };
    for (let attempt = 0; attempt < 2; attempt++) await expect(provider.deleteTemporaryUploadPart(part)).rejects.toThrow(/^Temporary upload cleanup unavailable$/u);
  });
});
