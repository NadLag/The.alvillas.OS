import { describe, expect, it } from "vitest";
import { documentSignaturePolicySchema } from "@/modules/documents/domain/document-signature-policy";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";

function configured() {
  return { source: "NATIVE_DOCUMENT_SIGNATURES", provider: "DOCUMENSO", enabled: true,
    account: { origin: "https://signature.example.test/", teamId: 17, scopeEnvelopeId: "envelope_owned_account_scope", scopeReference: "owned-account-scope-fixture" },
    legal: { signatureLevel: "owned technical fixture only", ownerDecisionReference: "owned legal decision fixture", certificateDecisionReference: "owned certificate decision fixture" },
    signing: { order: "SEQUENTIAL", methods: { typed: true, draw: false, upload: false }, delivery: { expiration: { unit: "day", amount: 17 }, reminders: { sendAfter: { disabled: true }, repeatEvery: { disabled: true } },
      emailSettings: { recipientSigningRequest: true, recipientRemoved: false, recipientSigned: false, documentPending: false, documentCompleted: true, documentDeleted: false, ownerDocumentCompleted: true, ownerRecipientExpired: true, ownerDocumentCreated: false } } } };
}
describe("configured native signature policy", () => {
  it("uses the existing configuration registry for enabled and disabled signature policies", () => {
    expect(parseConfigRuleValue("documents.signatures", configured())).toEqual(documentSignaturePolicySchema.parse(configured()));
    expect(parseConfigRuleValue("documents.signatures", { source: "NATIVE_DOCUMENT_SIGNATURES", provider: "DOCUMENSO", enabled: false, account: null, legal: null, signing: null })).toMatchObject({ enabled: false });
    expect(() => parseConfigRuleValue("documents.signatures", { enabled: true })).toThrow();
  });
  it("keeps sending disabled without inventing an account, legal approval, certificate or business schedule", () => {
    expect(documentSignaturePolicySchema.parse({ source: "NATIVE_DOCUMENT_SIGNATURES", provider: "DOCUMENSO", enabled: false, account: null, legal: null, signing: null })).toMatchObject({ enabled: false, legal: null });
    expect(documentSignaturePolicySchema.safeParse({}).success).toBe(false);
  });
  it("retains explicitly configured scope, legal references, methods, expiration and notification controls", () => {
    const input = configured(), result = documentSignaturePolicySchema.parse(input); expect(result.enabled).toBe(true);
    if (!result.enabled) throw Error("The explicit technical test configuration must be retained");
    expect(result.account.origin).toBe("https://signature.example.test"); expect(result.signing).toEqual(input.signing); expect(result.legal).toEqual(input.legal);
  });
  it("rejects enabling without the actual account scope and explicit owner and certificate decisions", () => {
    const input = configured();
    for (const change of [{ account: null }, { legal: null }, { legal: { ...input.legal, ownerDecisionReference: "" } },
      { legal: { ...input.legal, certificateDecisionReference: "" } }, { account: { ...input.account, scopeEnvelopeId: "" } }]) {
      expect(documentSignaturePolicySchema.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it("requires every business delivery choice instead of falling back to provider defaults", () => {
    const input = configured();
    for (const signing of [{ ...input.signing, methods: { typed: false, draw: false, upload: false } }, { ...input.signing, delivery: {} },
      { ...input.signing, delivery: { ...input.signing.delivery, expiration: null } }, { ...input.signing, delivery: { ...input.signing.delivery, reminders: {} } },
      { ...input.signing, delivery: { ...input.signing.delivery, emailSettings: {} } }, { ...input.signing, delivery: { ...input.signing.delivery, expiration: { unit: "day", amount: 0 } } }]) {
      expect(documentSignaturePolicySchema.safeParse({ ...input, signing }).success).toBe(false);
    }
  });
  it("rejects credential-bearing or ambiguous account origins and unsupported provider claims", () => {
    const input = configured();
    for (const origin of ["https://user:owned-secret@signature.example.test", "https://signature.example.test/api/v2", "https://signature.example.test/?secret=owned", "https://signature.example.test/#fragment", "file:///owned"]) {
      expect(documentSignaturePolicySchema.safeParse({ ...input, account: { ...input.account, origin } }).success).toBe(false);
    }
    expect(documentSignaturePolicySchema.safeParse({ ...input, provider: "unverified-provider" }).success).toBe(false);
    expect(documentSignaturePolicySchema.safeParse({ ...input, organizationId: "caller-tenant" }).success).toBe(false);
  });
});
