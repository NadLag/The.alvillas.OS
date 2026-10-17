import { headers } from "next/headers";
import type { Session } from "next-auth";
import type { PropertyTemplateVersion } from "@prisma/client";
import { z } from "zod";
import { authContextForAccount } from "@/platform/authz/account-context";
import { authorize, authorizeCollection } from "@/platform/authz/authorize";
import { present } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writePropertyConfiguration } from "@/platform/config/property-configuration";
import {
  reservationTaskConfigSchema,
  checklistCatalogSchema,
  parseConfigRuleValue
} from "@/platform/config/rule-registry";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import {
  PropertyTemplateRepository,
  templateJson
} from "../infrastructure/property-template-repository";
import {
  equalSetting,
  inheritedChanges,
  flattenSettings,
  readSetting,
  propertyTemplateProjectionSchema,
  templateChangeSchema,
  templateKinds,
  templateSaveSchema,
  templateRuleKeys,
  validateProjectedRules,
  writeSetting,
  type TemplateKind,
  type TemplateValues,
  type SettingMap
} from "../domain/property-template";
import { propertyOperatingProfileInputSchema } from "../domain/owner-property";
import type { CoreActorContext } from "./core-access";
import { updatePropertyOperatingProfile } from "./core-service";

export class TemplateAccessError extends Error {}
export class TemplateConflictError extends Error {}
export class TemplateNotFoundError extends Error {}
export type TemplateActorContext = CoreActorContext & { personId: string };
type Deps = { db?: TenantTransactionRunner; requestId?: string; ipAddress?: string | null };
export async function templateActorFromSession(
  session: Session | null
): Promise<TemplateActorContext | null> {
  if (
    !session?.user?.id ||
    !session.user.organizationId ||
    !session.user.personId ||
    session.user.securitySetupRequired ||
    session.user.sessionRevoked
  )
    return null;
  return {
    actorId: session.user.id,
    personId: session.user.personId,
    organizationId: session.user.organizationId,
    authContext: await authContextForAccount(session.user.organizationId, session.user.id)
  };
}
function allowed(
  ctx: TemplateActorContext,
  action: "view" | "create" | "configure",
  propertyId: string | null,
  kind?: string
) {
  const resource = { organizationId: ctx.organizationId, propertyId };
  if (
    !authorize(ctx.authContext, action, { ...resource, type: "config_rule" }) ||
    (propertyId &&
      !authorize(ctx.authContext, action === "view" ? "view" : "edit", {
        ...resource,
        type: "property"
      }))
  )
    throw new TemplateAccessError();
  if (
    kind === "SERVICE_CATALOG" &&
    !authorize(ctx.authContext, "view", { ...resource, type: "financial_transaction" })
  )
    throw new TemplateAccessError();
}
async function meta(deps: Deps) {
  if (deps.requestId) return { requestId: deps.requestId, ipAddress: deps.ipAddress ?? null };
  const h = await headers();
  return {
    requestId: h.get("x-request-id") ?? crypto.randomUUID(),
    ipAddress: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null
  };
}
function visibleVersion(
  ctx: TemplateActorContext,
  row: PropertyTemplateVersion,
  propertyId: string | null
) {
  const financial = authorize(ctx.authContext, "view", {
    type: "financial_transaction",
    organizationId: ctx.organizationId,
    propertyId
  });
  const serialized = present(
    {
      ...ctx.authContext,
      visibleDataClasses: new Set(financial ? ["operational", "financial"] : ["operational"])
    },
    "view",
    {
      type: "config_rule",
      id: row.id,
      organizationId: ctx.organizationId,
      propertyId,
      data: { ...row, values: row.values }
    },
    row.kind === "SERVICE_CATALOG" ? { values: { dataClass: "financial", mask: "omit" } } : {}
  );
  return {
    ...row,
    values: serialized.values ?? null,
    restricted: row.kind === "SERVICE_CATALOG" && !financial
  };
}
export async function savePropertyTemplate(ctx: TemplateActorContext, raw: unknown, deps: Deps = {}) {
  const input = templateSaveSchema.parse(raw);
  allowed(ctx, input.expectedVersion ? "configure" : "create", input.propertyId, input.kind);
  const audit = await meta(deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new PropertyTemplateRepository(tx, ctx.organizationId);
    await repo.lock(input.key);
    const before = await repo.latest(input.key);
    if (
      (before?.version ?? 0) !== input.expectedVersion ||
      (before && (before.kind !== input.kind || before.propertyId !== input.propertyId))
    )
      throw new TemplateConflictError();
    if (input.propertyId) await repo.projection(input.propertyId, []);
    const after = await repo.createVersion({
      key: input.key,
      kind: input.kind,
      propertyId: input.propertyId,
      version: input.expectedVersion + 1,
      name: templateJson(input.name),
      description: input.description ? templateJson(input.description) : undefined,
      values: templateJson(input.values),
      status: input.status,
      createdBy: ctx.actorId,
      reason: input.reason
    });
    await writeAuditEvent(tx, {
      ...audit,
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: "property_template.version.created",
      resourceType: "property_template",
      resourceId: after.id,
      propertyScopeId: input.propertyId,
      before,
      after,
      reason: input.reason,
      occurredAt: new Date()
    });
    return after;
  });
}
export async function templateCatalog(
  ctx: TemplateActorContext,
  input: {
    propertyId?: string;
    kind?: TemplateKind;
    search?: string;
    page?: number;
    propertyPage?: number;
    propertySearch?: string;
  } = {},
  deps: Deps = {}
) {
  if (
    !authorizeCollection(ctx.authContext, "view", "config_rule") ||
    !authorizeCollection(ctx.authContext, "view", "property")
  )
    throw new TemplateAccessError();
  const page = z
    .number()
    .int()
    .min(1)
    .max(10000)
    .parse(input.page ?? 1);
  const propertyId = input.propertyId ? z.uuid().parse(input.propertyId) : null;
  if (propertyId) allowed(ctx, "view", propertyId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new PropertyTemplateRepository(tx, ctx.organizationId);
    const properties = await repo.properties(
      ctx.authContext,
      z
        .string()
        .max(160)
        .parse(input.propertySearch ?? ""),
      z
        .number()
        .int()
        .min(1)
        .max(10000)
        .parse(input.propertyPage ?? 1)
    );
    const target =
      propertyId && !properties.some((p) => p.id === propertyId)
        ? await repo.propertyOption(propertyId)
        : null;
    const organization =
      propertyId !== null ||
      authorize(ctx.authContext, "view", { type: "config_rule", organizationId: ctx.organizationId });
    const rows = await repo.catalog({
      propertyIds: propertyId ? [propertyId] : properties.map((p) => p.id),
      organization,
      kind: input.kind,
      search: z
        .string()
        .max(160)
        .parse(input.search ?? ""),
      page
    });
    return {
      properties: target ? [target, ...properties.slice(0, 40)] : properties.slice(0, 40),
      moreProperties: properties.length > 40,
      templates: rows.slice(0, 24).map((row) => visibleVersion(ctx, row, row.propertyId ?? propertyId)),
      more: rows.length > 24,
      page
    };
  });
}
export async function templateVersionHistory(
  ctx: TemplateActorContext,
  id: string,
  page = 1,
  propertyId: string | null = null,
  deps: Deps = {}
) {
  z.uuid().parse(id);
  z.number().int().min(1).max(10000).parse(page);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new PropertyTemplateRepository(tx, ctx.organizationId),
      row = await repo.version(id);
    if (!row) throw new TemplateNotFoundError();
    if (row.propertyId && propertyId && row.propertyId !== propertyId) throw new TemplateAccessError();
    allowed(ctx, "view", row.propertyId ?? propertyId, row.kind);
    const rows = await repo.versions(row.key, page),
      latest = await repo.latest(row.key);
    return {
      selected: row,
      versions: rows.slice(0, 20),
      latestVersion: latest!.version,
      more: rows.length > 20
    };
  });
}
export async function propertyTemplateState(
  ctx: TemplateActorContext,
  propertyId: string,
  kind: TemplateKind,
  page = 1,
  deps: Deps = {}
) {
  z.uuid().parse(propertyId);
  z.enum(templateKinds).parse(kind);
  z.number().int().min(1).max(10000).parse(page);
  allowed(ctx, "view", propertyId, kind);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new PropertyTemplateRepository(tx, ctx.organizationId),
      binding = await repo.binding(propertyId, kind);
    const current = await repo.projection(propertyId, templateRuleKeys(kind));
    const base = binding ? flattenSettings(binding.templateVersion.values) : {};
    const fields = Object.entries(base).map(([path, inherited]) => ({
      path,
      inherited,
      current: readSetting(current, path) ?? null,
      overridden: !equalSetting(readSetting(current, path), inherited)
    }));
    const history = await repo.history(propertyId, kind, page);
    return {
      binding,
      fields,
      latest: binding ? await repo.latest(binding.templateVersion.key) : null,
      history: history.slice(0, 20),
      more: history.length > 20
    };
  });
}
export async function changePropertyTemplate(ctx: TemplateActorContext, raw: unknown, deps: Deps = {}) {
  const input = templateChangeSchema.parse(raw),
    audit = await meta(deps);
  allowed(ctx, "configure", input.propertyId);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new PropertyTemplateRepository(tx, ctx.organizationId);
    await repo.lockProperty(input.propertyId);
    const replay = await repo.operation(input.operationId);
    if (replay) {
      allowed(ctx, "configure", input.propertyId, replay.kind);
      if (replay.createdBy !== ctx.actorId || !equalSetting(replay.command, input))
        throw new TemplateConflictError();
      return replay;
    }
    const selected = input.action === "APPLY" ? await repo.version(input.templateVersionId) : null;
    if (input.action === "APPLY" && !selected) throw new TemplateNotFoundError();
    const kind = selected
      ? z.enum(templateKinds).parse(selected.kind)
      : (input as Exclude<typeof input, { action: "APPLY" }>).kind;
    allowed(ctx, "configure", input.propertyId, kind);
    const binding = await repo.binding(input.propertyId, kind);
    if ((binding?.revision ?? 0) !== input.expectedRevision) throw new TemplateConflictError();
    const template = selected ?? binding?.templateVersion;
    if (!template) throw new TemplateNotFoundError();
    await repo.lock(template.key);
    if (template.propertyId && template.propertyId !== input.propertyId) throw new TemplateAccessError();
    if (
      input.action === "APPLY" &&
      (template.status !== "ACTIVE" || (await repo.latest(template.key))?.status !== "ACTIVE")
    )
      throw new TemplateConflictError();
    const config = new ConfigRuleRepository(tx, ctx.organizationId);
    const ruleKeys = [
      ...new Set([
        ...templateRuleKeys(kind),
        ...(["WORKFLOW", "CHECKLIST"].includes(kind)
          ? ["ops.reservation_task_templates", "ops.checklists"]
          : [])
      ])
    ].sort();
    for (const key of ruleKeys) await config.lockVersion(key, "property", input.propertyId);
    const before = await repo.projection(input.propertyId, ruleKeys);
    const after = structuredClone(before) as TemplateValues & Record<string, unknown>;
    const base = flattenSettings(template.values),
      oldBase = binding ? flattenSettings(binding.templateVersion.values) : {};
    const changes: SettingMap = {};
    if (input.action === "APPLY") {
      Object.assign(changes, inheritedChanges(before, oldBase, base));
    } else if (input.action === "RESET") {
      for (const path of new Set(input.paths)) {
        if (!Object.hasOwn(base, path)) throw new TemplateConflictError();
        changes[path] = base[path];
      }
    } else {
      for (const [path, value] of Object.entries(input.values)) {
        if (!Object.hasOwn(base, path)) throw new TemplateConflictError();
        changes[path] = value;
      }
    }
    for (const [path, value] of Object.entries(changes)) writeSetting(after, path, value);
    propertyTemplateProjectionSchema.parse(after.property);
    propertyOperatingProfileInputSchema.parse(after.operating);
    validateProjectedRules(after);
    if (kind === "PROPERTY" && after.operating?.midStayCleaningEnabled) {
      const key = z.literal("ops.mid_stay_threshold").parse(after.operating.midStayCleaningRuleKey);
      parseConfigRuleValue(key, after.rules?.[key]);
    }
    if (["WORKFLOW", "CHECKLIST"].includes(kind) && after.rules?.["ops.reservation_task_templates"]) {
      const tasks = reservationTaskConfigSchema.parse(
        after.rules["ops.reservation_task_templates"]
      ).tasks;
      const references = tasks
        .map((task) => task.checklistTemplateKey)
        .filter((key): key is string => Boolean(key));
      if (references.length) {
        const catalog = checklistCatalogSchema.parse(after.rules["ops.checklists"]);
        for (const reference of references)
          z.string()
            .refine((key) => catalog.checklists.some((checklist) => checklist.key === key))
            .parse(reference);
      }
    }
    await repo.persistPropertyFields(input.propertyId, before, after);
    const transactionDb: TenantTransactionRunner = { $transaction: (work) => work(tx) };
    if (!equalSetting(before.operating, after.operating)) {
      await updatePropertyOperatingProfile(
        ctx,
        input.propertyId,
        propertyOperatingProfileInputSchema.parse(after.operating),
        { db: transactionDb, requestId: audit.requestId, ipAddress: audit.ipAddress }
      );
    }
    for (const [key, value] of Object.entries(after.rules ?? {})) {
      if (equalSetting(value, before.rules?.[key])) continue;
      await writePropertyConfiguration(
        ctx,
        { propertyId: input.propertyId, key, value, reason: input.reason },
        { tx, ...audit }
      );
    }
    const snapshot: Record<string, unknown> = {},
      overrides: SettingMap = {};
    for (const [path, inherited] of Object.entries(base)) {
      const value = readSetting(after, path);
      writeSetting(snapshot, path, value);
      if (!equalSetting(inherited, value)) overrides[path] = value;
    }
    const revision = await repo.createRevision({
      propertyId: input.propertyId,
      kind,
      revision: (binding?.revision ?? 0) + 1,
      templateVersionId: template.id,
      action: input.action,
      operationId: input.operationId,
      command: input,
      snapshot,
      overrides,
      createdBy: ctx.actorId,
      reason: input.reason
    });
    await writeAuditEvent(tx, {
      ...audit,
      organizationId: ctx.organizationId,
      actorId: ctx.actorId,
      action: `property_template.${input.action.toLowerCase()}`,
      resourceType: "property_template_revision",
      resourceId: revision.id,
      propertyScopeId: input.propertyId,
      before: {
        revision: binding?.revision ?? 0,
        templateVersionId: binding?.templateVersionId ?? null,
        values: Object.fromEntries(Object.keys(base).map((p) => [p, readSetting(before, p) ?? null]))
      },
      after: { revision: revision.revision, templateVersionId: template.id, snapshot, overrides },
      reason: input.reason,
      occurredAt: new Date()
    });
    return revision;
  });
}
