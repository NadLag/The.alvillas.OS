import { describe, expect, it, vi } from "vitest";
import { readExactResponseBytes, readBoundedJsonRequest } from "@/platform/http/read-exact-response";

describe("bounded private object reads", () => {
  it("reads exact streamed bytes without trusting a missing content-length", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.enqueue(new Uint8Array([3, 4])); controller.close(); } });
    expect(await readExactResponseBytes(new Response(stream), 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
  it("rejects short objects", async () => { await expect(readExactResponseBytes(new Response(new Uint8Array([1, 2])), 3)).rejects.toThrow("response_size_invalid"); });
  it("cancels an oversized stream before reading the remaining object", async () => {
    const cancelled = vi.fn(), stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel: cancelled });
    await expect(readExactResponseBytes(new Response(stream), 4)).rejects.toThrow("response_size_invalid"); expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("rejects excessive declared length and cancels the body", async () => {
    const cancelled = vi.fn(), stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    await expect(readExactResponseBytes(new Response(stream, { headers: { "Content-Length": "1000000000" } }), 4)).rejects.toThrow("response_size_invalid"); expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("sanitizes interrupted reads", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("private-signed-url")); } });
    await expect(readExactResponseBytes(new Response(stream), 4)).rejects.toThrow(/^response_size_invalid$/u);
  });
});

describe("bounded authenticated JSON request reads", () => {
  it("counts encoded bytes and accepts valid JSON without a declared length", async () => {
    const body = JSON.stringify({ note: "صورة" });
    expect(await readBoundedJsonRequest(new Request("https://example.test", { method: "POST", body }), Buffer.byteLength(body))).toEqual({ note: "صورة" });
    await expect(readBoundedJsonRequest(new Request("https://example.test", { method: "POST", body }), body.length)).rejects.toThrow("response_size_invalid");
  });
  it("enforces the stream bound when the declared content length is too small", async () => {
    await expect(readBoundedJsonRequest(new Request("https://example.test", { method: "POST", headers: { "Content-Length": "1" }, body: JSON.stringify({ value: "large-body" }) }), 8)).rejects.toThrow("response_size_invalid");
  });
  it("rejects malformed JSON and invalid UTF-8", async () => {
    await expect(readBoundedJsonRequest(new Request("https://example.test", { method: "POST", body: "{" }), 8)).rejects.toThrow();
    await expect(readBoundedJsonRequest(new Request("https://example.test", { method: "POST", body: new Uint8Array([0xff]) }), 8)).rejects.toThrow();
  });
});
