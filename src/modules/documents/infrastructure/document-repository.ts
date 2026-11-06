import { Prisma } from "@prisma/client";
import type { Resource } from "@/platform/authz/authorize";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { financialAttachmentAuthorityChecks } from "@/platform/authz/financial-attachment-resource";
import { FinancialAttachmentSourceRepository } from "@/platform/ledger/financial-attachment-source-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import type { documentSourceReferenceSchema } from "../domain/document-command";
import type { z } from "zod";
import type { signatureRecipientReferenceSchema } from "../domain/document-signature-command";

type Source = z.infer<typeof documentSourceReferenceSchema>;
export type DocumentSourceFacts = { reference: Source; resource: Resource; checks: CurrentAuthorityCheck[]; fingerprint: string; snapshot: unknown; archived: boolean; label: string };
const versionInclude = { admission: true, next: { select: { id: true } } } as const;
const signatureInclude = { recipients: { orderBy: { id: "asc" } }, events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } } satisfies Prisma.SignatureInclude;
const rootInclude = { template: true, instances: { orderBy: [{createdAt:"desc"},{id:"desc"}], take:1 } } satisfies Prisma.DocumentInclude;
type RootRow=Prisma.DocumentGetPayload<{include:typeof rootInclude}>;
const rootView=(row:RootRow)=>{const{instances,...root}=row;return{...root,instance:instances[0]??null};};

