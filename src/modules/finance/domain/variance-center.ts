import { z } from "zod";
import { varianceDetailSchema } from "./variance-workspace";

export const varianceCenterProviderSchema = z.enum(["OTA", "BANK", "STAFF", "INVENTORY"]);
export const varianceCenterFilterSchema = z.object({ provider: varianceCenterProviderSchema,
  status: z.enum(["OPEN", "RESOLVED", "MATCHED", "SOURCE_CHANGED", "ALL"]).default("OPEN"),
  assignment: z.enum(["ANY", "ME", "UNASSIGNED"]).default("ANY") }).strict();
export const varianceCenterInputSchema = varianceCenterFilterSchema.extend({ cursor: z.string().min(1).max(8192).optional() }).strict();
export const varianceCenterRowSchema = z.object({ reference: z.string().max(1000), detail: varianceDetailSchema }).strict();
export type VarianceCenterRow = z.infer<typeof varianceCenterRowSchema>;
export const varianceCenterPageSchema = z.object({ items: z.array(varianceCenterRowSchema).max(20),
  next: z.string().min(1).max(8192).nullable() }).strict();
export type VarianceCenterFilter = z.infer<typeof varianceCenterFilterSchema>;
export type VarianceCenterProvider = z.infer<typeof varianceCenterProviderSchema>;
export class VarianceCenterAccessError extends Error { constructor() { super("variance_center_forbidden"); } }
export class VarianceCenterCursorError extends Error { constructor() { super("variance_center_cursor_invalid"); } }

export const varianceCenterPositionSchema = z.object({ id: z.uuid(), at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u).pipe(z.iso.datetime()) }).strict();
export function includeVarianceCenterRow(detail: z.infer<typeof varianceDetailSchema>, filter: VarianceCenterFilter, actorId: string) {
  return detail.source.provider === filter.provider && (filter.status === "ALL" || detail.status === filter.status) &&
    (filter.assignment === "ANY" || (filter.assignment === "ME" ? detail.assignedTo === actorId : detail.assignedTo === null));
}
