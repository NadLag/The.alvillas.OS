import { z } from "zod";
import { localizedTextSchema } from "@/i18n/content";
import { propertyOperatingProfileInputSchema, propertyInputSchema } from "./owner-property";
import { configRuleSchemas, parseConfigRuleValue } from "@/platform/config/rule-registry";
import { Money } from "@/platform/money/money";

export const templateKinds = [
  "PROPERTY",
  "INVENTORY",
  "WORKFLOW",
  "CHECKLIST",
  "SERVICE_CATALOG"
] as const;
export const templateKindSchema = z.enum(templateKinds);
export type TemplateKind = z.infer<typeof templateKindSchema>;
export const propertyTemplateFields = [
  "propertyType",
  "bedrooms",
  "bathrooms",
  "livingSpaces",
  "hasPool",
  "hasGarden",
  "parkingSpaces",
  "maxGuests",
  "timezone",
  "amenities"
] as const;
export const operatingTemplateFields = Object.keys(propertyOperatingProfileInputSchema.shape) as Array<
  keyof z.infer<typeof propertyOperatingProfileInputSchema>
>;
const allowedRules: Record<TemplateKind, readonly string[]> = {
  PROPERTY: ["ops.mid_stay_threshold"],
  INVENTORY: ["inventory.minimums"],
  WORKFLOW: ["ops.reservation_task_templates", "ops.workflows"],
  CHECKLIST: ["ops.checklists"],
  SERVICE_CATALOG: ["services.pricing"]
};

export const propertyTemplateProjectionSchema = z.object({
  ...Object.fromEntries(propertyTemplateFields.map((key) => [key, propertyInputSchema.shape[key]])),
  timezone: propertyInputSchema.shape.timezone.refine((value) => {
    if (!/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/u.test(value)) return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  })
});
function sparseSettings(shape: Record<string, z.ZodType>) {
  return z.record(z.string(), z.unknown()).transform((input, ctx) => {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const parsed = Object.hasOwn(shape, key) ? shape[key].safeParse(value) : null;
      if (!parsed?.success) {
        ctx.addIssue({ code: "custom", path: [key], message: "Invalid template setting" });
        continue;
      }
      if (parsed.data !== undefined) result[key] = parsed.data;
    }
    return result;
  });
}
const propertySettingsSchema = sparseSettings(propertyTemplateProjectionSchema.shape);
const operatingSettingsSchema = sparseSettings(propertyOperatingProfileInputSchema.shape);
export type TemplateValues = {
  property?: Record<string, unknown>;
  operating?: Record<string, unknown>;
  rules?: Record<string, unknown>;
};
const templateValuesSchema = z
  .object({
    property: propertySettingsSchema.optional(),
    operating: operatingSettingsSchema.optional(),
    rules: z.record(z.string(), z.unknown()).optional()
  })
  .strict();
export const templateSaveSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9][a-z0-9_.-]*$/u),
    kind: templateKindSchema,
    propertyId: z.uuid().nullable().default(null),
    name: localizedTextSchema,
    description: localizedTextSchema.optional(),
    values: templateValuesSchema,
    status: z.enum(["ACTIVE", "ARCHIVED"]).default("ACTIVE"),
    expectedVersion: z.number().int().nonnegative(),
    reason: z.string().trim().min(6).max(500)
  })
  .superRefine((input, ctx) => {
    try {
      validateTemplateValues(input.kind, input.values);
    } catch {
      ctx.addIssue({ code: "custom", path: ["values"], message: "Invalid template settings" });
    }
  });
