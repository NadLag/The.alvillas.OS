import { z } from "zod";

/** Immutable correlation of actual native admission with the provider facts it used. */
export const externalRefundAdmissionEvidence = z.object({ schemaVersion: z.literal(1), intentId: z.uuid(), transactionId: z.uuid(),
  originalRequestKey: z.uuid(), originalRequestFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), originalRequestedBy: z.uuid(), admittedBy: z.uuid(),
  evidenceId: z.uuid(), settlementId: z.uuid(), firstEvidenceId: z.uuid(), refundedAt: z.iso.datetime() }).strict();
