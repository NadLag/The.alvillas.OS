import { headers } from "next/headers";
import type { Session } from "next-auth";
import type { PropertyTemplateVersion } from "@prisma/client";
import { z } from "zod";
import { authContextForAccount, authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { authorize, authorizeCollection, type AuthContext } from "@/platform/authz/authorize";
import { present, maskedValue, type FieldPolicy } from "@/platform/authz/present";
import { authorizeUnconditionalSource, authorizeOrganizationSource } from "@/platform/authz/organization-authority";
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
import { TemplateAccessError, TemplateConflictError, TemplateNotFoundError, type CoreActorContext } from "./core-access";
import { updatePropertyOperatingProfile } from "./core-service";

export { TemplateAccessError, TemplateConflictError, TemplateNotFoundError } from "./core-access";
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
  kind?: string,
  property?: NonNullable<Awaited<ReturnType<PropertyTemplateRepository["authorizationProperty"]>>>,
  ownerId?: string
) {
  const resource = { organizationId: ctx.organizationId, propertyId, ownerId,
    city: property?.cityId ?? undefined, region: property?.regionId ?? undefined };
  if (
    !authorize(ctx.authContext, action, { ...resource, type: "config_rule" }) ||
    (propertyId &&
      !authorize(ctx.authContext, action === "view" ? "view" : "edit", {
        ...resource,
        type: "property", id: propertyId ?? undefined, status: property?.status, occurredAt: property?.createdAt
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
function templateMetadataVisible(
  ctx: TemplateActorContext,
  row: Pick<PropertyTemplateVersion, "id" | "createdAt" | "status">,
  propertyId: string | null,
  current: AuthContext,
  property: { cityId: string | null; regionId: string | null; city: string; region: string | null } | undefined,
  at: Date
) {
  if (propertyId && !property) return false;
  const root = { type: "config_rule", organizationId: ctx.organizationId, id: row.id, financialRecordId: row.id, propertyId,
    city: property?.cityId ?? property?.city, region: property?.regionId ?? property?.region, occurredAt: row.createdAt, status: row.status, dataClass: "financial" as const };
  return [ctx.authContext, current].every(authority => authorize(authority, "view", root, at) &&
    (!propertyId || authorize(authority, "view", { ...root, id: propertyId, type: "property" }, at)));
}
function visibleVersion(
  ctx: TemplateActorContext,
  row: PropertyTemplateVersion,
  propertyId: string | null,
  current: AuthContext,
  property: { cityId: string | null; regionId: string | null; city: string; region: string | null } | undefined,
  at: Date
) {
  const source = {
    type: "financial_transaction",
    organizationId: ctx.organizationId,
    id: row.id, financialRecordId: row.id, propertyId, city: property?.cityId ?? property?.city,
    region: property?.regionId ?? property?.region, occurredAt: row.createdAt, status: row.status, dataClass: "financial" as const
  };
  if (!templateMetadataVisible(ctx, row, propertyId, current, property, at)) throw new TemplateAccessError();
  const financial = [ctx.authContext, current].every(authority => authorize(authority, "view", source, at));
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
      propertyId, city: source.city, region: source.region,
      data: { ...row, values: row.values }
    },
    row.kind === "SERVICE_CATALOG" ? { values: { dataClass: "financial", mask: "omit" }, reason: { dataClass: "financial" } } : {}, at
  );
  return {
    ...row,
    values: serialized.values ?? null,
    reason: serialized.reason ?? maskedValue,
    restricted: row.kind === "SERVICE_CATALOG" && !financial
  };
}
async function templateDisclosure(ctx: TemplateActorContext, repo: PropertyTemplateRepository, propertyId: string | null, financial: boolean) {
  const property = propertyId ? (await repo.presentationProperties([propertyId]))[0] : undefined;
  if (propertyId && !property) throw new TemplateNotFoundError();
  const current = financial ? await authContextForAccountInTransaction(repo.tx, ctx.organizationId, ctx.actorId) : ctx.authContext, at = new Date();
  return { current, property, at, source: { organizationId: ctx.organizationId, propertyId, id: propertyId ?? undefined,
    city: property?.cityId ?? property?.city, region: property?.regionId ?? property?.region } };
}
async function financialTemplateWriteAuthority(ctx: TemplateActorContext, repo: PropertyTemplateRepository, propertyId: string | null, action: "create" | "configure") {
  const disclosure = await templateDisclosure(ctx, repo, propertyId, true), source = { ...disclosure.source, dataClass: "financial" as const };
  if ([ctx.authContext, disclosure.current].some(authority =>
    !authorize(authority, action, { ...source, type: "config_rule" }, disclosure.at) ||
    !authorize(authority, "view", { ...source, type: "config_rule" }, disclosure.at) || propertyId &&
    !authorize(authority, "edit", { ...source, type: "property" }, disclosure.at) ||
    !authorizeUnconditionalSource(authority, "view", { ...source, type: "financial_transaction" }, disclosure.at))) throw new TemplateAccessError();
  return disclosure;
}
function presentFinancialTemplate<T extends Record<string, unknown>>(ctx: TemplateActorContext, disclosure: Awaited<ReturnType<typeof templateDisclosure>>, data: T, fields: readonly (keyof T & string)[]): T {
  return present({ ...ctx.authContext, visibleDataClasses: new Set(["financial"] as const) }, "view",
    { ...disclosure.source, type: "config_rule", data }, Object.fromEntries(fields.map(field => [field, { dataClass: "financial" as const }])) as FieldPolicy<T>, disclosure.at) as T;
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
    if (input.kind === "SERVICE_CATALOG") await financialTemplateWriteAuthority(ctx, repo, input.propertyId, input.expectedVersion ? "configure" : "create");
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
    if (input.kind !== "SERVICE_CATALOG") return after;
    const disclosure = await financialTemplateWriteAuthority(ctx, repo, input.propertyId, input.expectedVersion ? "configure" : "create");
    return presentFinancialTemplate(ctx, disclosure, after, ["values", "reason"]);
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
    const selectionAt = new Date(),
      completeOrganization = ["config_rule", "property"].every(type =>
        authorizeOrganizationSource(ctx.authContext, "view", { type, organizationId: ctx.organizationId, dataClass: "financial" }, selectionAt)),
      search = z.string().max(160).parse(input.search ?? ""),
      versions = !propertyId && !completeOrganization ? (await repo.catalogMetadata({ kind: input.kind, search }))
        .filter(row => templateMetadataVisible(ctx, row, row.propertyId, ctx.authContext, row.property ?? undefined, selectionAt)).map(row => row.id) : [];
    const rows = await repo.catalog({
      propertyIds: propertyId ? [propertyId] : [],
      organization: propertyId !== null || completeOrganization,
      allProperties: !propertyId && completeOrganization,
      versionIds: versions,
      kind: input.kind,
      search,
      page
    });
    const sourceIds = [...new Set([...properties.map(property => property.id), ...(target ? [target.id] : []), ...rows.slice(0, 24).flatMap(row => row.propertyId ? [row.propertyId] : []), ...(propertyId ? [propertyId] : [])])],
      sourceProperties = new Map((await repo.presentationProperties(sourceIds)).map(property => [property.id, property])),
      current = rows.slice(0, 24).some(row => row.kind === "SERVICE_CATALOG") ? await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId) : ctx.authContext, at = new Date();
    const propertyVisible = (id: string) => { const source = sourceProperties.get(id); return Boolean(source && authorize(current, "view", {
      type: "property", organizationId: ctx.organizationId, id, propertyId: id, city: source.cityId ?? source.city, region: source.regionId ?? source.region }, at)); };
    if (!authorizeCollection(current, "view", "config_rule") || !authorizeCollection(current, "view", "property") || propertyId && !propertyVisible(propertyId)) throw new TemplateAccessError();
    return {
      properties: (target ? [target, ...properties.slice(0, 40)] : properties.slice(0, 40)).filter(property => propertyVisible(property.id)),
      moreProperties: properties.length > 40,
      templates: rows.slice(0, 24).map((row) => { const sourceId = row.propertyId ?? propertyId;
        return visibleVersion(ctx, row, sourceId, current, sourceId ? sourceProperties.get(sourceId) : undefined, at); }),
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
    const rows = await repo.versions(row.key, page),
      latest = await repo.latest(row.key);
    const sourceId = row.propertyId ?? propertyId, disclosure = await templateDisclosure(ctx, repo, sourceId, row.kind === "SERVICE_CATALOG"),
      selected = visibleVersion(ctx, row, sourceId, disclosure.current, disclosure.property, disclosure.at);
    if (selected.restricted) throw new TemplateAccessError();
    return {
      selected,
      versions: rows.slice(0, 20).map(version => visibleVersion(ctx, version, sourceId, disclosure.current, disclosure.property, disclosure.at)),
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
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new PropertyTemplateRepository(tx, ctx.organizationId);
    const property = await repo.authorizationProperty(propertyId);
    if (!property) throw new TemplateNotFoundError();
    const disclosure = await templateDisclosure(ctx, repo, propertyId, true);
    allowed(ctx, "view", propertyId, kind, property);
    allowed({ ...ctx, authContext: disclosure.current }, "view", propertyId, kind, property);
    const source = { ...disclosure.source, dataClass: kind === "SERVICE_CATALOG" ? "financial" as const : "operational" as const };
    if (kind === "SERVICE_CATALOG" && [ctx.authContext, disclosure.current].some(authority =>
      !authorizeUnconditionalSource(authority, "view", { ...source, type: "financial_transaction" }, disclosure.at))) throw new TemplateAccessError();
    const binding = await repo.binding(propertyId, kind);
    const boundCommand = binding ? templateChangeSchema.parse(binding.command) : null;
    const ownerId = boundCommand?.ownerId;
    if (ownerId && !property.ownership.some(row => row.ownerId === ownerId)) throw new TemplateConflictError();
    const current = await repo.projection(propertyId, templateRuleKeys(kind), ownerId);
    const base = binding ? flattenSettings(binding.templateVersion.values) : {};
    const fields = Object.entries(base).map(([path, inherited]) => ({
      path,
      inherited,
      current: readSetting(current, path) ?? null,
      overridden: !equalSetting(readSetting(current, path), inherited)
    }));
    const history = await repo.history(propertyId, kind, page), latest = binding ? await repo.latest(binding.templateVersion.key) : null;
    if ([ctx.authContext, disclosure.current].some(authority => !authorize(authority, "view", { ...source, type: "config_rule" }, disclosure.at) ||
      !authorize(authority, "view", { ...source, type: "property" }, disclosure.at) || kind === "SERVICE_CATALOG" &&
      !authorizeUnconditionalSource(authority, "view", { ...source, type: "financial_transaction" }, disclosure.at))) throw new TemplateAccessError();
    const result = {
      binding,
      ...(ownerId ? { ownerId } : {}),
      fields,
      latest,
      history: history.slice(0, 20),
      more: history.length > 20
    };
    return kind === "SERVICE_CATALOG" ? presentFinancialTemplate(ctx, disclosure, result, ["binding", "fields", "latest", "history"]) : result;
  });
}
export async function changePropertyTemplate(ctx: TemplateActorContext, raw: unknown, deps: Deps = {}) {
  const input = templateChangeSchema.parse(raw),
    audit = await meta(deps);
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId)
    throw new TemplateAccessError();
  return withTenant(deps.db ?? prisma, ctx.organizationId, async (tx) => {
    const repo = new PropertyTemplateRepository(tx, ctx.organizationId);
    await repo.lockProperty(input.propertyId);
    const writeAuthority = async (kind?: string) => {
      const property = await repo.authorizationProperty(input.propertyId);
      if (!property) throw new TemplateNotFoundError();
      if (input.ownerId && !property.ownership.some(row => row.ownerId === input.ownerId)) throw new TemplateAccessError();
      const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
      allowed(ctx, "configure", input.propertyId, kind, property, input.ownerId);
      allowed({ ...ctx, authContext: current }, "configure", input.propertyId, kind, property, input.ownerId);
      return property;
    };
    await writeAuthority();
    const replay = await repo.operation(input.operationId);
    if (replay) {
      await writeAuthority(replay.kind);
      if (replay.createdBy !== ctx.actorId || !equalSetting(replay.command, input))
        throw new TemplateConflictError();
      if (replay.kind !== "SERVICE_CATALOG") return replay;
      const disclosure = await financialTemplateWriteAuthority(ctx, repo, input.propertyId, "configure");
      return presentFinancialTemplate(ctx, disclosure, replay, ["snapshot", "overrides", "command", "reason"]);
    }
    const selected = input.action === "APPLY" ? await repo.version(input.templateVersionId) : null;
    if (input.action === "APPLY" && !selected) throw new TemplateNotFoundError();
    const kind = selected
      ? z.enum(templateKinds).parse(selected.kind)
      : (input as Exclude<typeof input, { action: "APPLY" }>).kind;
    await writeAuthority(kind);
    const binding = await repo.binding(input.propertyId, kind);
    if ((binding?.revision ?? 0) !== input.expectedRevision) throw new TemplateConflictError();
    if (input.action !== "APPLY" && binding && templateChangeSchema.parse(binding.command).ownerId !== input.ownerId)
      throw new TemplateConflictError();
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
    if (kind === "SERVICE_CATALOG") await financialTemplateWriteAuthority(ctx, repo, input.propertyId, "configure");
    const before = await repo.projection(input.propertyId, ruleKeys, input.ownerId);
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
    await writeAuthority(kind);
    if (kind !== "SERVICE_CATALOG") return revision;
    const disclosure = await financialTemplateWriteAuthority(ctx, repo, input.propertyId, "configure");
    return presentFinancialTemplate(ctx, disclosure, revision, ["snapshot", "overrides", "command", "reason"]);
  });
}