export type TemplateSaveInput = z.input<typeof templateSaveSchema>;
export const templateChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("APPLY"),
    templateVersionId: z.uuid(),
    propertyId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    operationId: z.uuid(),
    reason: z.string().trim().min(6).max(500)
  }),
  z.object({
    action: z.literal("OVERRIDE"),
    kind: templateKindSchema,
    values: z
      .record(z.string().min(1).max(600), z.unknown())
      .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 500),
    propertyId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    operationId: z.uuid(),
    reason: z.string().trim().min(6).max(500)
  }),
  z.object({
    action: z.literal("RESET"),
    kind: templateKindSchema,
    paths: z.array(z.string().min(1).max(600)).min(1).max(500),
    propertyId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    operationId: z.uuid(),
    reason: z.string().trim().min(6).max(500)
  })
]);
export type TemplateChangeInput = z.infer<typeof templateChangeSchema>;
export type SettingMap = Record<string, unknown>;
export function settingInputText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}
const dangerous = new Set(["__proto__", "prototype", "constructor"]);
function isSettingObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const escape = (s: string) => s.replaceAll("~", "~0").replaceAll("/", "~1");
const unescape = (s: string) => s.replaceAll("~1", "/").replaceAll("~0", "~");
export function pathSegments(path: string): string[] {
  if (!path.startsWith("/")) throw new Error("Invalid setting path");
  const segments = path.slice(1).split("/").map(unescape);
  if (segments.some((s) => dangerous.has(s) || s.length === 0)) throw new Error("Invalid setting path");
  return segments;
}
export function equalSetting(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equalSetting(v, b[i]))
    );
  if (typeof a === "object" && typeof b === "object") {
    const x = a as Record<string, unknown>,
      y = b as Record<string, unknown>;
    return (
      Object.keys(x).length === Object.keys(y).length &&
      Object.keys(x).every((k) => equalSetting(x[k], y[k]))
    );
  }
  return false;
}
// Keyed collection entries keep their identity when reordered or extended by another property setting.
export function flattenSettings(values: unknown, segments: string[] = []): SettingMap {
  if (
    Array.isArray(values) &&
    values.length &&
    (values as unknown[]).every(
      (v) => isSettingObject(v) && (typeof v.key === "string" || typeof v.item === "string")
    )
  ) {
    return Object.fromEntries(
      (values as unknown[]).flatMap((item) => {
        const v = item as Record<string, unknown>;
        const field = typeof v.key === "string" ? "key" : "item";
        return Object.entries(
          flattenSettings(Object.fromEntries(Object.entries(v).filter(([k]) => k !== field)), [
            ...segments,
            `@${field}:${z.string().parse(v[field])}`
          ])
        );
      })
    );
  }
  if (
    values &&
    typeof values === "object" &&
    !Array.isArray(values) &&
    !("en" in values && "fr" in values) &&
    Object.keys(values).length
  ) {
    return Object.fromEntries(
      Object.entries(values).flatMap(([k, v]) => {
        if (dangerous.has(k)) throw new Error("Invalid setting");
        return Object.entries(flattenSettings(v, [...segments, k]));
      })
    );
  }
  return { [`/${segments.map(escape).join("/")}`]: values };
}
export function readSetting(root: unknown, path: string): unknown {
  let node = root;
  for (const segment of pathSegments(path)) {
    if (segment.startsWith("@")) {
      const split = segment.indexOf(":"),
        key = segment.slice(1, split),
        value = segment.slice(split + 1);
      node = Array.isArray(node)
        ? (node as unknown[]).find((v) => isSettingObject(v) && v[key] === value)
        : undefined;
    } else
      node = node && typeof node === "object" ? (node as Record<string, unknown>)[segment] : undefined;
  }
  return node;
}
export function inheritedChanges(
  current: TemplateValues,
  oldBase: SettingMap,
  nextBase: SettingMap
): SettingMap {
  const overridden = Object.entries(oldBase)
    .filter(([path, value]) => !equalSetting(readSetting(current, path), value))
    .map(([path]) => path);
  return Object.fromEntries(
    Object.entries(nextBase).filter(
      ([path]) =>
        !overridden.some(
          (previous) =>
            path === previous || path.startsWith(`${previous}/`) || previous.startsWith(`${path}/`)
        )
    )
  );
}
export function writeSetting(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = pathSegments(path);
  let node: Record<string, unknown> | unknown[] = root;
  parts.forEach((segment, index) => {
    const last = index === parts.length - 1;
    if (segment.startsWith("@")) {
      const split = segment.indexOf(":"),
        key = segment.slice(1, split),
        identity = segment.slice(split + 1);
      if (!Array.isArray(node) || !["key", "item"].includes(key) || !identity)
        throw new Error("Invalid collection setting");
      let child = node.find(
        (v) => v && typeof v === "object" && (v as Record<string, unknown>)[key] === identity
      ) as Record<string, unknown> | undefined;
      if (!child) {
        child = { [key]: identity };
        node.push(child);
      }
      if (last) throw new Error("Collection identity is immutable");
      node = child;
    } else {
      if (Array.isArray(node)) throw new Error("Invalid setting");
      if (last) {
        node[segment] = structuredClone(value);
        return;
      }
      if (node[segment] === undefined || node[segment] === null)
        node[segment] = parts[index + 1].startsWith("@") ? [] : {};
      if (typeof node[segment] !== "object") throw new Error("Invalid setting");
      node = node[segment] as Record<string, unknown>;
    }
  });
}
export function validateTemplateValues(kind: TemplateKind, values: TemplateValues): TemplateValues {
  const parsed = templateValuesSchema.parse(values);
  if (kind !== "PROPERTY" && (parsed.property || parsed.operating))
    throw new Error("Wrong template kind");
  for (const [key, value] of Object.entries(parsed.rules ?? {})) {
    if (!allowedRules[kind].includes(key)) throw new Error("Wrong template rule");
    parseConfigRuleValue(key, value);
  }
  if (kind === "INVENTORY") {
    const rule = parsed.rules?.["inventory.minimums"] as
      | { minimums: Array<Record<string, unknown>> }
      | undefined;
    if (!rule?.minimums.length) throw new Error("Inventory template is empty");
    for (const item of rule.minimums) {
      localizedTextSchema.parse(item.name);
      z.string().trim().min(1).parse(item.unit);
      z.enum(["CONSUMABLE", "LINEN", "EQUIPMENT"]).parse(item.category);
    }
  }
  if (kind === "SERVICE_CATALOG") {
    const rule = parsed.rules?.["services.pricing"] as
      | { services: Array<Record<string, unknown>> }
      | undefined;
    if (!rule?.services.length) throw new Error("Service template is empty");
    for (const service of rule.services) {
      localizedTextSchema.parse(service.name);
      if (service.pricing_model !== "CUSTOM" || service.amount !== undefined)
        Money.of(z.string().parse(service.amount), z.string().parse(service.currency));
    }
  }
  if (kind !== "PROPERTY" && !Object.keys(parsed.rules ?? {}).length)
    throw new Error("Template has no settings");
  const fields = flattenSettings(parsed);
  if (
    !Object.keys(fields).length ||
    Object.keys(fields).length > 500 ||
    Object.keys(fields).some((p) => p === "/" || equalSetting(fields[p], {}))
  )
    throw new Error("Template has no settings");
  return parsed;
}
export function templateRuleKeys(kind: TemplateKind): readonly string[] {
  return allowedRules[kind];
}
export function validateProjectedRules(values: TemplateValues): void {
  for (const [k, v] of Object.entries(values.rules ?? {}))
    configRuleSchemas[k as keyof typeof configRuleSchemas].parse(v);
}
