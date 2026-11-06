import { Money } from "@/platform/money/money";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { TemplateBindingError, type DocumentTemplateBinding } from "../domain/document-template";
import { DocumentRepository, type DocumentSourceFacts } from "./document-repository";

/** Fixed native field names are a data contract, never caller-provided values or object paths. */
export class DocumentTemplateSourceRepository extends DocumentRepository {
  async templateSourceValues(native: DocumentSourceFacts, requested: readonly string[]) {
    if (requested.length > 200 || new Set(requested).size !== requested.length) throw new TemplateBindingError();
    const reference = native.reference, where = { organizationId: this.organizationId, id: reference.id }, values = new Map<string, DocumentTemplateBinding>();
    const sourcePrivacy = reference.kind === "FINANCIAL_TRANSACTION" ? "financial" : ["OWNER", "PERSON"].includes(reference.kind) ? "sensitive" : "operational";
    const text = (key: string, value: string, privacy: "operational" | "sensitive" | "financial" = sourcePrivacy) => values.set(key, { kind: "TEXT", value, privacy: [privacy] });
    const integer = (key: string, value: number) => { if (!Number.isSafeInteger(value)) throw new TemplateBindingError(); values.set(key, { kind: "INTEGER", value: String(value), privacy: ["operational"] }); };
    text("source_label", native.label);
    let snapshot: unknown = { reference, sourceFingerprint: native.fingerprint };
    if (reference.kind === "ORGANIZATION") text("organization_name", native.label);
    else if (reference.kind === "PROPERTY") {
      const row = await this.tx.property.findFirst({ where, select: { id: true, name: true, addressLine1: true, addressLine2: true, city: true, bedrooms: true, bathrooms: true, maxGuests: true, archivedAt: true, updatedAt: true } });
      if (!row || row.archivedAt) throw new TemplateBindingError(); snapshot = row;
      text("property", row.name); text("property_name", row.name); text("property_address", [row.addressLine1, row.addressLine2].filter(value => value !== null).join("\n")); text("property_city", row.city);
      integer("property_bedrooms", row.bedrooms); integer("property_bathrooms", row.bathrooms); integer("property_capacity", row.maxGuests);
    } else if (reference.kind === "RESERVATION") {
      const row = await this.tx.reservation.findFirst({ where, select: { id: true, reference: true, checkIn: true, checkOut: true, nights: true, version: true, archivedAt: true, updatedAt: true } });
      if (!row || row.archivedAt) throw new TemplateBindingError(); snapshot = row;
      text("reservation_reference", row.reference); integer("reservation_nights", row.nights);
      values.set("reservation_check_in", { kind: "DATE", value: row.checkIn.toISOString().slice(0, 10), privacy: ["operational"] });
      values.set("reservation_check_out", { kind: "DATE", value: row.checkOut.toISOString().slice(0, 10), privacy: ["operational"] });
    } else if (reference.kind === "OWNER" || reference.kind === "PERSON") {
      const row = reference.kind === "OWNER" ? await this.tx.owner.findFirst({ where, select: { id: true, displayName: true, archivedAt: true, updatedAt: true } }) :
        await this.tx.person.findFirst({ where, select: { id: true, displayName: true, archivedAt: true, updatedAt: true } });
      if (!row || row.archivedAt) throw new TemplateBindingError(); snapshot = row; text(reference.kind === "OWNER" ? "owner_name" : "person_name", row.displayName, "sensitive");
    } else {
      const source = await this.source(reference.id); if (!source) throw new TemplateBindingError(); snapshot = { identity: source.identity, transaction: source.transaction };
      text("transaction_reference", source.transaction.reference, "financial");
      if (source.transaction.currency) {
        text("transaction_currency", source.transaction.currency, "financial");
        if (source.transaction.amount !== null) {
          if (typeof source.transaction.amount !== "string") throw new TemplateBindingError();
          values.set("transaction_amount", { kind: "MONEY", value: Money.of(source.transaction.amount, source.transaction.currency), privacy: ["financial"] });
        }
      }
    }
    const selected = new Map<string, DocumentTemplateBinding>();
    for (const key of requested) { const value = values.get(key); if (!value) throw new TemplateBindingError(); selected.set(key, value); }
    const evidence = { source: snapshot, values: [...selected].sort(([left], [right]) => left.localeCompare(right)).map(([key, binding]) => ({ key, ...binding, value: binding.kind === "MONEY" ? binding.value.toJSON() : binding.value })) };
    return { bindings: selected as ReadonlyMap<string, DocumentTemplateBinding>, fingerprint: commandFingerprint(evidence) };
  }
}
