import { z } from "zod";

export const employeeCompletedWorkSnapshotSchema = z.object({
  id: z.uuid(), organization_id: z.uuid(), property_id: z.uuid(), version: z.number().int().positive(), state: z.literal("COMPLETED"),
  completed_at: z.iso.datetime({ offset: true }), completed_by_person_id: z.uuid(), completed_by_user_account_id: z.uuid().nullable(),
  completion_idempotency_key: z.uuid(), completion_source: z.enum(["SELF", "OFFLINE_SYNC", "PROXY"]),
  required_role_key: z.string().nullable(), validated_by_person_id: z.uuid().nullable(), validated_by_user_account_id: z.uuid().nullable(),
  validated_at: z.iso.datetime({ offset: true }).nullable(), validation_reason: z.string().nullable()
}).passthrough();

/** The immutable completion event supplies the performer; current assignment never does. */
export function employeeCompletedWorkEvidence(event: { id: string; organizationId: string; taskId: string; version: number; actorId: string | null; after: unknown }) {
  const value = employeeCompletedWorkSnapshotSchema.parse(event.after);
  if (value.organization_id !== event.organizationId || value.id !== event.taskId || value.version !== event.version || !event.actorId) throw Error("Completion evidence identity is inconsistent");
  if (value.completion_source === "PROXY") {
    if (value.validated_by_user_account_id !== event.actorId || !value.validated_by_person_id || value.validated_by_person_id === value.completed_by_person_id ||
      !value.validated_at || !value.validation_reason || value.validation_reason.trim().length < 6) throw Error("Proxy completion requires its actual distinct validator");
  } else if (value.completed_by_user_account_id !== event.actorId) throw Error("Direct completion requires its actual performer account");
  return value;
}
