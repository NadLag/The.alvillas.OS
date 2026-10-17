import { Prisma, type PropertyTemplateVersion } from "@prisma/client";
import { authorize, type AuthContext } from "@/platform/authz/authorize";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { type TenantTransaction } from "@/platform/db/tenant";
import { CoreRepository } from "./core-repository";
import {
  propertyTemplateFields,
  operatingTemplateFields,
  type TemplateKind,
  type TemplateValues,
  type TemplateChangeInput,
  type SettingMap
} from "../domain/property-template";

export function templateJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
export class PropertyTemplateRepository {
  constructor(
    readonly tx: TenantTransaction,
    readonly organizationId: string
  ) {}
  lock(key: string) {
    return this.tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`template:${this.organizationId}:${key}`}, 0))`
    );
  }
  async lockProperty(id: string) {
    await this.tx.$queryRaw(
      Prisma.sql`SELECT id FROM property WHERE organization_id = ${this.organizationId}::uuid AND id = ${id}::uuid FOR UPDATE`
    );
    await this.tx.$queryRaw(
      Prisma.sql`SELECT id FROM property_operating_profile WHERE organization_id = ${this.organizationId}::uuid AND property_id = ${id}::uuid FOR UPDATE`
    );
  }
  latest(key: string) {
    return this.tx.propertyTemplateVersion.findFirst({
      where: { organizationId: this.organizationId, key },
      orderBy: { version: "desc" }
    });
  }
  version(id: string) {
    return this.tx.propertyTemplateVersion.findFirst({
      where: { organizationId: this.organizationId, id }
    });
  }
  propertyOption(id: string) {
    return this.tx.property.findFirst({
      where: { organizationId: this.organizationId, id, archivedAt: null },
      select: { id: true, name: true, city: true, region: true }
    });
  }
  createVersion(data: Omit<Prisma.PropertyTemplateVersionUncheckedCreateInput, "organizationId">) {
    return this.tx.propertyTemplateVersion.create({
      data: { ...data, organizationId: this.organizationId }
    });
  }
  binding(propertyId: string, kind: TemplateKind) {
    return this.tx.propertyTemplateRevision.findFirst({
      where: { organizationId: this.organizationId, propertyId, kind },
      orderBy: { revision: "desc" },
      include: { templateVersion: true }
    });
  }
  operation(operationId: string) {
    return this.tx.propertyTemplateRevision.findFirst({
      where: { organizationId: this.organizationId, operationId }
    });
  }
  history(propertyId: string, kind: TemplateKind, page: number) {
    return this.tx.propertyTemplateRevision.findMany({
      where: { organizationId: this.organizationId, propertyId, kind },
      orderBy: { revision: "desc" },
      skip: (page - 1) * 20,
      take: 21,
      include: { templateVersion: true }
    });
  }
  versions(key: string, page: number) {
    return this.tx.propertyTemplateVersion.findMany({
      where: { organizationId: this.organizationId, key },
      orderBy: { version: "desc" },
      skip: (page - 1) * 20,
      take: 21
    });
  }
  createRevision(input: {
    propertyId: string;
    kind: TemplateKind;
    revision: number;
    templateVersionId: string;
    action: string;
    operationId: string;
    command: TemplateChangeInput;
    snapshot: TemplateValues;
    overrides: SettingMap;
    createdBy: string;
    reason: string;
  }) {
    return this.tx.propertyTemplateRevision.create({
      data: {
        ...input,
        organizationId: this.organizationId,
        command: templateJson(input.command),
        snapshot: templateJson(input.snapshot),
        overrides: templateJson(input.overrides)
      }
    });
  }
  async properties(auth: AuthContext, search: string, page: number) {
    const assignments =
      auth.assignments ?? auth.scopes.map((scope) => ({ scope, permissions: auth.permissions }));
    const scopes = assignments.filter((a) => a.permissions.has("property:view")).map((a) => a.scope);
    const filters: Prisma.PropertyWhereInput[] = scopes.map((s) => {
      const kind = s.scopeType ?? s.resourceType ?? "organization",
        id = s.scopeId ?? s.resourceId;
      if (kind === "organization") return {};
      if (kind === "property" && id) return { id };
      if (kind === "city" && id) return { OR: [{ city: id }, { cityId: id }] };
      if (kind === "region" && id) return { OR: [{ region: id }, { regionId: id }] };
      return { id: { in: [] } };
    });
    const rows = await this.tx.property.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        AND: [{ OR: filters }, { name: { contains: search, mode: "insensitive" } }]
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * 40,
      take: 41,
      select: { id: true, name: true, city: true, region: true }
    });
    return rows.filter(
      (p) =>
        authorize(auth, "view", {
          type: "property",
          organizationId: this.organizationId,
          propertyId: p.id,
          city: p.city,
          region: p.region
        }) &&
        authorize(auth, "view", {
          type: "config_rule",
          organizationId: this.organizationId,
          propertyId: p.id,
          city: p.city,
          region: p.region
        })
    );
  }
  catalog(input: {
    propertyIds: string[];
    organization: boolean;
    kind?: TemplateKind;
    search: string;
    page: number;
  }) {
    return this.tx.$queryRaw<PropertyTemplateVersion[]>(Prisma.sql`
      SELECT * FROM (SELECT DISTINCT ON (key) id, organization_id AS "organizationId", key, kind,
        property_id AS "propertyId", version, name, description, values, status, created_by AS "createdBy", reason, created_at AS "createdAt"
        FROM property_template_version WHERE organization_id = ${this.organizationId}::uuid
        AND ((${input.organization} AND property_id IS NULL) OR property_id::text = ANY(${input.propertyIds}::text[]))
        ORDER BY key, version DESC) AS latest
      WHERE (${input.kind ?? null}::text IS NULL OR kind = ${input.kind ?? null})
        AND (name->>'en' ILIKE ${`%${input.search}%`} OR name->>'fr' ILIKE ${`%${input.search}%`} OR key ILIKE ${`%${input.search}%`})
      ORDER BY "createdAt" DESC, id DESC LIMIT 25 OFFSET ${(input.page - 1) * 24}`);
  }
  async projection(propertyId: string, ruleKeys: readonly string[]): Promise<TemplateValues> {
    const property = await new CoreRepository(this.tx, this.organizationId).findProperty(propertyId);
    if (!property) throw new Error("Property not found");
    const rules: Record<string, unknown> = {};
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    for (const key of ruleKeys) {
      const rule = await config.resolve({
        key,
        scopes: [
          { scopeType: "property", scopeId: propertyId },
          { scopeType: "organization", scopeId: null }
        ]
      });
      if (rule) rules[key] = rule.parsedValue;
    }
    return {
      property: Object.fromEntries(propertyTemplateFields.map((key) => [key, property[key]])),
      operating: Object.fromEntries(
        operatingTemplateFields
          .filter(
            (key) =>
              property.operatingProfile?.[key] !== null && property.operatingProfile?.[key] !== undefined
          )
          .map((key) => [key, property.operatingProfile?.[key]])
      ),
      rules
    };
  }
  async persistPropertyFields(propertyId: string, before: TemplateValues, after: TemplateValues) {
    const changedProperty = Object.fromEntries(
      Object.entries(after.property ?? {}).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(before.property?.[key])
      )
    );
    if (Object.keys(changedProperty).length)
      await this.tx.property.update({
        where: { id: propertyId, organizationId: this.organizationId },
        data: changedProperty
      });
  }
}
