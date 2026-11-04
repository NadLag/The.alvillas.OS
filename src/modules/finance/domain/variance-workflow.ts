import { z } from "zod";

const id = z.uuid().transform(value => value.toLowerCase());
const versionPattern = /^(?:0|[1-9]\d{0,18})$/u;
export const varianceWorkflowVersionSchema = z.string().regex(versionPattern).refine(value => versionPattern.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n);
const version = varianceWorkflowVersionSchema;
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const explanation = z.string().trim().min(6).max(500);
export const varianceSourceReferenceSchema = z.object({ provider: z.enum(["OTA", "BANK", "STAFF", "INVENTORY", "LAUNDRY", "OWNER_PAYOUT"]), id }).strict();
const command = z.object({ source: varianceSourceReferenceSchema, version, sourceFingerprint: fingerprint, reason: explanation });
/** Workflow intent carries no money or editable source facts. */
export const varianceWorkflowCommandSchema = z.discriminatedUnion("operation", [
  command.extend({ operation: z.literal("ASSIGN"), assignedTo: id.nullable() }).strict(),
  command.extend({ operation: z.literal("RESOLVE"), action: explanation }).strict(),
  command.extend({ operation: z.literal("REOPEN"), action: explanation }).strict()
]);
export type VarianceSourceReference = z.infer<typeof varianceSourceReferenceSchema>;
export type VarianceWorkflowCommand = z.infer<typeof varianceWorkflowCommandSchema>;
export type VarianceWorkflowState = {
  version: string; sourceFingerprint: string; status: "OPEN" | "RESOLVED"; assignedTo: string | null;
  reason: string; action: string | null; resolvedBy: string | null; resolvedAt: string | null;
};
export type VarianceWorkflowSource = {
  source: VarianceSourceReference; fingerprint: string; state: "OPEN" | "MATCHED" | "SOURCE_CHANGED";
  createdAt: Date; reason: string; action: string | null;
  baseline?: Pick<VarianceWorkflowState, "status" | "assignedTo" | "resolvedBy" | "resolvedAt">;
};
export class VarianceWorkflowConflictError extends Error { constructor() { super("variance_workflow_conflict"); } }
export class VarianceWorkflowSourceError extends Error { constructor() { super("variance_source_unavailable"); } }

export function projectVarianceWorkflow(source: VarianceWorkflowSource, latest: VarianceWorkflowState | null, now: Date) {
  const reference = varianceSourceReferenceSchema.parse(source.source); fingerprint.parse(source.fingerprint);
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(source.createdAt.getTime()) || now < source.createdAt) throw new VarianceWorkflowSourceError();
  const changed = latest !== null && latest.sourceFingerprint !== source.fingerprint;
  const baseline = source.baseline ?? { status: "OPEN" as const, assignedTo: null, resolvedBy: null, resolvedAt: null };
  const current: VarianceWorkflowState = latest && !changed ? { ...latest } : {
    version: latest?.version ?? "0", sourceFingerprint: source.fingerprint,
    status: changed ? "OPEN" : baseline.status, assignedTo: latest ? latest.assignedTo : baseline.assignedTo,
    reason: source.reason, action: source.action, resolvedBy: changed ? null : baseline.resolvedBy, resolvedAt: changed ? null : baseline.resolvedAt
  };
  version.parse(current.version);
  const status = source.state === "OPEN" ? current.status : source.state;
  return { ...current, source: reference, sourceFingerprint: source.fingerprint, status,
    ageMilliseconds: (BigInt(now.getTime()) - BigInt(source.createdAt.getTime())).toString() };
}

/** Authorized adapters supply current native facts; the repository owns nonce recovery and append-only attribution. */
export function decideVarianceWorkflow(input: {
  command: unknown; source: VarianceWorkflowSource; latest: VarianceWorkflowState | null;
  actorId: string; now: Date; assigneeEligible: boolean;
}): { operation: VarianceWorkflowCommand["operation"]; beforeVersion: string; after: VarianceWorkflowState } {
  const intent = varianceWorkflowCommandSchema.parse(input.command), actorId = id.parse(input.actorId);
  const current = projectVarianceWorkflow(input.source, input.latest, input.now);
  if (intent.source.provider !== current.source.provider || intent.source.id !== current.source.id || intent.version !== current.version ||
      intent.sourceFingerprint !== current.sourceFingerprint) throw new VarianceWorkflowConflictError();
  if (current.status === "MATCHED" || current.status === "SOURCE_CHANGED") throw new VarianceWorkflowSourceError();
  if (BigInt(current.version) === 9_223_372_036_854_775_807n) throw new VarianceWorkflowConflictError();
  const after: VarianceWorkflowState = { version: (BigInt(current.version) + 1n).toString(), sourceFingerprint: current.sourceFingerprint,
    status: current.status, assignedTo: current.assignedTo, reason: intent.reason, action: current.action,
    resolvedBy: current.resolvedBy, resolvedAt: current.resolvedAt };
  if (intent.operation === "ASSIGN") {
    if (current.status !== "OPEN" || intent.assignedTo === current.assignedTo || (intent.assignedTo !== null && !input.assigneeEligible)) throw new VarianceWorkflowConflictError();
    after.assignedTo = intent.assignedTo;
  } else if (intent.operation === "RESOLVE") {
    if (current.status !== "OPEN") throw new VarianceWorkflowConflictError();
    after.status = "RESOLVED"; after.action = intent.action; after.resolvedBy = actorId; after.resolvedAt = input.now.toISOString();
  } else {
    if (current.status !== "RESOLVED") throw new VarianceWorkflowConflictError();
    after.status = "OPEN"; after.action = intent.action; after.resolvedBy = null; after.resolvedAt = null;
  }
  return { operation: intent.operation, beforeVersion: current.version, after };
}
