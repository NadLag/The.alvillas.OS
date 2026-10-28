import { z } from "zod";

const optionalText = (max: number) => z.string().trim().max(max).transform(value => value || null).nullable().optional().transform(value => value ?? null);
export const supplierFields = z.object({
  displayName: z.string().trim().min(1).max(200), category: z.string().trim().min(1).max(80),
  contactName: optionalText(200), email: z.union([z.email().max(254), z.literal(""), z.null()]).optional().transform(value => value ? value.toLowerCase() : null),
  phone: z.union([z.string().regex(/^\+[1-9][0-9]{7,14}$/u), z.literal(""), z.null()]).optional().transform(value => value || null),
  address: optionalText(1000), externalReference: optionalText(100)
}).strict();
const reason = z.string().trim().min(6).max(500), id = z.uuid().transform(value => value.toLowerCase());
export const createSupplierInput = supplierFields.extend({ idempotencyKey: id, reason });
export const updateSupplierInput = supplierFields.extend({ id, expectedVersion: z.number().int().nonnegative(), reason });
export const archiveSupplierInput = z.object({ id, expectedVersion: z.number().int().nonnegative(), archived: z.boolean(), reason }).strict();
export const supplierFilters = z.object({ query: z.string().trim().max(120).optional(), category: z.string().trim().max(80).optional(),
  includeArchived: z.boolean().optional(), after: id.optional() }).strict();
export type SupplierFields = z.output<typeof supplierFields>;
