import { z } from "zod";
import { Temporal } from "temporal-polyfill";
import type { AppLocale } from "@/i18n/routing";
import { formatCurrency, formatDate } from "@/i18n/format";
import { Money } from "@/platform/money/money";
import { documentPrivacyTags } from "./document-policy";

const key = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/u).refine(value => !["constructor", "prototype"].includes(value));
const text = (maximum: number) => z.string().min(1).max(maximum).refine(value => value.trim().length > 0 && !/\p{Cc}/u.test(value.replaceAll("\t", "").replaceAll("\r", "").replaceAll("\n", "")));
export const documentTemplateMediaType = "application/vnd.alvillas.document-template+json";
export const templateVariableKinds = ["TEXT", "DATE", "INTEGER", "MONEY"] as const;
const variable = z.object({ key, kind: z.enum(templateVariableKinds) }).strict();
const block = z.object({ kind: z.enum(["HEADING", "PARAGRAPH", "BULLET"]), text: text(20000) }).strict();
const token = /\{\{\s*([a-z][a-z0-9_]{0,79})\s*\}\}/gu;

/** Tokens are exact map keys. They cannot invoke helpers, access object paths or execute code. */
export function templateReferences(value: string): string[] {
  if (value.includes("{{{") || value.includes("}}}")) throw new TemplateDefinitionError();
  const names = [...value.matchAll(token)].map(match => match[1]), remainder = value.replace(token, "");
  if (remainder.includes("{{") || remainder.includes("}}")) throw new TemplateDefinitionError();
  return [...new Set(names)].sort();
}
export const documentTemplateDefinitionSchema = z.object({ schemaVersion: z.literal(1), templateKey: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/u), locale: z.enum(["en", "fr", "ar"]),
  title: text(500), variables: z.array(variable).max(200), blocks: z.array(block).nonempty().max(200)
}).strict().superRefine((value, ctx) => {
  const declared = value.variables.map(item => item.key);
  if (new Set(declared).size !== declared.length) ctx.addIssue({ code: "custom", message: "template_duplicate_variable" });
  try {
    const used = [...new Set([value.title, ...value.blocks.map(item => item.text)].flatMap(templateReferences))].sort();
    if (JSON.stringify(used) !== JSON.stringify([...declared].sort())) ctx.addIssue({ code: "custom", message: "template_exact_declared_variables_required" });
  } catch { ctx.addIssue({ code: "custom", message: "template_invalid_variable_syntax" }); }
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) ctx.addIssue({ code: "custom", message: "template_definition_too_large" });
});
export type DocumentTemplateDefinition = z.infer<typeof documentTemplateDefinitionSchema>;
export const documentTemplateVariantsSchema = z.array(documentTemplateDefinitionSchema).min(2).max(3).superRefine((values, ctx) => {
  if (new Set(values.map(value => value.templateKey)).size !== 1 || new Set(values.map(value => value.locale)).size !== values.length ||
    !values.some(value => value.locale === "en") || !values.some(value => value.locale === "fr")) ctx.addIssue({ code: "custom", message: "template_explicit_en_fr_variants_required" });
  const identity = (value: DocumentTemplateDefinition) => JSON.stringify([...value.variables].sort((a, b) => a.key.localeCompare(b.key)));
  if (values.some(value => identity(value) !== identity(values[0]))) ctx.addIssue({ code: "custom", message: "template_locale_variable_contract_mismatch" });
});

const privacy = z.array(z.enum(documentPrivacyTags)).nonempty();
const isoDate = z.iso.date().refine(value => { try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; } });
const binding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("TEXT"), value: text(20000), privacy }).strict(),
  z.object({ kind: z.literal("DATE"), value: isoDate, privacy }).strict(),
  z.object({ kind: z.literal("INTEGER"), value: z.string().regex(/^-?(?:0|[1-9][0-9]{0,99})$/u), privacy }).strict(),
  z.object({ kind: z.literal("MONEY"), value: z.custom<Money>(value => value instanceof Money), privacy }).strict()
]);
export type DocumentTemplateBinding = z.infer<typeof binding>;
export class TemplateDefinitionError extends Error { constructor() { super("document_template_invalid"); } }
export class TemplateBindingError extends Error { constructor() { super("document_template_binding_unavailable"); } }

export function encodeDocumentTemplate(raw: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(documentTemplateDefinitionSchema.parse(raw)));
}
export function decodeDocumentTemplate(bytes: Uint8Array): DocumentTemplateDefinition {
  try {
    if (!bytes.length || bytes.length > 1024 * 1024) throw new TemplateDefinitionError();
    return documentTemplateDefinitionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new TemplateDefinitionError(); }
}

/** Native application resolvers supply classified values after source authorization. No caller-supplied values or locale fallback. */
export function renderDocumentTemplate(raw: unknown, supplied: ReadonlyMap<string, DocumentTemplateBinding>) {
  const definition = documentTemplateDefinitionSchema.parse(raw), values = new Map<string, string>(), classification = new Set<(typeof documentPrivacyTags)[number]>();
  if (supplied.size !== definition.variables.length || [...supplied.keys()].some(name => !definition.variables.some(item => item.key === name))) throw new TemplateBindingError();
  for (const declared of definition.variables) {
    const parsed = binding.safeParse(supplied.get(declared.key));
    if (!parsed.success || parsed.data.kind !== declared.kind) throw new TemplateBindingError();
    const value = parsed.data; for (const tag of value.privacy) classification.add(tag);
    let formatted: string;
    if (value.kind === "MONEY") { classification.add("financial"); formatted = formatCurrency(definition.locale, value.value); }
    else if (value.kind === "INTEGER") formatted = new Intl.NumberFormat(definition.locale).format(BigInt(value.value));
    else if (value.kind === "DATE") formatted = formatDate(definition.locale, new Date(value.value + "T12:00:00Z"), { timeZone: "UTC" });
    else formatted = value.value;
    values.set(declared.key, formatted);
  }
  const interpolate = (value: string) => value.replace(token, (_match: string, name: string) => { const replacement = values.get(name); if (replacement === undefined) throw new TemplateBindingError(); return replacement; });
  return { templateKey: definition.templateKey, locale: definition.locale, title: interpolate(definition.title),
    blocks: definition.blocks.map(item => ({ ...item, text: interpolate(item.text) })), privacy: [...classification].sort() };
}
export function selectDocumentTemplateVariant(raw: unknown, locale: AppLocale) {
  const values = documentTemplateVariantsSchema.parse(raw), selected = values.find(value => value.locale === locale);
  if (!selected) throw new TemplateBindingError(); return selected;
}
