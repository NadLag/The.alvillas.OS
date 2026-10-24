import { z } from "zod";
import { stayDateSchema } from "./reservation";

export const fieldPullPageSize = 50;
const date = stayDateSchema;
const revision = z.string().regex(/^[a-zA-Z0-9_-]{43}$/u);
const translations = z.record(z.string().min(1).max(40), z.string().max(1000));
export const fieldKnownTaskSchema = z.object({ id: z.uuid(), revision: revision.nullable() }).strict();
export const fieldPullInputSchema = z.object({
  organization_id: z.uuid(), actor_user_id: z.uuid(), mode: z.enum(["today", "assigned", "supervised"]).default("today"),
  property_id: z.uuid().optional(), cursor: z.string().min(1).max(2048).optional(),
  known_tasks: z.array(fieldKnownTaskSchema).max(fieldPullPageSize).default([]), only_known: z.boolean().default(false)
}).strict();
export const fieldWorkSnapshotSchema = z.object({
  id: z.uuid(), propertyId: z.uuid(), propertyName: z.string().max(240), propertyAddress: z.string().max(1000),
  propertyTimezone: z.string().min(1).max(100), reservationReference: z.string().max(160).nullable(),
  guestName: z.string().max(240).nullable().optional(), title: translations, type: z.string().max(80), state: z.string().max(80),
  priority: z.string().max(80), dueDate: date, businessDate: date, serverVersion: z.iso.datetime(), revision,
  canEdit: z.boolean(), checklistItems: z.array(z.object({ id: z.uuid(), key: z.string().max(160), label: translations, completed: z.boolean() }).strict()).max(50),
  proxyValidation: z.object({ performedByPersonId: z.uuid(), expectedVersion: z.number().int().min(1), performerName: z.string().max(240).optional() }).strict().optional()
}).strict();
export const fieldPullResultSchema = z.object({
  op_schema_version: z.literal(1), organization_id: z.uuid(), actor_user_id: z.uuid(), snapshot_at: z.iso.datetime(),
  cursor: z.string().min(1).max(2048), next_cursor: z.string().min(1).max(2048).nullable(),
  tasks: z.array(fieldWorkSnapshotSchema).max(fieldPullPageSize),
  known_changes: z.array(fieldWorkSnapshotSchema).max(fieldPullPageSize), tombstones: z.array(z.uuid()).max(fieldPullPageSize)
}).strict();
export type FieldPullInput = z.infer<typeof fieldPullInputSchema>;
export type FieldWorkSnapshot = z.infer<typeof fieldWorkSnapshotSchema>;
export type FieldPullResult = z.infer<typeof fieldPullResultSchema>;