export class DocumentRepository extends FinancialAttachmentSourceRepository {
  async clock() { const [row] = await this.tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`; return row.now; }
  async lock(key: string) { await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":documents:" + key},0))::text`); }
  async documentSource(reference: Source, action: "view" | "export" = "view"): Promise<DocumentSourceFacts | null> {
    const base = { organizationId: this.organizationId }, checks: CurrentAuthorityCheck[] = [];
    let resource: Resource, snapshot: unknown, label: string, archived = false;
    if (reference.kind === "FINANCIAL_TRANSACTION") {
      const native = await super.source(reference.id); if (!native) return null;
      const inherited = financialAttachmentAuthorityChecks(native.source, action); if (!inherited) return null;
      checks.push(...inherited.filter(check => check.resource.type !== "financial_attachment"), ...native.extraChecks);
      resource = native.source; snapshot = { reference, identity: native.identity }; label = native.transaction.reference;
    } else if (reference.kind === "PROPERTY") {
      const row = await this.tx.property.findFirst({ where: { ...base, id: reference.id }, select: { id: true, name: true, cityId: true, regionId: true, archivedAt: true, status: true } }); if (!row) return null;
      const { name, ...facts } = row; label = name;
      archived = Boolean(row.archivedAt); resource = { ...base, type: "property", id: row.id, propertyId: row.id, city: row.cityId, region: row.regionId, status: row.status, dataClass: "operational" }; snapshot = facts;
    } else if (reference.kind === "RESERVATION") {
      const row = await this.tx.reservation.findFirst({ where: { ...base, id: reference.id }, select: { id: true, reference: true, status: true, archivedAt: true, version: true, property: { select: { id: true, cityId: true, regionId: true, archivedAt: true } } } }); if (!row) return null;
      archived = Boolean(row.archivedAt || row.property.archivedAt); resource = { ...base, type: "reservation", id: row.id, reservationId: row.id, propertyId: row.property.id, city: row.property.cityId, region: row.property.regionId, status: row.status, dataClass: "operational" };
      const { reference: name, ...facts } = row; label = name;
      checks.push({ action: "view", resource: { ...resource, type: "property", id: row.property.id } }); snapshot = facts;
    } else if (reference.kind === "OWNER") {
      const row = await this.tx.owner.findFirst({ where: { ...base, id: reference.id }, select: { id: true, displayName: true, archivedAt: true, updatedAt: true } }); if (!row) return null;
      const { displayName, ...facts } = row; label = displayName;
      archived = Boolean(row.archivedAt); resource = { ...base, type: "owner", id: row.id, ownerId: row.id, dataClass: "personal" }; snapshot = facts;
    } else if (reference.kind === "PERSON") {
      const row = await this.tx.person.findFirst({ where: { ...base, id: reference.id }, select: { id: true, displayName: true, archivedAt: true, updatedAt: true } }); if (!row) return null;
      const { displayName, ...facts } = row; label = displayName;
      archived = Boolean(row.archivedAt); resource = { ...base, type: "team_member", id: row.id, assignedPersonId: row.id, dataClass: "personal" };
      checks.push({ action: "view", resource: { ...resource, type: "staff_document", dataClass: "sensitive" } }); snapshot = facts;
    } else {
      if (reference.id !== this.organizationId) return null;
      const row = await this.tx.organization.findFirst({ where: { id: this.organizationId }, select: { id: true, name: true } }); if (!row) return null;
      label = row.name; resource = { ...base, type: "organization", id: row.id, dataClass: "operational" }; snapshot = { id: row.id };
    }
    if (reference.kind !== "FINANCIAL_TRANSACTION") {
      checks.push({ action: "view", resource, organizationOnly: reference.kind === "ORGANIZATION" || reference.kind === "PERSON" });
      if (action === "export") checks.push({ action, resource, organizationOnly: reference.kind === "ORGANIZATION" || reference.kind === "PERSON" });
    }
    return { reference, resource, checks, archived, snapshot, label, fingerprint: commandFingerprint({ reference, resource, snapshot, checks }) };
  }
  async document(id: string,instanceId?:string) { const row=await this.tx.document.findFirst({ where: { organizationId: this.organizationId, id }, include: instanceId?{...rootInclude,instances:{where:{id:instanceId},take:1}}:rootInclude });return row?rootView(row):null; }
  version(id: string) { return this.tx.documentVersion.findFirst({ where: { organizationId: this.organizationId, id }, include: versionInclude }); }
  latest(documentId: string) { return this.tx.documentVersion.findFirst({ where: { organizationId: this.organizationId, documentId }, orderBy: { number: "desc" }, include: versionInclude }); }
  effectiveVersion(documentId:string,at:Date){return this.tx.documentVersion.findFirst({where:{organizationId:this.organizationId,documentId,createdAt:{lte:at},OR:[{effectiveFrom:null},{effectiveFrom:{lte:at}}]},orderBy:{number:"desc"},select:{id:true,number:true,effectiveFrom:true,createdAt:true}});}
  admission(id: string) { return this.tx.documentAdmission.findFirst({ where: { organizationId: this.organizationId, id }, include: { version: { include: versionInclude } } }); }
  byNonce(createdBy: string, commandKey: string) { return this.tx.documentAdmission.findFirst({ where: { organizationId: this.organizationId, createdBy, commandKey }, include: { version: { include: versionInclude } } }); }
  nonceOwner(commandKey: string) { return this.tx.documentAdmission.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { createdBy: true } }); }
  async appendDocument(data: Omit<Prisma.DocumentUncheckedCreateInput, "organizationId">) { return rootView(await this.tx.document.create({ data: { ...data, organizationId: this.organizationId }, include: rootInclude })); }
  appendAdmission(data: Omit<Prisma.DocumentAdmissionUncheckedCreateInput, "organizationId">) { return this.tx.documentAdmission.create({ data: { ...data, organizationId: this.organizationId } }); }
  appendVersion(data: Omit<Prisma.DocumentVersionUncheckedCreateInput, "organizationId">) { return this.tx.documentVersion.create({ data: { ...data, organizationId: this.organizationId }, include: versionInclude }); }
  appendTemplate(data: Omit<Prisma.DocumentTemplateUncheckedCreateInput, "organizationId">) { return this.tx.documentTemplate.create({ data: { ...data, organizationId: this.organizationId } }); }
  appendInstance(data: Omit<Prisma.DocumentInstanceUncheckedCreateInput, "organizationId">) { return this.tx.documentInstance.create({ data: { ...data, organizationId: this.organizationId } }); }
  async instance(id: string) { const row=await this.tx.documentInstance.findFirst({ where: { organizationId: this.organizationId, id } });if(!row)return null;const document=await this.document(row.documentId,row.id);return document?{...row,document}:null; }
  async instanceByNonce(createdBy: string, commandKey: string) { const row=await this.tx.documentInstance.findFirst({ where: { organizationId: this.organizationId, createdBy, commandKey } });if(!row)return null;const document=await this.document(row.documentId,row.id);return document?{...row,document}:null; }
  instanceNonceOwner(commandKey: string) { return this.tx.documentInstance.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { createdBy: true } }); }
  signature(id: string) { return this.tx.signature.findFirst({ where: { organizationId: this.organizationId, id }, include: signatureInclude }); }
  signatureByNonce(requestedBy: string, commandKey: string) { return this.tx.signature.findFirst({ where: { organizationId: this.organizationId, requestedBy, commandKey }, include: signatureInclude }); }
  signatureNonceOwner(commandKey: string) { return this.tx.signature.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { requestedBy: true } }); }
  appendSignature(data: Omit<Prisma.SignatureUncheckedCreateInput, "organizationId">) { return this.tx.signature.create({ data: { ...data, organizationId: this.organizationId } }); }
  appendSignatureRecipient(data: Omit<Prisma.SignatureRecipientUncheckedCreateInput, "organizationId">) { return this.tx.signatureRecipient.create({ data: { ...data, organizationId: this.organizationId } }); }
  appendSignatureEvent(data: Omit<Prisma.SignatureEventUncheckedCreateInput, "organizationId">) { return this.tx.signatureEvent.create({ data: { ...data, organizationId: this.organizationId } }); }
  async versionMatchesInstance(versionId: string, instanceId: string) { const [row] = await this.tx.$queryRaw<Array<{ matches: boolean }>>`SELECT app_document_version_matches_instance(${this.organizationId}::uuid,${versionId}::uuid,${instanceId}::uuid) AS matches`; return row?.matches === true; }
  async signatureRecipientSource(reference: z.infer<typeof signatureRecipientReferenceSchema>) {
    const where = { organizationId: this.organizationId, id: reference.id }, select = { id: true, displayName: true, email: true, archivedAt: true, updatedAt: true } as const;
    const row = reference.kind === "PERSON" ? await this.tx.person.findFirst({ where, select }) : reference.kind === "OWNER" ? await this.tx.owner.findFirst({ where, select }) :
      reference.kind === "SUPPLIER" ? await this.tx.supplier.findFirst({ where, select }) : await this.tx.guestRecord.findFirst({ where, select: { ...select, mergedIntoId: true } });
    if (!row) return null; const type = reference.kind === "PERSON" ? "team_member" : reference.kind.toLowerCase(), resource: Resource = { organizationId: this.organizationId, type, id: row.id, dataClass: reference.kind === "GUEST" ? "guest" : "personal",
      ...(reference.kind === "OWNER" ? { ownerId: row.id } : {}), ...(reference.kind === "PERSON" ? { assignedPersonId: row.id } : {}) };
    const checks: CurrentAuthorityCheck[] = [{ action: "view", resource, organizationOnly: reference.kind !== "OWNER" }, { action: "export", resource, organizationOnly: reference.kind !== "OWNER" }];
    if (reference.kind === "PERSON") checks.push({ action: "view", resource: { ...resource, type: "staff_document", dataClass: "sensitive" }, organizationOnly: true }, { action: "export", resource: { ...resource, type: "staff_document", dataClass: "sensitive" }, organizationOnly: true });
    const archived = Boolean(row.archivedAt || ("mergedIntoId" in row && row.mergedIntoId)), fingerprint = commandFingerprint({ reference, row, checks });
    return { reference, displayName: row.displayName, email: row.email, archived, resource, checks, fingerprint };
  }
  signatureRecipientCandidates(kind: z.infer<typeof signatureRecipientReferenceSchema>["kind"], query: string, before?: string) {
    const where = { organizationId: this.organizationId, archivedAt: null, displayName: { contains: query, mode: "insensitive" as const }, ...(before ? { id: { lt: before } } : {}) },
      args = { where, select: { id: true }, orderBy: { id: "desc" as const }, take: 31 };
    if (kind === "PERSON") return this.tx.person.findMany(args);
    if (kind === "OWNER") return this.tx.owner.findMany(args);
    if (kind === "SUPPLIER") return this.tx.supplier.findMany(args);
    return this.tx.guestRecord.findMany({ ...args, where: { ...where, mergedIntoId: null } });
  }
  appendAction(data: Omit<Prisma.DocumentActionUncheckedCreateInput, "organizationId">) { return this.tx.documentAction.create({ data: { ...data, organizationId: this.organizationId } }); }
  async snapshot(id: string) { const [row] = await this.tx.$queryRaw<{ value: Prisma.JsonObject }[]>`SELECT to_jsonb(d) AS value FROM document d WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid`; return row?.value ?? null; }
  async protect(id: string, revision: bigint, privacy: string[]) { return rootView(await this.tx.document.update({ where: { organizationId_id: { organizationId: this.organizationId, id }, revision }, data: { privacy, revision: { increment: 1 } }, include: rootInclude })); }
  async roots(source: Source, before?: string, typeKey?: string, locale?: string) { return (await this.tx.document.findMany({ where: { organizationId: this.organizationId, sourceKind: source.kind, sourceId: source.id,
    ...(before ? { id: { lt: before } } : {}), ...(typeKey ? { typeKey } : {}), ...(locale ? { locale } : {}) }, include: rootInclude, orderBy: { id: "desc" }, take: 51 })).map(rootView); }
  versions(documentId: string, before?: number) { return this.tx.documentVersion.findMany({ where: { organizationId: this.organizationId, documentId, ...(before ? { number: { lt: before } } : {}) }, include: versionInclude, orderBy: { number: "desc" }, take: 51 }); }
  async rootProtections(ids: string[]) { const rows = await this.tx.document.findMany({ where: { organizationId: this.organizationId, id: { in: ids } }, select: { id: true, privacy: true, revision: true } }); return new Map(rows.map(row => [row.id,row])); }
  async sourceCandidates(kind: Source["kind"], query: string, before?: string) {
    const where = { organizationId: this.organizationId, ...(before ? { id: { lt: before } } : {}) }, orderBy = { id: "desc" as const }, take = 31;
    if (kind === "ORGANIZATION") {
      const row = before ? null : await this.tx.organization.findFirst({ where: { id: this.organizationId, name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true } });
      return row ? [{ id: row.id, label: row.name }] : [];
    }
    if (kind === "PROPERTY") return (await this.tx.property.findMany({ where: { ...where, name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true }, orderBy, take })).map(row => ({ id: row.id, label: row.name }));
    if (kind === "OWNER") return (await this.tx.owner.findMany({ where: { ...where, displayName: { contains: query, mode: "insensitive" } }, select: { id: true, displayName: true }, orderBy, take })).map(row => ({ id: row.id, label: row.displayName }));
    if (kind === "PERSON") return (await this.tx.person.findMany({ where: { ...where, displayName: { contains: query, mode: "insensitive" } }, select: { id: true, displayName: true }, orderBy, take })).map(row => ({ id: row.id, label: row.displayName }));
    if (kind === "RESERVATION") return (await this.tx.reservation.findMany({ where: { ...where, reference: { contains: query, mode: "insensitive" } }, select: { id: true, reference: true }, orderBy, take })).map(row => ({ id: row.id, label: row.reference }));
    return (await this.tx.financialTransaction.findMany({ where: { ...where, sealed: true, reference: { contains: query, mode: "insensitive" } }, select: { id: true, reference: true }, orderBy, take })).map(row => ({ id: row.id, label: row.reference }));
  }
}
