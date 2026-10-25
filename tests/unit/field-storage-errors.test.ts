import Dexie from "dexie";
import { describe, expect, it } from "vitest";
import { isStorageQuotaError } from "@/platform/offline/storage-errors";

describe("native field storage quota errors", () => {
  it("recognizes the native quota error without depending on its realm", () => {
    expect(isStorageQuotaError(new DOMException("", "QuotaExceededError"))).toBe(true);
    expect(isStorageQuotaError({ name: "QuotaExceededError" })).toBe(true);
  });
  it("recognizes the actual Dexie abort wrapper around the native transaction quota error", () => {
    const wrapped = new Dexie.AbortError(new DOMException("", "QuotaExceededError"));
    expect(wrapped.name).toBe("AbortError");
    expect(isStorageQuotaError(wrapped)).toBe(true);
    expect(isStorageQuotaError(new Dexie.AbortError(wrapped))).toBe(true);
  });
  it("follows standard error causes as well as Dexie inner errors", () => {
    const cause = new Dexie.AbortError(new DOMException("", "QuotaExceededError"));
    expect(isStorageQuotaError(new Error("Storage unavailable", { cause }))).toBe(true);
  });
  it("keeps unrelated abort, decoding, session and constraint failures distinct", () => {
    for (const error of [null, undefined, "QuotaExceededError", new Error("QuotaExceededError"),
      new Dexie.AbortError(new DOMException("", "ConstraintError")), new Error("FIELD_SESSION_CHANGED"),
      new DOMException("", "InvalidStateError"), new DOMException("", "AbortError")]) expect(isStorageQuotaError(error)).toBe(false);
  });
  it("terminates on cyclic non-quota causes", () => {
    const error: { name: string; cause?: unknown } = { name: "AbortError" }; error.cause = error;
    expect(isStorageQuotaError(error)).toBe(false);
  });
  it("finds a quota cause even when another wrapper branch cycles", () => {
    const error: { name: string; inner?: unknown; cause?: unknown } = { name: "AbortError" };
    error.inner = error; error.cause = new DOMException("", "QuotaExceededError");
    expect(isStorageQuotaError(error)).toBe(true);
  });
});
