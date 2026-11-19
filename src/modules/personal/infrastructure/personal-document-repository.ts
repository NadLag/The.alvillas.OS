import { createHash } from "node:crypto";
import { decryptBytes, encryptBytes } from "@/platform/auth/secret-encryption";
import { requirePrivatePayloadKeys } from "@/platform/auth/private-payload-keys";
import { presentPersonal } from "../domain/household-access";
import { documentMatchesType, personalDocumentSchema } from "../domain/personal-document";
import { PersonalConflict, type HouseholdScope } from "./household-repository";

function documentKeys(encrypting: boolean) {
  const env = { NODE_ENV: process.env.NODE_ENV, ENCRYPTION_KEYS: process.env.PERSONAL_ENCRYPTION_KEYS };
  requirePrivatePayloadKeys(env, encrypting, () => new Error("Personal document key ring unavailable"));
  return env;
}

export class PersonalDocumentRepository {
  constructor(private readonly scope: HouseholdScope) {}

  private where(id: string) {
    return { organizationId_householdId_id: { ...this.scope.key, id } };
  }

  private context(id: string, contentType: string, contentHash: string) {
    return JSON.stringify(["personal-document-v1", this.scope.identity.organizationId, this.scope.id, id, contentType, contentHash]);
  }

  async upload(raw: unknown) {
    this.scope.require("documents", "edit");
    const { id: commandId, displayName, file } = personalDocumentSchema.parse(raw);
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!documentMatchesType(bytes, file.type)) throw new PersonalConflict();
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const existing = await this.scope.tx.personalDocument.findUnique({
      where: { organizationId_householdId_commandId: { ...this.scope.key, commandId } }, select: { displayName: true, contentHash: true, contentType: true, createdBy: true }
    });
    if (existing) {
      if (existing.contentHash !== contentHash || existing.contentType !== file.type || existing.displayName !== displayName
        || existing.createdBy !== this.scope.identity.accountId) throw new PersonalConflict();
      return;
    }
    const id = await this.scope.nextId();
    const ciphertext = new Uint8Array(encryptBytes(bytes, this.context(id, file.type, contentHash), documentKeys(true)));
    await this.scope.tx.personalDocument.create({
      data: { ...this.scope.key, id, commandId, displayName, contentType: file.type, contentHash, ciphertext,
        createdBy: this.scope.identity.accountId }
    });
    await this.scope.audit("personal.document_uploaded", "personal_documents", id);
  }

  async list(includeArchived: boolean, after?: string) {
    this.scope.require("documents", includeArchived ? "edit" : "view");
    const rows = await this.scope.tx.personalDocument.findMany({
      where: { ...this.scope.key, archivedAt: includeArchived ? { not: null } : null, ...(after ? { id: { lt: after } } : {}) },
      orderBy: { id: "desc" }, take: 51, select: { id: true, displayName: true, contentType: true, createdAt: true }
    });
    return {
      items: rows.slice(0, 50).map((row) => presentPersonal(this.scope.authority, this.scope.id, "documents", row)),
      next: rows.length > 50 ? rows[49].id : undefined
    };
  }

  async archive(id: string, archived: boolean) {
    this.scope.require("documents", "edit");
    const changed = await this.scope.tx.personalDocument.updateMany({
      where: { ...this.scope.key, id, archivedAt: archived ? null : { not: null } },
      data: { archivedAt: archived ? new Date() : null }
    });
    if (changed.count) await this.scope.audit(archived ? "personal.document_archived" : "personal.document_restored", "personal_documents", id);
  }

  async download(id: string) {
    this.scope.require("documents");
    const row = await this.scope.tx.personalDocument.findUnique({ where: this.where(id) });
    if (!row || row.archivedAt) return null;
    const bytes = decryptBytes(row.ciphertext, this.context(id, row.contentType, row.contentHash), documentKeys(false));
    if (createHash("sha256").update(bytes).digest("hex") !== row.contentHash) throw new PersonalConflict();
    await this.scope.audit("personal.document_downloaded", "personal_documents", id);
    return { bytes: new Uint8Array(bytes), contentType: row.contentType,
      displayName: presentPersonal(this.scope.authority, this.scope.id, "documents", { displayName: row.displayName }).displayName };
  }
}
