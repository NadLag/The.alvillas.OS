import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

// A protocol authenticator for service-level PostgreSQL tests. Registration and
// assertions still pass through the real WebAuthn verifier; no auth is skipped.
export class IntegrationAuthenticator {
  private readonly keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  private readonly credentialId = randomBytes(32);
  private counter = 0;

  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  registration(options: PublicKeyCredentialCreationOptionsJSON, origin: string): RegistrationResponseJSON {
    const jwk = this.keyPair.publicKey.export({ format: "jwk" });
    if (!jwk.x || !jwk.y || !options.rp.id) throw new Error("Expected an EC credential and relying party");
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]
    ]));
    const length = Buffer.alloc(2); length.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([createHash("sha256").update(options.rp.id).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, this.credentialId, cose]);
    const attestation = isoCBOR.encode(new Map<string, string | Map<string, never> | Uint8Array>([
      ["fmt", "none"], ["attStmt", new Map<string, never>()], ["authData", authData]
    ]));
    return { id: this.credentialId.toString("base64url"), rawId: this.credentialId.toString("base64url"), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: this.clientData("webauthn.create", options.challenge, origin).toString("base64url"), attestationObject: Buffer.from(attestation).toString("base64url"), transports: ["internal"] } };
  }

  authentication(options: PublicKeyCredentialRequestOptionsJSON, origin: string): AuthenticationResponseJSON {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++this.counter);
    const clientData = this.clientData("webauthn.get", options.challenge, origin);
    const authData = Buffer.concat([createHash("sha256").update(options.rpId ?? new URL(origin).hostname).digest(), Buffer.from([0x05]), counter]);
    const signature = sign("sha256", Buffer.concat([authData, createHash("sha256").update(clientData).digest()]), this.keyPair.privateKey);
    return { id: this.credentialId.toString("base64url"), rawId: this.credentialId.toString("base64url"), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"), signature: signature.toString("base64url") } };
  }
}
