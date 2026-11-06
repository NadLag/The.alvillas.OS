import { z } from "zod";
import { signatureDeliveryOptionsSchema, signatureMethodsSchema, signatureRequestIdSchema, signatureSigningOrderSchema, signatureTeamIdSchema } from "@/platform/providers/signature-contract";

export const documentSignaturePolicyKey = "documents.signatures";
const reference = z.string().min(8).max(1000).refine(value => value === value.trim()), origin = z.url().refine(value => {
  const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && [url.origin, url.origin + "/"].includes(value) && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
}, "signature_account_origin_required").transform(value => new URL(value).origin);
const common = z.object({ source: z.literal("NATIVE_DOCUMENT_SIGNATURES"), provider: z.literal("DOCUMENSO") }).strict();
const enabled = common.extend({ enabled: z.literal(true), account: z.object({ origin, teamId: signatureTeamIdSchema, scopeEnvelopeId: signatureRequestIdSchema, scopeReference: z.string().min(1).max(255) }).strict(),
  legal: z.object({ signatureLevel: z.string().min(1).max(200).refine(value => value === value.trim()), ownerDecisionReference: reference, certificateDecisionReference: reference }).strict(),
  signing: z.object({ order: signatureSigningOrderSchema, methods: signatureMethodsSchema.refine(value => value.typed || value.draw || value.upload, "configured_signature_method_required"), delivery: signatureDeliveryOptionsSchema }).strict()
}).strict();
export { enabled as enabledDocumentSignaturePolicySchema };
export const documentSignaturePolicySchema = z.discriminatedUnion("enabled", [enabled, common.extend({ enabled: z.literal(false), account: z.null(), legal: z.null(), signing: z.null() }).strict()]);
export type EnabledDocumentSignaturePolicy = z.infer<typeof enabled>;
