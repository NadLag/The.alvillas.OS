import { z } from "zod";
import { configSlugSchema } from "./identifiers";

const id = z.uuid().transform(value => value.toLowerCase());
const properties = z.discriminatedUnion("mode", [z.object({ mode: z.literal("ANY") }).strict(), z.object({ mode: z.literal("COMPANY") }).strict(),
  z.object({ mode: z.literal("SELECTED"), ids: z.array(id).min(1).max(10000).refine(values => new Set(values).size === values.length) }).strict()]);
const keys = z.discriminatedUnion("mode", [z.object({ mode: z.literal("ANY") }).strict(),
  z.object({ mode: z.literal("SELECTED"), keys: z.array(configSlugSchema).min(1).max(1000).refine(values => new Set(values).size === values.length) }).strict()]);
export const taxCategoryPolicySchema = z.object({ key: configSlugSchema,
  labels: z.object({ en: z.string().trim().min(1).max(200), fr: z.string().trim().min(1).max(200), ar: z.string().trim().min(1).max(200) }).strict() }).strict();
export const taxHookContextPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("PROPERTY"), properties }).strict(),
  z.object({ kind: z.literal("SERVICE"), properties, services: keys }).strict(),
  z.object({ kind: z.literal("TRANSACTION"), properties, transactionTypes: keys }).strict()
]);
/** Optional metadata on the original finance.tax entry; no country treatment or rate is supplied. */
export const taxHookPolicySchema = z.object({ category: taxCategoryPolicySchema, contexts: z.array(taxHookContextPolicySchema).min(1).max(100) }).strict();
