import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { Money } from "@/platform/money/money";
import initialPolicy from "@/platform/config/defaults/staff-management.json" with { type: "json" };
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { teamPolicyKey } from "../domain/team";

export type OnboardingTeamAssignmentHead={id:string;personId:string;roleId:string;userAccountId:string|null;scopeType:string;scopeId:string|null;validFrom:Date;validTo:Date|null;archivedAt:Date|null;createdBy:string|null;createdAt:Date;rowVersion:string;tuple:string};
export type OnboardingTeamPersonHead={id:string;archivedAt:Date|null;rowVersion:string;tuple:string};
export type OnboardingTeamAccountHead={id:string;personId:string|null;status:string;rowVersion:string;tuple:string};
export type OnboardingTeamRoleHead={id:string;archivedAt:Date|null;rowVersion:string;tuple:string;permissionsHash:string;permissionCount:number;permissionsValid:boolean};
export type OnboardingTeamPersonScope={personId:string;assignmentId:string;scopeType:string;scopeId:string|null;propertyId:string|null;city:string|null;region:string|null;jobId:string|null;rowVersion:string;tuple:string};

export class TeamRepository {
  constructor(
    readonly tx: TenantTransaction,
    readonly organizationId: string
  ) {}
  async initializePolicy() {
    const config = new ConfigRuleRepository(this.tx, this.organizationId);
    await config.lockVersion(teamPolicyKey, "organization");
    if (
      !(await config.list({ key: teamPolicyKey, scopeType: "organization", scopeId: null, take: 1 }))
        .length
    ) {
      await config.createVersion({
        key: teamPolicyKey,
        scopeType: "organization",
        value: initialPolicy,
        effectiveFrom: new Date(0),
        reason: "Initialize configurable staff document policy"
      });
    }
  }
  async clock() {
    const [row] = await this.tx.$queryRaw<Array<{ now: Date }>>(Prisma.sql`SELECT clock_timestamp() AS now`);
    return row.now;
  }
  async flushGuards() {
    await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS ALL IMMEDIATE`);
  }
  async onboardingTeamAssignmentHeads(ids:readonly string[],includeArchived=false):Promise<OnboardingTeamAssignmentHead[]>{
    if(!ids.length)return[];
    return this.tx.$queryRaw<OnboardingTeamAssignmentHead[]>(Prisma.sql`
      SELECT a.id,a.person_id AS "personId",a.role_id AS "roleId",a.user_account_id AS "userAccountId",
        a.scope_type AS "scopeType",a.scope_id AS "scopeId",a.valid_from AS "validFrom",a.valid_to AS "validTo",
        a.archived_at AS "archivedAt",a.created_by AS "createdBy",a.created_at AS "createdAt",a.xmin::text AS "rowVersion",a.ctid::text AS tuple
      FROM role_assignment a WHERE a.organization_id=${this.organizationId}::uuid
        AND a.id IN (${Prisma.join([...new Set(ids)].map(id=>Prisma.sql`${id}::uuid`))})
        ${includeArchived?Prisma.empty:Prisma.sql`AND a.archived_at IS NULL`} ORDER BY a.id`);
  }
  async onboardingTeamPersonHeads(ids:readonly string[],includeArchived=false):Promise<OnboardingTeamPersonHead[]>{
    if(!ids.length)return[];
    return this.tx.$queryRaw<OnboardingTeamPersonHead[]>(Prisma.sql`
      SELECT p.id,p.archived_at AS "archivedAt",p.xmin::text AS "rowVersion",p.ctid::text AS tuple
      FROM person p WHERE p.organization_id=${this.organizationId}::uuid
        AND p.id IN (${Prisma.join([...new Set(ids)].map(id=>Prisma.sql`${id}::uuid`))})
        ${includeArchived?Prisma.empty:Prisma.sql`AND p.archived_at IS NULL`} ORDER BY p.id`);
  }
  async onboardingTeamAccountHeads(ids:readonly string[]):Promise<OnboardingTeamAccountHead[]>{
    if(!ids.length)return[];
    return this.tx.$queryRaw<OnboardingTeamAccountHead[]>(Prisma.sql`
      SELECT a.id,a.person_id AS "personId",a.status::text AS status,a.xmin::text AS "rowVersion",a.ctid::text AS tuple
      FROM user_account a WHERE a.organization_id=${this.organizationId}::uuid
        AND a.id IN (${Prisma.join([...new Set(ids)].map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY a.id`);
  }
  async onboardingTeamRoleHeads(ids:readonly string[],includeArchived=false):Promise<OnboardingTeamRoleHead[]>{
    if(!ids.length)return[];
    return this.tx.$queryRaw<OnboardingTeamRoleHead[]>(Prisma.sql`
      SELECT r.id,r.archived_at AS "archivedAt",r.xmin::text AS "rowVersion",r.ctid::text AS tuple,
        coalesce(witness.signature,md5('')) AS "permissionsHash",coalesce(witness.total,0)::int AS "permissionCount",coalesce(witness.valid,true) AS "permissionsValid"
      FROM role r LEFT JOIN LATERAL (
        SELECT md5(string_agg(rp.permission_id::text||':'||rp.xmin::text||':'||rp.ctid::text||':'||coalesce(p.key,'MISSING')||':'||coalesce(p.resource,'MISSING')||':'||coalesce(p.action,'MISSING')||':'||coalesce(p.xmin::text,'MISSING')||':'||coalesce(p.ctid::text,'MISSING'),'|' ORDER BY rp.permission_id)) AS signature,count(*)::int AS total,bool_and(p.id IS NOT NULL) AS valid
        FROM role_permission rp LEFT JOIN permission p ON p.organization_id=rp.organization_id AND p.id=rp.permission_id
        WHERE rp.organization_id=r.organization_id AND rp.role_id=r.id
      ) witness ON true
      WHERE r.organization_id=${this.organizationId}::uuid
        AND r.id IN (${Prisma.join([...new Set(ids)].map(id=>Prisma.sql`${id}::uuid`))})
        ${includeArchived?Prisma.empty:Prisma.sql`AND r.archived_at IS NULL`} ORDER BY r.id`);
  }
  async onboardingTeamAssignmentPage(propertyId:string,after:string|undefined,asOf:Date){
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
      SELECT a.id FROM role_assignment a WHERE a.organization_id=${this.organizationId}::uuid
        AND a.scope_type='property' AND a.scope_id=${propertyId}::uuid AND a.archived_at IS NULL AND a.created_at<=${asOf}
        ${after?Prisma.sql`AND a.id>${after}::uuid`:Prisma.empty} ORDER BY a.id LIMIT 51`);
  }
  async onboardingTeamAssignmentChoices(propertyId:string,query:string,after:string|undefined,asOf:Date){
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
      SELECT a.id FROM role_assignment a
      JOIN person p ON p.organization_id=a.organization_id AND p.id=a.person_id AND p.archived_at IS NULL
      JOIN role r ON r.organization_id=a.organization_id AND r.id=a.role_id AND r.archived_at IS NULL
      WHERE a.organization_id=${this.organizationId}::uuid AND a.scope_type='property' AND a.scope_id=${propertyId}::uuid
        AND a.archived_at IS NULL AND a.created_at<=${asOf}
        AND (${query}='' OR position(lower(${query}) in lower(p.display_name))>0 OR position(lower(${query}) in lower(r.name))>0)
        ${after?Prisma.sql`AND a.id>${after}::uuid`:Prisma.empty} ORDER BY a.id LIMIT 51`);
  }
  async onboardingTeamPersonChoices(query:string,after:string|undefined,asOf:Date){
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
      SELECT p.id FROM person p WHERE p.organization_id=${this.organizationId}::uuid AND p.archived_at IS NULL AND p.created_at<=${asOf}
        AND (${query}='' OR position(lower(${query}) in lower(p.display_name))>0)
        ${after?Prisma.sql`AND p.id>${after}::uuid`:Prisma.empty} ORDER BY p.id LIMIT 51`);
  }
  async onboardingTeamRoleChoices(query:string,after:string|undefined,asOf:Date){
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
      SELECT r.id FROM role r WHERE r.organization_id=${this.organizationId}::uuid AND r.archived_at IS NULL AND r.created_at<=${asOf}
        AND (${query}='' OR position(lower(${query}) in lower(r.name))>0 OR position(lower(${query}) in lower(r.key))>0)
        ${after?Prisma.sql`AND r.id>${after}::uuid`:Prisma.empty} ORDER BY r.id LIMIT 51`);
  }
  async onboardingTeamAccountChoices(personId:string,query:string,after:string|undefined,asOf:Date){
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`
      SELECT a.id FROM user_account a WHERE a.organization_id=${this.organizationId}::uuid AND a.person_id=${personId}::uuid AND a.status='ACTIVE' AND a.created_at<=${asOf}
        AND (${query}='' OR position(lower(${query}) in lower(coalesce(a.email,'')))>0)
        ${after?Prisma.sql`AND a.id>${after}::uuid`:Prisma.empty} ORDER BY a.id LIMIT 51`);
  }
  async onboardingTeamPersonScopes(ids:readonly string[],asOf:Date):Promise<OnboardingTeamPersonScope[]>{
    if(!ids.length)return[];
    return this.tx.$queryRaw<OnboardingTeamPersonScope[]>(Prisma.sql`
      SELECT a.person_id AS "personId",a.id AS "assignmentId",a.scope_type AS "scopeType",a.scope_id AS "scopeId",
        p.id AS "propertyId",coalesce(p.city_id,c.id) AS city,coalesce(p.region_id,c.region_id,r.id) AS region,t.id AS "jobId",a.xmin::text AS "rowVersion",a.ctid::text AS tuple
      FROM role_assignment a
      LEFT JOIN operation_task t ON a.scope_type='job' AND t.organization_id=a.organization_id AND t.id=a.scope_id AND t.archived_at IS NULL
      LEFT JOIN property p ON a.scope_type IN ('property','job') AND p.organization_id=a.organization_id AND p.id=CASE WHEN a.scope_type='job' THEN t.property_id ELSE a.scope_id END AND p.archived_at IS NULL
      LEFT JOIN city c ON a.scope_type='city' AND c.organization_id=a.organization_id AND c.id=a.scope_id AND c.archived_at IS NULL
      LEFT JOIN region r ON a.scope_type='region' AND r.organization_id=a.organization_id AND r.id=a.scope_id AND r.archived_at IS NULL
      WHERE a.organization_id=${this.organizationId}::uuid AND a.person_id IN (${Prisma.join([...new Set(ids)].map(id=>Prisma.sql`${id}::uuid`))})
        AND a.archived_at IS NULL AND a.valid_from<=${asOf} AND (a.valid_to IS NULL OR a.valid_to>${asOf})
        AND ((a.scope_type='organization' AND a.scope_id IS NULL) OR p.id IS NOT NULL OR c.id IS NOT NULL OR r.id IS NOT NULL)
      ORDER BY a.person_id,a.id`);
  }
  onboardingTeamAssignmentRows(ids:readonly string[],includeArchived=false){
    return this.tx.roleAssignment.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]},...includeArchived?{}:{archivedAt:null}},select:{id:true,personId:true,roleId:true,userAccountId:true,scopeType:true,scopeId:true,conditions:true,validFrom:true,validTo:true,archivedAt:true,createdBy:true,createdAt:true},orderBy:{id:"asc"}});
  }
  onboardingTeamPersonRows(ids:readonly string[],includeArchived=false){
    return this.tx.person.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]},...includeArchived?{}:{archivedAt:null}},select:{id:true,displayName:true,archivedAt:true},orderBy:{id:"asc"}});
  }
  onboardingTeamAccountRows(ids:readonly string[]){
    return this.tx.userAccount.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,personId:true,email:true,status:true},orderBy:{id:"asc"}});
  }
  async onboardingTeamRoleRows(ids:readonly string[],includeArchived=false){
    const roles=await this.tx.role.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]},...includeArchived?{}:{archivedAt:null}},select:{id:true,key:true,name:true,archivedAt:true,rolePermissions:{where:{organizationId:this.organizationId},select:{permission:{select:{organizationId:true,key:true}}}}},orderBy:{id:"asc"}});
    return roles.map(({rolePermissions,...role})=>{if(rolePermissions.some(row=>row.permission.organizationId!==this.organizationId))throw Error("native_onboarding_invalid_role_permission_source");return{...role,permissionKeys:rolePermissions.map(row=>row.permission.key).sort()};});
  }
  compensationFor(assignments: string[]) {
    return this.tx.teamCompensation.findMany({
      where: { organizationId: this.organizationId, assignmentId: { in: assignments } },
      orderBy: [{ assignmentId: "asc" }, { version: "desc" }]
    });
  }
  properties(ids:readonly string[]) {
    return this.tx.property.findMany({
      where: { organizationId: this.organizationId, archivedAt: null, id:{in:[...new Set(ids)]} },
      select: { id: true, name: true },
      orderBy:{id:"asc"}
    });
  }
  regions(ids:readonly string[]) {
    return this.tx.region.findMany({
      where: { organizationId: this.organizationId, archivedAt: null, id:{in:[...new Set(ids)]} },
      select: { id: true, name: true },
      orderBy:{id:"asc"}
    });
  }
  cities(ids:readonly string[]) {
    return this.tx.city.findMany({
      where: { organizationId: this.organizationId, archivedAt: null, id:{in:[...new Set(ids)]} },
      select: { id: true, name: true },
      orderBy:{id:"asc"}
    });
  }
  async scopeChoices(input:{type:"property"|"region"|"city";query:string;after?:string}):Promise<Array<{id:string;name:string;cityId:string|null;regionId:string|null}>>{
    const where={organizationId:this.organizationId,archivedAt:null,...input.query?{name:{contains:input.query,mode:"insensitive" as const}}:{},...input.after?{id:{gt:input.after}}:{}},page={where,orderBy:{id:"asc" as const},take:26};
    if(input.type==="property")return this.tx.property.findMany({...page,select:{id:true,name:true,cityId:true,regionId:true}});
    if(input.type==="city")return(await this.tx.city.findMany({...page,select:{id:true,name:true,regionId:true}})).map(row=>({...row,cityId:row.id}));
    return(await this.tx.region.findMany({...page,select:{id:true,name:true}})).map(row=>({...row,cityId:null,regionId:row.id}));
  }
  async scopeChoiceExists(type:"property"|"region"|"city",id:string):Promise<{id:string}|null>{const where={id,organizationId:this.organizationId,archivedAt:null};return type==="property"?this.tx.property.findFirst({where,select:{id:true}}):type==="city"?this.tx.city.findFirst({where,select:{id:true}}):this.tx.region.findFirst({where,select:{id:true}});}
  organization() {
    return this.tx.organization.findUniqueOrThrow({
      where: { id: this.organizationId },
      select: { baseCurrency: true }
    });
  }
  walletAccounts() {
    return this.tx.ledgerAccount.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        accountType: "STAFF_WALLET",
        teamWallet: null
      },
      select: { id: true, name: true, code: true },
      orderBy: { code: "asc" },
      take: 1000
    });
  }
  document(id: string) {
    return this.tx.teamDocument.findFirst({
      where: { id, organizationId: this.organizationId, archivedAt: null, confirmedAt: { not: null } }
    });
  }
  createDocument(data: Omit<Prisma.TeamDocumentUncheckedCreateInput, "organizationId">) {
    return this.tx.teamDocument.create({ data: { ...data, organizationId: this.organizationId } });
  }
  archiveDocument(id: string) {
    return this.tx.teamDocument.update({
      where: { id, organizationId: this.organizationId },
      data: { archivedAt: new Date() }
    });
  }
  dueDocuments(until: Date, cursor?: string) {
    return this.tx.teamDocument.findMany({
      where: {
        organizationId: this.organizationId,
        ...(cursor ? { id: { gt: cursor } } : {}),
        archivedAt: null,
        confirmedAt: { not: null },
        expiresOn: { lte: until },
        person: { archivedAt: null }
      },
      take: 100,
      orderBy: { id: "asc" }
    });
  }
  archiveAssignment(id: string) {
    return this.tx.roleAssignment.update({
      where: { id, organizationId: this.organizationId },
      data: { archivedAt: new Date() }
    });
  }
  currency(code: string) {
    return this.tx.currency.findUnique({ where: { code } });
  }
  createCompensation(data: Omit<Prisma.TeamCompensationUncheckedCreateInput, "organizationId">) {
    return this.tx.teamCompensation.create({ data: { ...data, organizationId: this.organizationId } });
  }
  createAvailability(data: Omit<Prisma.TeamAvailabilityUncheckedCreateInput, "organizationId">) {
    return this.tx.teamAvailability.create({ data: { ...data, organizationId: this.organizationId } });
  }
  findAvailability(id: string) {
    return this.tx.teamAvailability.findFirst({ where: { id, organizationId: this.organizationId } });
  }
  decideAvailability(id: string, status: string, actorId: string) {
    return this.tx.teamAvailability.update({
      where: { id, organizationId: this.organizationId },
      data: { status, decidedBy: actorId }
    });
  }
  ledgerAccount(id: string) {
    return this.tx.ledgerAccount.findFirst({
      where: { organizationId: this.organizationId, id, archivedAt: null, accountType: "STAFF_WALLET" }
    });
  }
  linkWallet(personId: string, ledgerAccountId: string, actorId: string) {
    return this.tx.teamWallet.create({
      data: { organizationId: this.organizationId, personId, ledgerAccountId, createdBy: actorId }
    });
  }
  async archivePerson(personId: string) {
    await this.tx.roleAssignment.updateMany({
      where: { organizationId: this.organizationId, personId, archivedAt: null },
      data: { archivedAt: new Date() }
    });
    return this.tx.person.update({
      where: { id: personId, organizationId: this.organizationId },
      data: { archivedAt: new Date() }
    });
  }
  async lock(personId: string) {
    await this.tx.$queryRaw(
      Prisma.sql`SELECT id FROM person WHERE organization_id=${this.organizationId}::uuid AND id=${personId}::uuid FOR UPDATE`
    );
  }
  async person(id: string) {
    const person = await this.tx.person.findFirst({
      where: { organizationId: this.organizationId, id },
      include: {
        userAccounts: { select: { id: true, status: true } },
        roleAssignments: {
          include: { role: { include: { rolePermissions: { include: { permission: true } } } } }
        }
      }
    });
    if (!person) return null;
    const [properties, cities] = await Promise.all([
      this.tx.property.findMany({
        where: {
          organizationId: this.organizationId,
          id: {
            in: person.roleAssignments
              .filter((a) => a.scopeType === "property")
              .flatMap((a) => (a.scopeId ? [a.scopeId] : []))
          }
        },
        select: { id: true, regionId: true, cityId: true }
      }),
      this.tx.city.findMany({
        where: {
          organizationId: this.organizationId,
          id: {
            in: person.roleAssignments
              .filter((a) => a.scopeType === "city")
              .flatMap((a) => (a.scopeId ? [a.scopeId] : []))
          }
        },
        select: { id: true, regionId: true }
      })
    ]);
    return {
      ...person,
      roleAssignments: person.roleAssignments.map((a) => ({
        ...a,
        regionId:
          properties.find((p) => p.id === a.scopeId)?.regionId ??
          cities.find((c) => c.id === a.scopeId)?.regionId ??
          null,
        cityId: properties.find((p) => p.id === a.scopeId)?.cityId ?? null
      }))
    };
  }
  resource(person: { id: string }, type = "team_member"): Resource {
    return { type, id: person.id, organizationId: this.organizationId, assignedPersonId: person.id };
  }
  async visiblePeople(ctx: AuthContext, search: string, page: number) {
    // Scope the SQL query before pagination. Property/city/region grants reach only
    // people with an assignment in that scope, never the entire tenant directory.
    const grants = (
      ctx.assignments ?? ctx.scopes.map((scope) => ({ scope, permissions: ctx.permissions }))
    ).filter((a) => a.permissions.has("team_member:view"));
    const filters: Prisma.PersonWhereInput[] = [];
    const geographicIds = grants
      .filter((a) => a.scope.scopeType === "city" || a.scope.scopeType === "region")
      .flatMap((a) => (a.scope.scopeId ? [a.scope.scopeId] : []));
    const properties = geographicIds.length
      ? await this.tx.property.findMany({
          where: {
            organizationId: this.organizationId,
            OR: [{ regionId: { in: geographicIds } }, { cityId: { in: geographicIds } }]
          },
          select: { id: true, regionId: true, cityId: true }
        })
      : [];
    const cities = geographicIds.length
      ? await this.tx.city.findMany({
          where: { organizationId: this.organizationId, regionId: { in: geographicIds } },
          select: { id: true, regionId: true }
        })
      : [];
    for (const a of grants) {
      const scope = a.scope;
      if (scope.organizationId !== this.organizationId) continue;
      if ("validFrom" in a && a.validFrom && a.validFrom > new Date()) continue;
      if ("validTo" in a && a.validTo && a.validTo <= new Date()) continue;
      if ("conditions" in a && a.conditions) {
        if (
          a.conditions.statuses?.length ||
          a.conditions.maxAmount !== undefined ||
          a.conditions.timeWindow
        )
          continue;
        if (a.conditions.assignedToMe) {
          if (ctx.personId) filters.push({ id: ctx.personId });
          continue;
        }
      }
      if (
        !scope.resourceId &&
        !scope.scopeId &&
        (!scope.scopeType || scope.scopeType === "organization")
      ) {
        filters.push({});
        continue;
      }
      if (scope.resourceType === "team_member") {
        filters.push({ id: scope.resourceId });
        continue;
      }
      if (scope.scopeType && scope.scopeId)
        filters.push({
          roleAssignments: {
            some: {
              organizationId: this.organizationId,
              AND: [
                {
                  OR: [
                    { scopeType: scope.scopeType, scopeId: scope.scopeId },
                    {
                      scopeType: "property",
                      scopeId: {
                        in: properties
                          .filter((p) => p.regionId === scope.scopeId || p.cityId === scope.scopeId)
                          .map((p) => p.id)
                      }
                    },
                    {
                      scopeType: "city",
                      scopeId: {
                        in: cities.filter((c) => c.regionId === scope.scopeId).map((c) => c.id)
                      }
                    }
                  ]
                }
              ],
              archivedAt: null,
              validFrom: { lte: new Date() },
              OR: [{ validTo: null }, { validTo: { gt: new Date() } }]
            }
          }
        });
    }
    if (!filters.length) return { people: [], total: 0 };
    const where: Prisma.PersonWhereInput = {
      organizationId: this.organizationId,
      AND: [
        { OR: filters },
        ...(search ? [{ displayName: { contains: search, mode: "insensitive" as const } }] : [])
      ]
    };
    const [people, total] = await Promise.all([
      this.tx.person.findMany({
        where,
        orderBy: [{ displayName: "asc" }, { id: "asc" }],
        skip: (page - 1) * 25,
        take: 25,
        include: {
          roleAssignments: { where: { archivedAt: null }, select: { scopeType: true, scopeId: true } }
        }
      }),
      this.tx.person.count({ where })
    ]);
    return {
      people: people.filter((person) =>
        this.can(ctx, "view", {
          ...person,
          roleAssignments: person.roleAssignments.map((a) => ({
            ...a,
            regionId:
              properties.find((p) => p.id === a.scopeId)?.regionId ??
              cities.find((c) => c.id === a.scopeId)?.regionId,
            cityId: properties.find((p) => p.id === a.scopeId)?.cityId
          }))
        })
      ),
      total
    };
  }
  can(
    ctx: AuthContext,
    action: Parameters<typeof authorize>[1],
    person: {
      id: string;
      roleAssignments?: {
        scopeType: string;
        scopeId: string | null;
        regionId?: string | null;
        cityId?: string | null;
      }[];
    },
    type = "team_member"
  ) {
    const resource = this.resource(person, type);
    return (
      authorize(ctx, action, resource) ||
      (person.roleAssignments ?? []).some((a) =>
        authorize(ctx, action, {
          ...resource,
          region: a.regionId,
          city: a.cityId,
          ...(a.scopeType === "property"
            ? { propertyId: a.scopeId }
            : a.scopeType === "city"
              ? { city: a.scopeId }
              : a.scopeType === "region"
                ? { region: a.scopeId }
                : a.scopeType === "job"
                  ? { jobId: a.scopeId }
                  : {})
        })
      )
    );
  }
  async scopeExists(type: string, id: string | null) {
    if (type === "organization") return id === null;
    const where = { id: id ?? "", organizationId: this.organizationId, archivedAt: null };
    switch (type) {
      case "property":
        return Boolean(await this.tx.property.findFirst({ where, select: { id: true } }));
      case "region":
        return Boolean(await this.tx.region.findFirst({ where, select: { id: true } }));
      case "city":
        return Boolean(await this.tx.city.findFirst({ where, select: { id: true } }));
      case "job":
        return Boolean(await this.tx.operationTask.findFirst({ where, select: { id: true } }));
      default:
        return false;
    }
  }
  assignmentPerson(id:string){
    return this.tx.person.findFirst({where:{id,organizationId:this.organizationId},select:{id:true,archivedAt:true,userAccounts:{where:{organizationId:this.organizationId},select:{id:true,status:true}},roleAssignments:{where:{organizationId:this.organizationId},select:{roleId:true,scopeType:true,scopeId:true,validFrom:true,validTo:true,archivedAt:true}}}});
  }
  async assignmentScope(type:string,id:string|null):Promise<Pick<Resource,"propertyId"|"city"|"region"|"jobId">|null>{
    if(type==="organization")return id===null?{}:null;
    if(!id)return null;const where={id,organizationId:this.organizationId,archivedAt:null};
    if(type==="region")return await this.tx.region.findFirst({where,select:{id:true}})?{region:id}:null;
    if(type==="city"){const city=await this.tx.city.findFirst({where,select:{id:true,regionId:true}});return city?{city:city.id,region:city.regionId}:null;}
    const task=type==="job"?await this.tx.operationTask.findFirst({where,select:{id:true,propertyId:true}}):null;
    if(type!=="property"&&!task)return null;
    const property=await this.tx.property.findFirst({where:{id:task?.propertyId??id,organizationId:this.organizationId,archivedAt:null},select:{id:true,cityId:true,regionId:true}});
    return property?{propertyId:property.id,city:property.cityId,region:property.regionId,...task?{jobId:task.id}:{}}:null;
  }
  assignment(id: string) {
    return this.tx.roleAssignment.findFirst({
      where: { id, organizationId: this.organizationId },
      include: { person: true }
    });
  }
  compensation(assignmentId: string) {
    return this.tx.teamCompensation.findMany({
      where: { organizationId: this.organizationId, assignmentId },
      orderBy: { version: "desc" }
    });
  }
  availability(personId: string) {
    return this.tx.teamAvailability.findMany({
      where: { organizationId: this.organizationId, personId },
      orderBy: [{ startsOn: "desc" }, { id: "desc" }],
      take: 100
    });
  }
  async tasks(personId: string, from: Date, until: Date, ctx: AuthContext) {
    const accounts = await this.tx.userAccount.findMany({
      where: { organizationId: this.organizationId, personId },
      select: { id: true }
    });
    const grants =
      ctx.assignments ?? ctx.scopes.map((scope) => ({ scope, permissions: ctx.permissions }));
    const filters: Prisma.OperationTaskWhereInput[] = [];
    for (const grant of grants) {
      if (!grant.permissions.has("task:view")) continue;
      const type = grant.scope.scopeType ?? grant.scope.resourceType ?? "organization",
        id = grant.scope.scopeId ?? grant.scope.resourceId;
      const conditions = "conditions" in grant ? grant.conditions : undefined;
      const candidate: Resource = {
        type: "task",
        organizationId: this.organizationId,
        assignedPersonId: personId,
        assignedUserAccountId: accounts.find((a) => a.id === ctx.userAccountId)?.id ?? accounts[0]?.id,
        status: conditions?.statuses?.[0],
        ...(type === "property"
          ? { propertyId: id }
          : type === "city"
            ? { city: id }
            : type === "region"
              ? { region: id }
              : type === "job" || type === "task"
                ? { id, jobId: id }
                : type === "reservation"
                  ? { reservationId: id }
                  : {})
      };
      if (
        !authorize({ ...ctx, assignments: [grant], permissions: grant.permissions }, "view", candidate)
      )
        continue;
      const scope: Prisma.OperationTaskWhereInput | null =
        !id || type === "organization"
          ? {}
          : type === "property"
            ? { propertyId: id }
            : type === "region"
              ? { property: { regionId: id } }
              : type === "city"
                ? { property: { cityId: id } }
                : type === "job" || type === "task"
                  ? { id }
                  : type === "reservation"
                    ? { reservationId: id }
                    : null;
      if (scope)
        filters.push({
          AND: [
            scope,
            ...(conditions?.statuses?.length ? [{ state: { in: [...conditions.statuses] } }] : []),
            ...(conditions?.assignedToMe
              ? [
                  {
                    OR: [
                      { assignedToPersonId: ctx.personId ?? "00000000-0000-4000-8000-000000000000" },
                      {
                        assignedToUserAccountId:
                          ctx.userAccountId ?? "00000000-0000-4000-8000-000000000000"
                      }
                    ]
                  }
                ]
              : [])
          ]
        });
    }
    if (!filters.length) return [];
    return this.tx.operationTask.findMany({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        dueDate: { gte: from, lt: until },
        AND: [{ OR: filters }],
        OR: [
          { assignedToPersonId: personId },
          { assignedToUserAccountId: { in: accounts.map((a) => a.id) } }
        ]
      },
      include: { property: { select: { name: true, timezone: true, cityId: true, regionId: true } } },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: 501
    });
  }
  documents(personId: string) {
    return this.tx.teamDocument.findMany({
      where: {
        organizationId: this.organizationId,
        personId,
        archivedAt: null,
        confirmedAt: { not: null }
      },
      orderBy: { createdAt: "desc" },
      take: 100
    });
  }
  async wallet(personId: string) {
    const link = await this.tx.teamWallet.findFirst({
      where: { organizationId: this.organizationId, personId },
      include: { ledgerAccount: true }
    });
    if (!link) return null;
    const totals = await this.tx.posting.groupBy({
      by: ["currency", "side"],
      where: { organizationId: this.organizationId, ledgerAccountId: link.ledgerAccountId },
      _sum: { amount: true }
    });
    const balances = new Map<string, Money>();
    for (const row of totals) {
      const value = Money.of(row._sum.amount?.toString() ?? "0", row.currency);
      const current = balances.get(row.currency) ?? Money.zero(row.currency);
      balances.set(
        row.currency,
        row.side === link.ledgerAccount.normalSide ? current.add(value) : current.subtract(value)
      );
    }
    return {
      id: link.id,
      ledgerAccountId: link.ledgerAccountId,
      balances: [...balances.values()].map((v) => v.toJSON())
    };
  }
  walletMovements(ledgerAccountId: string, page: number) {
    return this.tx.posting.findMany({
      where: { organizationId: this.organizationId, ledgerAccountId },
      include: { transaction: { select: { reference: true, description: true, occurredAt: true } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 26,
      skip: (page - 1) * 25
    });
  }
  walletLink(personId: string) {
    return this.tx.teamWallet.findFirst({
      where: { organizationId: this.organizationId, personId },
      select: { id: true }
    });
  }
  async offboarding(personId: string) {
    const [wallet, person] = await Promise.all([this.wallet(personId), this.person(personId)]);
    const accounts = person?.userAccounts.map((a) => a.id) ?? [];
    const openTasks = await this.tx.operationTask.count({
      where: {
        organizationId: this.organizationId,
        archivedAt: null,
        state: { notIn: ["COMPLETED", "CANCELLED"] },
        OR: [{ assignedToPersonId: personId }, { assignedToUserAccountId: { in: accounts } }]
      }
    });
    return {
      openTasks,
      wallet,
      walletClear: !wallet?.balances.some(
        (b) => !Money.of(b.amount, b.currency).equals(Money.zero(b.currency))
      )
    };
  }
}
