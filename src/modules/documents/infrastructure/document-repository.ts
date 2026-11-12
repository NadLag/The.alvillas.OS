import type { ConfigScopeCandidate } from "@/platform/config/config-rule-repository";
import { Prisma } from "@prisma/client";
import type { Resource } from "@/platform/authz/authorize";
import type { CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import { financialAttachmentAuthorityChecks } from "@/platform/authz/financial-attachment-resource";
import { FinancialAttachmentSourceRepository } from "@/platform/ledger/financial-attachment-source-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { documentSourceReferenceSchema,DocumentConflictError } from "../domain/document-command";
import {nativeLeadDocumentSource,nativeLeadDocumentSources,nativeLeadDocumentLabel,nativeLeadDocumentContact} from "@/platform/documents/lead-source";
import {nativeOnboardingDocumentSource,nativeOnboardingDocumentSources,nativeOnboardingDocumentChoices,type OnboardingDocumentSourceHead} from "@/platform/documents/onboarding-source";
import type { z } from "zod";
import type { signatureRecipientReferenceSchema } from "../domain/document-signature-command";

type Source = z.infer<typeof documentSourceReferenceSchema>;
export function documentSourceRuleScopes(source:Resource):ConfigScopeCandidate[]{return[{scopeType:"organization",scopeId:null},...(source.city?[{scopeType:"city",scopeId:source.city}]:[]),...(source.ownerId?[{scopeType:"owner",scopeId:source.ownerId}]:[]),...(source.propertyId?[{scopeType:"property",scopeId:source.propertyId}]:[])];}
export type DocumentSourceFacts = { reference: Source; resource: Resource; checks: CurrentAuthorityCheck[]; fingerprint: string; snapshot: unknown; archived: boolean; label: string };
const versionInclude = { admission: true, next: { select: { id: true } } } as const;
const signatureInclude = { recipients: { orderBy: { id: "asc" } }, events: { orderBy: [{ occurredAt: "asc" }, { id: "asc" }] } } satisfies Prisma.SignatureInclude;
const rootInclude = { template: true, instances: { orderBy: [{createdAt:"desc"},{id:"desc"}], take:1 } } satisfies Prisma.DocumentInclude;
type RootRow=Prisma.DocumentGetPayload<{include:typeof rootInclude}>;
const rootView=(row:RootRow):Omit<RootRow,"instances">&{instance:RootRow["instances"][number]|null}=>{const{instances,...root}=row;return{...root,instance:instances[0]??null};};

const documentPropertyReadSelect={ id: true, name: true, cityId: true, regionId: true, archivedAt: true, status: true } as const;
const documentReservationReadSelect={ id: true, reference: true, status: true, archivedAt: true, version: true, property: { select: { id: true, cityId: true, regionId: true, archivedAt: true } } } as const;
const documentOwnerReadSelect={ id: true, displayName: true, archivedAt: true, updatedAt: true } as const;
const documentPersonReadSelect={ id: true, displayName: true, archivedAt: true, updatedAt: true } as const;
const documentSupplierReadSelect={ id: true, displayName: true, reference: true, archivedAt: true, version: true } as const;
const documentGuestRecordReadSelect={ id: true, displayName: true, archivedAt: true, mergedIntoId: true, updatedAt: true } as const;
const documentOrganizationReadSelect={ id: true, name: true } as const;

export class DocumentRepository extends FinancialAttachmentSourceRepository {
  private documentOnboardingReads?:Map<string,OnboardingDocumentSourceHead|null>;
  private async documentReadOnboarding(id:string){if(this.documentOnboardingReads?.has(id))return this.documentOnboardingReads.get(id)??null;const row=(await nativeOnboardingDocumentSources(this.tx,this.organizationId,[id])).get(id)??null;(this.documentOnboardingReads??=new Map()).set(id,row);return row;}
  private documentLeadReads?:Map<string,Awaited<ReturnType<typeof nativeLeadDocumentSource>>>;
  private async documentReadLead(id:string){if(this.documentLeadReads?.has(id))return this.documentLeadReads.get(id)??null;const native=await nativeLeadDocumentSource(this.tx,this.organizationId,id);(this.documentLeadReads??=new Map()).set(id,native);return native;}
  /** Reveal a human label only after the caller checks the corresponding captured source. */
  documentSourceLabel(native:DocumentSourceFacts,env?:NodeJS.ProcessEnv){
    if(native.reference.kind!=="LEAD")return native.label;const lead=this.documentLeadReads?.get(native.reference.id);
    if(!lead||commandFingerprint(lead.snapshot)!==commandFingerprint(native.snapshot))throw new DocumentConflictError();return nativeLeadDocumentLabel(lead,env);
  }
  private documentSourceReads?:Map<string,DocumentSourceFacts|null>;
  private documentPropertyReads?:Map<string,Prisma.PropertyGetPayload<{select:typeof documentPropertyReadSelect}>|null>;
  private async documentReadProperty(id:string){if(this.documentPropertyReads?.has(id))return this.documentPropertyReads.get(id)??null;return this.tx.property.findFirst({where:{organizationId:this.organizationId,id},select:documentPropertyReadSelect});}
  private documentReservationReads?:Map<string,Prisma.ReservationGetPayload<{select:typeof documentReservationReadSelect}>|null>;
  private async documentReadReservation(id:string){if(this.documentReservationReads?.has(id))return this.documentReservationReads.get(id)??null;return this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id},select:documentReservationReadSelect});}
  private documentOwnerReads?:Map<string,Prisma.OwnerGetPayload<{select:typeof documentOwnerReadSelect}>|null>;
  private async documentReadOwner(id:string){if(this.documentOwnerReads?.has(id))return this.documentOwnerReads.get(id)??null;return this.tx.owner.findFirst({where:{organizationId:this.organizationId,id},select:documentOwnerReadSelect});}
  private documentPersonReads?:Map<string,Prisma.PersonGetPayload<{select:typeof documentPersonReadSelect}>|null>;
  private async documentReadPerson(id:string){if(this.documentPersonReads?.has(id))return this.documentPersonReads.get(id)??null;return this.tx.person.findFirst({where:{organizationId:this.organizationId,id},select:documentPersonReadSelect});}
  private documentSupplierReads?:Map<string,Prisma.SupplierGetPayload<{select:typeof documentSupplierReadSelect}>|null>;
  private async documentReadSupplier(id:string){if(this.documentSupplierReads?.has(id))return this.documentSupplierReads.get(id)??null;return this.tx.supplier.findFirst({where:{organizationId:this.organizationId,id},select:documentSupplierReadSelect});}
  private documentGuestRecordReads?:Map<string,Prisma.GuestRecordGetPayload<{select:typeof documentGuestRecordReadSelect}>|null>;
  private async documentReadGuestRecord(id:string){if(this.documentGuestRecordReads?.has(id))return this.documentGuestRecordReads.get(id)??null;return this.tx.guestRecord.findFirst({where:{organizationId:this.organizationId,id},select:documentGuestRecordReadSelect});}
  private documentOrganizationReads?:Map<string,Prisma.OrganizationGetPayload<{select:typeof documentOrganizationReadSelect}>|null>;
  private async documentReadOrganization(id:string){if(this.documentOrganizationReads?.has(id))return this.documentOrganizationReads.get(id)??null;return this.tx.organization.findFirst({where:{id},select:documentOrganizationReadSelect});}
  /** Materialize one bounded view snapshot using the same source checks and fingerprints. */
  async prepareDocumentSources(references:readonly Source[]){
    const unique=[...new Map(references.map(ref=>[ref.kind+":"+ref.id,ref])).values()];if(unique.length>100)throw Error("Bounded native document source read required");this.documentSourceReads=new Map();
    {const ids=unique.filter(ref=>ref.kind==="ONBOARDING").map(ref=>ref.id),rows=ids.length?await nativeOnboardingDocumentSources(this.tx,this.organizationId,ids):new Map<string,OnboardingDocumentSourceHead>();this.documentOnboardingReads=new Map(ids.map(id=>[id,rows.get(id)??null]));}
    {const ids=unique.filter(ref=>ref.kind==="PROPERTY").map(ref=>ref.id);this.documentPropertyReads=undefined;if(ids.length){const rows=await this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:documentPropertyReadSelect}),byId=new Map(rows.map(row=>[row.id,row]));this.documentPropertyReads=new Map(ids.map(id=>[id,byId.get(id)??null]));}}
    {const ids=unique.filter(ref=>ref.kind==="RESERVATION").map(ref=>ref.id);this.documentReservationReads=undefined;if(ids.length){const rows=await this.tx.reservation.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:documentReservationReadSelect}),byId=new Map(rows.map(row=>[row.id,row]));this.documentReservationReads=new Map(ids.map(id=>[id,byId.get(id)??null]));}}
    {const ids=unique.filter(ref=>ref.kind==="OWNER").map(ref=>ref.id);this.documentOwnerReads=undefined;if(ids.length){const rows=await this.tx.owner.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:documentOwnerReadSelect}),byId=new Map(rows.map(row=>[row.id,row]));this.documentOwnerReads=new Map(ids.map(id=>[id,byId.get(id)??null]));}}
    {const ids=unique.filter(ref=>ref.kind==="PERSON").map(ref=>ref.id);this.documentPersonReads=undefined;if(ids.length){const rows=await this.tx.person.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:documentPersonReadSelect}),byId=new Map(rows.map(row=>[row.id,row]));this.documentPersonReads=new Map(ids.map(id=>[id,byId.get(id)??null]));}}
    {const ids=unique.filter(ref=>ref.kind==="SUPPLIER").map(ref=>ref.id);this.documentSupplierReads=undefined;if(ids.length){const rows=await this.tx.supplier.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:documentSupplierReadSelect}),byId=new Map(rows.map(row=>[row.id,row]));this.documentSupplierReads=new Map(ids.map(id=>[id,byId.get(id)??null]));}}
    {const ids=unique.filter(ref=>ref.kind==="GUEST").map(ref=>ref.id);this.documentGuestRecordReads=undefined;if(ids.length){const rows=await this.tx.guestRecord.findMany({where:{organizationId:this.organizationId,id:{in:ids}},select:documentGuestRecordReadSelect}),byId=new Map(rows.map(row=>[row.id,row]));this.documentGuestRecordReads=new Map(ids.map(id=>[id,byId.get(id)??null]));}}
    {const ids=unique.filter(ref=>ref.kind==="ORGANIZATION").map(ref=>ref.id);this.documentOrganizationReads=undefined;if(ids.length){const rows=await this.tx.organization.findMany({where:{id:{in:ids.filter(id=>id===this.organizationId)}},select:documentOrganizationReadSelect}),byId=new Map(rows.map(row=>[row.id,row]));this.documentOrganizationReads=new Map(ids.map(id=>[id,byId.get(id)??null]));}}
    this.documentLeadReads=await nativeLeadDocumentSources(this.tx,this.organizationId,unique.filter(reference=>reference.kind==="LEAD").map(reference=>reference.id));
    await this.prepareFinancialAttachmentSources(unique.filter(reference=>reference.kind==="FINANCIAL_TRANSACTION").map(reference=>reference.id));
    for(const reference of unique){const native=await this.documentSource(reference);this.documentSourceReads.set(reference.kind+":"+reference.id,native);}
  }

  async clock() { const [row] = await this.tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`; return row.now; }
  async lock(key: string) { await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId + ":documents:" + key},0))::text`); }
  async documentSource(reference: Source, action: "view" | "export" = "view"): Promise<DocumentSourceFacts | null> {
    const readKey=reference.kind+":"+reference.id;if(action==="view"&&this.documentSourceReads?.has(readKey))return this.documentSourceReads.get(readKey)??null;
    const base = { organizationId: this.organizationId }, checks: CurrentAuthorityCheck[] = [];
    let resource: Resource, snapshot: unknown, label: string, archived = false;
    if(reference.kind==="ONBOARDING"){
      const head=await this.documentReadOnboarding(reference.id);if(!head)return null;const native=nativeOnboardingDocumentSource(head);resource=native.resource;snapshot=native.snapshot;label=native.label;archived=native.archived;checks.push(...native.checks);
    } else if(reference.kind==="LEAD"){
      const native=await this.documentReadLead(reference.id);if(!native)return null;
      resource=native.resource;snapshot=native.snapshot;label=native.label;archived=native.archived;
    } else if (reference.kind === "FINANCIAL_TRANSACTION") {
      const native = await super.source(reference.id); if (!native) return null;
      const inherited = financialAttachmentAuthorityChecks(native.source, action); if (!inherited) return null;
      checks.push(...inherited.filter(check => check.resource.type !== "financial_attachment"), ...native.extraChecks);
      resource = native.source; snapshot = { reference, identity: native.identity }; label = native.transaction.reference;
    } else if (reference.kind === "PROPERTY") {
      const row = await this.documentReadProperty(reference.id); if (!row) return null;
      const { name, ...facts } = row; label = name;
      archived = Boolean(row.archivedAt); resource = { ...base, type: "property", id: row.id, propertyId: row.id, city: row.cityId, region: row.regionId, status: row.status, dataClass: "operational" }; snapshot = facts;
    } else if (reference.kind === "RESERVATION") {
      const row = await this.documentReadReservation(reference.id); if (!row) return null;
      archived = Boolean(row.archivedAt || row.property.archivedAt); resource = { ...base, type: "reservation", id: row.id, reservationId: row.id, propertyId: row.property.id, city: row.property.cityId, region: row.property.regionId, status: row.status, dataClass: "operational" };
      const { reference: name, ...facts } = row; label = name;
      checks.push({ action: "view", resource: { ...resource, type: "property", id: row.property.id } }); snapshot = facts;
    } else if (reference.kind === "OWNER") {
      const row = await this.documentReadOwner(reference.id); if (!row) return null;
      const { displayName, ...facts } = row; label = displayName;
      archived = Boolean(row.archivedAt); resource = { ...base, type: "owner", id: row.id, ownerId: row.id, dataClass: "personal" }; snapshot = facts;
    } else if (reference.kind === "PERSON") {
      const row = await this.documentReadPerson(reference.id); if (!row) return null;
      const { displayName, ...facts } = row; label = displayName;
      archived = Boolean(row.archivedAt); resource = { ...base, type: "team_member", id: row.id, assignedPersonId: row.id, dataClass: "personal" };
      checks.push({ action: "view", resource: { ...resource, type: "staff_document", dataClass: "sensitive" } }); snapshot = facts;
    } else if (reference.kind === "SUPPLIER") {
      const row = await this.documentReadSupplier(reference.id); if (!row) return null;
      const { displayName, ...facts } = row; label = displayName; archived = Boolean(row.archivedAt);
      resource = { ...base, type: "supplier", id: row.id, dataClass: "personal" }; snapshot = facts;
    } else if (reference.kind === "GUEST") {
      const row = await this.documentReadGuestRecord(reference.id); if (!row) return null;
      const { displayName, ...facts } = row; label = displayName ?? row.id; archived = Boolean(row.archivedAt || row.mergedIntoId);
      resource = { ...base, type: "guest", id: row.id, dataClass: "guest" }; snapshot = facts;
    } else {
      if (reference.id !== this.organizationId) return null;
      const row = await this.documentReadOrganization(reference.id); if (!row) return null;
      label = row.name; resource = { ...base, type: "organization", id: row.id, dataClass: "operational" }; snapshot = { id: row.id };
    }
    if (reference.kind !== "FINANCIAL_TRANSACTION") {
      const organizationOnly = ["ORGANIZATION", "PERSON", "SUPPLIER", "GUEST"].includes(reference.kind);
      checks.push({ action: "view", resource, organizationOnly });
      if (action === "export") checks.push({ action, resource, organizationOnly });
    }
    return { reference, resource, checks, archived, snapshot, label, fingerprint: commandFingerprint({ reference, resource, snapshot, checks }) };
  }
  async document(id: string,instanceId?:string) { const row=await this.tx.document.findFirst({ where: { organizationId: this.organizationId, id }, include: instanceId?{...rootInclude,instances:{where:{id:instanceId},take:1}}:rootInclude });return row?rootView(row):null; }
  version(id: string) { return this.tx.documentVersion.findFirst({ where: { organizationId: this.organizationId, id }, include: versionInclude }); }
  originalVersionMetadata(id:string){return this.tx.documentVersion.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,documentId:true,admissionId:true,cipherSha256:true,admission:{select:{contentType:true,fileSize:true,sha256:true}}}});}
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
  signatureRecord(id: string) { return this.tx.signature.findFirst({ where: { organizationId: this.organizationId, id }, include: { recipients: { orderBy: { id: "asc" } } } }); }
  signaturesForVersion(documentVersionId: string, before?: string) { return this.tx.signature.findMany({ where: { organizationId: this.organizationId, documentVersionId, ...(before ? { id: { lt: before } } : {}) }, select: { id: true }, orderBy: { id: "desc" }, take: 31 }); }
  async signatureEvents(signatureId: string, before?: string) {
    const anchor = before ? await this.tx.signatureEvent.findFirst({ where: { organizationId: this.organizationId, signatureId, id: before }, select: { id: true, occurredAt: true } }) : null; if (before && !anchor) return null;
    return this.tx.signatureEvent.findMany({ where: { organizationId: this.organizationId, signatureId, ...(anchor ? { OR: [{ occurredAt: { lt: anchor.occurredAt } }, { occurredAt: anchor.occurredAt, id: { lt: anchor.id } }] } : {}) }, orderBy: [{ occurredAt: "desc" }, { id: "desc" }], take: 51 });
  }
  async latestSignatureEvent(signatureId: string) {
    // Delivery order cannot regress a verified lifecycle. Completion still needs
    // its native signed archive; a provider completion receipt has no SIGNED row.
    const rows = await this.tx.$queryRaw<Array<{ state: string }>>`SELECT state FROM signature_event WHERE organization_id=${this.organizationId}::uuid AND signature_id=${signatureId}::uuid
      ORDER BY CASE state WHEN 'SIGNED' THEN 4 WHEN 'DECLINED' THEN 3 WHEN 'EXPIRED' THEN 3 WHEN 'VIEWED' THEN 2 WHEN 'SENT' THEN 1 ELSE 0 END DESC,occurred_at DESC,observed_at DESC,id DESC LIMIT 1`; return rows[0] ?? null;
  }
  signatureByNonce(requestedBy: string, commandKey: string) { return this.tx.signature.findFirst({ where: { organizationId: this.organizationId, requestedBy, commandKey }, include: signatureInclude }); }
  signatureNonceOwner(commandKey: string) { return this.tx.signature.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { requestedBy: true } }); }
  async providerPreparationByNonce(requestedBy: string, commandKey: string) { return await this.tx.signatureProviderIntent.findFirst({ where: { organizationId: this.organizationId, requestedBy, commandKey }, select: { id: true } }) ?? await this.tx.signatureProviderIdentityRecovery.findFirst({ where: { organizationId: this.organizationId, requestedBy, commandKey }, select: { id: true } }) ?? await this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, actorId: requestedBy, commandKey, action: "SIGNED_ARCHIVE_RECONCILED" }, select: { id: true } }) ?? await this.tx.documentExpiryRevision.findFirst({where:{organizationId:this.organizationId,createdBy:requestedBy,commandKey},select:{id:true}}) ?? this.tx.documentRetentionRevision.findFirst({where:{organizationId:this.organizationId,createdBy:requestedBy,commandKey},select:{id:true}}); }
  async providerPreparationNonceOwner(commandKey: string) { const original = await this.tx.signatureProviderIntent.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { requestedBy: true } }) ?? await this.tx.signatureProviderIdentityRecovery.findFirst({ where: { organizationId: this.organizationId, commandKey }, select: { requestedBy: true } }); if (original) return original; const manual = await this.tx.documentAction.findFirst({ where: { organizationId: this.organizationId, commandKey, action: "SIGNED_ARCHIVE_RECONCILED" }, select: { actorId: true } }); if(manual?.actorId)return{requestedBy:manual.actorId};const expiry=await this.tx.documentExpiryRevision.findFirst({where:{organizationId:this.organizationId,commandKey},select:{createdBy:true}});if(expiry)return{requestedBy:expiry.createdBy};const retention=await this.tx.documentRetentionRevision.findFirst({where:{organizationId:this.organizationId,commandKey},select:{createdBy:true}});return retention?{requestedBy:retention.createdBy}:null; }
  appendSignature(data: Omit<Prisma.SignatureUncheckedCreateInput, "organizationId">) { return this.tx.signature.create({ data: { ...data, organizationId: this.organizationId } }); }
  appendSignatureRecipient(data: Omit<Prisma.SignatureRecipientUncheckedCreateInput, "organizationId">) { return this.tx.signatureRecipient.create({ data: { ...data, organizationId: this.organizationId } }); }
  appendSignatureEvent(data: Omit<Prisma.SignatureEventUncheckedCreateInput, "organizationId">) { return this.tx.signatureEvent.create({ data: { ...data, organizationId: this.organizationId } }); }
  async versionMatchesInstance(versionId: string, instanceId: string) { const [row] = await this.tx.$queryRaw<Array<{ matches: boolean }>>`SELECT app_document_version_matches_instance(${this.organizationId}::uuid,${versionId}::uuid,${instanceId}::uuid) AS matches`; return row?.matches === true; }
  async signatureRecipientSource(reference: z.infer<typeof signatureRecipientReferenceSchema>) {
    if(reference.kind==="LEAD"){
      const native=await this.documentReadLead(reference.id);if(!native)return null;const resource=native.resource,checks:CurrentAuthorityCheck[]=[{action:"view",resource},{action:"export",resource}];
      return{reference,displayName:null,email:null,archived:native.archived,resource,checks,fingerprint:commandFingerprint({reference,snapshot:native.snapshot,checks})};
    }
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
  /** Only the signature boundary calls this after authorizing the captured party facts. */
  signatureLeadContact(party:NonNullable<Awaited<ReturnType<DocumentRepository["signatureRecipientSource"]>>>,env?:NodeJS.ProcessEnv){
    const native=this.documentLeadReads?.get(party.reference.id);if(party.reference.kind!=="LEAD"||!native||commandFingerprint({reference:party.reference,snapshot:native.snapshot,checks:party.checks})!==party.fingerprint)throw new DocumentConflictError();return nativeLeadDocumentContact(native,env);
  }
  signatureRecipientCandidates(kind: z.infer<typeof signatureRecipientReferenceSchema>["kind"], query: string, before?: string) {
    if(kind==="LEAD")throw new DocumentConflictError(); // Lead choices are restricted to the document's actual source.
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
    if(kind==="ONBOARDING")return nativeOnboardingDocumentChoices(this.tx,this.organizationId,query,before,take);
    if (kind === "ORGANIZATION") {
      const row = before ? null : await this.tx.organization.findFirst({ where: { id: this.organizationId, name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true } });
      return row ? [{ id: row.id, label: row.name }] : [];
    }
    if(kind==="LEAD"){
      const exact=query&&documentSourceReferenceSchema.safeParse({kind:"LEAD",id:query}).success;
      // Contact names stay encrypted. The boundary filters a bounded authorized page.
      return(await this.tx.lead.findMany({where:{...where,...(exact?{AND:[{id:query}]}:{})},select:{id:true},orderBy,take})).map(row=>({id:row.id,label:row.id}));
    }
    if (kind === "PROPERTY") return (await this.tx.property.findMany({ where: { ...where, name: { contains: query, mode: "insensitive" } }, select: { id: true, name: true }, orderBy, take })).map(row => ({ id: row.id, label: row.name }));
    if (kind === "OWNER") return (await this.tx.owner.findMany({ where: { ...where, displayName: { contains: query, mode: "insensitive" } }, select: { id: true, displayName: true }, orderBy, take })).map(row => ({ id: row.id, label: row.displayName }));
    if (kind === "PERSON") return (await this.tx.person.findMany({ where: { ...where, displayName: { contains: query, mode: "insensitive" } }, select: { id: true, displayName: true }, orderBy, take })).map(row => ({ id: row.id, label: row.displayName }));
    if (kind === "RESERVATION") return (await this.tx.reservation.findMany({ where: { ...where, reference: { contains: query, mode: "insensitive" } }, select: { id: true, reference: true }, orderBy, take })).map(row => ({ id: row.id, label: row.reference }));
    if (kind === "SUPPLIER") return (await this.tx.supplier.findMany({ where: { ...where, displayName: { contains: query, mode: "insensitive" } }, select: { id: true, displayName: true }, orderBy, take })).map(row => ({ id: row.id, label: row.displayName }));
    if (kind === "GUEST") return (await this.tx.guestRecord.findMany({ where: { ...where, displayName: { contains: query, mode: "insensitive" } }, select: { id: true, displayName: true }, orderBy, take })).map(row => ({ id: row.id, label: row.displayName ?? row.id }));
    return (await this.tx.financialTransaction.findMany({ where: { ...where, sealed: true, reference: { contains: query, mode: "insensitive" } }, select: { id: true, reference: true }, orderBy, take })).map(row => ({ id: row.id, label: row.reference }));
  }
}
