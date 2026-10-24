import { describe, expect, it } from "vitest";
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import vector from "../fixtures/webauthn-short-ecdsa.json";

// Public synthetic protocol input. The matching private key is never retained.
function verify(overrides: Partial<Parameters<typeof verifyAuthenticationResponse>[0]> = {}) {
  return verifyAuthenticationResponse({
    response: structuredClone(vector.response) as AuthenticationResponseJSON,
    expectedChallenge: vector.challenge,
    expectedOrigin: vector.origin,
    expectedRPID: vector.rpId,
    requireUserVerification: true,
    credential: {
      id: vector.credential.id,
      publicKey: new Uint8Array(Buffer.from(vector.credential.publicKey, "base64url")),
      counter: vector.credential.counter
    },
    ...overrides
  });
}

describe("WebAuthn ECDSA component encoding", () => {
  it("accepts a valid P-256 assertion with a 31-byte DER component", async () => {
    expect(Math.min(vector.componentBytes.r, vector.componentBytes.s)).toBe(31);
    expect((await verify()).verified).toBe(true);
  });

  it.each([
    { expectedChallenge: "different-challenge" },
    { expectedOrigin: "https://other.example.test" },
    { expectedRPID: "other.example.test" }
  ])("rejects a mismatched relying-party binding: %o", async (binding) => {
    await expect(verify(binding)).rejects.toThrow();
  });

  it("requires user verification", async () => {
    const response = structuredClone(vector.response) as AuthenticationResponseJSON;
    const data = Buffer.from(response.response.authenticatorData, "base64url");
    data[32] &= ~0x04;
    response.response.authenticatorData = data.toString("base64url");
    await expect(verify({ response })).rejects.toThrow(/user verification/iu);
  });

  it("rejects a tampered signature", async () => {
    const response = structuredClone(vector.response) as AuthenticationResponseJSON;
    const signature = Buffer.from(response.response.signature, "base64url");
    signature[signature.length - 1] ^= 0x01;
    response.response.signature = signature.toString("base64url");
    expect((await verify({ response })).verified).toBe(false);
  });

  it("rejects a replayed authenticator counter", async () => {
    const data = Buffer.from(vector.response.response.authenticatorData, "base64url");
    await expect(verify({ credential: {
      id: vector.credential.id,
      publicKey: new Uint8Array(Buffer.from(vector.credential.publicKey, "base64url")),
      counter: data.readUInt32BE(33)
    } })).rejects.toThrow(/counter/iu);
  });
});
