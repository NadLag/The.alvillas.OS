import { Prisma, type PropertyTemplateVersion } from "@prisma/client";
import { authorize, type AuthContext } from "@/platform/authz/authorize";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
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

  /** Native template sources select identities and authority metadata before any names, values or reasons. */
  nativeInventoryTemplateHeads(ids:readonly string[],kind:"INVENTORY"|"SERVICE_CATALOG"|"WORKFLOW"="INVENTORY") {
    if(ids.length===0)return Promise.resolve([] as Array<{id:string;key:string;version:number;propertyId:string|null;status:string;createdBy:string;createdAt:Date;rowVersion:string;tuple:string;latestId:string;latestStatus:string}>);
    return this.tx.$queryRaw<Array<{id:string;key:string;version:number;propertyId:string|null;status:string;createdBy:string;createdAt:Date;rowVersion:string;tuple:string;latestId:string;latestStatus:string}>>(Prisma.sql`SELECT t.id,t.key,t.version,t.property_id AS "propertyId",t.status,t.created_by AS "createdBy",t.created_at AS "createdAt",t.xmin::text AS "rowVersion",t.ctid::text AS tuple,latest.id AS "latestId",latest.status AS "latestStatus" FROM property_template_version t JOIN LATERAL(SELECT id,status FROM property_template_version v WHERE v.organization_id=t.organization_id AND v.key=t.key ORDER BY version DESC LIMIT 1)latest ON true WHERE t.organization_id=${this.organizationId}::uuid AND t.kind=${kind} AND t.id IN(${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY t.id`);
  }

  nativeInventoryTemplateRows(ids:readonly string[],kind:"INVENTORY"|"SERVICE_CATALOG"|"WORKFLOW"="INVENTORY") {
    return this.tx.propertyTemplateVersion.findMany({where:{organizationId:this.organizationId,kind,id:{in:[...ids]}},select:{id:true,key:true,version:true,propertyId:true,status:true,name:true,values:true,createdBy:true,createdAt:true},orderBy:{id:"asc"}});
  }

  async nativeInventoryBindingHead(propertyId:string,kind:"INVENTORY"|"SERVICE_CATALOG"|"WORKFLOW"="INVENTORY") {
    const rows=await this.tx.$queryRaw<Array<{id:string;revision:number;templateVersionId:string;createdBy:string;createdAt:Date;rowVersion:string;tuple:string}>>(Prisma.sql`SELECT id,revision,template_version_id AS "templateVersionId",created_by AS "createdBy",created_at AS "createdAt",xmin::text AS "rowVersion",ctid::text AS tuple FROM property_template_revision WHERE organization_id=${this.organizationId}::uuid AND property_id=${propertyId}::uuid AND kind=${kind} ORDER BY revision DESC LIMIT 1`);
    return rows[0]??null;
  }

  nativeInventoryTemplatePage(propertyId:string,query:string,after:string|undefined,asOf:Date,kind:"INVENTORY"|"SERVICE_CATALOG"|"WORKFLOW"="INVENTORY") {
    const pattern="%"+query.replace(/[\\%_]/gu,value=>"\\"+value)+"%";
    return this.tx.$queryRaw<Array<{id:string;propertyId:string|null;status:string;createdBy:string;createdAt:Date}>>(Prisma.sql`SELECT t.id,t.property_id AS "propertyId",t.status,t.created_by AS "createdBy",t.created_at AS "createdAt" FROM property_template_version t WHERE t.organization_id=${this.organizationId}::uuid AND t.kind=${kind} AND(t.property_id IS NULL OR t.property_id=${propertyId}::uuid) AND t.status='ACTIVE' AND t.created_at<=${asOf} AND NOT EXISTS(SELECT 1 FROM property_template_version v WHERE v.organization_id=t.organization_id AND v.key=t.key AND v.version>t.version AND v.created_at<=${asOf}) ${after?Prisma.sql`AND t.id>${after}::uuid`:Prisma.empty} AND(${query}='' OR t.key ILIKE ${pattern} OR t.name->>'en' ILIKE ${pattern} OR t.name->>'fr' ILIKE ${pattern} OR t.name->>'ar' ILIKE ${pattern}) ORDER BY t.id LIMIT 51`);
  }
  nativeInventoryTemplateChoiceRows(ids:readonly string[],kind:"INVENTORY"|"SERVICE_CATALOG"="INVENTORY") {
    if(!ids.length)return Promise.resolve([]);
    return this.tx.$queryRaw<Array<{id:string;key:string;version:number;name:Prisma.JsonValue;itemCount:number}>>(Prisma.sql`SELECT t.id,t.key,t.version,t.name,jsonb_array_length(t.values->'rules'->${kind==="INVENTORY"?"inventory.minimums":"services.pricing"}->${kind==="INVENTORY"?"minimums":"services"})::int AS "itemCount" FROM property_template_version t WHERE t.organization_id=${this.organizationId}::uuid AND t.kind=${kind} AND t.id IN(${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY t.id`);
  }
  async authorizationProperty(propertyId: string) {
    const [property] = await new CoreRepository(this.tx, this.organizationId).onboardingPropertyHeads([propertyId]);
    return property ?? null;
  }
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
      select: { id: true, name: true, city: true, region: true, cityId: true, regionId: true }
    });
  }
  presentationProperties(ids: readonly string[]) {
    return this.tx.property.findMany({ where: { organizationId: this.organizationId, id: { in: [...ids] } },
      select: { id: true, cityId: true, regionId: true, city: true, region: true } });
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
  nativeWorkflowCommandRows(propertyId:string,ids:readonly string[]) {
    if(!ids.length)return Promise.resolve([]);
    return this.tx.$queryRaw<Array<{id:string;propertyId:string;kind:string;revision:number;templateVersionId:string;action:string;operationId:string;createdBy:string;command:Prisma.JsonValue;reason:string;rowVersion:string;tuple:string}>>(Prisma.sql`SELECT id,property_id AS "propertyId",kind,revision,template_version_id AS "templateVersionId",action,operation_id AS "operationId",created_by AS "createdBy",command,reason,xmin::text AS "rowVersion",ctid::text AS tuple FROM property_template_revision WHERE organization_id=${this.organizationId}::uuid AND property_id=${propertyId}::uuid AND kind='WORKFLOW' AND id IN(${Prisma.join(ids.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY revision`);
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
      select: { id: true, name: true, city: true, region: true, cityId: true, regionId: true }
    });
    return rows.filter(
      (p) =>
        authorize(auth, "view", {
          type: "property",
          organizationId: this.organizationId,
          propertyId: p.id,
          city: p.cityId ?? p.city,
          region: p.regionId ?? p.region
        }) &&
        authorize(auth, "view", {
          type: "config_rule",
          organizationId: this.organizationId,
          propertyId: p.id,
          city: p.cityId ?? p.city,
          region: p.regionId ?? p.region
        })
    );
  }
  catalogMetadata(input: { kind?: TemplateKind; search: string }) {
    return this.tx.$queryRaw<Array<Pick<PropertyTemplateVersion, "id" | "propertyId" | "createdAt" | "status"> & {
      property: { cityId: string | null; regionId: string | null; city: string; region: string | null } | null;
    }>>(Prisma.sql`SELECT t.id,t.property_id AS "propertyId",t.created_at AS "createdAt",t.status,
      CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('cityId',p.city_id,'regionId',p.region_id,'city',p.city,'region',p.region) END AS property
      FROM (SELECT DISTINCT ON(key) id,key,kind,property_id,name,status,created_at FROM property_template_version
        WHERE organization_id=${this.organizationId}::uuid ORDER BY key,version DESC) t
      LEFT JOIN property p ON p.organization_id=${this.organizationId}::uuid AND p.id=t.property_id
      WHERE (t.property_id IS NULL OR(p.id IS NOT NULL AND p.archived_at IS NULL))
        AND (${input.kind ?? null}::text IS NULL OR t.kind=${input.kind ?? null})
        AND(t.name->>'en' ILIKE ${`%${input.search}%`} OR t.name->>'fr' ILIKE ${`%${input.search}%`} OR t.key ILIKE ${`%${input.search}%`}) ORDER BY t.id`);
  }
  async catalog(input: {
    propertyIds: string[];
    organization: boolean;
    allProperties?: boolean;
    versionIds?: string[];
    kind?: TemplateKind;
    search: string;
    page: number;
  }): Promise<PropertyTemplateVersion[]> {
    return this.tx.$queryRaw<PropertyTemplateVersion[]>(Prisma.sql`
      SELECT * FROM (SELECT DISTINCT ON (key) id, organization_id AS "organizationId", key, kind,
        property_id AS "propertyId", version, name, description, values, status, created_by AS "createdBy", reason, created_at AS "createdAt"
        FROM property_template_version WHERE organization_id = ${this.organizationId}::uuid
        AND ((${input.organization} AND property_id IS NULL) OR property_id::text = ANY(${input.propertyIds}::text[])
          OR (${input.allProperties ?? false} AND EXISTS(SELECT 1 FROM property p WHERE p.organization_id=${this.organizationId}::uuid AND p.id=property_id AND p.archived_at IS NULL))
          OR id::text=ANY(${input.versionIds ?? []}::text[]))
        ORDER BY key, version DESC) AS latest
      WHERE (${input.kind ?? null}::text IS NULL OR kind = ${input.kind ?? null})
        AND (name->>'en' ILIKE ${`%${input.search}%`} OR name->>'fr' ILIKE ${`%${input.search}%`} OR key ILIKE ${`%${input.search}%`})
      ORDER BY "createdAt" DESC, id DESC LIMIT 25 OFFSET ${(input.page - 1) * 24}`);
  }
  async projection(propertyId: string, ruleKeys: readonly string[], ownerId?: string): Promise<TemplateValues> {
    const property = await new CoreRepository(this.tx, this.organizationId).findProperty(propertyId);
    if (!property) throw new Error("Property not found");
    const rules: Record<string, unknown> = {};
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    const asOf = new Date();
    const scopes = await new ReservationConfigScopeRepository(this.tx, this.organizationId).scopes({ propertyId, ownerId, asOf });
    for (const key of ruleKeys) {
      const rule = await config.resolve({
        key,
        scopes,
        asOf
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
